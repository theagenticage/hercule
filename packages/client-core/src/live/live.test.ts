/**
 * The live supervisor against a stub socket.
 *
 * The supervisor is the one piece of this feature no server test can reach: it
 * owns the ticket fetch, the reconnect schedule, the keepalive and what a
 * subscription does after the connection it was made on is gone. So the socket
 * here is a stub that is also the server - it records what the client sends and
 * answers only what the transport needs answering (its own keepalive, `hello`
 * and `ping`); every push and every failure is pressed by the test, so what is
 * being measured is the supervisor's reaction and never the controller's.
 *
 * Time is faked throughout. The reconnect schedule and the 30-second keepalive
 * are the behaviour under test, and waiting for them in real time would make
 * the suite slow and flaky at once. The backoff may carry jitter that only ever
 * shortens a delay, so advancing by the nominal delay always reaches the next
 * attempt.
 */
import { afterEach, assert, beforeEach, describe, it, vi } from "vitest";
import type { Event } from "@hercule/contract";
import {
  createClient,
  createLive,
  queryKeys,
  queryKeysFor,
  type FetchLike,
  type Live,
  type LiveQueryKey,
} from "../index";
import type { LiveDelta } from "./live";
import { STUB_SERVER_VERSION as SERVER_VERSION, StubSocket, openInto } from "./socket-stub";

const BASE = "http://controller.test";
const SOCKET_URL = "ws://controller.test/ws";

/** Every socket the supervisor under test has opened, oldest first. */
const opened: Array<StubSocket> = [];

const socketAt = (index: number): StubSocket => {
  const socket = opened[index];
  assert.isDefined(socket, `no socket at index ${index}`);
  return socket;
};

const lastSocket = (): StubSocket => socketAt(opened.length - 1);

