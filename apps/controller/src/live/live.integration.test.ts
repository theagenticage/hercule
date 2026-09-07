/**
 * The live socket against the real controller: how a connection is opened, what
 * it is allowed to ask for, and what the controller keeps hold of afterwards.
 *
 * This drives a real WebSocket against a real listener with a real RPC client
 * built from the published contract group, because the whole point of the
 * socket is the wire. A hand-rolled frame would only re-test the RPC codec.
 *
 * Four things matter here and nothing else does yet. A connection is nobody
 * until `hello` succeeds, and a ticket is spent the moment it does, so a stolen
 * or replayed one buys nothing. The vocabulary the socket accepts is closed: an
 * unknown Live Topic and a cursor on a mutable one are both refused, because the
 * client that sent them has a bug and silence would hide it. Every refusal
 * arrives as one of the contract's own errors and leaves the connection up, so a
 * client that mis-asks once can go on working. And a subscription the client
 * lets go of leaves nothing behind on the controller.
 *
 * What a subscription then carries is here too: a mutable topic's
 * invalidations, which name the changed records and nothing else, and the
 * `event` log's deltas, which carry the records themselves with the cursor a
 * reconnecting client replays from. Both are driven by ordinary HTTP calls
 * against the same controller, because a push that does not agree with what
 * `GET /tasks` and `GET /events` answer is worse than no push at all.
 *
 * And a connection is not trusted for ever: the credential behind it can be
 * revoked, the log it reads needs the grant reading the log needs, a subscriber
 * that stops reading is ended rather than buffered without bound, and the
 * greeting happens once.
 */
import { describe, expect, it } from "vitest";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import {
  CapExceeded,
  InvalidState,
  live,
  MUTABLE_LIVE_TOPICS,
  Unauthenticated,
  Validation,
  type Delta,
  type Event,
  type LiveMessage,
  type Task,
} from "@hydra/contract";
import { PROTOCOL_VERSION, type JoinAnswer, type RunnerFacts } from "@hydra/protocol";
import {
  collecting,
  completeSetup,
  del,
  expectHeld,
  get,
  liveConnection,
  onSocket,
  post,
  send,
  socketUrl,
  ticketFor,
  withServer,
  within,
  type Collected,
  type LiveClient,
} from "../http/testing";

/**
 * Whether the listener will upgrade a plain dial of the socket at all. A dial
 * that neither opens nor errors answers "hung", so a handler that stops
 * answering reads as a failed assertion rather than as a timed-out suite.
 */
const dial = (base: string): Promise<"open" | "refused" | "hung"> =>
  new Promise((resolve) => {
    const socket = new WebSocket(socketUrl(base));
    socket.onopen = () => {
      socket.close();
      resolve("open");
    };
    socket.onerror = () => resolve("refused");
    setTimeout(() => resolve("hung"), 2000);
  });

/** Runs a subscription to its first item, which is all a refusal needs. */
const firstItem = (client: LiveClient, payload: { topic: string; cursor?: string }) =>
  Stream.runHead(client.subscribe(payload));

/**
 * What a call answered with, refusal or not, and never later than `limit`.
 *
 * A call the controller ought to refuse but does not would, flipped, throw its
 * own success as a defect and say nothing about what happened; and one that is
 * meant to fail but instead waits for a push that never comes would hang out
 * the whole suite. Both read here as a value the assertion can name.
 */
const answer = <A, E>(
  effect: Effect.Effect<A, E>,
  limit: Duration.Input = "2 seconds",
): Effect.Effect<unknown> =>
  Effect.match(Effect.timeout(effect, limit), {
    onSuccess: (value): unknown => value,
    onFailure: (error): unknown => error,
  });

/** The value, asserted present, so a test reads past an index without a cast. */
const present = <T>(value: T | undefined): T => {
  expect(value).toBeDefined();
  return value as T;
};

/** The deltas a collector saw, which is every message on an append-only topic. */
const deltas = (collected: Collected): ReadonlyArray<Delta> =>
  collected.received.filter((message): message is Delta => message._tag === "delta");

const createTask = async (base: string, token: string, title: string): Promise<Task> => {
  const response = await post(base, "/api/v1/tasks", { title, description: "" }, token);
  expect(response.status).toBe(200);
  return (await response.json()) as Task;
};

