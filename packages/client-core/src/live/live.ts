/**
 * The live supervisor: one WebSocket, held open, carrying Live Topic
 * subscriptions.
 *
 * Everything Effect-shaped about the socket stops here. A caller starts it,
 * hands it a topic and a callback, and gets an unsubscribe function back; what
 * it never sees is the ticket fetch, the RPC client, the reconnect schedule or
 * the keepalive.
 *
 * The connection is disposable and the subscriptions are not. A subscription is
 * a record in this module's own registry, and every connection takes the whole
 * registry out again from scratch - which is why subscribing before the socket
 * is up is ordinary rather than an error, and why a drop costs the caller
 * nothing but a refetch.
 *
 * The two families are answered differently, because they lose different things
 * when a connection goes. A mutable topic's subscriber missed pushes naming
 * records it cannot name itself, so on reconnect it is told to refetch
 * everything it watches. An append-only subscriber holds a cursor, so it asks
 * to be caught up from it and misses nothing - unless the controller refuses
 * the cursor, which means the log it came back to is not the log it left, and
 * then the position is dropped and the reader is told so it can start again.
 */
import {
  isAppendOnlyLiveTopic,
  live as liveGroup,
  LIVE_PROTOCOL_VERSION,
  type AppendOnlyLiveTopic,
  type CapExceeded,
  type Event,
  type Forbidden,
  type Internal,
  type LiveMessage,
  type LiveTopic,
  type MutableLiveTopic,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { Effect, Fiber, Latch, Layer, Result, Schedule, Stream } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import type { HydraClient } from "../client";
import { ApiError } from "../errors";
import { queryKeysFor, type LiveQueryKey } from "./keys";

/** How long the first reconnect waits, and how long the longest one waits. */
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/** How often a connection proves itself to the controller. */
const PING_INTERVAL_MS = 30_000;

/**
 * How much of a reconnect delay is given up to chance. Jitter only ever
 * shortens the wait, so the schedule stays the one the caller was promised
 * while many tabs coming back at once spread out rather than arriving together.
 */
const JITTER = 0.2;

/**
 * Only what dialling the socket needs: a url in, a socket out. The seam a test
 * hands a stub through, and the reason nothing here reaches for the global.
 */
export type LiveWebSocketConstructor = (url: string) => WebSocket;

export interface LiveOptions {
  /** The client the ticket is fetched with, and whose credential the socket inherits. */
  readonly client: HydraClient;
  /** Where the controller lives, e.g. `http://127.0.0.1:7717`. */
  readonly baseUrl: string;
  /** The `WebSocket` to dial with. Defaults to the global one; a seam for tests. */
  readonly webSocket?: LiveWebSocketConstructor;
}

/** A mutable topic's push, as the keys its records are cached under. */
export type LiveInvalidateHandler = (keys: ReadonlyArray<LiveQueryKey>) => void;

/**
 * An append-only topic's push. `reset` says the position was lost rather than
 * advanced: everything the reader holds is now unrelated to what follows, so it
 * reads its page again instead of appending to a gap. There is no cursor to
 * report on such a call, because there is no position.
 */
export interface LiveDelta {
  readonly cursor: string | null;
  readonly items: ReadonlyArray<Event>;
  readonly reset: boolean;
}

export type LiveDeltaHandler = (delta: LiveDelta) => void;

/**
 * Where the supervisor is. Neither `unauthenticated` nor `stopped` goes
 * anywhere on its own - the first means the credential is gone, the second that
 * the caller asked for it - and `start` is what leaves either of them.
 */
export type LiveStatus =
  "idle" | "connecting" | "connected" | "disconnected" | "unauthenticated" | "stopped";

export interface Live {
  /**
   * Begins connecting, and keeps connecting. Calling it while it is already
   * connecting or connected does nothing; calling it after it stopped, or
   * after it gave up on a credential that was gone, is how a fresh sign-in
   * gets live updates back.
   */
  start(): void;
  /**
   * Ends the connection and everything it was doing. What was subscribed stays
   * subscribed: a later `start` takes the whole registry out again, the way a
   * reconnect does.
   */
  stop(): Promise<void>;
  subscribe(topic: MutableLiveTopic, handler: LiveInvalidateHandler): () => void;
  subscribe(topic: AppendOnlyLiveTopic, handler: LiveDeltaHandler): () => void;
  /** Reports where the supervisor is now, and again on every change. */
  onStatus(listener: (status: LiveStatus) => void): void;
  /** What the controller answered at the greeting, or `null` before the first one. */
  readonly serverVersion: string | null;
}

/** One thing being watched, across however many connections carry it. */
interface Subscription {
  readonly topic: LiveTopic;
  readonly handler: LiveInvalidateHandler | LiveDeltaHandler;
  /** Where an append-only reader has got to; `undefined` means from the head. */
  cursor: string | undefined;
}

/** What a subscription's stream can fail with: a refusal, or the transport. */
type LiveFailure =
  Unauthenticated | Forbidden | Validation | CapExceeded | Internal | RpcClientError;

/** The contract group's own client, as one connection hands it over. */
type LiveClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof liveGroup>, RpcClientError>;

/** The socket sits at `/ws` on the authority the API is served from. */
const socketUrl = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/ws`;

/**
 * The code a refusal names, or nothing when the failure is the transport's
 * rather than the controller's. The contract's errors are told apart by the
 * code in their envelope; none of them carries a tag.
 */
const errorCode = (failure: LiveFailure) => ("error" in failure ? failure.error.code : undefined);

/**
 * Waits before trying again. The wait is shortened by chance rather than
 * lengthened, so the schedule stays the one that was promised while many
 * waiters - tabs, or subscriptions capped in the same flush - stop waking
 * together.
 */
const waitOut = (delay: number): Effect.Effect<void> =>
  Effect.sleep(delay * (1 - JITTER * Math.random()));

export const createLive = (options: LiveOptions): Live => {
  const url = socketUrl(options.baseUrl);
  const dial: LiveWebSocketConstructor =
    options.webSocket ?? ((address) => new globalThis.WebSocket(address));

  const subscriptions = new Set<Subscription>();
  /** Opened whenever the registry changes, so a live connection picks it up. */
  const changed = Latch.makeUnsafe(false);

  const listeners = new Set<(status: LiveStatus) => void>();
  let status: LiveStatus = "idle";
  const setStatus = (next: LiveStatus): void => {
    if (next === status) return;
    status = next;
    for (const listener of listeners) listener(next);
  };

  let serverVersion: string | null = null;
  let running: Fiber.Fiber<void> | null = null;

  /**
   * Tells a mutable topic's reader that everything it watches may have moved.
   * The answer whenever pushes were missed and nothing names which records they
   * were about: after a drop, and after a subscription ended for any reason
   * other than the caller letting go of it.
   */
  const sweep = (subscription: Subscription): void => {
    const topic = subscription.topic;
    if (isAppendOnlyLiveTopic(topic)) return;
    isolate(() => (subscription.handler as LiveInvalidateHandler)(queryKeysFor(topic, [])));
  };

  /**
   * Runs one of the caller's callbacks. A callback that throws is the caller's
   * bug and not this connection's business, so the throw is handed to the host
   * to report - the way a DOM listener's is - rather than taking a reader off
   * the air, or the whole connection down, with nothing said.
   */
  const isolate = (call: () => void): void => {
    try {
      call();
    } catch (thrown) {
      queueMicrotask(() => {
        throw thrown;
      });
    }
  };

  /** Hands one message to the caller's callback. */
  const deliver = (subscription: Subscription, message: LiveMessage): void => {
    isolate(() => {
      if (message._tag === "delta") {
        subscription.cursor = message.cursor;
        (subscription.handler as LiveDeltaHandler)({
          cursor: message.cursor,
          items: message.items,
          reset: false,
        });
        return;
      }
      (subscription.handler as LiveInvalidateHandler)(
        queryKeysFor(subscription.topic as MutableLiveTopic, message.ids),
      );
    });
  };

  /**
   * Holds one subscription open for as long as the connection lasts, and takes
   * it out again whenever it ends.
   *
   * There are three answers, not one per refusal. A credential that is gone is
   * the connection's problem and ends it. A cursor the log cannot honour is
   * given up, and the reader is told so it can start its page again. Everything
   * else - falling behind, a read that failed, a stream that ended - is
   * answered the same way: whatever was pushed in the meantime was missed, so a
   * mutable reader reads everything again, and the subscription is taken out
   * once more after a wait that grows, so a refusal that keeps repeating costs
   * two frames a minute rather than a flood. Nothing here ends a subscription
   * for good: only the caller does that.
   */
  const follow = (rpc: LiveClient, subscription: Subscription, closed: Latch.Latch) =>
    Effect.gen(function* () {
      let delay = FIRST_RETRY_MS;
      for (;;) {
        const payload =
          subscription.cursor === undefined
            ? { topic: subscription.topic }
            : { topic: subscription.topic, cursor: subscription.cursor };
        const outcome = yield* Effect.result(
          Stream.runForEach(rpc.subscribe(payload), (message: LiveMessage) =>
            Effect.sync(() => deliver(subscription, message)),
          ),
        );

        const code = Result.isFailure(outcome) ? errorCode(outcome.failure) : undefined;
        if (code === "unauthenticated") {
          // The credential behind this connection is gone, so nothing on it can
          // be recovered by asking again. A fresh connection is the only move,
          // and its ticket fetch is what finds out whether there is a credential
          // left at all.
          closed.openUnsafe();
          return;
        }
        if (
          code === "validation" &&
          isAppendOnlyLiveTopic(subscription.topic) &&
          subscription.cursor !== undefined
        ) {
          subscription.cursor = undefined;
          isolate(() =>
            (subscription.handler as LiveDeltaHandler)({ cursor: null, items: [], reset: true }),
          );
          continue;
        }
        sweep(subscription);
        yield* waitOut(delay);
        delay = Math.min(delay * 2, MAX_RETRY_MS);
      }
    });

  /**
   * One greeted connection's work: tell the readers that missed pushes to
   * refetch, keep the connection proven, and keep the registry on the wire.
   *
   * Every mutable reader in the registry is swept, whether or not a connection
   * has carried it before. A subscription made while there was no connection
   * has the same gap as one that survived a drop: whatever was pushed between
   * the screen's own read and this greeting named records nobody can name any
   * more. The price is one refetch per reader on the first connection of a page
   * load, which is what a gap nobody can see is worth.
   */
  const session = (rpc: LiveClient, closed: Latch.Latch) =>
    Effect.gen(function* () {
      for (const subscription of subscriptions) sweep(subscription);

      yield* Effect.forkChild(
        rpc.ping({}).pipe(
          Effect.delay(PING_INTERVAL_MS),
          Effect.forever,
          Effect.catchCause(() => Effect.sync(() => closed.openUnsafe())),
        ),
      );

      const held = new Map<Subscription, Fiber.Fiber<void>>();
      for (;;) {
        changed.closeUnsafe();
        for (const subscription of subscriptions) {
          if (held.has(subscription)) continue;
          held.set(subscription, yield* Effect.forkChild(follow(rpc, subscription, closed)));
        }
        for (const [subscription, fiber] of held) {
          if (subscriptions.has(subscription)) continue;
          held.delete(subscription);
          // Ending a stream is a round trip the socket may no longer be able to
          // make, so it is never waited on: the caller's unsubscribe already
          // returned and the connection's scope collects whatever is left.
          yield* Effect.forkChild(Fiber.interrupt(fiber));
        }
        yield* changed.await;
      }
    });

  /**
   * One connection, from the dial to whatever ends it. Answers how long it was
   * greeted for, or nothing when it never was, which is what tells the next
   * wait whether this was one drop in a bad minute or the first after a good
   * hour. The reading is monotonic, so a clock the machine corrects while the
   * connection is up does not make a moment look like an hour.
   */
  const connect = (ticket: string) =>
    Effect.suspend(() => {
      const closed = Latch.makeUnsafe(false);
      let greetedAt: number | null = null;
      const construct = (address: string): WebSocket => {
        const socket = dial(address);
        const ended = (): void => {
          closed.openUnsafe();
        };
        socket.addEventListener("close", ended, { once: true });
        socket.addEventListener("error", ended, { once: true });
        return socket;
      };

      const protocol = Layer.effect(RpcClient.Protocol)(
        // The transport reconnects on its own by default, which would leave a
        // socket that has never been greeted answering for a connection this
        // module thinks it still owns. Reconnecting is this module's job,
        // because only it holds a ticket.
        RpcClient.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }),
      ).pipe(
        Layer.provide(Socket.layerWebSocket(url)),
        Layer.provide(Layer.succeed(Socket.WebSocketConstructor)(construct)),
        Layer.provide(RpcSerialization.layerJson),
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const rpc = yield* RpcClient.make(liveGroup);
          const greeting = yield* rpc.hello({ v: LIVE_PROTOCOL_VERSION, ticket });
          serverVersion = greeting.serverVersion;
          greetedAt = performance.now();
          setStatus("connected");
          yield* Effect.raceFirst(session(rpc, closed), closed.await);
        }).pipe(Effect.provide(protocol)),
      ).pipe(
        Effect.ignore,
        Effect.map(() => (greetedAt === null ? null : performance.now() - greetedAt)),
      );
    });

  /** Connect, and go on connecting, until the credential turns out to be gone. */
  const supervise = Effect.gen(function* () {
    let delay = FIRST_RETRY_MS;
    for (;;) {
      setStatus("connecting");
      const ticket = yield* Effect.promise(() =>
        options.client.auth.wsTicket().then(
          (answer) => ({ ticket: answer.ticket, refused: false }),
          (cause: unknown) => ({
            ticket: null,
            refused: cause instanceof ApiError && cause.code === "unauthenticated",
          }),
        ),
      );
      if (ticket.refused) {
        // Only a fresh sign-in helps, and when one happens the caller starts
        // this supervisor again rather than building another, so the fiber
        // hands its slot back on the way out.
        running = null;
        setStatus("unauthenticated");
        return;
      }
      const held = ticket.ticket === null ? null : yield* connect(ticket.ticket);
      setStatus("disconnected");
      // A connection that lasted longer than the longest wait was not a client
      // that cannot connect, so the next drop starts over at the shortest wait
      // rather than inheriting a schedule from hours ago.
      if (held !== null && held >= MAX_RETRY_MS) delay = FIRST_RETRY_MS;
      yield* waitOut(delay);
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
  });

  return {
    start: () => {
      if (running !== null) return;
      running = Effect.runFork(supervise);
    },
    stop: async () => {
      const fiber = running;
      running = null;
      setStatus("stopped");
      if (fiber !== null) await Effect.runPromise(Fiber.interrupt(fiber));
    },
    subscribe: (topic: LiveTopic, handler: LiveInvalidateHandler | LiveDeltaHandler) => {
      const subscription: Subscription = { topic, handler, cursor: undefined };
      subscriptions.add(subscription);
      changed.openUnsafe();
      return () => {
        subscriptions.delete(subscription);
        changed.openUnsafe();
      };
    },
    onStatus: (listener: (status: LiveStatus) => void) => {
      listeners.add(listener);
      listener(status);
    },
    get serverVersion(): string | null {
      return serverVersion;
    },
  };
};
