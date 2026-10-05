/**
 * The live socket: the contract's `live` RPC group, served at `GET /ws` next
 * to the API routes.
 *
 * A connection has no actor until `hello` succeeds. `hello` uses up the
 * ticket, and the resolved user is kept for the life of the connection on the
 * per-connection record the RPC server already has, so it goes away with the
 * connection and there is no map to clean up. The greeting is claimed before
 * the ticket is looked up, so two `hello` frames sent at once cannot both
 * succeed. Otherwise the second one could change the actor under
 * subscriptions that are already open.
 *
 * A successful `hello` is not permanent. A socket can stay open for hours,
 * and its credential can be logged out or revoked in that time. So:
 *
 * - every call on the connection resolves the credential again;
 * - a sweep re-checks every connection with an open subscription, because a
 *   client that stops calling would otherwise keep receiving data forever.
 *
 * A connection whose credential is gone loses its subscriptions, and every
 * later call fails.
 *
 * Every failure is one of the contract's errors, for the one request that
 * caused it. That is why the payload schemas accept more than the valid
 * values: a payload the transport cannot decode becomes an untyped defect. So
 * the values of `v`, `topic` and `cursor` are validated here, where a
 * `validation` error can be returned and the connection stays open.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import {
  createDecodeValidationError,
  createInternalError,
  createInvalidStateError,
  createUnauthenticatedError,
  createValidationError,
  isAppendOnlyLiveTopic,
  live,
  LIVE_PROTOCOL_VERSION,
  LiveTopic,
  parseSessionTopic,
  type Internal,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { VERSION } from "@hercule/home/version";
import { CurrentActor, requireGrant, type UserActor } from "../actor";
import { Credentials } from "../credentials";
import { WsTickets } from "./tickets";
import { LiveTopics, type LiveQueue } from "./topics";

/** The socket's path. The handshake has no query string. */
const LIVE_SOCKET_PATH = "/ws";

/**
 * How often the sweep re-checks the credentials of connections with open
 * subscriptions. Short enough that a revocation takes effect while the person
 * who revoked it is still watching.
 */
const REVOCATION_SWEEP = Duration.seconds(30);

const HELLO_FIRST = "this connection has not said hello";
const HELLO_ONCE = "this connection has already said hello";
const TICKET_REFUSED = "the ticket is not valid";
const CREDENTIAL_GONE = "the credential this connection was opened with is no longer valid";
const UNREADABLE = "the credential behind this connection could not be checked";

/** A cursor as a client sends it: decimal digits only. */
const CURSOR = /^\d+$/;

/**
 * Parses a cursor from the wire into a log position. Returns `undefined` when
 * no cursor was given, which means "follow from the head". Fails with a
 * validation error when the cursor is not a whole number. Used by `event` and
 * `session:<id>:stream`, the two topics that have positions.
 */
const parsePosition = (raw: string | undefined): Effect.Effect<number | undefined, Validation> => {
  if (raw === undefined) return Effect.succeed(undefined);
  const cursor = Number(raw);
  if (!CURSOR.test(raw) || !Number.isSafeInteger(cursor)) {
    return Effect.fail(
      createValidationError([
        {
          path: ["cursor"],
          message: "the cursor must be a whole number: the position of an entry in the log",
        },
      ]),
    );
  }
  return Effect.succeed(cursor);
};

/**
 * What the controller keeps for one connection: its actor, and its open
 * subscriptions, so they can all be ended at once when its credential goes
 * away.
 *
 * `actor` is undefined until a `hello` succeeds. `greeting` is true while a
 * `hello` is being handled, so a second `hello` fails instead of racing it.
 */
interface Connection {
  actor: UserActor | undefined;
  greeting: boolean;
  gone: boolean;
  readonly open: Set<LiveQueue>;
}

/**
 * The connection's record, stored on the connection. It exists from the
 * moment the first `hello` starts. The connection is authenticated when the
 * record has an actor.
 */
class Greeted extends Context.Service<Greeted, Connection>()("hercule/controller/live/Greeted") {}

const decodeSchemaTopic = Schema.decodeUnknownEffect(LiveTopic);