/**
 * Lets everything already due happen: the promises of the ticket fetch, the
 * frames the stub answers, and the fibers the client runs them on. A tick of
 * exactly zero does not release the fibers waiting on the scheduler's
 * `setImmediate`, so this moves the clock by a millisecond at a time; the 20 ms
 * it costs is far below any interval under test, and the backoff's jitter only
 * ever shortens a delay, so a little extra elapsed time never hides an attempt.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(1);
};

/** A `fetch` that answers the ticket route with a fresh ticket every time. */
const ticketServer = () => {
  const seen: Array<Request> = [];
  let issued = 0;
  const fetch: FetchLike = (url, init) => {
    seen.push(new Request(url, init));
    issued += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ ticket: `t${issued}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetch, seen };
};

/** A `fetch` that refuses the ticket the way a spent credential is refused. */
const refusingFetch = (): { readonly fetch: FetchLike; readonly count: () => number } => {
  let count = 0;
  return {
    fetch: () => {
      count += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: "unauthenticated", message: "no credential" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      );
    },
    count: () => count,
  };
};

const capFailure = {
  error: {
    code: "cap_exceeded",
    message: "the subscriber is not keeping up",
    details: { count: 1001, cap: 1000 },
  },
};

const unauthenticatedFailure = {
  error: { code: "unauthenticated", message: "no credential" },
};

const forbiddenFailure = {
  error: {
    code: "forbidden",
    message: "missing grant event.read",
    details: { grant: "event.read" },
  },
};

const validationFailure = {
  error: {
    code: "validation",
    message: "cursor is past the end of the log",
    details: { issues: [] },
  },
};

const notFoundFailure = {
  error: { code: "not_found", message: "no session s_gone" },
};

const event = (id: number): Event => ({
  id,
  source: "platform",
  connectionId: null,
  system: "hercule",
  kind: "task.created",
  occurredAt: "2026-09-05T10:00:00.000Z",
  receivedAt: "2026-09-05T10:00:00.000Z",
  dedupKey: `dedup-${id}`,
  refs: [],
  url: null,
  payload: {},
  raw: null,
  actor: "user",
});

/** Keys compare as sets: the criterion names which keys, not their order. */
const sorted = (keys: ReadonlyArray<LiveQueryKey>): Array<string> =>
  keys.map((key) => JSON.stringify(key)).sort();

let live: Live | null = null;

const supervisor = (fetch: FetchLike): Live => {
  const client = createClient({ baseUrl: BASE, token: "tok", fetch });
  live = createLive({ client, baseUrl: BASE, webSocket: openInto(opened) });
  return live;
};

/** A started, greeted supervisor with its first socket. */
const connected = async (
  fetch: FetchLike,
): Promise<{ readonly live: Live; readonly socket: StubSocket }> => {
  const started = supervisor(fetch);
  started.start();
  await settle();
  return { live: started, socket: lastSocket() };
};

beforeEach(() => {
  vi.useFakeTimers();
  opened.length = 0;
});

afterEach(async () => {
  // Real timers first: tearing down waits on the client's own fibers, and a
  // clock nobody is advancing any more would never let them finish.
  const started = live;
  live = null;
  vi.useRealTimers();
  if (started !== null) await started.stop();
});

describe("createLive", () => {
  it("fetches a ticket, opens the socket, greets and exposes the server version", async () => {
    const { fetch, seen } = ticketServer();
    const started = supervisor(fetch);
    const statuses: Array<string> = [];
    started.onStatus((status) => statuses.push(status));

    assert.deepStrictEqual(statuses, ["idle"]);

    started.start();
    await settle();

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0]?.url, `${BASE}/api/v1/auth/ws-ticket`);
    assert.strictEqual(seen[0]?.method, "POST");

    assert.strictEqual(opened.length, 1);
    assert.strictEqual(socketAt(0).url, SOCKET_URL);

    const hello = socketAt(0).calls("hello");
    assert.strictEqual(hello.length, 1);
    assert.deepStrictEqual(hello[0]?.payload, { v: 1, ticket: "t1" });

    assert.strictEqual(started.serverVersion, SERVER_VERSION);
    assert.strictEqual(statuses[statuses.length - 1], "connected");
  });

  it("reconnects with a fresh ticket on a backoff that doubles and caps at 30 s", async () => {
    const { fetch, seen } = ticketServer();
    const { socket } = await connected(fetch);

    assert.strictEqual(opened.length, 1);

    // The sixth and seventh delays would be 32 s and 64 s uncapped, so reaching
    // an attempt after 30 s is what proves the cap.
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    let current = socket;

    for (const delay of delays) {
      const before = opened.length;
      current.drop();
      await settle();
      assert.strictEqual(opened.length, before, `reconnected before ${delay} ms`);

      await vi.advanceTimersByTimeAsync(delay);
      await settle();
      assert.strictEqual(opened.length, before + 1, `no reconnect after ${delay} ms`);
      current = lastSocket();
    }

    // Every attempt bought its own ticket, and no ticket was used twice.
    const tickets = opened.map((each) => {
      const hello = each.calls("hello")[0];
      return (hello?.payload as { readonly ticket: string }).ticket;
    });
    assert.strictEqual(tickets.length, delays.length + 1);
    assert.strictEqual(new Set(tickets).size, tickets.length);
    assert.strictEqual(seen.length, tickets.length);
  });

  it("waits from the shortest delay again after a connection that held", async () => {
    const { fetch } = ticketServer();
    const { socket } = await connected(fetch);

    // Three quick drops walk the wait up to eight seconds.
    let current = socket;
    for (const delay of [1000, 2000, 4000]) {
      current.drop();
      await vi.advanceTimersByTimeAsync(delay);
      await settle();
      current = lastSocket();
    }

    // A connection that outlasts the longest wait was not a client that cannot
    // connect, so the drop after it starts the schedule over.
    await vi.advanceTimersByTimeAsync(31_000);
    await settle();
    const before = opened.length;

    current.drop();
    await settle();
    assert.strictEqual(opened.length, before);

    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    assert.strictEqual(opened.length, before + 1);

    // Started over, not flattened: the wait after that one doubles again.
    lastSocket().drop();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    assert.strictEqual(opened.length, before + 1, "the schedule stopped growing");

    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    assert.strictEqual(opened.length, before + 2);
  });

  it("closes the socket when it is stopped, and opens a fresh one when it is started again", async () => {
    // Signing out and back in inside one page is exactly this, and the second
    // connection must be the second person's rather than the first's.
    const { fetch, seen } = ticketServer();
    const { live: started, socket } = await connected(fetch);
    started.subscribe("task", () => {});
    await settle();

    await started.stop();
    await settle();
    assert.strictEqual(socket.readyState, 3);

    started.start();
    await settle();
    assert.strictEqual(opened.length, 2);
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(lastSocket().calls("hello").length, 1);
    // The registry survived, so the second connection watches what the first did.
    assert.deepStrictEqual(
      lastSocket()
        .subscriptions()
        .map((each) => each.topic),
      ["task"],
    );
  });

  it("stops for good and reports unauthenticated when the ticket is refused", async () => {
    const { fetch, count } = refusingFetch();
    const started = supervisor(fetch);
    const statuses: Array<string> = [];
    started.onStatus((status) => statuses.push(status));

    started.start();
    await settle();

    assert.strictEqual(statuses[statuses.length - 1], "unauthenticated");
    assert.strictEqual(opened.length, 0);

    // Terminal: no later attempt, however long it is given.
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();
    assert.strictEqual(count(), 1);
    assert.strictEqual(opened.length, 0);
    assert.strictEqual(statuses[statuses.length - 1], "unauthenticated");
  });

  it("calls ping every 30 s while connected", async () => {
    const { fetch } = ticketServer();
    const { socket } = await connected(fetch);

    assert.strictEqual(socket.calls("ping").length, 0);

    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    assert.strictEqual(socket.calls("ping").length, 1);

    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    assert.strictEqual(socket.calls("ping").length, 2);
    assert.strictEqual(socket.closedWith, null);
  });

  it("resubscribes from the last cursor and invalidates everything watched before any new push", async () => {
    const { fetch } = ticketServer();
    const { live: started, socket } = await connected(fetch);

    const deltas: Array<LiveDelta> = [];
    const invalidations: Array<ReadonlyArray<LiveQueryKey>> = [];
    started.subscribe("event", (delta) => deltas.push(delta));
    started.subscribe("task", (keys) => invalidations.push(keys));
    await settle();

    const firstEventCall = socket.calls("subscribe").find((call) => {
      return (call.payload as { readonly topic: string }).topic === "event";
    });
    assert.isDefined(firstEventCall);
    socket.chunk(firstEventCall?.id, [{ _tag: "delta", cursor: "7", items: [event(7)] }]);
    await settle();

    assert.strictEqual(deltas.length, 1);
    assert.strictEqual(deltas[0]?.cursor, "7");
    assert.deepStrictEqual(deltas[0]?.items, [event(7)]);
    assert.strictEqual(deltas[0]?.reset, false);
    const invalidatedBeforeDrop = invalidations.length;

    socket.drop();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();

    const reopened = lastSocket();
    assert.notStrictEqual(reopened, socket);

    const resubscribes = reopened.calls("subscribe");
    assert.strictEqual(resubscribes.length, 2);
    const eventAgain = resubscribes.find(
      (call) => (call.payload as { readonly topic: string }).topic === "event",
    );
    const taskAgain = resubscribes.find(
      (call) => (call.payload as { readonly topic: string }).topic === "task",
    );
    assert.deepStrictEqual(eventAgain?.payload, { topic: "event", cursor: "7" });
    assert.deepStrictEqual(taskAgain?.payload, { topic: "task" });

    // Everything the topic covers is invalidated once, and it happened before
    // the connection carried any push.
    assert.strictEqual(invalidations.length, invalidatedBeforeDrop + 1);
    const onReconnect = invalidations[invalidatedBeforeDrop];
    assert.deepStrictEqual(sorted(onReconnect ?? []), sorted(queryKeysFor("task", [])));

    reopened.chunk(taskAgain?.id, [{ _tag: "invalidate", ids: ["task-9"], kind: "updated" }]);
    await settle();

    assert.strictEqual(invalidations.length, 2);
    assert.deepStrictEqual(
      sorted(invalidations[1] ?? []),
      sorted(queryKeysFor("task", ["task-9"])),
    );
  });

  it("reads everything again for a reader that subscribed before the first connection", async () => {
    // A screen mounted before the socket was up read the API over HTTP and then
    // subscribed. Whatever was pushed in between named records it cannot name,
    // so the first greeting owes it the same sweep a reconnect owes.
    const { fetch } = ticketServer();
    const started = supervisor(fetch);

    const invalidations: Array<ReadonlyArray<LiveQueryKey>> = [];
    started.subscribe("task", (keys) => invalidations.push(keys));

    started.start();
    await settle();

    assert.strictEqual(invalidations.length, 1);
    assert.deepStrictEqual(sorted(invalidations[0] ?? []), sorted(queryKeysFor("task", [])));

    // And it happened before the connection carried anything.
    const socket = lastSocket();
    const call = socket.calls("subscribe")[0];
    assert.isDefined(call);
    socket.chunk(call?.id, [{ _tag: "invalidate", ids: ["task-1"], kind: "created" }]);
    await settle();
    assert.strictEqual(invalidations.length, 2);
    assert.deepStrictEqual(
      sorted(invalidations[1] ?? []),
      sorted(queryKeysFor("task", ["task-1"])),
    );
  });

  it("reads everything again for a reader that subscribed while the connection was down", async () => {
    const { fetch } = ticketServer();
    const { live: started, socket } = await connected(fetch);

    const invalidations: Array<ReadonlyArray<LiveQueryKey>> = [];
    socket.drop();
    await settle();
    started.subscribe("task", (keys) => invalidations.push(keys));

    // Nothing is owed while there is nothing to have missed a push.
    assert.strictEqual(invalidations.length, 0);

    await vi.advanceTimersByTimeAsync(1000);
    await settle();

    assert.strictEqual(invalidations.length, 1);
    assert.deepStrictEqual(sorted(invalidations[0] ?? []), sorted(queryKeysFor("task", [])));
  });

  it("drops a refused cursor, resubscribes from the head and tells the handler", async () => {
    const { fetch } = ticketServer();
    const { live: started, socket } = await connected(fetch);

    const deltas: Array<LiveDelta> = [];
    started.subscribe("event", (delta) => deltas.push(delta));
    await settle();

    const first = socket.calls("subscribe")[0];
    socket.chunk(first?.id, [{ _tag: "delta", cursor: "7", items: [] }]);
    await settle();
    const seenBefore = deltas.length;

    socket.drop();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();

    const reopened = lastSocket();
    const withCursor = reopened.calls("subscribe")[0];
    assert.deepStrictEqual(withCursor?.payload, { topic: "event", cursor: "7" });

    reopened.fail(withCursor?.id, validationFailure);
    await settle();

    // The cursor is gone, so the subscription is taken out again from the head.
    const retry = reopened.calls("subscribe")[1];
    assert.isDefined(retry);
    assert.deepStrictEqual(retry?.payload, { topic: "event" });

    // And the handler is told, so a screen reading the log refetches its page
    // rather than sitting on a gap it cannot see.
    const afterRefusal = deltas.slice(seenBefore);
    assert.isTrue(
      afterRefusal.some((delta) => delta.reset),
      "the handler was never told the position was lost",
    );

    reopened.chunk(retry?.id, [{ _tag: "delta", cursor: "11", items: [event(11)] }]);
    await settle();

    const last = deltas[deltas.length - 1];
    assert.strictEqual(last?.cursor, "11");
    assert.deepStrictEqual(last?.items, [event(11)]);
    assert.strictEqual(last?.reset, false);
  });

  it("starts an append-only subscription from a cursor the caller already holds, not from the head", async () => {
    // A caller that fetched a page over HTTP before subscribing has already
    // read everything up to some position; starting the subscription from the
    // head would miss whatever was written between that fetch and this call.
    const { fetch } = ticketServer();
    const { live: started, socket } = await connected(fetch);

    started.subscribe("event", () => {}, "41");
    await settle();

    const call = socket.calls("subscribe")[0];
    assert.deepStrictEqual(call?.payload, { topic: "event", cursor: "41" });
  });

  it("tells an append-only subscriber its topic is gone and stops retrying it, leaving the connection and other subscriptions untouched", async () => {
    const { fetch } = ticketServer();
    const { live: started, socket } = await connected(fetch);

    const streamDeltas: Array<LiveDelta> = [];
    const invalidations: Array<ReadonlyArray<LiveQueryKey>> = [];
    started.subscribe("session:s_gone:stream", (delta) => streamDeltas.push(delta));
    started.subscribe("task", (keys) => invalidations.push(keys));
    await settle();

    const streamCall = socket
      .calls("subscribe")
      .find((call) =>
        call.payload === undefined
          ? false
          : (call.payload as { topic: string }).topic === "session:s_gone:stream",
      );
    assert.isDefined(streamCall);
    socket.fail(streamCall?.id, notFoundFailure);
    await settle();

    assert.isTrue(
      streamDeltas.some((delta) => delta.gone),
      "the handler was never told the topic was gone",
    );

    // Nothing retries it: no second `subscribe` call for that topic appears,
    // even after the backoff a transient refusal would wait out.
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    const streamCalls = socket
      .calls("subscribe")
      .filter(
        (call) =>
          (call.payload as { topic: string } | undefined)?.topic === "session:s_gone:stream",
      );
    assert.strictEqual(streamCalls.length, 1);

    // The connection itself, and the other subscription on it, are unaffected.
    assert.strictEqual(socket.readyState, 1);
    socket.push("task", { _tag: "invalidate", ids: ["t1"], kind: "updated" });
    await settle();
    assert.isTrue(invalidations.length > 0, "the unrelated subscription stopped receiving pushes");
  });

  it("tells a capped reader to read everything again, and waits before asking again", async () => {
    const { fetch } = ticketServer();
    const { live: started, socket } = await connected(fetch);

    const invalidations: Array<ReadonlyArray<LiveQueryKey>> = [];
    started.subscribe("task", (keys) => invalidations.push(keys));
    await settle();

    const first = socket.calls("subscribe")[0];
    socket.fail(first?.id, capFailure);
    await settle();

    // Nothing names what was dropped, so everything the topic covers is read
    // again - the same answer a reconnect gives.
    assert.strictEqual(invalidations.length, 1);
    assert.deepStrictEqual(sorted(invalidations[0] ?? []), sorted(queryKeysFor("task", [])));

    // A reader that fell behind once falls behind again, so asking as fast as
    // the refusal arrives would be a flood.
    assert.strictEqual(socket.calls("subscribe").length, 1);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    assert.strictEqual(socket.calls("subscribe").length, 2);
  });

  it("closes the socket and reconnects when a subscription is told the credential is gone", async () => {
    const { fetch } = ticketServer();
    const { live: started, socket } = await connected(fetch);

    started.subscribe("task", () => undefined);
    await settle();

    socket.fail(socket.calls("subscribe")[0]?.id, unauthenticatedFailure);
    await settle();

    assert.isNotNull(socket.closedWith);
    assert.strictEqual(opened.length, 1);

    await vi.advanceTimersByTimeAsync(1000);
    await settle();

    // The fresh connection is what finds out whether there is a credential
    // left: its ticket fetch is the one that would be refused.
    assert.strictEqual(opened.length, 2);
    assert.strictEqual(lastSocket().calls("hello").length, 1);
  });

  it("keeps a refused subscription trying, and leaves the connection out of it", async () => {
    const { fetch } = ticketServer();
    const { live: started, socket } = await connected(fetch);

    started.subscribe("event", () => undefined);
    await settle();

    // The wait grows, so a refusal that keeps repeating costs a couple of
    // frames a minute rather than a flood.
    for (const [attempt, delay] of [1000, 2000, 4000].entries()) {
      socket.fail(socket.calls("subscribe")[attempt]?.id, forbiddenFailure);
      await settle();
      assert.strictEqual(
        socket.calls("subscribe").length,
        attempt + 1,
        `resubscribed before waiting ${delay} ms`,
      );

      await vi.advanceTimersByTimeAsync(delay);
      await settle();
      assert.strictEqual(socket.calls("subscribe").length, attempt + 2);
    }

    // One subscription being refused is not the connection's problem, and the
    // others on it go on working.
    assert.strictEqual(opened.length, 1);
    assert.isNull(socket.closedWith);
  });

  it("ends the subscription the caller lets go of, and delivers nothing more to it", async () => {
    const { fetch } = ticketServer();
    const { live: started, socket } = await connected(fetch);

    const invalidations: Array<ReadonlyArray<LiveQueryKey>> = [];
    const off = started.subscribe("task", (keys) => invalidations.push(keys));
    await settle();

    const call = socket.calls("subscribe")[0];
    off();
    await settle();

    assert.isTrue(socket.frames("Interrupt").some((frame) => frame.requestId === call?.id));

    socket.chunk(call?.id, [{ _tag: "invalidate", ids: ["task-1"], kind: "created" }]);
    await settle();
    assert.strictEqual(invalidations.length, 0);
  });
});

describe("queryKeysFor", () => {
  it("maps a task push to the list prefix and one detail key per id", () => {
    assert.deepStrictEqual(queryKeysFor("task", ["a", "b"]), [
      ["tasks"],
      ["task", "a"],
      ["task", "b"],
    ]);

    // The same builders the tasks queries are keyed on.
    assert.deepStrictEqual(queryKeysFor("task", ["a"]), [queryKeys.tasks(), queryKeys.task("a")]);
  });

  it("covers every record of the topic when no id is named", () => {
    assert.deepStrictEqual(queryKeysFor("task", []), [["tasks"], ["task"]]);
  });

  it("maps a runner push to the fleet listing and the page of each machine named", () => {
    assert.deepStrictEqual(queryKeysFor("runner", ["r1", "r2"]), [
      ["runners"],
      ["runner", "r1"],
      ["runner", "r2"],
    ]);

    // The same builders the fleet and the runner page are keyed on.
    assert.deepStrictEqual(queryKeysFor("runner", ["r1"]), [
      queryKeys.runners(),
      queryKeys.runner("r1"),
    ]);

    // A push naming no machine means every one of them moved.
    assert.deepStrictEqual(queryKeysFor("runner", []), [["runners"], ["runner"]]);
  });

  it("maps a session push to the listing, each session's own page, and each session's queued-input list", () => {
    assert.deepStrictEqual(queryKeysFor("session", ["s1"]), [
      queryKeys.sessions(),
      queryKeys.session("s1"),
      queryKeys.inputs("s1"),
    ]);

    // A push naming no session means every one of them moved.
    assert.deepStrictEqual(queryKeysFor("session", []), [
      queryKeys.sessions(),
      queryKeys.session(),
      queryKeys.inputs(),
    ]);
  });
});