const updateTask = async (base: string, token: string, id: string): Promise<void> => {
  const response = await send("PATCH", base, `/api/v1/tasks/${id}`, {
    body: { status: "done" },
    token,
  });
  expect(response.status).toBe(200);
};

const deleteTask = async (base: string, token: string, id: string): Promise<void> => {
  const response = await del(base, `/api/v1/tasks/${id}`, token);
  expect(response.status).toBe(200);
};

/** The log as `GET /events` answers it, oldest first. */
const logEvents = async (base: string, token: string): Promise<ReadonlyArray<Event>> => {
  const response = await get(base, "/api/v1/events?sort=id:asc&limit=500", token);
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Event> }).items;
};

/** One entry of the log, read back the way any other client reads it. */
const readEvent = async (base: string, token: string, id: number): Promise<Event> => {
  const response = await get(base, `/api/v1/events/${String(id)}`, token);
  expect(response.status).toBe(200);
  return (await response.json()) as Event;
};

describe("opening a live connection", () => {
  it("is not there at all until Hydra is set up", async () => {
    await withServer(async ({ base }) => {
      // Nothing on the socket is reachable before the password exists - a
      // ticket needs a credential, and there is no user to hold one - so the
      // controller refuses the upgrade rather than holding the connection.
      expect(await dial(base)).toBe("refused");
      await completeSetup(base);
      expect(await dial(base)).toBe("open");
    });
  });

  it("greets a ticket holder with the version the API answers with", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const identity = await get(base, "/api/v1/controller", token);
      expect(identity.status).toBe(200);
      const { version } = (await identity.json()) as { version: string };
      const ticket = await ticketFor(base, token);

      // The handshake carries nothing: no header, no query string, no ticket in
      // the URL. The credential rides in the first frame instead.
      expect(socketUrl(base)).not.toContain(ticket);
      expect(new URL(socketUrl(base)).search).toBe("");

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          const hello = yield* client.hello({ v: 1, ticket });
          expect(hello).toEqual({ v: 1, serverVersion: version });
        }),
      );
    });
  });

  it("spends the ticket on the first hello, so a replay of it is nobody", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.map(client.hello({ v: 1, ticket }), (hello) => {
          expect(hello.v).toBe(1);
        }),
      );

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(client.hello({ v: 1, ticket }));
          expect(failure).toBeInstanceOf(Unauthenticated);
          expect((failure as Unauthenticated).error.code).toBe("unauthenticated");
        }),
      );
    });
  });

  it("refuses a ticket that was never issued", async () => {
    await withServer(async ({ base }) => {
      await completeSetup(base);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            client.hello({ v: 1, ticket: "not-a-ticket-anybody-issued" }),
          );
          expect(failure).toBeInstanceOf(Unauthenticated);
          expect((failure as Unauthenticated).error.code).toBe("unauthenticated");
        }),
      );
    });
  });

  it("greets one connection and leaves the others where they were", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (greeted) =>
        Effect.gen(function* () {
          yield* greeted.hello({ v: 1, ticket });

          // A second socket, opened while the first one is authenticated, is
          // still nobody: the greeting belongs to a connection, not to the
          // controller.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stranger = yield* RpcClient.make(live);
              expect(yield* Effect.flip(stranger.ping({}))).toBeInstanceOf(Unauthenticated);
            }).pipe(Effect.provide(liveConnection(base))),
          );

          expect(yield* greeted.ping({})).toEqual({});
        }),
      );
    });
  });

  it("refuses a protocol version it does not speak", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          for (const v of [0, 2, 1.5]) {
            const failure = yield* Effect.flip(client.hello({ v, ticket }));
            expect(failure, String(v)).toBeInstanceOf(Validation);
            expect((failure as Validation).error.code).toBe("validation");
          }
        }),
      );
    });
  });

  it("answers nothing before hello: neither a ping nor a subscription", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          const ping = yield* Effect.flip(client.ping({}));
          expect(ping).toBeInstanceOf(Unauthenticated);

          const subscription = yield* Effect.flip(firstItem(client, { topic: "task" }));
          expect(subscription).toBeInstanceOf(Unauthenticated);

          // And the connection was never the problem: the same one works once
          // the ticket has been presented.
          yield* client.hello({ v: 1, ticket });
          expect(yield* client.ping({})).toEqual({});
        }),
      );
    });
  });
});

