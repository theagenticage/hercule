/**
 * The live socket: the contract's RPC group, served at `GET /ws` beside the
 * API's own routes.
 *
 * A connection is nobody until `hello` succeeds. The ticket it presents is
 * spent there and the caller it resolved to is remembered for the length of the
 * connection, on the per-connection record the RPC server already keeps, so it
 * goes away with the connection and there is no map to clean up. The greeting
 * is claimed before the ticket is looked up, so two `hello` frames sent at once
 * cannot both win: swapping the caller under subscriptions that are already
 * open would leave the connection reading as somebody it was not opened as.
 *
 * Being greeted is not permanent. A socket outlives a request by hours, and the
 * credential behind it can be logged out or revoked in that time. Every call on
 * the connection resolves that credential again, and because a client that
 * stops calling would otherwise keep reading for ever, a sweep does the same
 * for every connection that is holding a subscription. Either way, a connection
 * whose credential is gone loses what it had open and is refused from then on.
 *
 * Every refusal is one of the contract's errors and belongs to the one request
 * that earned it. That is why the payload schemas are wider than the values
 * they accept: a payload the transport itself cannot decode comes back as an
 * untyped defect, so the vocabulary `v`, `topic` and `cursor` accept is checked
 * here, where a `validation` can be raised for it and the connection stays up.
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
  internal,
  invalidState,
  isAppendOnlyLiveTopic,
  live,
  LIVE_PROTOCOL_VERSION,
  LiveTopic,
  parseSessionTopic,
  unauthenticated,
  validation,
  validationOf,
  type Internal,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { VERSION } from "@hydra/home/version";
import { CurrentActor, requireGrant, type UserActor } from "../actor";
import { Credentials } from "../credentials";
import { WsTickets } from "./tickets";
import { LiveTopics, type LiveQueue } from "./topics";

/** Where the socket lives. The handshake carries no query string. */
const LIVE_SOCKET_PATH = "/ws";

/**
 * How often a connection that has stopped calling has its credential looked at
 * again. Short enough that a revocation takes effect while the person who asked
 * for it is still watching.
 */
const REVOCATION_SWEEP = Duration.seconds(30);

const HELLO_FIRST = "this connection has not said hello";
const HELLO_ONCE = "this connection has already said hello";
const TICKET_REFUSED = "the ticket is not valid";
const CREDENTIAL_GONE = "the credential this connection was opened with is no longer valid";
const UNREADABLE = "the credential behind this connection could not be checked";

/** A position in a log, as a client hands one back: a decimal, and nothing else. */
const CURSOR = /^\d+$/;

/**
 * A cursor from the wire, decoded to the position it names - `undefined` for
 * one not given, which is what asks to follow from the head. Shared by `event`
 * and `session:<id>:stream`, the two topics a position means anything on.
 */
const parsePosition = (raw: string | undefined): Effect.Effect<number | undefined, Validation> => {
  if (raw === undefined) return Effect.succeed(undefined);
  const cursor = Number(raw);
  if (!CURSOR.test(raw) || !Number.isSafeInteger(cursor)) {
    return Effect.fail(
      validation([{ path: ["cursor"], message: "a position in the log is a whole number" }]),
    );
  }
  return Effect.succeed(cursor);
};

/**
 * What the controller holds for one greeted connection: who it is, and what it
 * has open, so that all of it can be ended at once when the credential behind
 * it goes away.
 *
 * `actor` is undefined while a `hello` is still being answered, which is what
 * makes the greeting a claim rather than a check.
 */
interface Connection {
  actor: UserActor | undefined;
  greeting: boolean;
  gone: boolean;
  readonly open: Set<LiveQueue>;
}

/**
 * The connection's own record, kept on the connection. Present from the moment
 * a `hello` starts being answered; carrying an actor is what "authenticated"
 * means here.
 */
class Greeted extends Context.Service<Greeted, Connection>()("hydra/controller/live/Greeted") {}

const decodeSchemaTopic = Schema.decodeUnknownEffect(LiveTopic);

/**
 * The schema only proves the wire shape - a flat literal or `session:<id>:kind`
 * - and a pattern check cannot itself carry the literal precision `LiveTopic`
 * is typed with, so a value that decoded is asserted into it here, the one
 * place a session topic's string is trusted to be the shape it matched.
 */
const decodeTopic = (raw: unknown) =>
  Effect.map(decodeSchemaTopic(raw), (topic) => topic as LiveTopic);

