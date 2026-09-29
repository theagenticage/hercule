/**
 * Tests the live socket against the real controller: how a connection is
 * opened, what it may ask for, and what the controller keeps afterwards.
 *
 * The tests use a real WebSocket, a real listener and a real RPC client built
 * from the published contract group, because the socket is tested on the
 * wire. Hand-written frames would only test the RPC codec again.
 *
 * The tests check four things about connections:
 *
 * - A connection has no actor until `hello` succeeds, and the ticket is used
 *   up at that moment, so a stolen or replayed ticket is useless.
 * - The socket accepts a fixed set of values: an unknown Live Topic and a
 *   cursor on a mutable topic both fail, because the client that sent them
 *   has a bug, and ignoring it would hide the bug.
 * - Every error is one of the contract's errors and leaves the connection
 *   open, so a client that makes one bad request can keep working.
 * - A subscription the client closes leaves nothing behind on the
 *   controller.
 *
 * They also check what a subscription receives: a mutable topic's
 * invalidations, which name the changed records and nothing else, and the
 * `event` log's deltas, which carry the records themselves, with the cursor a
 * reconnecting client replays from. Both are triggered by ordinary HTTP calls
 * to the same controller, because a push that disagrees with `GET /tasks` or
 * `GET /events` is worse than no push at all.
 *
 * Finally, a connection is not trusted forever: its credential can be
 * revoked, reading the log needs the same grant as over HTTP, a subscriber
 * that stops reading is ended rather than buffered without limit, and `hello`
 * works only once.
 */
import { describe, expect, it } from "vitest";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import {
  CapExceeded,
  DESKTOP_APP_ORIGIN,
  InvalidState,
  live,
  MUTABLE_LIVE_TOPICS,
  NotFound,
  Unauthenticated,
  Validation,
  type Assistant,
  type Conversation,
  type Delta,
  type Event,
  type LiveMessage,
  type Task,
  type TapItem,
  type TranscriptRow,
} from "@hercule/contract";
import {
  PROTOCOL_VERSION,
  type JoinAnswer,
  type RunnerFacts,
  type SessionStart,
} from "@hercule/protocol";
import type { Plugin } from "@hercule/plugin-host";
import { createPluginFixture, buildProviderDefinition } from "../plugins/testing";
import {
  collectMessages,
  completeSetup,
  del,
  expectHeld,
  get,
  buildLiveConnection,
  onSocket,
  post,
  send,
  buildSocketUrl,
  fetchTicket,
  withServer,
  waitForLiveToSettle,
  waitWithin,
  type Collected,
  type LiveClient,
  type ServerHarness,
} from "../http/testing";
import {
  waitForFrames,
  reportEvent,
  spawnSessionOrFail,
  waitUntil,
  withAgentFleet,
  withFleet,
  type Arranged,
} from "../sessions/testing";

/**
 * Checks whether the listener upgrades a plain connection to the socket at
 * all. A connection that neither opens nor errors returns "hung", so a handler
 * that stops responding shows up as a failed assertion rather than a timed-out
 * suite. With `origin`, the upgrade request carries that `Origin` header, as a
 * page's would.
 */
const dial = (base: string, origin?: string): Promise<"open" | "refused" | "hung"> =>
  new Promise((resolve) => {
    const socket = new WebSocket(
      buildSocketUrl(base),
      origin === undefined ? undefined : { headers: { origin } },
    );
    socket.onopen = () => {
      socket.close();
      resolve("open");
    };
    socket.onerror = () => resolve("refused");
    setTimeout(() => resolve("hung"), 2000);
  });

/** Runs a subscription until its first item, which is enough to see an error. */
const readFirstItem = (client: LiveClient, payload: { topic: string; cursor?: string }) =>
  Stream.runHead(client.subscribe(payload));

/**
 * Returns the result of a call, success or error, waiting at most `limit`.
 *
 * With `Effect.flip`, a call that should fail but succeeds would throw its
 * success as a defect, which says nothing useful. And a call that should fail
 * but instead waits for a push that never comes would hang the whole suite.
 * Here both become a value the assertion can show.
 */
const awaitOutcome = <A, E>(
  effect: Effect.Effect<A, E>,
  limit: Duration.Input = "2 seconds",
): Effect.Effect<unknown> =>
  Effect.match(Effect.timeout(effect, limit), {
    onSuccess: (value): unknown => value,
    onFailure: (error): unknown => error,
  });

/** Asserts that a value is present and returns it, so a test can use an indexed value without a cast. */
const expectPresent = <T>(value: T | undefined): T => {
  expect(value).toBeDefined();
  return value as T;
};

/** Returns the deltas a collector received, which is every message on an append-only topic. */
const listDeltas = (collected: Collected): ReadonlyArray<Delta> =>
  collected.received.filter((message): message is Delta => message._tag === "delta");

/**
 * Returns a delta's items as `Event`s: the only item type in `Delta` with a
 * numeric `id`, which is how the three types are told apart. A topic only
 * ever carries one of them.
 */
const listEventItems = (delta: Delta): ReadonlyArray<Event> =>
  delta.items.filter((item): item is Event => "id" in item);

/** Returns a delta's items as `TranscriptRow`s: the only item type with `position`. */
const listTranscriptItems = (delta: Delta): ReadonlyArray<TranscriptRow> =>
  delta.items.filter((item): item is TranscriptRow => "position" in item);

