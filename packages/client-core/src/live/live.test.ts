/**
 * Tests the live supervisor against a stub socket.
 *
 * No controller test can reach the supervisor: it owns the ticket fetch, the
 * reconnect schedule, the keepalive, and what a subscription does after its
 * connection is gone. So the socket here is a stub that also plays the
 * server. It records what the client sends and replies only to what the
 * transport needs (its keepalive, `hello` and `ping`), plus the push the
 * controller sends first on every mutable subscription, which says every
 * record may have changed. The test triggers every other push and every
 * failure, so the tests check only the supervisor's reaction, never the
 * controller's.
 *
 * All timers are fake. The reconnect schedule and the 30-second keepalive are
 * the behaviour under test, and waiting for them in real time would make the
 * suite both slow and flaky. The backoff's jitter only ever shortens a delay,
 * so advancing by the nominal delay always reaches the next attempt.
 */
import { afterEach, assert, beforeEach, describe, it, vi } from "vitest";
import type { Event } from "@hercule/contract";
import {
  createClient,
  createLive,
  queryKeys,
  buildQueryKeys,
  type FetchLike,
  type Live,
  type LiveQueryKey,
} from "../index";
import type { LiveDelta } from "./live";
import {
  STUB_SERVER_VERSION as SERVER_VERSION,
  StubSocket,
  stubWebSocketInto,
} from "./socket-stub";

const BASE = "http://controller.test";
const SOCKET_URL = "ws://controller.test/ws";

/** Every socket the supervisor under test has opened, oldest first. */
const opened: Array<StubSocket> = [];

const readOpenedSocket = (index: number): StubSocket => {
  const socket = opened[index];
  assert.isDefined(socket, `no socket at index ${index}`);
  return socket;
};

const readLastSocket = (): StubSocket => readOpenedSocket(opened.length - 1);

/**
 * Runs everything that is already due: the ticket fetch's promises, the stub's
 * replies, and the fibers the client runs them on. Advancing by exactly zero
 * does not release fibers waiting on the scheduler's `setImmediate`, so this
 * advances the clock one millisecond at a time. The 20 ms total is far below
 * any interval under test, and the backoff's jitter only ever shortens a
 * delay, so the extra time never skips an attempt.
 */
const settleTimers = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(1);
};