const handlers = live.toLayer(
  Effect.gen(function* () {
    const tickets = yield* WsTickets;
    const topics = yield* LiveTopics;
    const credentials = yield* Credentials;

    /** The connections holding a subscription, which are the ones still reading. */
    const watching = new Set<Connection>();

    /**
     * Whether the credential a connection was opened with still resolves. The
     * token itself was never kept - only the hash it resolved through - which
     * is all a second lookup needs.
     */
    const stillThere = (actor: UserActor): Effect.Effect<boolean, Internal> =>
      Effect.mapError(credentials.stillLive(actor.credential), () => internal(UNREADABLE));

    /**
     * Takes everything away from a connection whose credential has gone. A
     * subscription is a standing read, and it stops when the permission to read
     * stops rather than at the next thing the client happens to ask for.
     */
    const revoke = (connection: Connection): Effect.Effect<void> =>
      Effect.gen(function* () {
        connection.gone = true;
        watching.delete(connection);
        const gone = unauthenticated(CREDENTIAL_GONE);
        yield* Effect.forEach(connection.open, (queue) => topics.end(queue, gone), {
          discard: true,
        });
        connection.open.clear();
      });

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep(REVOCATION_SWEEP);
          // Several connections usually share one credential - a tab per
          // screen - and every read here queues behind the controller's writes,
          // so each credential is looked up once per round.
          const resolved = new Map<string, boolean>();
          for (const connection of [...watching]) {
            const actor = connection.actor;
            if (actor === undefined) continue;
            const hash = actor.credential.tokenHash;
            let alive = resolved.get(hash);
            if (alive === undefined) {
              // A database that will not answer is not grounds for logging
              // anybody out; the round after this one asks again.
              alive = yield* Effect.catchCause(stillThere(actor), (cause) =>
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
     * The connection behind a call, or the reason there is none. Every call
     * re-resolves the credential, so a client that keeps talking learns at once
     * that it has been logged out.
     */
    const caller = (
      client: Rpc.ServerClient,
    ): Effect.Effect<
      { readonly connection: Connection; readonly actor: UserActor },
      Unauthenticated | Internal
    > =>
      Effect.gen(function* () {
        const connection = Context.getOrUndefined(client.annotations, Greeted);
        const actor = connection?.actor;
        if (connection === undefined || actor === undefined) {
          return yield* Effect.fail(unauthenticated(HELLO_FIRST));
        }
        if (connection.gone) return yield* Effect.fail(unauthenticated(CREDENTIAL_GONE));
        if (yield* stillThere(actor)) return { connection, actor };
        yield* revoke(connection);
        return yield* Effect.fail(unauthenticated(CREDENTIAL_GONE));
      });

    /**
     * Takes out a subscription and remembers it on the connection, so it can be
     * ended when the connection's credential goes. The connection is checked
     * again once the subscription exists, because a revocation that ran while it
     * was being taken out would have swept a set this queue was not yet in.
     */
    const held = <E, R>(
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
          yield* topics.end(queue, unauthenticated(CREDENTIAL_GONE));
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
            return yield* Effect.fail(invalidState(HELLO_ONCE));
          }
          // Claimed before anything is looked up, and given back if this
          // greeting does not succeed, so a client whose first try was refused
          // can try again.
          connection.greeting = true;
          return yield* Effect.ensuring(
            Effect.gen(function* () {
              if (payload.v !== LIVE_PROTOCOL_VERSION) {
                return yield* Effect.fail(
                  validation([
                    {
                      path: ["v"],
                      message: `this controller speaks live protocol version ${LIVE_PROTOCOL_VERSION}`,
                    },
                  ]),
                );
              }
              const actor = yield* tickets.consume(payload.ticket);
              // A ticket outlives the credential that fetched it by up to five
              // minutes, so the greeting checks that credential rather than
              // trusting what the ticket was minted for.
              if (Option.isNone(actor) || !(yield* stillThere(actor.value))) {
                return yield* Effect.fail(unauthenticated(TICKET_REFUSED));
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
          const { connection, actor } = yield* caller(options.client);
          const topic = yield* Effect.mapError(decodeTopic(payload.topic), validationOf);
          const session = parseSessionTopic(topic);

          if (session?.kind === "tap") {
            if (payload.cursor !== undefined) {
              return yield* Effect.fail(
                validation([
                  {
                    path: ["cursor"],
                    message: `${topic} never replays, so there is nothing to resume from`,
                  },
                ]),
              );
            }
            // A tap is transcript content before it is a row, so it needs
            // exactly what reading the transcript over HTTP needs - the same
            // operation the `:stream` topic below names.
            yield* Effect.provideService(requireGrant("transcript.read"), CurrentActor, actor);
            return yield* held(connection, topics.tapSession(session.sessionId));
          }

          if (session?.kind === "stream") {
            const cursor = yield* parsePosition(payload.cursor);
            // The transcript's deltas are the transcript, so this stream needs
            // what reading it over HTTP needs.
            yield* Effect.provideService(requireGrant("transcript.read"), CurrentActor, actor);
            return yield* held(connection, topics.followSession(session.sessionId, cursor));
          }

          if (!isAppendOnlyLiveTopic(topic)) {
            if (payload.cursor !== undefined) {
              return yield* Effect.fail(
                validation([
                  {
                    path: ["cursor"],
                    message: `${topic} is not a log, so there is nothing to replay`,
                  },
                ]),
              );
            }
            // A mutable topic carries no records, so being greeted is the whole
            // of what it asks for.
            return yield* held(connection, topics.subscribe(topic));
          }
          const cursor = yield* parsePosition(payload.cursor);
          // The log's deltas are the log, so this stream needs what reading the
          // log over HTTP needs.
          yield* Effect.provideService(requireGrant("event.query"), CurrentActor, actor);
          return yield* held(connection, topics.follow(cursor));
        }),

      ping: (_payload, options) => Effect.as(caller(options.client), {}),
    };
  }),
);

/**
 * The socket, as a route on the current router. JSON framing, because a
 * WebSocket frames its own messages and the client is a browser.
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