/** Returns a delta's items as `TapItem`s: the only item type with `streamKind`. */
const listTapItems = (delta: Delta): ReadonlyArray<TapItem> =>
  delta.items.filter((item): item is TapItem => "streamKind" in item);

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

/** Lists the log as `GET /events` returns it, oldest first. */
const listLogEvents = async (base: string, token: string): Promise<ReadonlyArray<Event>> => {
  const response = await get(base, "/api/v1/events?sort=id:asc&limit=500", token);
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Event> }).items;
};

/** Reads one log entry through the API, as any other client does. */
const readEvent = async (base: string, token: string, id: number): Promise<Event> => {
  const response = await get(base, `/api/v1/events/${String(id)}`, token);
  expect(response.status).toBe(200);
  return (await response.json()) as Event;
};

describe("opening a live connection", () => {
  it("is not available at all until Hercule is set up", async () => {
    await withServer(async ({ base }) => {
      // Nothing on the socket is reachable before the password exists: a
      // ticket needs a credential, and there is no user to have one. So the
      // controller rejects the upgrade rather than keeping the connection.
      expect(await dial(base)).toBe("refused");
      await completeSetup(base);
      expect(await dial(base)).toBe("open");
    });
  });

  it("accepts an upgrade from the desktop app's origin, which it does not check", async () => {
    await withServer(async ({ base }) => {
      await completeSetup(base);
      // The socket checks no origin: the credential is the ticket, sent in
      // the first frame, and a ticket needs the bearer token, which a page
      // on another origin does not have.
      expect(await dial(base, DESKTOP_APP_ORIGIN)).toBe("open");
    });
  });

  it("accepts hello with a ticket, and returns the same version as the API", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const identity = await get(base, "/api/v1/controller", token);
      expect(identity.status).toBe(200);
      const { version } = (await identity.json()) as { version: string };
      const ticket = await fetchTicket(base, token);

      // The handshake carries nothing: no header, no query string, no ticket
      // in the URL. The credential is sent in the first frame instead.
      expect(buildSocketUrl(base)).not.toContain(ticket);
      expect(new URL(buildSocketUrl(base)).search).toBe("");

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          const hello = yield* client.hello({ v: 1, ticket });
          expect(hello).toEqual({ v: 1, serverVersion: version });
        }),
      );
    });
  });

  it("uses up the ticket on the first hello, so replaying it fails", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);

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

  it("rejects a ticket that was never issued", async () => {
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

  it("authenticates only the connection that said hello", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (greeted) =>
        Effect.gen(function* () {
          yield* greeted.hello({ v: 1, ticket });

          // A second socket, opened while the first one is authenticated, has
          // no actor: a hello belongs to a connection, not to the controller.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stranger = yield* RpcClient.make(live);
              expect(yield* Effect.flip(stranger.ping({}))).toBeInstanceOf(Unauthenticated);
            }).pipe(Effect.provide(buildLiveConnection(base))),
          );

          expect(yield* greeted.ping({})).toEqual({});
        }),
      );
    });
  });

  it("rejects a protocol version it does not support", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);

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

  it("rejects every call before hello, both a ping and a subscription", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          const ping = yield* Effect.flip(client.ping({}));
          expect(ping).toBeInstanceOf(Unauthenticated);

          const subscription = yield* Effect.flip(readFirstItem(client, { topic: "task" }));
          expect(subscription).toBeInstanceOf(Unauthenticated);

          // The connection itself was never the problem: the same one works
          // once the ticket has been sent.
          yield* client.hello({ v: 1, ticket });
          expect(yield* client.ping({})).toEqual({});
        }),
      );
    });
  });
});

describe("the keepalive", () => {
  it("answers a ping on a connection after hello", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);

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
  it("rejects a topic that is not a Live Topic", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          for (const topic of ["project", "tasks", "", "TASK"]) {
            const failure = yield* Effect.flip(readFirstItem(client, { topic }));
            expect(failure, topic).toBeInstanceOf(Validation);
            expect((failure as Validation).error.code).toBe("validation");
          }
        }),
      );
    });
  });

  it("rejects a cursor on a mutable topic, which has nothing to replay", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const failure = yield* Effect.flip(readFirstItem(client, { topic: "task", cursor: "1" }));
          expect(failure).toBeInstanceOf(Validation);
          expect((failure as Validation).error.code).toBe("validation");
        }),
      );
    });
  });

  it("keeps the connection open after an error, so a client can try again", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });

          const refused = yield* Effect.flip(readFirstItem(client, { topic: "nonsense" }));
          expect(refused).toBeInstanceOf(Validation);

          // The same connection: a ping still works, and a valid subscription
          // is accepted and kept.
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

describe("closing a subscription", () => {
  it("removes it when the client ends the stream", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);

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

  it("removes it when the socket closes without the client unsubscribing", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          yield* Effect.forkChild(Stream.runDrain(client.subscribe({ topic: "task" })));
          yield* Effect.promise(() => expectHeld(reader, 1));
        }),
      );

      // The scope closed the socket. Nothing is kept for a closed connection,
      // whether or not it unsubscribed first.
      await expectHeld(reader, 0);
    });
  });
});