describe("the keepalive", () => {
  it("answers a ping on a connection past hello", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          expect(yield* client.ping({})).toEqual({});
          expect(yield* client.ping({})).toEqual({});
        }),
      );
    });
  });
});

describe("what a subscription may ask for", () => {
  it("refuses a topic that is not a Live Topic", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          for (const topic of ["project", "tasks", "", "TASK"]) {
            const failure = yield* Effect.flip(firstItem(client, { topic }));
            expect(failure, topic).toBeInstanceOf(Validation);
            expect((failure as Validation).error.code).toBe("validation");
          }
        }),
      );
    });
  });

  it("refuses a cursor on a mutable topic, which has nothing to replay", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const failure = yield* Effect.flip(firstItem(client, { topic: "task", cursor: "1" }));
          expect(failure).toBeInstanceOf(Validation);
          expect((failure as Validation).error.code).toBe("validation");
        }),
      );
    });
  });

  it("keeps the connection up after a refusal, so a client can ask again", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });

          const refused = yield* Effect.flip(firstItem(client, { topic: "nonsense" }));
          expect(refused).toBeInstanceOf(Validation);

          // The same connection: a ping still answers, and a good subscription
          // is accepted and held.
          expect(yield* client.ping({})).toEqual({});
          const held = yield* Effect.forkChild(
            Stream.runDrain(client.subscribe({ topic: "task" })),
          );
          yield* Effect.promise(() => expectHeld(reader, 1));
          yield* Fiber.interrupt(held);
        }),
      );
    });
  });
});

describe("letting a subscription go", () => {
  it("drops it when the client ends the stream", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          yield* Effect.promise(() => expectHeld(reader, 0));

          const held = yield* Effect.forkChild(
            Stream.runDrain(client.subscribe({ topic: "task" })),
          );
          yield* Effect.promise(() => expectHeld(reader, 1));

          yield* Fiber.interrupt(held);
          yield* Effect.promise(() => expectHeld(reader, 0));
        }),
      );
    });
  });

  it("drops it when the socket closes without the client saying anything", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          yield* Effect.forkChild(Stream.runDrain(client.subscribe({ topic: "task" })));
          yield* Effect.promise(() => expectHeld(reader, 1));
        }),
      );

      // The scope closed the socket. Nothing is held for a connection that is
      // gone, whether or not it unsubscribed first.
      await expectHeld(reader, 0);
    });
  });
});

describe("what a task subscription is told", () => {
  it("names the task on a create, an update and a delete, and tells no other topic", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const tasks = yield* collecting(client, { topic: "task" });
          const runs = yield* collecting(client, { topic: "run" });
          yield* Effect.promise(() => expectHeld(reader, 1, "task"));
          yield* Effect.promise(() => expectHeld(reader, 1, "run"));

          const task = yield* Effect.promise(() => createTask(base, token, "watched"));
          expect(yield* Effect.promise(() => within(200, () => tasks.received.length >= 1))).toBe(
            true,
          );
          expect(tasks.received[0]).toEqual({
            _tag: "invalidate",
            ids: [task.id],
            kind: "created",
          });

          yield* Effect.promise(() => updateTask(base, token, task.id));
          expect(yield* Effect.promise(() => within(200, () => tasks.received.length >= 2))).toBe(
            true,
          );
          expect(tasks.received[1]).toEqual({
            _tag: "invalidate",
            ids: [task.id],
            kind: "updated",
          });

          yield* Effect.promise(() => deleteTask(base, token, task.id));
          expect(yield* Effect.promise(() => within(200, () => tasks.received.length >= 3))).toBe(
            true,
          );
          expect(tasks.received[2]).toEqual({
            _tag: "invalidate",
            ids: [task.id],
            kind: "deleted",
          });

          // A topic nothing happened on hears nothing: an invalidation is not
          // a broadcast.
          expect(runs.received).toEqual([]);

          yield* Fiber.interrupt(tasks.fiber);
          yield* Fiber.interrupt(runs.fiber);
        }),
      );
    });
  });

  it("coalesces a burst into one message per kind, naming each id once", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const tasks = yield* collecting(client, { topic: "task" });
          yield* Effect.promise(() => expectHeld(reader, 1, "task"));

          const created = yield* Effect.promise(() =>
            Promise.all([
              createTask(base, token, "one"),
              createTask(base, token, "two"),
              createTask(base, token, "three"),
            ]),
          );
          const doomed = present(created[0]);
          yield* Effect.promise(() => deleteTask(base, token, doomed.id));

          // Two messages and no more: the window holds a create and a delete,
          // and each kind is announced once.
          expect(yield* Effect.promise(() => within(1000, () => tasks.received.length >= 2))).toBe(
            true,
          );
          yield* Effect.promise(() => within(200, () => tasks.received.length >= 3));
          expect(tasks.received).toHaveLength(2);

          const creates = tasks.received.filter(
            (message) => message._tag === "invalidate" && message.kind === "created",
          );
          const deletes = tasks.received.filter(
            (message) => message._tag === "invalidate" && message.kind === "deleted",
          );
          expect(creates).toHaveLength(1);
          expect(deletes).toHaveLength(1);

          const createdIds = (creates[0] as { ids: ReadonlyArray<string> }).ids;
          expect([...createdIds].sort()).toEqual([...created.map((task) => task.id)].sort());
          expect((deletes[0] as { ids: ReadonlyArray<string> }).ids).toEqual([doomed.id]);

          // No message repeats an id, whatever the window swept up.
          for (const message of tasks.received) {
            const ids = (message as { ids: ReadonlyArray<string> }).ids;
            expect(new Set(ids).size).toBe(ids.length);
          }

          yield* Fiber.interrupt(tasks.fiber);
        }),
      );
    });
  });
});