/** Returns a `fetch` that responds to the ticket route with a new ticket every time. */
const stubTicketServer = () => {
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

/**
 * Returns a `fetch` that rejects the ticket request as `unauthenticated`, as
 * for an expired credential.
 */
const stubRefusingFetch = (): { readonly fetch: FetchLike; readonly count: () => number } => {
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

const buildEvent = (id: number): Event => ({
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

/** Sorts keys so they compare as sets: the tests check which keys, not their order. */
const sortKeys = (keys: ReadonlyArray<LiveQueryKey>): Array<string> =>
  keys.map((key) => JSON.stringify(key)).sort();

let live: Live | null = null;

const createSupervisor = (fetch: FetchLike): Live => {
  const client = createClient({ baseUrl: BASE, token: "tok", fetch });
  live = createLive({ client, baseUrl: BASE, webSocket: stubWebSocketInto(opened) });
  return live;
};

/** Returns a started supervisor that received its `hello` reply, with its first socket. */
const startConnectedSupervisor = async (
  fetch: FetchLike,
): Promise<{ readonly live: Live; readonly socket: StubSocket }> => {
  const started = createSupervisor(fetch);
  started.start();
  await settleTimers();
  return { live: started, socket: readLastSocket() };
};

beforeEach(() => {
  vi.useFakeTimers();
  opened.length = 0;
});

afterEach(async () => {
  // Switch to real timers first: stopping waits on the client's fibers, and
  // with a fake clock that nobody advances they would never finish.
  const started = live;
  live = null;
  vi.useRealTimers();
  if (started !== null) await started.stop();
});

describe("createLive", () => {
  it("fetches a ticket, opens the socket, sends hello and exposes the server version", async () => {
    const { fetch, seen } = stubTicketServer();
    const started = createSupervisor(fetch);
    const statuses: Array<string> = [];
    started.onStatus((status) => statuses.push(status));

    assert.deepStrictEqual(statuses, ["idle"]);

    started.start();
    await settleTimers();

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0]?.url, `${BASE}/api/v1/auth/ws-ticket`);
    assert.strictEqual(seen[0]?.method, "POST");

    assert.strictEqual(opened.length, 1);
    assert.strictEqual(readOpenedSocket(0).url, SOCKET_URL);

    const hello = readOpenedSocket(0).calls("hello");
    assert.strictEqual(hello.length, 1);
    assert.deepStrictEqual(hello[0]?.payload, { v: 1, ticket: "t1" });

    assert.strictEqual(started.serverVersion, SERVER_VERSION);
    assert.strictEqual(statuses[statuses.length - 1], "connected");
  });

  it("reconnects with a fresh ticket on a backoff that doubles and caps at 30 s", async () => {
    const { fetch, seen } = stubTicketServer();
    const { socket } = await startConnectedSupervisor(fetch);

    assert.strictEqual(opened.length, 1);

    // Without the cap, the sixth and seventh delays would be 32 s and 64 s, so
    // an attempt after 30 s proves the cap works.
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    let current = socket;

    for (const delay of delays) {
      const before = opened.length;
      current.drop();
      await settleTimers();
      assert.strictEqual(opened.length, before, `reconnected before ${delay} ms`);

      await vi.advanceTimersByTimeAsync(delay);
      await settleTimers();
      assert.strictEqual(opened.length, before + 1, `no reconnect after ${delay} ms`);
      current = readLastSocket();
    }

    // Every attempt fetched its own ticket, and no ticket was used twice.
    const tickets = opened.map((each) => {
      const hello = each.calls("hello")[0];
      return (hello?.payload as { readonly ticket: string }).ticket;
    });
    assert.strictEqual(tickets.length, delays.length + 1);
    assert.strictEqual(new Set(tickets).size, tickets.length);
    assert.strictEqual(seen.length, tickets.length);
  });

  it("starts again from the shortest delay after a connection that stayed up", async () => {
    const { fetch } = stubTicketServer();
    const { socket } = await startConnectedSupervisor(fetch);

    // Three quick drops raise the wait to eight seconds.
    let current = socket;
    for (const delay of [1000, 2000, 4000]) {
      current.drop();
      await vi.advanceTimersByTimeAsync(delay);
      await settleTimers();
      current = readLastSocket();
    }

    // A connection that lasts longer than the longest wait shows the client
    // can connect, so the drop after it starts the schedule over.
    await vi.advanceTimersByTimeAsync(31_000);
    await settleTimers();
    const before = opened.length;

    current.drop();
    await settleTimers();
    assert.strictEqual(opened.length, before);

    await vi.advanceTimersByTimeAsync(1000);
    await settleTimers();
    assert.strictEqual(opened.length, before + 1);

    // The schedule starts over rather than staying flat: the next wait doubles again.
    readLastSocket().drop();
    await vi.advanceTimersByTimeAsync(1000);
    await settleTimers();
    assert.strictEqual(opened.length, before + 1, "the schedule stopped growing");

    await vi.advanceTimersByTimeAsync(1000);
    await settleTimers();
    assert.strictEqual(opened.length, before + 2);
  });

  it("closes the socket when stopped, and opens a new one when started again", async () => {
    // This is what signing out and back in on one page does, and the second
    // connection must use the new sign-in, not the first one.
    const { fetch, seen } = stubTicketServer();
    const { live: started, socket } = await startConnectedSupervisor(fetch);
    started.subscribe("task", () => {});
    await settleTimers();

    await started.stop();
    await settleTimers();
    assert.strictEqual(socket.readyState, 3);

    started.start();
    await settleTimers();
    assert.strictEqual(opened.length, 2);
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(readLastSocket().calls("hello").length, 1);
    // The registry was kept, so the second connection has the same subscriptions as the first.
    assert.deepStrictEqual(
      readLastSocket()
        .subscriptions()
        .map((each) => each.topic),
      ["task"],
    );
  });

  it("stops calling a status listener after it is removed", async () => {
    const { fetch } = stubTicketServer();
    const started = createSupervisor(fetch);
    const statuses: Array<string> = [];
    const stopListening = started.onStatus((status) => statuses.push(status));

    stopListening();
    started.start();
    await settleTimers();

    assert.deepStrictEqual(statuses, ["idle"]);
  });

  it("stops for good and reports unauthenticated when the ticket request is rejected", async () => {
    const { fetch, count } = stubRefusingFetch();
    const started = createSupervisor(fetch);
    const statuses: Array<string> = [];
    started.onStatus((status) => statuses.push(status));

    started.start();
    await settleTimers();

    assert.strictEqual(statuses[statuses.length - 1], "unauthenticated");
    assert.strictEqual(opened.length, 0);

    // This is final: there is no later attempt, however long the test waits.
    await vi.advanceTimersByTimeAsync(120_000);
    await settleTimers();
    assert.strictEqual(count(), 1);
    assert.strictEqual(opened.length, 0);
    assert.strictEqual(statuses[statuses.length - 1], "unauthenticated");
  });

  it("calls ping every 30 s while connected", async () => {
    const { fetch } = stubTicketServer();
    const { socket } = await startConnectedSupervisor(fetch);

    assert.strictEqual(socket.calls("ping").length, 0);

    await vi.advanceTimersByTimeAsync(30_000);
    await settleTimers();
    assert.strictEqual(socket.calls("ping").length, 1);

    await vi.advanceTimersByTimeAsync(30_000);
    await settleTimers();
    assert.strictEqual(socket.calls("ping").length, 2);
    assert.strictEqual(socket.closedWith, null);
  });

  it("resubscribes from the last cursor after a reconnect, and adds no invalidation of its own", async () => {
    const { fetch } = stubTicketServer();
    const { live: started, socket } = await startConnectedSupervisor(fetch);

    const deltas: Array<LiveDelta> = [];
    const invalidations: Array<ReadonlyArray<LiveQueryKey>> = [];
    started.subscribe("event", (delta) => deltas.push(delta));
    started.subscribe("task", (keys) => invalidations.push(keys));
    await settleTimers();

    const firstEventCall = socket.calls("subscribe").find((call) => {
      return (call.payload as { readonly topic: string }).topic === "event";
    });
    assert.isDefined(firstEventCall);
    socket.chunk(firstEventCall?.id, [{ _tag: "delta", cursor: "7", items: [buildEvent(7)] }]);
    await settleTimers();

    assert.strictEqual(deltas.length, 1);
    assert.strictEqual(deltas[0]?.cursor, "7");
    assert.deepStrictEqual(deltas[0]?.items, [buildEvent(7)]);
    assert.strictEqual(deltas[0]?.reset, false);
    const invalidatedBeforeDrop = invalidations.length;

    socket.drop();
    await vi.advanceTimersByTimeAsync(1000);
    await settleTimers();

    const reopened = readLastSocket();
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

    // The controller's first push on the new subscription invalidates every
    // key of the topic. It is the only invalidation: the client sends none of
    // its own, so a reconnect costs one refetch, not two.
    assert.strictEqual(invalidations.length, invalidatedBeforeDrop + 1);
    const onReconnect = invalidations[invalidatedBeforeDrop];
    assert.deepStrictEqual(sortKeys(onReconnect ?? []), sortKeys(buildQueryKeys("task", [])));

    reopened.chunk(taskAgain?.id, [{ _tag: "invalidate", ids: ["task-9"], kind: "updated" }]);
    await settleTimers();

    assert.strictEqual(invalidations.length, invalidatedBeforeDrop + 2);
    assert.deepStrictEqual(
      sortKeys(invalidations.at(-1) ?? []),
      sortKeys(buildQueryKeys("task", ["task-9"])),
    );
  });

  it("invalidates everything once for a subscriber that subscribed before the first connection", async () => {
    // A screen that mounted before the socket was open fetched over HTTP and
    // then subscribed. It cannot know what was pushed in between, so the
    // controller's first push on the subscription tells it to refetch.
    const { fetch } = stubTicketServer();
    const started = createSupervisor(fetch);

    const invalidations: Array<ReadonlyArray<LiveQueryKey>> = [];
    started.subscribe("task", (keys) => invalidations.push(keys));

    started.start();
    await settleTimers();

    assert.strictEqual(invalidations.length, 1);
    assert.deepStrictEqual(sortKeys(invalidations[0] ?? []), sortKeys(buildQueryKeys("task", [])));

    // A push made after that one is passed on as it comes.
    const socket = readLastSocket();
    const call = socket.calls("subscribe")[0];
    assert.isDefined(call);
    socket.chunk(call?.id, [{ _tag: "invalidate", ids: ["task-1"], kind: "created" }]);
    await settleTimers();
    assert.strictEqual(invalidations.length, 2);
    assert.deepStrictEqual(
      sortKeys(invalidations[1] ?? []),
      sortKeys(buildQueryKeys("task", ["task-1"])),
    );
  });

  it("invalidates the current session of each conversation a session push names", async () => {
    const { fetch } = stubTicketServer();
    const started = createSupervisor(fetch);

    const invalidations: Array<ReadonlyArray<LiveQueryKey>> = [];
    started.subscribe("session", (keys) => invalidations.push(keys));
    started.start();
    await settleTimers();

    const socket = readLastSocket();
    const call = socket.calls("subscribe")[0];
    assert.isDefined(call);
    socket.chunk(call?.id, [
      {
        _tag: "invalidate",
        ids: ["s1", "thread-1"],
        kind: "updated",
        conversationIds: { s1: "c1", "thread-1": null },
      },
    ]);
    await settleTimers();
    assert.deepStrictEqual(invalidations[1], [
      queryKeys.sessions(),
      queryKeys.session("s1"),
      queryKeys.session("thread-1"),
      queryKeys.inputs("s1"),
      queryKeys.inputs("thread-1"),
      queryKeys.conversationSession("c1"),
    ]);
  });

  it("invalidates everything for a subscriber that subscribed while the connection was down", async () => {
    const { fetch } = stubTicketServer();
    const { live: started, socket } = await startConnectedSupervisor(fetch);

    const invalidations: Array<ReadonlyArray<LiveQueryKey>> = [];
    socket.drop();
    await settleTimers();
    started.subscribe("task", (keys) => invalidations.push(keys));

    // No invalidation yet: the controller sends it once the next connection
    // has made the subscription.
    assert.strictEqual(invalidations.length, 0);

    await vi.advanceTimersByTimeAsync(1000);
    await settleTimers();

    assert.strictEqual(invalidations.length, 1);
    assert.deepStrictEqual(sortKeys(invalidations[0] ?? []), sortKeys(buildQueryKeys("task", [])));
  });

  it("invalidates everything once for a subscriber that subscribed while the connection was open", async () => {
    // A screen opened while connected reads over HTTP and then subscribes. A
    // change made between that read and the subscription is pushed to nobody,
    // so the controller's first push on the subscription makes the screen
    // read again. An assistant's Conversation, opened from the sidebar, is
    // such a screen.
    const { fetch } = stubTicketServer();
    const { live: started, socket } = await startConnectedSupervisor(fetch);

    const invalidations: Array<ReadonlyArray<LiveQueryKey>> = [];
    started.subscribe("conversation", (keys) => invalidations.push(keys));
    await settleTimers();

    assert.strictEqual(invalidations.length, 1);
    assert.deepStrictEqual(
      sortKeys(invalidations[0] ?? []),
      sortKeys(buildQueryKeys("conversation", [])),
    );
    // The subscription was made on the open connection, not on a new one.
    assert.strictEqual(opened.length, 1);
    assert.strictEqual(socket.calls("subscribe").length, 1);
  });

  it("drops a rejected cursor, resubscribes from the head and tells the handler", async () => {
    const { fetch } = stubTicketServer();
    const { live: started, socket } = await startConnectedSupervisor(fetch);

    const deltas: Array<LiveDelta> = [];
    started.subscribe("event", (delta) => deltas.push(delta));
    await settleTimers();

    const first = socket.calls("subscribe")[0];
    socket.chunk(first?.id, [{ _tag: "delta", cursor: "7", items: [] }]);
    await settleTimers();
    const seenBefore = deltas.length;

    socket.drop();
    await vi.advanceTimersByTimeAsync(1000);
    await settleTimers();

    const reopened = readLastSocket();
    const withCursor = reopened.calls("subscribe")[0];
    assert.deepStrictEqual(withCursor?.payload, { topic: "event", cursor: "7" });

    reopened.fail(withCursor?.id, validationFailure);
    await settleTimers();

    // The cursor was dropped, so the subscription starts again from the head.
    const retry = reopened.calls("subscribe")[1];
    assert.isDefined(retry);
    assert.deepStrictEqual(retry?.payload, { topic: "event" });

    // And the handler is told, so a screen showing the log refetches its page
    // rather than keeping a gap it cannot see.
    const afterRefusal = deltas.slice(seenBefore);
    assert.isTrue(
      afterRefusal.some((delta) => delta.reset),
      "the handler was never told the position was lost",
    );

    reopened.chunk(retry?.id, [{ _tag: "delta", cursor: "11", items: [buildEvent(11)] }]);
    await settleTimers();

    const last = deltas[deltas.length - 1];
    assert.strictEqual(last?.cursor, "11");
    assert.deepStrictEqual(last?.items, [buildEvent(11)]);
    assert.strictEqual(last?.reset, false);
  });

  it("starts an append-only subscription from a cursor the caller already holds, not from the head", async () => {
    // A caller that fetched a page over HTTP before subscribing has already
    // read up to some position. Starting from the head would miss whatever
    // was written between that fetch and this call.
    const { fetch } = stubTicketServer();
    const { live: started, socket } = await startConnectedSupervisor(fetch);

    started.subscribe("event", () => {}, "41");
    await settleTimers();

    const call = socket.calls("subscribe")[0];
    assert.deepStrictEqual(call?.payload, { topic: "event", cursor: "41" });
  });

  it("tells an append-only subscriber its topic is gone and stops retrying it, leaving the connection and other subscriptions untouched", async () => {
    const { fetch } = stubTicketServer();
    const { live: started, socket } = await startConnectedSupervisor(fetch);

    const streamDeltas: Array<LiveDelta> = [];
    const invalidations: Array<ReadonlyArray<LiveQueryKey>> = [];
    started.subscribe("session:s_gone:stream", (delta) => streamDeltas.push(delta));
    started.subscribe("task", (keys) => invalidations.push(keys));
    await settleTimers();

    const streamCall = socket
      .calls("subscribe")
      .find((call) =>
        call.payload === undefined
          ? false
          : (call.payload as { topic: string }).topic === "session:s_gone:stream",
      );
    assert.isDefined(streamCall);
    socket.fail(streamCall?.id, notFoundFailure);
    await settleTimers();

    assert.isTrue(
      streamDeltas.some((delta) => delta.gone),
      "the handler was never told the topic was gone",
    );

    // Nothing retries it: there is no second `subscribe` call for that topic,
    // even after the backoff that a temporary error would wait for.
    await vi.advanceTimersByTimeAsync(30_000);
    await settleTimers();
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
    await settleTimers();
    assert.isTrue(invalidations.length > 0, "the unrelated subscription stopped receiving pushes");
  });

  it("waits before resubscribing a subscriber that hit a cap, and then invalidates everything once", async () => {
    const { fetch } = stubTicketServer();
    const { live: started, socket } = await startConnectedSupervisor(fetch);

    const invalidations: Array<ReadonlyArray<LiveQueryKey>> = [];
    started.subscribe("task", (keys) => invalidations.push(keys));
    await settleTimers();
    const beforeCap = invalidations.length;

    const first = socket.calls("subscribe")[0];
    socket.fail(first?.id, capFailure);
    await settleTimers();

    // A subscriber that fell behind once will fall behind again, so
    // resubscribing as fast as the errors arrive would flood the controller.
    assert.strictEqual(socket.calls("subscribe").length, 1);
    assert.strictEqual(invalidations.length, beforeCap);
    await vi.advanceTimersByTimeAsync(1000);
    await settleTimers();
    assert.strictEqual(socket.calls("subscribe").length, 2);

    // There is no way to know what was dropped. The controller's first push
    // on the new subscription invalidates every key of the topic, as after a
    // reconnect. It comes after the wait, so the refetch also sees what
    // changed during it.
    assert.strictEqual(invalidations.length, beforeCap + 1);
    assert.deepStrictEqual(
      sortKeys(invalidations[beforeCap] ?? []),
      sortKeys(buildQueryKeys("task", [])),
    );
  });

  it("marks the first delta of each subscription made with a cursor as the replay", async () => {
    const { fetch } = stubTicketServer();
    const { live: started, socket } = await startConnectedSupervisor(fetch);

    const deltas: Array<LiveDelta> = [];
    started.subscribe("event", (delta) => deltas.push(delta), "41");
    await settleTimers();

    const call = socket.calls("subscribe")[0];
    socket.chunk(call?.id, [{ _tag: "delta", cursor: "42", items: [buildEvent(42)] }]);
    socket.chunk(call?.id, [{ _tag: "delta", cursor: "43", items: [buildEvent(43)] }]);
    await settleTimers();
    assert.deepStrictEqual(
      deltas.map((delta) => delta.replay),
      [true, false],
    );

    socket.drop();
    await vi.advanceTimersByTimeAsync(1000);
    await settleTimers();

    // The subscription is made again from the last cursor, and its first
    // delta is again the replay, even when nothing was written in between.
    const reopened = readLastSocket();
    const again = reopened.calls("subscribe")[0];
    assert.deepStrictEqual(again?.payload, { topic: "event", cursor: "43" });
    reopened.chunk(again?.id, [{ _tag: "delta", cursor: "43", items: [] }]);
    await settleTimers();
    assert.deepStrictEqual(deltas.at(-1), {
      cursor: "43",
      items: [],
      reset: false,
      replay: true,
      gone: false,
    });
  });

  it("tells a tap subscriber to reset each time its subscription starts again, and marks no tap as a replay", async () => {
    // A tap is never stored, so the taps sent while it was not subscribed
    // cannot be replayed. Its subscriber has to learn that it missed some.
    const { fetch } = stubTicketServer();
    const started = createSupervisor(fetch);
    const deltas: Array<LiveDelta> = [];
    started.subscribe("session:s1:tap", (delta) => deltas.push(delta));

    // The first connection: the tap was not subscribed before it either.
    started.start();
    await settleTimers();
    const socket = readLastSocket();
    assert.deepStrictEqual(
      deltas.map((delta) => delta.reset),
      [true],
    );

    const tap = {
      turnId: "t1",
      itemId: "a1",
      streamKind: "assistant_text" as const,
      delta: "Hi",
    };
    const first = socket.calls("subscribe")[0];
    socket.chunk(first?.id, [{ _tag: "delta", items: [tap] }]);
    await settleTimers();
    assert.deepStrictEqual(deltas.at(-1), {
      cursor: null,
      items: [tap],
      reset: false,
      replay: false,
      gone: false,
    });

    // A subscription the controller ended is made again after a wait, and
    // the subscriber is told just before that.
    socket.fail(first?.id, capFailure);
    await settleTimers();
    assert.strictEqual(deltas.length, 2);
    await vi.advanceTimersByTimeAsync(1000);
    await settleTimers();
    assert.strictEqual(socket.calls("subscribe").length, 2);
    assert.strictEqual(deltas.at(-1)?.reset, true);

    // And after a reconnect.
    socket.drop();
    await vi.advanceTimersByTimeAsync(1000);
    await settleTimers();
    assert.strictEqual(readLastSocket().calls("subscribe").length, 1);
    assert.deepStrictEqual(
      deltas.map((delta) => delta.reset),
      [true, false, true, true],
    );
  });

  it("closes the socket and reconnects when a subscription fails with unauthenticated", async () => {
    const { fetch } = stubTicketServer();
    const { live: started, socket } = await startConnectedSupervisor(fetch);

    started.subscribe("task", () => undefined);
    await settleTimers();

    socket.fail(socket.calls("subscribe")[0]?.id, unauthenticatedFailure);
    await settleTimers();

    assert.isNotNull(socket.closedWith);
    assert.strictEqual(opened.length, 1);

    await vi.advanceTimersByTimeAsync(1000);
    await settleTimers();

    // The new connection finds out whether the credential is still valid: its
    // ticket fetch is the request that would be rejected.
    assert.strictEqual(opened.length, 2);
    assert.strictEqual(readLastSocket().calls("hello").length, 1);
  });

  it("keeps retrying a rejected subscription without closing the connection", async () => {
    const { fetch } = stubTicketServer();
    const { live: started, socket } = await startConnectedSupervisor(fetch);

    started.subscribe("event", () => undefined);
    await settleTimers();

    // The wait grows, so an error that keeps repeating costs a couple of
    // frames a minute rather than a flood.
    for (const [attempt, delay] of [1000, 2000, 4000].entries()) {
      socket.fail(socket.calls("subscribe")[attempt]?.id, forbiddenFailure);
      await settleTimers();
      assert.strictEqual(
        socket.calls("subscribe").length,
        attempt + 1,
        `resubscribed before waiting ${delay} ms`,
      );

      await vi.advanceTimersByTimeAsync(delay);
      await settleTimers();
      assert.strictEqual(socket.calls("subscribe").length, attempt + 2);
    }

    // One failing subscription is not a problem for the connection, and the
    // other subscriptions keep working.
    assert.strictEqual(opened.length, 1);
    assert.isNull(socket.closedWith);
  });

  it("ends a subscription the caller unsubscribes, and delivers nothing more to it", async () => {
    const { fetch } = stubTicketServer();
    const { live: started, socket } = await startConnectedSupervisor(fetch);

    const invalidations: Array<ReadonlyArray<LiveQueryKey>> = [];
    const off = started.subscribe("task", (keys) => invalidations.push(keys));
    await settleTimers();
    const beforeOff = invalidations.length;

    const call = socket.calls("subscribe")[0];
    off();
    await settleTimers();

    assert.isTrue(socket.frames("Interrupt").some((frame) => frame.requestId === call?.id));

    socket.chunk(call?.id, [{ _tag: "invalidate", ids: ["task-1"], kind: "created" }]);
    await settleTimers();
    assert.strictEqual(invalidations.length, beforeOff);
  });
});

describe("buildQueryKeys", () => {
  it("maps a task push to the list prefix and one detail key per id", () => {
    assert.deepStrictEqual(buildQueryKeys("task", ["a", "b"]), [
      ["tasks"],
      ["task", "a"],
      ["task", "b"],
    ]);

    // The same key builders the task queries use.
    assert.deepStrictEqual(buildQueryKeys("task", ["a"]), [queryKeys.tasks(), queryKeys.task("a")]);
  });

  it("covers every record of the topic when no id is named", () => {
    assert.deepStrictEqual(buildQueryKeys("task", []), [["tasks"], ["task"]]);
  });

  it("maps a runner push to the runner list and the page of each runner in it", () => {
    assert.deepStrictEqual(buildQueryKeys("runner", ["r1", "r2"]), [
      ["runners"],
      ["runner", "r1"],
      ["runner", "r2"],
    ]);

    // The same key builders the fleet and runner page queries use.
    assert.deepStrictEqual(buildQueryKeys("runner", ["r1"]), [
      queryKeys.runners(),
      queryKeys.runner("r1"),
    ]);

    // A push with no ids means any runner may have changed.
    assert.deepStrictEqual(buildQueryKeys("runner", []), [["runners"], ["runner"]]);
  });

  it("maps a workflow push to the workflow list, and the page and triggers of each workflow in it", () => {
    assert.deepStrictEqual(buildQueryKeys("workflow", ["w1", "w2"]), [
      queryKeys.workflows(),
      queryKeys.workflow("w1"),
      queryKeys.workflow("w2"),
      queryKeys.triggers("w1"),
      queryKeys.triggers("w2"),
    ]);

    // A push with no ids means any workflow may have changed.
    assert.deepStrictEqual(buildQueryKeys("workflow", []), [
      ["workflows"],
      ["workflow"],
      ["triggers"],
    ]);
  });

  it("maps a run push to every run list and the page of each run in it", () => {
    assert.deepStrictEqual(buildQueryKeys("run", ["r1", "r2"]), [
      queryKeys.runs(),
      queryKeys.run("r1"),
      queryKeys.run("r2"),
    ]);

    // A push with no ids means any run may have changed.
    assert.deepStrictEqual(buildQueryKeys("run", []), [["runs"], ["run"]]);
  });

  it("maps a session push to the session list, each session's page, and each session's queued-input list", () => {
    assert.deepStrictEqual(buildQueryKeys("session", ["s1"], { s1: null }), [
      queryKeys.sessions(),
      queryKeys.session("s1"),
      queryKeys.inputs("s1"),
    ]);

    // A push with no ids means any session may have changed, including each
    // conversation's current session.
    assert.deepStrictEqual(buildQueryKeys("session", []), [
      queryKeys.sessions(),
      queryKeys.session(),
      queryKeys.inputs(),
      queryKeys.conversationSession(),
    ]);
  });

  it("keys the thread list under the prefix a session push invalidates", () => {
    const threads = queryKeys.sessions({ thread: true });

    assert.deepStrictEqual(threads, ["sessions", { thread: true }]);
    // A query client matches an invalidated key as a prefix of a cached one.
    const [listPrefix] = buildQueryKeys("session", ["s1"]);
    assert.deepStrictEqual(threads.slice(0, listPrefix?.length), listPrefix);
  });

  it("maps a subagent push to the subagent lists of the sessions it names", () => {
    assert.deepStrictEqual(buildQueryKeys("subagent", ["s1", "s2"]), [
      queryKeys.subagents("s1"),
      queryKeys.subagents("s2"),
    ]);

    // A push with no ids means any session's subagents may have changed.
    assert.deepStrictEqual(buildQueryKeys("subagent", []), [["subagents"]]);
  });

  it("keys each agent's transcript of a session apart, under the session's prefix", () => {
    const own = queryKeys.transcript("s1");
    const subagent = queryKeys.transcript("s1", "agent-1");

    assert.deepStrictEqual(own, ["transcript", "s1", null]);
    assert.deepStrictEqual(subagent, ["transcript", "s1", "agent-1"]);
  });

  it("maps an assistant push to the assistant list and the page of each assistant in it", () => {
    assert.deepStrictEqual(buildQueryKeys("assistant", ["a1"]), [
      queryKeys.assistants(),
      queryKeys.assistant("a1"),
    ]);
  });

  it("maps a conversation push to the conversation list prefix, and each conversation and its messages", () => {
    assert.deepStrictEqual(buildQueryKeys("conversation", ["c1"]), [
      queryKeys.conversations(),
      queryKeys.conversation("c1"),
      queryKeys.conversationMessages("c1"),
    ]);
    // The list key is the prefix of every filtered conversation list, such as
    // one assistant's conversations, so one invalidation reaches them all.
    assert.deepStrictEqual(queryKeys.conversations(), ["conversations"]);
  });
});