describe("what a task subscription receives", () => {
  it("names the task on a create, an update and a delete, and notifies no other topic", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const tasks = yield* collectMessages(client, { topic: "task" });
          const runs = yield* collectMessages(client, { topic: "run" });
          yield* Effect.promise(() => expectHeld(reader, 1, "task"));
          yield* Effect.promise(() => expectHeld(reader, 1, "run"));

          const task = yield* Effect.promise(() => createTask(base, token, "watched"));
          expect(
            yield* Effect.promise(() => waitWithin(200, () => tasks.received.length >= 1)),
          ).toBe(true);
          expect(tasks.received[0]).toEqual({
            _tag: "invalidate",
            ids: [task.id],
            kind: "created",
          });

          yield* Effect.promise(() => updateTask(base, token, task.id));
          expect(
            yield* Effect.promise(() => waitWithin(200, () => tasks.received.length >= 2)),
          ).toBe(true);
          expect(tasks.received[1]).toEqual({
            _tag: "invalidate",
            ids: [task.id],
            kind: "updated",
          });

          yield* Effect.promise(() => deleteTask(base, token, task.id));
          expect(
            yield* Effect.promise(() => waitWithin(200, () => tasks.received.length >= 3)),
          ).toBe(true);
          expect(tasks.received[2]).toEqual({
            _tag: "invalidate",
            ids: [task.id],
            kind: "deleted",
          });

          // A topic with no changes receives nothing: an invalidation is not a
          // broadcast.
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
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const tasks = yield* collectMessages(client, { topic: "task" });
          yield* Effect.promise(() => expectHeld(reader, 1, "task"));

          const created = yield* Effect.promise(() =>
            Promise.all([
              createTask(base, token, "one"),
              createTask(base, token, "two"),
              createTask(base, token, "three"),
            ]),
          );
          const doomed = expectPresent(created[0]);
          yield* Effect.promise(() => deleteTask(base, token, doomed.id));

          // Two messages and no more: the window holds three creates and a
          // delete, and each kind is sent once.
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => tasks.received.length >= 2)),
          ).toBe(true);
          yield* Effect.promise(() => waitWithin(200, () => tasks.received.length >= 3));
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

          // No message repeats an id, whatever the window collected.
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

/** Creates an assistant with only a name, and fails the test unless the create succeeds. */
const createAssistant = async (base: string, token: string, name: string): Promise<Assistant> => {
  const response = await post(base, "/api/v1/assistants", { name }, token);
  expect(response.ok, await response.clone().text()).toBe(true);
  return (await response.json()) as Assistant;
};