describe("what an event subscription is told", () => {
  it("opens at the head of the log and pushes what is appended after it", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);
      const before = await logEvents(base, token);
      const head = present(before[before.length - 1]);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const events = yield* collecting(client, { topic: "event" });

          // The first item positions the client and hands it nothing: a
          // subscriber with no cursor is asking for what happens next.
          expect(yield* Effect.promise(() => within(1000, () => events.received.length >= 1))).toBe(
            true,
          );
          expect(events.received[0]).toEqual({
            _tag: "delta",
            cursor: String(head.id),
            items: [],
          });

          yield* Effect.promise(() => createTask(base, token, "a task the log records"));
          expect(yield* Effect.promise(() => within(1000, () => events.received.length >= 2))).toBe(
            true,
          );

          const pushed = present(deltas(events)[1]);
          expect(pushed.items).toHaveLength(1);
          const item = present(pushed.items[0]);
          expect(item.kind).toBe("task.created");
          expect(pushed.cursor).toBe(String(item.id));

          // The record on the socket is the record over HTTP, field for field.
          expect(item).toEqual(yield* Effect.promise(() => readEvent(base, token, item.id)));

          yield* Fiber.interrupt(events.fiber);
        }),
      );
    });
  });

  it("replays from a cursor, hands back nothing at the head, and refuses a cursor that is not one", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      for (const title of ["one", "two", "three", "four", "five"]) {
        await createTask(base, token, title);
      }
      const ticket = await ticketFor(base, token);
      const log = await logEvents(base, token);
      expect(log.length).toBeGreaterThanOrEqual(5);
      const from = present(log[log.length - 3]);
      const missed = log.slice(log.length - 2);
      const newest = present(log[log.length - 1]);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });

          const replay = yield* collecting(client, { topic: "event", cursor: String(from.id) });
          expect(yield* Effect.promise(() => within(1000, () => replay.received.length >= 1))).toBe(
            true,
          );
          const caught = present(deltas(replay)[0]);
          expect(caught.items.map((item) => item.id)).toEqual(missed.map((item) => item.id));
          expect(caught.cursor).toBe(String(newest.id));
          yield* Fiber.interrupt(replay.fiber);

          // A client already at the head has missed nothing, and is told so
          // rather than told the log again.
          const current = yield* collecting(client, { topic: "event", cursor: String(newest.id) });
          expect(
            yield* Effect.promise(() => within(1000, () => current.received.length >= 1)),
          ).toBe(true);
          expect(current.received[0]).toEqual({
            _tag: "delta",
            cursor: String(newest.id),
            items: [],
          });
          yield* Fiber.interrupt(current.fiber);

          const refused = yield* answer(
            firstItem(client, { topic: "event", cursor: "the day before yesterday" }),
          );
          expect(refused).toBeInstanceOf(Validation);
          expect((refused as Validation).error.code).toBe("validation");
        }),
      );
    });
  });

  it("reads the log for a credential that may read the log, and needs no grant for the mutable topics", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });

          const events = yield* collecting(client, { topic: "event" });
          expect(yield* Effect.promise(() => within(1000, () => events.received.length >= 1))).toBe(
            true,
          );
          expect(present(events.received[0])._tag).toBe("delta");
          yield* Fiber.interrupt(events.fiber);

          // The eight mutable topics carry no records, so being greeted is the
          // whole of what they ask for: each one is accepted and held.
          for (const topic of MUTABLE_LIVE_TOPICS) {
            const held = yield* collecting(client, { topic });
            yield* Effect.promise(() => expectHeld(reader, 1, topic));
            yield* Fiber.interrupt(held.fiber);
            yield* Effect.promise(() => expectHeld(reader, 0, topic));
          }
        }),
      );
    });
  });

  it("ends a subscriber that stops reading rather than queueing for it without bound", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });

          // A subscriber that crawls: it takes a delta and then spends long
          // enough on it that the controller cannot hand it the next thousand.
          const seen: Array<Delta> = [];
          const slow = yield* Effect.forkChild(
            Stream.runForEach(client.subscribe({ topic: "event" }), (message) =>
              Effect.gen(function* () {
                if (message._tag === "delta") seen.push(message);
                yield* Effect.sleep("5 millis");
              }),
            ),
          );
          yield* Effect.promise(() => expectHeld(reader, 1, "event"));

          // Past the cap of a thousand queued deltas, and by enough that the
          // crawl cannot be what saved it.
          yield* Effect.promise(async () => {
            for (let batch = 0; batch < 45; batch++) {
              await Promise.all(
                Array.from({ length: 50 }, (_, index) =>
                  createTask(base, token, `flood ${String(batch)}-${String(index)}`),
                ),
              );
            }
          });

          const failure = yield* answer(Fiber.join(slow), "20 seconds");
          expect(failure).toBeInstanceOf(CapExceeded);
          expect((failure as CapExceeded).error.code).toBe("cap_exceeded");
          expect((failure as CapExceeded).error.details).toMatchObject({ cap: 1000 });

          // The controller is holding nothing for it any more.
          yield* Effect.promise(() => expectHeld(reader, 0, "event"));

          // And the client can come back where it left off: what it missed is
          // still the log, replayed from its last cursor.
          const last = present(seen[seen.length - 1]);
          const again = yield* collecting(client, { topic: "event", cursor: last.cursor });
          expect(yield* Effect.promise(() => within(2000, () => again.received.length >= 1))).toBe(
            true,
          );
          const replayed = present(deltas(again)[0]);
          expect(replayed.items[0]?.id).toBe(Number(last.cursor) + 1);
          yield* Fiber.interrupt(again.fiber);
        }),
      );
    });
  }, 120_000);
});

