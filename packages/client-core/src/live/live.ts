/**
 * The live supervisor: one WebSocket, kept open, that carries Live Topic
 * subscriptions.
 *
 * No Effect types get past this module. A caller starts the supervisor, passes
 * a topic and a callback, and gets an unsubscribe function back. The caller
 * never deals with the ticket fetch, the RPC client, the reconnect schedule or
 * the keepalive.
 *
 * Connections come and go, but subscriptions stay. A subscription is an entry
 * in this module's registry, and every new connection subscribes to everything
 * in the registry again. That is why subscribing before the socket is open is
 * normal rather than an error, and why a dropped connection costs the caller
 * only a refetch.
 *
 * The two kinds of topic recover differently, because they lose different
 * things when a connection drops:
 *
 * - A mutable topic's subscriber may have missed pushes about records it
 *   cannot list itself, so after a reconnect it is told to refetch everything
 *   it watches.
 * - An append-only topic's subscriber holds a cursor, so it resubscribes from
 *   that cursor and misses nothing. If the controller rejects the cursor, the
 *   log is no longer the one the cursor came from: the cursor is dropped and
 *   the subscriber is told, so it can start again.
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
  type NotFound,
  type TapItem,
  type TranscriptRow,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { Effect, Fiber, Latch, Layer, Result, Schedule, Stream } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import type { HerculeClient } from "../client";
import { ApiError } from "../errors";
import { buildQueryKeys, type LiveQueryKey } from "./keys";

/** How long the first reconnect waits, and how long the longest one waits. */
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/** How often the connection pings the controller to show it is still alive. */
const PING_INTERVAL_MS = 30_000;

/**
 * The largest fraction by which a reconnect delay is randomly shortened. Jitter
 * only ever shortens the wait, so no wait is longer than the schedule, while
 * many tabs reconnecting at once spread out rather than arriving together.
 */
const JITTER = 0.2;

/**
 * Creates a WebSocket for a URL. Tests pass a stub through this option, which
 * is why nothing here uses the global `WebSocket` directly.
 */
export type LiveWebSocketConstructor = (url: string) => WebSocket;

export interface LiveOptions {
  /** The client used to fetch the socket ticket; the socket uses the same credential. */
  readonly client: HerculeClient;
  /** The controller's address, for example `http://127.0.0.1:7717`. */
  readonly baseUrl: string;
  /** Creates the `WebSocket`. Defaults to the global one; tests pass a stub. */
  readonly webSocket?: LiveWebSocketConstructor;
}

/** Receives a mutable topic's push, as the query keys to invalidate. */
export type LiveInvalidateHandler = (keys: ReadonlyArray<LiveQueryKey>) => void;

/**
 * An append-only topic's push.
 *
 * `reset` is true when the position in the log was lost. What the subscriber
 * holds no longer connects to what follows, so it must fetch its page again
 * rather than append after a gap. `cursor` is then `null`, because there is
 * no position.
 *
 * `gone` is true when the controller rejected the topic with `not_found`: the
 * session it names was never spawned, or no longer exists. Subscribing again
 * cannot fix that, so the subscription is not retried, just as a connection
 * is not retried after `unauthenticated`. The problem is with the topic, not
 * the socket, so only this subscription stops. The caller should unsubscribe
 * (with the function `subscribe` returned) once it sees `gone`.
 */
export interface LiveDelta {
  readonly cursor: string | null;
  readonly items: ReadonlyArray<Event | TranscriptRow | TapItem>;
  readonly reset: boolean;
  readonly gone: boolean;
}

export type LiveDeltaHandler = (delta: LiveDelta) => void;

/**
 * The supervisor's status. `unauthenticated` (the credential is gone) and
 * `stopped` (the caller stopped it) never change on their own; only `start`
 * leaves them.
 */
export type LiveStatus =
  "idle" | "connecting" | "connected" | "disconnected" | "unauthenticated" | "stopped";

export interface Live {
  /**
   * Starts connecting, and keeps reconnecting. Does nothing while already
   * connecting or connected. After `stop`, or after the credential was
   * rejected, calling it again restarts live updates, for example after the
   * user signs in again.
   */
  start(): void;
  /**
   * Closes the connection and stops all its work. Subscriptions stay
   * registered: a later `start` subscribes to all of them again, as a
   * reconnect does.
   */
  stop(): Promise<void>;
  subscribe(topic: MutableLiveTopic, handler: LiveInvalidateHandler): () => void;
  /**
   * `cursor` sets where an append-only subscription starts replaying from.
   * Pass it when the caller already fetched a page over HTTP. Without it,
   * replay starts from the head, and anything written between that fetch and
   * the subscription starting is lost.
   */
  subscribe(topic: AppendOnlyLiveTopic, handler: LiveDeltaHandler, cursor?: string): () => void;
  /**
   * Calls the listener with the current status, and again on every change.
   * Returns a function that removes the listener.
   */
  onStatus(listener: (status: LiveStatus) => void): () => void;
  /** The server version from the controller's `hello` reply, or `null` before the first one. */
  readonly serverVersion: string | null;
}