/** Returns the web conversation of an assistant. */
const readWebConversation = async (
  base: string,
  token: string,
  assistantId: string,
): Promise<Conversation> => {
  const response = await get(base, `/api/v1/conversations?assistantId=${assistantId}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  const found = ((await response.json()) as { items: ReadonlyArray<Conversation> }).items.find(
    (one) => one.channel === "web",
  );
  return expectPresent(found);
};

describe("what an assistant subscription receives", () => {
  it("names the assistant once on a create, an update and a delete", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      // Setup creates the default assistant; its nudge must not count here.
      await waitForLiveToSettle();
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const assistants = yield* collectMessages(client, { topic: "assistant" });
          yield* Effect.promise(() => expectHeld(reader, 1, "assistant"));

          const assistant = yield* Effect.promise(() => createAssistant(base, token, "Ada"));
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => assistants.received.length >= 1)),
          ).toBe(true);
          yield* Effect.promise(() => waitForLiveToSettle());

          const updated = yield* Effect.promise(() =>
            send("PATCH", base, `/api/v1/assistants/${assistant.id}`, {
              body: { name: "Bea" },
              token,
            }),
          );
          expect(updated.status).toBe(200);
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => assistants.received.length >= 2)),
          ).toBe(true);
          yield* Effect.promise(() => waitForLiveToSettle());

          const deleted = yield* Effect.promise(() =>
            del(base, `/api/v1/assistants/${assistant.id}`, token),
          );
          expect(deleted.status).toBe(200);
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => assistants.received.length >= 3)),
          ).toBe(true);
          yield* Effect.promise(() => waitWithin(200, () => assistants.received.length >= 4));

          expect(assistants.received).toEqual([
            { _tag: "invalidate", ids: [assistant.id], kind: "created" },
            { _tag: "invalidate", ids: [assistant.id], kind: "updated" },
            { _tag: "invalidate", ids: [assistant.id], kind: "deleted" },
          ]);

          yield* Fiber.interrupt(assistants.fiber);
        }),
      );
    });
  });
});

describe("what a conversation subscription receives", () => {
  it("names the conversation once when its assistant is created and once when it is deleted", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      await waitForLiveToSettle();
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const conversations = yield* collectMessages(client, { topic: "conversation" });
          yield* Effect.promise(() => expectHeld(reader, 1, "conversation"));

          const assistant = yield* Effect.promise(() => createAssistant(base, token, "Ada"));
          const conversation = yield* Effect.promise(() =>
            readWebConversation(base, token, assistant.id),
          );
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => conversations.received.length >= 1)),
          ).toBe(true);
          yield* Effect.promise(() => waitForLiveToSettle());

          const deleted = yield* Effect.promise(() =>
            del(base, `/api/v1/assistants/${assistant.id}`, token),
          );
          expect(deleted.status).toBe(200);
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => conversations.received.length >= 2)),
          ).toBe(true);
          yield* Effect.promise(() => waitWithin(200, () => conversations.received.length >= 3));

          expect(conversations.received).toEqual([
            { _tag: "invalidate", ids: [conversation.id], kind: "created" },
            { _tag: "invalidate", ids: [conversation.id], kind: "deleted" },
          ]);

          yield* Fiber.interrupt(conversations.fiber);
        }),
      );
    });
  });

  it("names the conversation once when a message is stored in it", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const token = arranged.token;
      const listed = await get(base, "/api/v1/assistants", token);
      const [assistant] = ((await listed.json()) as { items: ReadonlyArray<Assistant> }).items;
      const conversation = await readWebConversation(base, token, expectPresent(assistant).id);
      await waitForLiveToSettle();
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const conversations = yield* collectMessages(client, { topic: "conversation" });
          yield* Effect.promise(() => expectHeld(arranged.harness.live, 1, "conversation"));

          const sent = yield* Effect.promise(() =>
            post(base, `/api/v1/conversations/${conversation.id}/messages`, { text: "hi" }, token),
          );
          expect(sent.status, yield* Effect.promise(() => sent.clone().text())).toBe(200);
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => conversations.received.length >= 1)),
          ).toBe(true);
          yield* Effect.promise(() => waitWithin(200, () => conversations.received.length >= 2));

          // The spec names the conversation's id for a stored message, not
          // which kind of change it is.
          expect(conversations.received).toHaveLength(1);
          expect(conversations.received[0]).toMatchObject({
            _tag: "invalidate",
            ids: [conversation.id],
          });

          yield* Fiber.interrupt(conversations.fiber);
        }),
      );
    });
  });
});

describe("what an event subscription receives", () => {
  it("starts at the end of the log and pushes what is appended after it", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);
      const before = await listLogEvents(base, token);
      const head = expectPresent(before[before.length - 1]);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const events = yield* collectMessages(client, { topic: "event" });

          // The first message sets the client's position and has no items: a
          // subscriber without a cursor wants only what happens next.
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => events.received.length >= 1)),
          ).toBe(true);
          expect(events.received[0]).toEqual({
            _tag: "delta",
            cursor: String(head.id),
            items: [],
          });

          yield* Effect.promise(() => createTask(base, token, "a task the log records"));
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => events.received.length >= 2)),
          ).toBe(true);

          const pushed = expectPresent(listDeltas(events)[1]);
          expect(pushed.items).toHaveLength(1);
          const item = expectPresent(listEventItems(pushed)[0]);
          expect(item.kind).toBe("task.created");
          expect(pushed.cursor).toBe(String(item.id));

          // The record on the socket matches the record over HTTP, field for
          // field.
          expect(item).toEqual(yield* Effect.promise(() => readEvent(base, token, item.id)));

          yield* Fiber.interrupt(events.fiber);
        }),
      );
    });
  });

  it("replays from a cursor, returns nothing at the end of the log, and rejects an invalid cursor", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      for (const title of ["one", "two", "three", "four", "five"]) {
        await createTask(base, token, title);
      }
      const ticket = await fetchTicket(base, token);
      const log = await listLogEvents(base, token);
      expect(log.length).toBeGreaterThanOrEqual(5);
      const from = expectPresent(log[log.length - 3]);
      const missed = log.slice(log.length - 2);
      const newest = expectPresent(log[log.length - 1]);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });

          const replay = yield* collectMessages(client, {
            topic: "event",
            cursor: String(from.id),
          });
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => replay.received.length >= 1)),
          ).toBe(true);
          const caught = expectPresent(listDeltas(replay)[0]);
          expect(listEventItems(caught).map((item) => item.id)).toEqual(
            missed.map((item) => item.id),
          );
          expect(caught.cursor).toBe(String(newest.id));
          yield* Fiber.interrupt(replay.fiber);

          // A client already at the end has missed nothing, and gets an empty
          // replay rather than the log again.
          const current = yield* collectMessages(client, {
            topic: "event",
            cursor: String(newest.id),
          });
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => current.received.length >= 1)),
          ).toBe(true);
          expect(current.received[0]).toEqual({
            _tag: "delta",
            cursor: String(newest.id),
            items: [],
          });
          yield* Fiber.interrupt(current.fiber);

          const refused = yield* awaitOutcome(
            readFirstItem(client, { topic: "event", cursor: "the day before yesterday" }),
          );
          expect(refused).toBeInstanceOf(Validation);
          expect((refused as Validation).error.code).toBe("validation");
        }),
      );
    });
  });

  it("needs the log-reading grant for the event topic, and no grant for the mutable topics", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });

          const events = yield* collectMessages(client, { topic: "event" });
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => events.received.length >= 1)),
          ).toBe(true);
          expect(expectPresent(events.received[0])._tag).toBe("delta");
          yield* Fiber.interrupt(events.fiber);

          // The eight mutable topics carry no records, so a successful hello is
          // all they need: each one is accepted and kept.
          for (const topic of MUTABLE_LIVE_TOPICS) {
            const held = yield* collectMessages(client, { topic });
            yield* Effect.promise(() => expectHeld(reader, 1, topic));
            yield* Fiber.interrupt(held.fiber);
            yield* Effect.promise(() => expectHeld(reader, 0, topic));
          }
        }),
      );
    });
  });

  it("ends a subscriber that stops reading rather than queueing for it without limit", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });

          // A very slow subscriber: it takes a delta and then spends so long on
          // it that the controller cannot deliver the next thousand.
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

          // Well past the limit of a thousand queued deltas, by enough that the
          // slow reads cannot keep the queue under it.
          yield* Effect.promise(async () => {
            for (let batch = 0; batch < 45; batch++) {
              await Promise.all(
                Array.from({ length: 50 }, (_, index) =>
                  createTask(base, token, `flood ${String(batch)}-${String(index)}`),
                ),
              );
            }
          });

          const failure = yield* awaitOutcome(Fiber.join(slow), "20 seconds");
          expect(failure).toBeInstanceOf(CapExceeded);
          expect((failure as CapExceeded).error.code).toBe("cap_exceeded");
          expect((failure as CapExceeded).error.details).toMatchObject({ cap: 1000 });

          // The controller no longer keeps anything for it.
          yield* Effect.promise(() => expectHeld(reader, 0, "event"));

          // And the client can resume where it left off: what it missed is
          // still in the log, replayed from its last cursor.
          const last = expectPresent(seen[seen.length - 1]);
          const again = yield* collectMessages(client, {
            topic: "event",
            cursor: expectPresent(last.cursor),
          });
          expect(
            yield* Effect.promise(() => waitWithin(2000, () => again.received.length >= 1)),
          ).toBe(true);
          const replayed = expectPresent(listDeltas(again)[0]);
          expect(listEventItems(replayed)[0]?.id).toBe(Number(last.cursor) + 1);
          yield* Fiber.interrupt(again.fiber);
        }),
      );
    });
  }, 120_000);
});

describe("a connection whose credential is gone", () => {
  it("stops responding to a login token that logged out, and pushes nothing more", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);
      // A second credential, so the test can still write after the first one
      // is revoked. The connection uses only the login token.
      const minted = await post(base, "/api/v1/api-keys", { name: "a writing key" }, token);
      expect(minted.status).toBe(200);
      const other = ((await minted.json()) as { token: string }).token;

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const tasks = yield* collectMessages(client, { topic: "task" });
          yield* Effect.promise(() => expectHeld(reader, 1, "task"));

          const loggedOut = yield* Effect.promise(() =>
            post(base, "/api/v1/auth/logout", {}, token),
          );
          expect(loggedOut.status).toBe(200);

          const refused = yield* awaitOutcome(client.ping({}));
          expect(refused).toBeInstanceOf(Unauthenticated);
          expect((refused as Unauthenticated).error.code).toBe("unauthenticated");

          // The connection is closed, not just one call rejected: nothing on it
          // works afterwards.
          expect(yield* Effect.exit(client.ping({}))).toMatchObject({ _tag: "Failure" });

          // And its subscriptions no longer reach it. The change below needs a
          // valid credential of its own, which is what the key is for.
          const before = tasks.received.length;
          yield* Effect.promise(() => createTask(base, other, "after the logout"));
          yield* Effect.promise(() => waitWithin(500, () => tasks.received.length > before));
          expect(tasks.received).toHaveLength(before);
        }),
      );
    });
  });

  it("stops responding to an API key that was revoked", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const minted = await post(base, "/api/v1/api-keys", { name: "a socket key" }, token);
      expect(minted.status).toBe(200);
      const key = (await minted.json()) as { id: string; token: string };
      const ticket = await fetchTicket(base, key.token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          expect(yield* client.ping({})).toEqual({});

          const revoked = yield* Effect.promise(() =>
            del(base, `/api/v1/api-keys/${key.id}`, token),
          );
          expect(revoked.status).toBe(200);

          const refused = yield* awaitOutcome(client.ping({}));
          expect(refused).toBeInstanceOf(Unauthenticated);
          expect((refused as Unauthenticated).error.code).toBe("unauthenticated");
        }),
      );
    });
  });
});

describe("what a connection may hold", () => {
  it("rejects a ticket whose credential was revoked before it was used", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);
      // The ticket is valid for five minutes, but the credential that fetched
      // it is not guaranteed to last that long.
      expect((await post(base, "/api/v1/auth/logout", {}, token)).status).toBe(200);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          const refused = yield* awaitOutcome(client.hello({ v: 1, ticket }));
          expect(refused).toBeInstanceOf(Unauthenticated);
        }),
      );
    });
  });

  it("rejects a cursor past the end of the log, rather than subscribing to nothing", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);
      const log = await listLogEvents(base, token);
      const beyond = String(expectPresent(log[log.length - 1]).id + 1000);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const refused = yield* awaitOutcome(
            readFirstItem(client, { topic: "event", cursor: beyond }),
          );
          expect(refused).toBeInstanceOf(Validation);
          yield* Effect.promise(() => expectHeld(reader, 0, "event"));

          // The client gets an error and stays connected: it can drop its
          // cursor and follow the log from where it is now.
          expect(yield* client.ping({})).toEqual({});
          const followed = yield* collectMessages(client, { topic: "event" });
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => followed.received.length >= 1)),
          ).toBe(true);
          expect(expectPresent(followed.received[0])._tag).toBe("delta");
          yield* Fiber.interrupt(followed.fiber);
        }),
      );
    });
  });
});

describe("saying hello twice on one connection", () => {
  it("rejects the second hello and leaves the connection as it was", async () => {
    await withServer(async ({ base, live: reader }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);
      const second = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const tasks = yield* collectMessages(client, { topic: "task" });
          yield* Effect.promise(() => expectHeld(reader, 1, "task"));

          const refused = yield* awaitOutcome(client.hello({ v: 1, ticket: second }));
          expect(refused).toBeInstanceOf(InvalidState);
          expect((refused as InvalidState).error.code).toBe("invalid_state");

          // The connection kept everything: it still responds, and its
          // subscriptions still reach it.
          expect(yield* client.ping({})).toEqual({});
          yield* Effect.promise(() => expectHeld(reader, 1, "task"));
          const task = yield* Effect.promise(() => createTask(base, token, "still watched"));
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => tasks.received.length >= 1)),
          ).toBe(true);
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

describe("what a runner subscription receives", () => {
  /** The facts the runner in this test reports about its machine. */
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

  /** Joins a runner the normal way: mints a join token and uses it to join. */
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
   * Opens the runner's end of the runner socket and says hello. Only what the
   * runner sends matters here: the controller's replies are tested in the
   * runner socket suite, and this suite checks that changes to the runner row
   * reach a watching client.
   */
  const connectMachine = async (
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

  /** Returns the ids one invalidation named, whatever its kind. */
  const listInvalidatedIds = (message: LiveMessage): ReadonlyArray<string> =>
    message._tag === "invalidate" ? message.ids : [];

  it("names the runner when it joins, comes online, reports facts and is patched", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const fleet = yield* collectMessages(client, { topic: "runner" });
          const tasks = yield* collectMessages(client, { topic: "task" });
          yield* Effect.promise(() => expectHeld(harness.live, 1, "runner"));
          yield* Effect.promise(() => expectHeld(harness.live, 1, "task"));

          // A runner joining is a runner appearing in the fleet.
          const joined = yield* Effect.promise(() => enlist(harness));
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => fleet.received.length >= 1)),
          ).toBe(true);
          expect(fleet.received[0]).toEqual({
            _tag: "invalidate",
            ids: [joined.runnerId],
            kind: "created",
          });

          const runner = yield* Effect.promise(() => connectMachine(base, joined.credential));
          runner.say({
            _tag: "runnerHello",
            protocolVersion: PROTOCOL_VERSION,
            capabilities: [],
            binaryVersion: "0.1.0",
            nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
            facts: FACTS,
          });

          // The row is online now, which a fleet screen has to show.
          expect(
            yield* Effect.promise(() => waitWithin(2000, () => fleet.received.length >= 2)),
          ).toBe(true);
          expect(listInvalidatedIds(expectPresent(fleet.received[1]))).toContain(joined.runnerId);

          const seenBeforeFacts = fleet.received.length;
          runner.say({
            _tag: "factsReport",
            facts: { ...FACTS, docker: true, totalMemoryBytes: 137438953472 },
          });
          expect(
            yield* Effect.promise(() =>
              waitWithin(2000, () => fleet.received.length > seenBeforeFacts),
            ),
            "a facts report reaches the subscriber",
          ).toBe(true);
          expect(listInvalidatedIds(expectPresent(fleet.received[seenBeforeFacts]))).toContain(
            joined.runnerId,
          );

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
              waitWithin(2000, () => fleet.received.length > seenBeforePatch),
            ),
            "a patch reaches the subscriber",
          ).toBe(true);
          expect(listInvalidatedIds(expectPresent(fleet.received[seenBeforePatch]))).toContain(
            joined.runnerId,
          );

          // A topic with none of these changes receives nothing.
          expect(tasks.received).toEqual([]);

          runner.close();
          yield* Fiber.interrupt(fleet.fiber);
          yield* Fiber.interrupt(tasks.fiber);
        }),
      );
    });
  });
  it("notifies a watcher about a hello that changed only the row's version and facts", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const fleet = yield* collectMessages(client, { topic: "runner" });
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

          const runner = yield* Effect.promise(() => connectMachine(base, joined.credential));
          greet(runner.say, "0.1.0");
          expect(
            yield* Effect.promise(() => waitWithin(2000, () => fleet.received.length >= 2)),
          ).toBe(true);

          // A runner that reconnects within the silence window never left
          // `online`, so its state did not change, but its hello rewrote the
          // version and facts the row shows.
          const second = yield* Effect.promise(() => connectMachine(base, joined.credential));
          const seenBefore = fleet.received.length;
          greet(second.say, "0.2.0");
          expect(
            yield* Effect.promise(() => waitWithin(2000, () => fleet.received.length > seenBefore)),
            "a hello on a row already online reaches the subscriber",
          ).toBe(true);
          expect(listInvalidatedIds(expectPresent(fleet.received[seenBefore]))).toContain(
            joined.runnerId,
          );

          second.close();
          runner.close();
          yield* Fiber.interrupt(fleet.fiber);
        }),
      );
    });
  });
});

/**
 * The smallest fleet that can spawn one session and write its transcript: one
 * provider, and one runner that answers hello and probes and sends nothing
 * else on its own. Placement, access modes and input are tested in
 * `sessions.integration.test.ts`. This suite only needs a session that exists
 * and a wire to report its events on, so its two live topics have something
 * to carry. The fleet helpers (`Wire`, `dial`, `withFleet`) are shared with
 * that suite; only the fixture is this suite's own.
 */
const SESSION_TOPIC_FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["session-topic-provider"],
  identityPort: 4939,
};

const SESSION_TOPIC_MODELS = [{ slug: "fast", name: "Fast", isDefault: true, options: [] }];

const buildSessionTopicPlugins = (): ReadonlyArray<Plugin> => [
  createPluginFixture({
    id: "session-topics",
    definitions: [buildProviderDefinition("session-topic-provider", { token: "t" })],
  }).plugin,
];

const withSessionTopicFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  withFleet(body, {
    plugins: buildSessionTopicPlugins(),
    facts: SESSION_TOPIC_FACTS,
    models: SESSION_TOPIC_MODELS,
  });

interface StreamRow {
  readonly position: number;
  readonly tag: string;
}

/** Reads one session's rows from `session_stream`, as the sessions suite does. */
const readStreamRows = (harness: ServerHarness, id: string): Promise<ReadonlyArray<StreamRow>> =>
  Effect.runPromise(
    Effect.orDie(
      harness.sql<StreamRow>`
        SELECT position, json_extract(event, '$._tag') AS tag
        FROM session_stream WHERE session_id = unhex(replace(${id}, '-', ''))
        ORDER BY position`,
    ),
  );

/** Waits until a session's stream holds at least this many rows. */
const waitForStreamRows = (
  harness: ServerHarness,
  id: string,
  count: number,
): Promise<ReadonlyArray<StreamRow>> =>
  waitUntil(`wrote ${String(count)} stream rows`, async () => {
    const rows = await readStreamRows(harness, id);
    return rows.length >= count ? rows : undefined;
  });

const AT = "2026-09-08T10:00:00.000Z";

describe("what a session's stream subscription receives", () => {
  it("starts at the empty end without a cursor, and pushes each later row as a TranscriptRow with its position as the cursor", async () => {
    await withSessionTopicFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      const ticket = await fetchTicket(arranged.harness.base, arranged.token);

      await onSocket(arranged.harness.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const stream = yield* collectMessages(client, { topic: `session:${session.id}:stream` });

          // No rows exist yet, so the first message sets the client's position
          // at the empty end and has no items, exactly as `event` does for a
          // subscriber without a cursor.
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => stream.received.length >= 1)),
          ).toBe(true);
          expect(stream.received[0]).toEqual({ _tag: "delta", cursor: "0", items: [] });

          reportEvent(arranged.wire, 1, {
            eventId: crypto.randomUUID(),
            sessionId: session.id,
            at: AT,
            _tag: "session.started",
          });
          expect(
            yield* Effect.promise(() => waitWithin(2000, () => stream.received.length >= 2)),
          ).toBe(true);
          const pushed = expectPresent(listDeltas(stream)[1]);
          const row = expectPresent(listTranscriptItems(pushed)[0]);
          expect(row.position).toBe(1);
          expect(row.event._tag).toBe("session.started");
          expect(pushed.cursor).toBe("1");

          reportEvent(arranged.wire, 2, {
            eventId: crypto.randomUUID(),
            sessionId: session.id,
            at: AT,
            _tag: "turn.started",
            turnId: "t1",
          });
          expect(
            yield* Effect.promise(() => waitWithin(2000, () => stream.received.length >= 3)),
          ).toBe(true);
          const second = expectPresent(listDeltas(stream)[2]);
          expect(expectPresent(listTranscriptItems(second)[0]).event._tag).toBe("turn.started");
          expect(second.cursor).toBe("2");

          yield* Fiber.interrupt(stream.fiber);
        }),
      );
    });
  });

  it("replays the rows after a cursor before following, the same as event does", async () => {
    await withSessionTopicFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);

      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at: AT,
        _tag: "session.started",
      });
      reportEvent(arranged.wire, 2, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at: AT,
        _tag: "turn.started",
        turnId: "t1",
      });
      const rows = await waitForStreamRows(arranged.harness, session.id, 2);
      expect(rows.map((row) => row.tag)).toEqual(["session.started", "turn.started"]);
      const from = expectPresent(rows[0]);
      const newest = expectPresent(rows[1]);

      const ticket = await fetchTicket(arranged.harness.base, arranged.token);
      await onSocket(arranged.harness.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const replay = yield* collectMessages(client, {
            topic: `session:${session.id}:stream`,
            cursor: String(from.position),
          });
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => replay.received.length >= 1)),
          ).toBe(true);
          const caught = expectPresent(listDeltas(replay)[0]);
          expect(listTranscriptItems(caught).map((item) => item.event._tag)).toEqual([
            "turn.started",
          ]);
          expect(caught.cursor).toBe(String(newest.position));
          yield* Fiber.interrupt(replay.fiber);
        }),
      );
    });
  });

  it("rejects a cursor past the end of the transcript, the same way event does", async () => {
    await withSessionTopicFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at: AT,
        _tag: "session.started",
      });
      await waitForStreamRows(arranged.harness, session.id, 1);

      const ticket = await fetchTicket(arranged.harness.base, arranged.token);
      await onSocket(arranged.harness.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const refused = yield* awaitOutcome(
            readFirstItem(client, { topic: `session:${session.id}:stream`, cursor: "1000" }),
          );
          expect(refused).toBeInstanceOf(Validation);
          expect((refused as Validation).error.code).toBe("validation");
        }),
      );
    });
  });

  it("fails with not_found for a session id that was never spawned", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);
      // A UUID v7, like a real session id, so this tests the sessions table
      // lookup. A `crypto.randomUUID()` v4 id would fail the format check
      // before reaching the lookup.
      const stranger = Bun.randomUUIDv7();

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const refused = yield* awaitOutcome(
            readFirstItem(client, { topic: `session:${stranger}:stream` }),
          );
          expect(refused).toBeInstanceOf(NotFound);
          expect((refused as NotFound).error.code).toBe("not_found");
        }),
      );
    });
  });
});

describe("what a session's tap subscription receives", () => {
  it("pushes a content delta as one TapItem before the row it eventually coalesces into exists", async () => {
    await withSessionTopicFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at: AT,
        _tag: "session.started",
      });
      await waitForStreamRows(arranged.harness, session.id, 1);

      const ticket = await fetchTicket(arranged.harness.base, arranged.token);
      await onSocket(arranged.harness.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const tap = yield* collectMessages(client, { topic: `session:${session.id}:tap` });
          yield* Effect.promise(() =>
            expectHeld(arranged.harness.live, 1, `session:${session.id}:tap`),
          );

          reportEvent(arranged.wire, 2, {
            eventId: crypto.randomUUID(),
            sessionId: session.id,
            at: AT,
            _tag: "content.delta",
            turnId: "t1",
            itemId: "i1",
            streamKind: "assistant_text",
            delta: "He",
          });

          expect(
            yield* Effect.promise(() => waitWithin(1000, () => tap.received.length >= 1)),
          ).toBe(true);
          expect(tap.received[0]).toEqual({
            _tag: "delta",
            items: [{ turnId: "t1", itemId: "i1", streamKind: "assistant_text", delta: "He" }],
          });

          // The delta is before the item boundary and under the 4KB flush, so
          // the coalescing rule in stream.ts has written nothing for it yet:
          // the row the tap item will end up in does not exist yet.
          expect(
            yield* Effect.promise(() => readStreamRows(arranged.harness, session.id)),
          ).toHaveLength(1);

          reportEvent(arranged.wire, 3, {
            eventId: crypto.randomUUID(),
            sessionId: session.id,
            at: AT,
            _tag: "item.completed",
            turnId: "t1",
            itemId: "i1",
            kind: "assistant_message",
            status: "completed",
          });
          const rows = yield* Effect.promise(() =>
            waitForStreamRows(arranged.harness, session.id, 2),
          );
          expect(rows[1]!.tag).toBe("content.delta");

          // The item boundary flushed the row, but that is not a tap itself:
          // the tap received the delta once, before the row was written.
          expect(tap.received).toHaveLength(1);

          yield* Fiber.interrupt(tap.fiber);
        }),
      );
    });
  });

  it("rejects a cursor on tap, which never replays", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);
      const stranger = crypto.randomUUID();

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const refused = yield* awaitOutcome(
            readFirstItem(client, { topic: `session:${stranger}:tap`, cursor: "1" }),
          );
          expect(refused).toBeInstanceOf(Validation);
          expect((refused as Validation).error.code).toBe("validation");
        }),
      );
    });
  });

  it("fails with not_found for a session id that was never spawned, the same as stream does", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const ticket = await fetchTicket(base, token);
      const stranger = Bun.randomUUIDv7();

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const refused = yield* awaitOutcome(
            readFirstItem(client, { topic: `session:${stranger}:tap` }),
          );
          expect(refused).toBeInstanceOf(NotFound);
          expect((refused as NotFound).error.code).toBe("not_found");
        }),
      );
    });
  });

  it("writes no extra row per delta beyond what the coalescing rule in stream.ts already writes", async () => {
    await withSessionTopicFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at: AT,
        _tag: "session.started",
      });
      const before = await waitForStreamRows(arranged.harness, session.id, 1);

      const ticket = await fetchTicket(arranged.harness.base, arranged.token);
      await onSocket(arranged.harness.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const tap = yield* collectMessages(client, { topic: `session:${session.id}:tap` });
          yield* Effect.promise(() =>
            expectHeld(arranged.harness.live, 1, `session:${session.id}:tap`),
          );

          // Five deltas on the same item, well under the 4KB flush and before
          // an item or turn boundary: the coalescing rule keeps them all in its
          // buffer and writes nothing for them.
          for (let index = 0; index < 5; index++) {
            reportEvent(arranged.wire, 2 + index, {
              eventId: crypto.randomUUID(),
              sessionId: session.id,
              at: AT,
              _tag: "content.delta",
              turnId: "t1",
              itemId: "i1",
              streamKind: "assistant_text",
              delta: `chunk-${String(index)}`,
            });
          }

          expect(
            yield* Effect.promise(() => waitWithin(1000, () => tap.received.length >= 5)),
          ).toBe(true);
          const items = listDeltas(tap).flatMap(listTapItems);
          expect(items.map((item) => item.delta)).toEqual([
            "chunk-0",
            "chunk-1",
            "chunk-2",
            "chunk-3",
            "chunk-4",
          ]);

          // Long enough that a row would already be there if the coalescing
          // rule were going to write one.
          yield* Effect.sleep("200 millis");
          expect(
            yield* Effect.promise(() => readStreamRows(arranged.harness, session.id)),
          ).toHaveLength(before.length);

          yield* Fiber.interrupt(tap.fiber);
        }),
      );
    });
  });
});