describe("a connection whose credential is gone", () => {
  it("stops answering a login bearer that logged out, and pushes nothing more", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);
      // A second credential, so the test can still write once the first one is
      // revoked. It is never the connection's; the connection is the bearer's.
      const minted = await post(base, "/api/v1/api-keys", { name: "a writing key" }, token);
      expect(minted.status).toBe(200);
      const other = ((await minted.json()) as { token: string }).token;

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const tasks = yield* collecting(client, { topic: "task" });
          yield* Effect.promise(() => expectHeld(reader, 1, "task"));

          const loggedOut = yield* Effect.promise(() =>
            post(base, "/api/v1/auth/logout", {}, token),
          );
          expect(loggedOut.status).toBe(200);

          const refused = yield* answer(client.ping({}));
          expect(refused).toBeInstanceOf(Unauthenticated);
          expect((refused as Unauthenticated).error.code).toBe("unauthenticated");

          // The connection is closed, not merely refused once: nothing on it
          // answers afterwards.
          expect(yield* Effect.exit(client.ping({}))).toMatchObject({ _tag: "Failure" });

          // And what it was subscribed to reaches it no more. The mutation
          // needs a live credential of its own, which is what the key is for.
          const before = tasks.received.length;
          yield* Effect.promise(() => createTask(base, other, "after the logout"));
          yield* Effect.promise(() => within(500, () => tasks.received.length > before));
          expect(tasks.received).toHaveLength(before);
        }),
      );
    });
  });

  it("stops answering an API key that was revoked", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const minted = await post(base, "/api/v1/api-keys", { name: "a socket key" }, token);
      expect(minted.status).toBe(200);
      const key = (await minted.json()) as { id: string; token: string };
      const ticket = await ticketFor(base, key.token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          expect(yield* client.ping({})).toEqual({});

          const revoked = yield* Effect.promise(() =>
            del(base, `/api/v1/api-keys/${key.id}`, token),
          );
          expect(revoked.status).toBe(200);

          const refused = yield* answer(client.ping({}));
          expect(refused).toBeInstanceOf(Unauthenticated);
          expect((refused as Unauthenticated).error.code).toBe("unauthenticated");
        }),
      );
    });
  });
});