/**
 * Decodes a topic from the wire. The schema checks the shape (a fixed name or
 * `session:<id>:kind`), but a pattern check cannot produce the exact template
 * type `LiveTopic` has. So a decoded value is cast to `LiveTopic` here, the
 * one place that trusts a session topic string to match its pattern.
 */
const decodeTopic = (raw: unknown) =>
  Effect.map(decodeSchemaTopic(raw), (topic) => topic as LiveTopic);

const handlers = live.toLayer(
  Effect.gen(function* () {
    const tickets = yield* WsTickets;
    const topics = yield* LiveTopics;
    const credentials = yield* Credentials;

    /** The connections with at least one open subscription, which the sweep re-checks. */
    const watching = new Set<Connection>();

    /**
     * Checks whether the connection's credential is still valid. Fails with an
     * internal error when the lookup fails. The token itself is never kept,
     * only its hash, which is all the lookup needs.
     */
    const isCredentialLive = (actor: UserActor): Effect.Effect<boolean, Internal> =>
      Effect.mapError(credentials.stillLive(actor.credential), () =>
        createInternalError(UNREADABLE),
      );

    /**
     * Ends every subscription of a connection whose credential is gone, and
     * marks the connection so later calls fail. A subscription is an ongoing
     * read, so it must stop as soon as the permission to read stops, not at
     * the client's next call.
     */
    const revoke = (connection: Connection): Effect.Effect<void> =>
      Effect.gen(function* () {
        connection.gone = true;
        watching.delete(connection);
        const gone = createUnauthenticatedError(CREDENTIAL_GONE);
        yield* Effect.forEach(connection.open, (queue) => topics.end(queue, gone), {
          discard: true,
        });
        connection.open.clear();
      });

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep(REVOCATION_SWEEP);
          // Several connections often share one credential (one per browser
          // tab), and every read here waits behind the controller's writes, so
          // each credential is looked up once per round.
          const resolved = new Map<string, boolean>();
          for (const connection of [...watching]) {
            const actor = connection.actor;
            if (actor === undefined) continue;
            const hash = actor.credential.tokenHash;
            let alive = resolved.get(hash);
            if (alive === undefined) {
              // A failed database read is no reason to log anyone out; the next
              // round checks again.
              alive = yield* Effect.catchCause(isCredentialLive(actor), (cause) =>
                Effect.as(
                  Effect.logError("a live connection's credential could not be re-checked", cause),
                  true,
                ),
              );
              resolved.set(hash, alive);
            }
            if (!alive) yield* revoke(connection);
          }
        }),
      ),
    );

    /**
     * Returns the connection and actor of a call. Fails with unauthenticated
     * when the connection has not said hello or its credential is gone. Every
     * call re-checks the credential, so an active client learns at once that
     * it has been logged out.
     */
    const identifyCaller = (
      client: Rpc.ServerClient,
    ): Effect.Effect<
      { readonly connection: Connection; readonly actor: UserActor },
      Unauthenticated | Internal
    > =>
      Effect.gen(function* () {
        const connection = Context.getOrUndefined(client.annotations, Greeted);
        const actor = connection?.actor;
        if (connection === undefined || actor === undefined) {
          return yield* Effect.fail(createUnauthenticatedError(HELLO_FIRST));
        }
        if (connection.gone) return yield* Effect.fail(createUnauthenticatedError(CREDENTIAL_GONE));
        if (yield* isCredentialLive(actor)) return { connection, actor };
        yield* revoke(connection);
        return yield* Effect.fail(createUnauthenticatedError(CREDENTIAL_GONE));
      });

    /**
     * Opens a subscription and records it on the connection, so it can be
     * ended when the connection's credential goes. The connection is checked
     * again after the subscription is open, because a revocation that ran
     * while it was opening would have missed it.
     */
    const holdSubscription = <E, R>(
      connection: Connection,
      subscription: Effect.Effect<LiveQueue, E, R>,
    ): Effect.Effect<LiveQueue, E, R | Scope.Scope> =>
      Effect.gen(function* () {
        const queue = yield* subscription;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            connection.open.add(queue);
            watching.add(connection);
          }),
          () =>
            Effect.sync(() => {
              connection.open.delete(queue);
              if (connection.open.size === 0) watching.delete(connection);
            }),
        );
        if (connection.gone) {
          yield* topics.end(queue, createUnauthenticatedError(CREDENTIAL_GONE));
        }
        return queue;
      });

    return {
      hello: (payload, options) =>
        Effect.gen(function* () {
          const existing = Context.getOrUndefined(options.client.annotations, Greeted);
          const connection: Connection = existing ?? {
            actor: undefined,
            greeting: false,
            gone: false,
            open: new Set<LiveQueue>(),
          };
          if (existing === undefined) options.client.annotate(Greeted, connection);
          if (connection.actor !== undefined || connection.greeting) {
            return yield* Effect.fail(createInvalidStateError(HELLO_ONCE));
          }
          // Claim the greeting before any lookup, and release it if this
          // `hello` fails, so a client whose first try failed can try again.
          connection.greeting = true;
          return yield* Effect.ensuring(
            Effect.gen(function* () {
              if (payload.v !== LIVE_PROTOCOL_VERSION) {
                return yield* Effect.fail(
                  createValidationError([
                    {
                      path: ["v"],
                      message: `this controller speaks live protocol version ${LIVE_PROTOCOL_VERSION}`,
                    },
                  ]),
                );
              }
              const actor = yield* tickets.consume(payload.ticket);
              // A ticket can outlive the credential that requested it by up to
              // five minutes, so check that credential again instead of
              // trusting the ticket.
              if (Option.isNone(actor) || !(yield* isCredentialLive(actor.value))) {
                return yield* Effect.fail(createUnauthenticatedError(TICKET_REFUSED));
              }
              connection.actor = actor.value;
              return { v: LIVE_PROTOCOL_VERSION, serverVersion: VERSION } as const;
            }),
            Effect.sync(() => {
              connection.greeting = false;
            }),
          );
        }),

      subscribe: (payload, options) =>
        Effect.gen(function* () {
          const { connection, actor } = yield* identifyCaller(options.client);
          const topic = yield* Effect.mapError(
            decodeTopic(payload.topic),
            createDecodeValidationError,
          );
          const session = parseSessionTopic(topic);

          if (session?.kind === "tap") {
            if (payload.cursor !== undefined) {
              return yield* Effect.fail(
                createValidationError([
                  {
                    path: ["cursor"],
                    message: `${topic} never replays, so there is nothing to resume from`,
                  },
                ]),
              );
            }
            // A tap carries transcript content before it is stored, so it needs
            // the same grant as reading the transcript over HTTP, like the
            // `:stream` topic below.
            yield* Effect.provideService(requireGrant("transcript.read"), CurrentActor, actor);
            return yield* holdSubscription(
              connection,
              topics.tapSession(session.sessionId, session.subagentId),
            );
          }

          if (session?.kind === "stream") {
            const cursor = yield* parsePosition(payload.cursor);
            // The stream's deltas are the transcript, so it needs the same grant
            // as reading the transcript over HTTP.
            yield* Effect.provideService(requireGrant("transcript.read"), CurrentActor, actor);
            return yield* holdSubscription(
              connection,
              topics.followSession(session.sessionId, session.subagentId, cursor),
            );
          }

          if (!isAppendOnlyLiveTopic(topic)) {
            if (payload.cursor !== undefined) {
              return yield* Effect.fail(
                createValidationError([
                  {
                    path: ["cursor"],
                    message: `${topic} is not a log, so there is nothing to replay`,
                  },
                ]),
              );
            }
            // A mutable topic carries no records, so a successful `hello` is all
            // it needs.
            return yield* holdSubscription(connection, topics.subscribe(topic));
          }
          const cursor = yield* parsePosition(payload.cursor);
          // The deltas are the event log, so this stream needs the same grant
          // as reading the log over HTTP.
          yield* Effect.provideService(requireGrant("event.query"), CurrentActor, actor);
          return yield* holdSubscription(connection, topics.follow(cursor));
        }),

      ping: (_payload, options) => Effect.as(identifyCaller(options.client), {}),
    };
  }),
);

/**
 * Serves the live socket as a route on the current router. Uses JSON
 * serialization, because a WebSocket already frames its messages and the
 * client is a browser.
 */
export const LiveSocketLayer: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | WsTickets | LiveTopics | Credentials
> = RpcServer.layer(live).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: LIVE_SOCKET_PATH })),
  Layer.provide(RpcSerialization.layerJson),
);
