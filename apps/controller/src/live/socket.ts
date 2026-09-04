/**
 * The live socket: the contract's RPC group, served at `GET /ws` beside the
 * API's own routes.
 *
 * A connection is nobody until `hello` succeeds. The ticket it presents is
 * spent there and the caller it resolved to is remembered for the length of the
 * connection, on the per-connection record the RPC server already keeps, so it
 * goes away with the connection and there is no map to clean up.
 *
 * Every refusal is one of the contract's errors and belongs to the one request
 * that earned it. That is why the payload schemas are wider than the values
 * they accept: a payload the transport itself cannot decode comes back as an
 * untyped defect, so the vocabulary `v` and `topic` accept is checked here,
 * where a `validation` can be raised for it and the connection stays up.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import {
  isAppendOnlyLiveTopic,
  live,
  LIVE_PROTOCOL_VERSION,
  LiveTopic,
  unauthenticated,
  validation,
  validationOf,
} from "@hydra/contract";
import { VERSION } from "@hydra/home/version";
import type { Actor } from "../actor";
import { WsTickets } from "./tickets";
import { LiveTopics } from "./topics";

/** Where the socket lives. The handshake carries no query string. */
const LIVE_SOCKET_PATH = "/ws";

const HELLO_FIRST = "this connection has not said hello";
const TICKET_REFUSED = "the ticket is not valid";

/**
 * The caller behind a connection, kept on the connection's own record. Present
 * only after `hello`, which is exactly what "authenticated" means here.
 */
class Greeted extends Context.Service<Greeted, Actor>()("hydra/controller/live/Greeted") {}

const greeted = (client: Rpc.ServerClient): boolean =>
  Context.getOrUndefined(client.annotations, Greeted) !== undefined;

const decodeTopic = Schema.decodeUnknownEffect(LiveTopic);

const handlers = live.toLayer(
  Effect.gen(function* () {
    const tickets = yield* WsTickets;
    const topics = yield* LiveTopics;

    return {
      hello: (payload, options) =>
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
          if (Option.isNone(actor)) {
            return yield* Effect.fail(unauthenticated(TICKET_REFUSED));
          }
          options.client.annotate(Greeted, actor.value);
          return { v: LIVE_PROTOCOL_VERSION, serverVersion: VERSION };
        }),

      subscribe: (payload, options) =>
        Effect.gen(function* () {
          if (!greeted(options.client)) {
            return yield* Effect.fail(unauthenticated(HELLO_FIRST));
          }
          const topic = yield* Effect.mapError(decodeTopic(payload.topic), validationOf);
          if (payload.cursor !== undefined && !isAppendOnlyLiveTopic(topic)) {
            return yield* Effect.fail(
              validation([
                {
                  path: ["cursor"],
                  message: `${topic} is not a log, so there is nothing to replay`,
                },
              ]),
            );
          }
          return yield* topics.subscribe(topic);
        }),

      ping: (_payload, options) =>
        greeted(options.client) ? Effect.succeed({}) : Effect.fail(unauthenticated(HELLO_FIRST)),
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
  HttpRouter.HttpRouter | WsTickets | LiveTopics
> = RpcServer.layer(live).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: LIVE_SOCKET_PATH })),
  Layer.provide(RpcSerialization.layerJson),
);