describe("what a connection may hold", () => {
  it("refuses a ticket whose credential was revoked before it was spent", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);
      // The ticket is good for five minutes, which is five minutes longer than
      // the credential that fetched it is guaranteed to last.
      expect((await post(base, "/api/v1/auth/logout", {}, token)).status).toBe(200);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          const refused = yield* answer(client.hello({ v: 1, ticket }));
          expect(refused).toBeInstanceOf(Unauthenticated);
        }),
      );
    });
  });

  it("refuses a position the log has not reached, rather than watching nothing", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);
      const log = await logEvents(base, token);
      const beyond = String(present(log[log.length - 1]).id + 1000);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const refused = yield* answer(firstItem(client, { topic: "event", cursor: beyond }));
          expect(refused).toBeInstanceOf(Validation);
          yield* Effect.promise(() => expectHeld(reader, 0, "event"));

          // The client is told, and is still there to be told: it can drop the
          // cursor it was holding and follow the log from where it is now.
          expect(yield* client.ping({})).toEqual({});
          const followed = yield* collecting(client, { topic: "event" });
          expect(
            yield* Effect.promise(() => within(1000, () => followed.received.length >= 1)),
          ).toBe(true);
          expect(present(followed.received[0])._tag).toBe("delta");
          yield* Fiber.interrupt(followed.fiber);
        }),
      );
    });
  });
});

describe("greeting a connection twice", () => {
  it("refuses the second hello and leaves the connection as it was", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);
      const second = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const tasks = yield* collecting(client, { topic: "task" });
          yield* Effect.promise(() => expectHeld(reader, 1, "task"));

          const refused = yield* answer(client.hello({ v: 1, ticket: second }));
          expect(refused).toBeInstanceOf(InvalidState);
          expect((refused as InvalidState).error.code).toBe("invalid_state");

          // The connection kept everything it had: it still answers, and what
          // it was watching still reaches it.
          expect(yield* client.ping({})).toEqual({});
          yield* Effect.promise(() => expectHeld(reader, 1, "task"));
          const task = yield* Effect.promise(() => createTask(base, token, "still watched"));
          expect(yield* Effect.promise(() => within(1000, () => tasks.received.length >= 1))).toBe(
            true,
          );
          expect(tasks.received[0]).toEqual({
            _tag: "invalidate",
            ids: [task.id],
            kind: "created",
          });

          yield* Fiber.interrupt(tasks.fiber);
        }),
      );
    });
  });
});