/** One subscription in the registry. It outlives any single connection. */
interface Subscription {
  readonly topic: LiveTopic;
  readonly handler: LiveInvalidateHandler | LiveDeltaHandler;
  /** How far an append-only subscriber has read; `undefined` means from the head. */
  cursor: string | undefined;
}

/** The errors a subscription's stream can fail with: a controller error, or a transport error. */
type LiveFailure =
  Unauthenticated | Forbidden | Validation | NotFound | CapExceeded | Internal | RpcClientError;

/** The RPC client for the contract's live group, on one connection. */
type LiveClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof liveGroup>, RpcClientError>;

/** Returns the socket URL: `/ws` on the same host and port as the API. */
const buildSocketUrl = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/ws`;

/**
 * Returns the error code of a controller error, or `undefined` for a transport
 * error. The contract's errors are told apart by the code in their envelope;
 * none of them has a tag.
 */
const readErrorCode = (failure: LiveFailure) =>
  "error" in failure ? failure.error.code : undefined;

/**
 * Waits before trying again. The wait is randomly shortened, never
 * lengthened, so it never exceeds the schedule, while many waiters (tabs, or
 * subscriptions that hit a cap at the same moment) stop waking up together.
 */
const sleepWithJitter = (delay: number): Effect.Effect<void> =>
  Effect.sleep(delay * (1 - JITTER * Math.random()));

/** Creates a live supervisor. It does not connect until `start` is called. */
export const createLive = (options: LiveOptions): Live => {
  const url = buildSocketUrl(options.baseUrl);
  const dial: LiveWebSocketConstructor =
    options.webSocket ?? ((address) => new globalThis.WebSocket(address));

  const subscriptions = new Set<Subscription>();
  /** Opened whenever the registry changes, so the current connection picks up the change. */
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
   * Tells a mutable topic's subscriber that everything it watches may have
   * changed. Used whenever pushes may have been missed and there is no way to
   * know which records they were about: after a dropped connection, and after
   * a subscription ended for any reason other than the caller unsubscribing.
   */
  const sweep = (subscription: Subscription): void => {
    const topic = subscription.topic;
    if (isAppendOnlyLiveTopic(topic)) return;
    isolate(() => (subscription.handler as LiveInvalidateHandler)(buildQueryKeys(topic, [])));
  };

  /**
   * Runs one of the caller's callbacks. A callback that throws is a bug in the
   * caller, not in the connection, so the error is rethrown in a microtask for
   * the host to report, the way a DOM listener's error is. It does not stop the
   * subscription or bring the connection down silently.
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

  /** Passes one message to the subscription's callback. */
  const deliver = (subscription: Subscription, message: LiveMessage): void => {
    isolate(() => {
      if (message._tag === "delta") {
        subscription.cursor = message.cursor;
        (subscription.handler as LiveDeltaHandler)({
          cursor: message.cursor ?? null,
          items: message.items,
          reset: false,
          gone: false,
        });
        return;
      }
      (subscription.handler as LiveInvalidateHandler)(
        buildQueryKeys(subscription.topic as MutableLiveTopic, message.ids),
      );
    });
  };

  /**
   * Keeps one subscription open for as long as the connection lasts, and
   * subscribes again whenever the stream ends.
   *
   * How a stream's end is handled:
   *
   * - `unauthenticated`: the credential is gone, which is a problem for the
   *   whole connection, so the connection is closed.
   * - `not_found` on an append-only topic: the topic will never exist, so the
   *   subscriber is told it is `gone` and this subscription stops.
   * - `validation` on an append-only topic with a cursor: the log rejected the
   *   cursor, so the cursor is dropped, the subscriber is told to `reset`, and
   *   the subscription starts again from the head.
   * - Anything else (falling behind, a failed read, a stream that ended): any
   *   pushes in the meantime were missed, so a mutable subscriber refetches
   *   everything, and the subscription is retried after a growing wait. An
   *   error that keeps repeating then costs two frames a minute rather than a
   *   flood.
   *
   * Apart from `not_found`, nothing here ends a subscription for good: only
   * the caller does that.
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

        const code = Result.isFailure(outcome) ? readErrorCode(outcome.failure) : undefined;
        if (code === "unauthenticated") {
          // The connection's credential is gone, so retrying on this connection
          // cannot help. Only a new connection can, and its ticket fetch finds
          // out whether there is still a valid credential.
          closed.openUnsafe();
          return;
        }
        if (code === "not_found" && isAppendOnlyLiveTopic(subscription.topic)) {
          // The topic names a record that does not exist (a session id that was
          // never spawned, or one that no longer exists), and retrying cannot
          // fix that. Only this subscription stops; the connection and every
          // other subscription on it are unaffected.
          isolate(() =>
            (subscription.handler as LiveDeltaHandler)({
              cursor: null,
              items: [],
              reset: false,
              gone: true,
            }),
          );
          return;
        }
        if (
          code === "validation" &&
          isAppendOnlyLiveTopic(subscription.topic) &&
          subscription.cursor !== undefined
        ) {
          subscription.cursor = undefined;
          isolate(() =>
            (subscription.handler as LiveDeltaHandler)({
              cursor: null,
              items: [],
              reset: true,
              gone: false,
            }),
          );
          continue;
        }
        sweep(subscription);
        yield* sleepWithJitter(delay);
        delay = Math.min(delay * 2, MAX_RETRY_MS);
      }
    });

  /**
   * Does the work of one connection after the `hello` reply: tells subscribers
   * that may have missed pushes to refetch, pings the controller to keep the
   * connection alive, and keeps the controller's subscriptions in step with
   * the registry.
   *
   * Every mutable subscriber is told to refetch, whether or not an earlier
   * connection carried it. A subscription made while there was no connection
   * has the same gap as one that survived a drop: pushes sent between the
   * screen's own fetch and this connection are lost. The cost is one refetch
   * per subscriber on the first connection of a page load, which is worth it
   * to close a gap that is otherwise invisible.
   */
  const runConnection = (rpc: LiveClient, closed: Latch.Latch) =>
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
          // Ending a stream needs a round trip that the socket may no longer be
          // able to make, so it is never awaited: the caller's unsubscribe has
          // already returned, and the connection's scope cleans up the rest.
          yield* Effect.forkChild(Fiber.interrupt(fiber));
        }
        yield* changed.await;
      }
    });

  /**
   * Runs one connection, from opening the socket until it ends. Returns how
   * long the connection was up after the `hello` reply, or `null` when there
   * was no reply. The supervisor uses that to decide whether this was one more
   * drop in a bad minute or the first drop after a good hour. It uses a
   * monotonic clock, so a system clock correction during the connection cannot
   * make a moment look like an hour.
   */
  const connect = (ticket: string) =>
    Effect.suspend(() => {
      const closed = Latch.makeUnsafe(false);
      let greetedAt: number | null = null;
      const construct = (address: string): WebSocket => {
        const socket = dial(address);
        const markClosed = (): void => {
          closed.openUnsafe();
        };
        socket.addEventListener("close", markClosed, { once: true });
        socket.addEventListener("error", markClosed, { once: true });
        return socket;
      };

      const protocol = Layer.effect(RpcClient.Protocol)(
        // By default the transport reconnects on its own, which would leave
        // this module using a socket that never received a `hello` reply.
        // Reconnecting is this module's job, because only it has a ticket.
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
          yield* Effect.raceFirst(runConnection(rpc, closed), closed.await);
        }).pipe(Effect.provide(protocol)),
      ).pipe(
        Effect.ignore,
        Effect.map(() => (greetedAt === null ? null : performance.now() - greetedAt)),
      );
    });

  /** Connects, and keeps reconnecting until the credential is rejected. */
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
        // Only a new sign-in can help. After one, the caller calls `start` on
        // this supervisor again rather than creating another, so clear
        // `running` before the fiber ends.
        running = null;
        setStatus("unauthenticated");
        return;
      }
      const held = ticket.ticket === null ? null : yield* connect(ticket.ticket);
      setStatus("disconnected");
      // A connection that lasted longer than the longest wait shows the client
      // can connect, so the next wait starts again from the shortest delay
      // rather than continuing a backoff from hours ago.
      if (held !== null && held >= MAX_RETRY_MS) delay = FIRST_RETRY_MS;
      yield* sleepWithJitter(delay);
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
    subscribe: (
      topic: LiveTopic,
      handler: LiveInvalidateHandler | LiveDeltaHandler,
      cursor?: string,
    ) => {
      const subscription: Subscription = { topic, handler, cursor };
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
      return () => {
        listeners.delete(listener);
      };
    },
    get serverVersion(): string | null {
      return serverVersion;
    },
  };
};
