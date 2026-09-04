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
 * What a subscription then carries - invalidations and deltas - is not here;
 * nothing publishes yet.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import { live, Unauthenticated, Validation } from "@hydra/contract";
import { completeSetup, get, post, withServer, type LiveReader } from "../http/testing";

type LiveClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof live>, RpcClientError>;

/** The socket sits at `/ws` on the same authority the API is served from. */
const socketUrl = (base: string): string => `${base.replace(/^http:/, "ws:")}/ws`;

/** One connection's worth of client transport. */
const connection = (base: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(BunSocket.layerWebSocket(socketUrl(base))),
    Layer.provide(RpcSerialization.layerJson),
  );

/**
 * Opens one connection for the length of `body` and closes it afterwards. The
 * client is the contract group's own, over JSON framing, which is what a browser
 * client will be.
 */
const onSocket = (
  base: string,
  body: (client: LiveClient) => Effect.Effect<void, unknown, Scope.Scope>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(live);
        yield* body(client);
      }).pipe(Effect.provide(connection(base))),
    ).pipe(Effect.orDie),
  );

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

/** A ticket, fetched the way a client fetches one: over HTTP, before dialling. */
const ticketFor = async (base: string, token: string): Promise<string> => {
  const response = await post(base, "/api/v1/auth/ws-ticket", {}, token);
  expect(response.status).toBe(200);
  return ((await response.json()) as { ticket: string }).ticket;
};

/** Runs a subscription to its first item, which is all a refusal needs. */
const firstItem = (client: LiveClient, payload: { topic: string; cursor?: string }) =>
  Stream.runHead(client.subscribe(payload));

/**
 * Asserts the controller holds exactly this many `task` subscriptions, giving it
 * time to get there. A subscription is torn down asynchronously, so a count read
 * in the same turn as the interrupt would be measuring the race rather than the
 * behaviour.
 */
const expectHeld = async (reader: LiveReader, expected: number): Promise<void> => {
  let seen = await reader.subscriberCount("task");
  for (let attempt = 0; attempt < 200 && seen !== expected; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    seen = await reader.subscriberCount("task");
  }
  expect(seen).toBe(expected);
};

describe("opening a live connection", () => {
  it("is not there at all until Hydra is set up", async () => {
    await withServer(async (base) => {
      // Nothing on the socket is reachable before the password exists - a
      // ticket needs a credential, and there is no user to hold one - so the
      // controller refuses the upgrade rather than holding the connection.
      expect(await dial(base)).toBe("refused");
      await completeSetup(base);
      expect(await dial(base)).toBe("open");
    });
  });

  it("greets a ticket holder with the version the API answers with", async () => {
    await withServer(async (base) => {
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
    await withServer(async (base) => {
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
    await withServer(async (base) => {
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
    await withServer(async (base) => {
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
            }).pipe(Effect.provide(connection(base))),
          );

          expect(yield* greeted.ping({})).toEqual({});
        }),
      );
    });
  });

  it("refuses a protocol version it does not speak", async () => {
    await withServer(async (base) => {
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
    await withServer(async (base) => {
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
    await withServer(async (base) => {
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
    await withServer(async (base) => {
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
    await withServer(async (base) => {
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
    await withServer(async (base, _audit, _sql, reader) => {
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
    await withServer(async (base, _audit, _sql, reader) => {
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
    await withServer(async (base, _audit, _sql, reader) => {
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