describe("what a runner subscription is told", () => {
  /** What a runner in this test says about the machine it is on. */
  const FACTS: RunnerFacts = {
    os: "darwin",
    arch: "arm64",
    totalMemoryBytes: 68719476736,
    docker: false,
    toolchains: [{ name: "git", version: "2.50.1", path: "/usr/bin/git" }],
    providers: [],
    adapters: ["claude-code"],
    identityPort: 4939,
  };

  /** Enlists a machine the way one enlists: a minted token, spent on the join. */
  const enlist = async (harness: {
    readonly base: string;
    readonly joinToken: () => Promise<string>;
  }): Promise<JoinAnswer> => {
    const response = await send("POST", harness.base, "/api/v1/runners/join", {
      body: {},
      token: await harness.joinToken(),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as JoinAnswer;
  };

  /**
   * A machine's end of the runner socket, open and greeted. Only what a runner
   * says is needed here: what the controller answers is the socket suite's
   * business, and what matters on this one is that the row's changes reach a
   * watching client.
   */
  const machine = async (
    base: string,
    credential: string,
  ): Promise<{ say: (message: unknown) => void; close: () => void }> => {
    const socket = new WebSocket(`${base.replace(/^http:/, "ws:")}/api/v1/runners/socket`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("the controller refused the runner's upgrade"));
      setTimeout(() => reject(new Error("the controller never upgraded the runner")), 3000);
    });
    return {
      say: (message) => socket.send(JSON.stringify(message)),
      close: () => socket.close(),
    };
  };

  /** The ids one invalidation named, whatever kind it was. */
  const named = (message: LiveMessage): ReadonlyArray<string> =>
    message._tag === "invalidate" ? message.ids : [];

  it("names the runner when it joins, comes online, reports facts and is patched", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const fleet = yield* collecting(client, { topic: "runner" });
          const tasks = yield* collecting(client, { topic: "task" });
          yield* Effect.promise(() => expectHeld(harness.live, 1, "runner"));
          yield* Effect.promise(() => expectHeld(harness.live, 1, "task"));

          // A machine enlisting is a runner appearing in the fleet.
          const joined = yield* Effect.promise(() => enlist(harness));
          expect(yield* Effect.promise(() => within(1000, () => fleet.received.length >= 1))).toBe(
            true,
          );
          expect(fleet.received[0]).toEqual({
            _tag: "invalidate",
            ids: [joined.runnerId],
            kind: "created",
          });

          const runner = yield* Effect.promise(() => machine(base, joined.credential));
          runner.say({
            _tag: "runnerHello",
            protocolVersion: PROTOCOL_VERSION,
            capabilities: [],
            binaryVersion: "0.1.0",
            nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
            facts: FACTS,
          });

          // The row is online now, which is a change a fleet screen has to see.
          expect(yield* Effect.promise(() => within(2000, () => fleet.received.length >= 2))).toBe(
            true,
          );
          expect(named(present(fleet.received[1]))).toContain(joined.runnerId);

          const seenBeforeFacts = fleet.received.length;
          runner.say({
            _tag: "factsReport",
            facts: { ...FACTS, docker: true, totalMemoryBytes: 137438953472 },
          });
          expect(
            yield* Effect.promise(() =>
              within(2000, () => fleet.received.length > seenBeforeFacts),
            ),
            "a facts report reaches the subscriber",
          ).toBe(true);
          expect(named(present(fleet.received[seenBeforeFacts]))).toContain(joined.runnerId);

          const seenBeforePatch = fleet.received.length;
          const patched = yield* Effect.promise(() =>
            send("PATCH", base, `/api/v1/runners/${joined.runnerId}`, {
              body: { name: "moss" },
              token,
            }),
          );
          expect(patched.status).toBe(200);
          expect(
            yield* Effect.promise(() =>
              within(2000, () => fleet.received.length > seenBeforePatch),
            ),
            "a patch reaches the subscriber",
          ).toBe(true);
          expect(named(present(fleet.received[seenBeforePatch]))).toContain(joined.runnerId);

          // A topic none of this happened on hears nothing.
          expect(tasks.received).toEqual([]);

          runner.close();
          yield* Fiber.interrupt(fleet.fiber);
          yield* Fiber.interrupt(tasks.fiber);
        }),
      );
    });
  });
  it("tells a watcher about a hello that changed nothing but the row", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const fleet = yield* collecting(client, { topic: "runner" });
          yield* Effect.promise(() => expectHeld(harness.live, 1, "runner"));

          const joined = yield* Effect.promise(() => enlist(harness));
          const greet = (say: (message: unknown) => void, version: string) =>
            say({
              _tag: "runnerHello",
              protocolVersion: PROTOCOL_VERSION,
              capabilities: [],
              binaryVersion: version,
              nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
              facts: FACTS,
            });

          const runner = yield* Effect.promise(() => machine(base, joined.credential));
          greet(runner.say, "0.1.0");
          expect(yield* Effect.promise(() => within(2000, () => fleet.received.length >= 2))).toBe(
            true,
          );

          // A machine that dials again inside the silence window never left
          // `online`, so nothing about its state changed - but its hello
          // rewrote the version and the facts the row shows.
          const second = yield* Effect.promise(() => machine(base, joined.credential));
          const seenBefore = fleet.received.length;
          greet(second.say, "0.2.0");
          expect(
            yield* Effect.promise(() => within(2000, () => fleet.received.length > seenBefore)),
            "a hello on a row already online reaches the subscriber",
          ).toBe(true);
          expect(named(present(fleet.received[seenBefore]))).toContain(joined.runnerId);

          second.close();
          runner.close();
          yield* Fiber.interrupt(fleet.fiber);
        }),
      );
    });
  });
});
