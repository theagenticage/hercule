/**
 * The listener's drain: what lets the controller stop in milliseconds even
 * when runners and apps are connected.
 *
 * Bun's graceful stop waits for every open connection. A WebSocket never
 * closes by itself, so without this a stop with one attached waits for the
 * full drain deadline. The drain does the waiting itself, in two steps the
 * controller runs one after the other (`../index.ts`):
 *
 * 1. `finishRequests`: from now on every new request is refused with a 503, a
 *    socket upgrade included. It returns once every plain request admitted
 *    before has finished, so a request waiting for a runner's reply still gets
 *    it.
 * 2. `closeSockets`: closes every socket with the going-away code, then waits
 *    until the route that served each one has ended. A runner's route records
 *    that the runner left as it ends, so that write is done when this returns.
 *
 * A request is counted until its request scope closes, not until its handler
 * returns. The handler of a streamed response returns before the body is
 * sent, and the platform moves the scope onto the body stream, so the scope
 * closes when the last byte has been sent.
 *
 * A route upgrades a request only through `upgrade`. That is what makes every
 * open socket known to the drain, and what keeps a socket from opening after
 * the drain has begun.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import type { HttpServerError } from "effect/http/HttpServerError";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Socket from "effect/socket/Socket";
import { createInternalError } from "@hercule/contract";
import { GOING_AWAY_CLOSE_CODE } from "@hercule/protocol";
import { buildErrorResponse } from "./envelope";

/**
 * The reason sent with the going-away close. A WebSocket close reason holds at
 * most 123 bytes.
 */
const STOPPING_CLOSE_REASON = "the controller is stopping";

const STOPPING_MESSAGE = "Hercule is stopping; try again once it is back.";

/** The error `upgrade` fails with once the drain has begun. */
export class ListenerStopping extends Data.TaggedError("ListenerStopping") {}

/**
 * Builds the answer to a request that arrives once the drain has begun: a 503
 * with the error envelope. The contract has no error code for "unavailable"
 * (`controller_sealed` carries the address of a new machine, and there is
 * none), so the body uses `internal`, which clients show as a plain message.
 */
export const buildStoppingResponse = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.setStatus(buildErrorResponse(createInternalError(STOPPING_MESSAGE)), 503);

/** A socket the drain knows about: the effect that closes it. */
interface OpenSocket {
  readonly close: Effect.Effect<void>;
}

/** What opening a socket returns: the socket for the route, and the drain's record of it. */
interface OpenedSocket {
  readonly socket: Socket.Socket;
  readonly open: OpenSocket;
}

const make = Effect.sync(() => {
  let draining = false;

  // Each latch is open while its count is zero, so waiting for "none left"
  // is waiting for the latch.
  let requestsInFlight = 0;
  const noRequestsInFlight = Latch.makeUnsafe(true);
  const openSockets = new Set<OpenSocket>();
  const noOpenSockets = Latch.makeUnsafe(true);

  const startRequest = Effect.sync(() => {
    requestsInFlight++;
    noRequestsInFlight.closeUnsafe();
  });
  const endRequest = Effect.sync(() => {
    requestsInFlight--;
    if (requestsInFlight === 0) noRequestsInFlight.openUnsafe();
  });

  /**
   * Upgrades the request, takes the socket's writer and registers the socket.
   * The upgrade counts as a request in flight until the socket is registered,
   * so `finishRequests` also waits for an upgrade that started before it.
   */
  const openSocket = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<OpenedSocket, HttpServerError, Scope.Scope> =>
    Effect.andThen(
      startRequest,
      Effect.gen(function* () {
        const socket = yield* request.upgrade;
        const { write } = yield* socket.writer;
        const open: OpenSocket = {
          // Closing a socket that is already closed does nothing.
          close: Effect.ignore(
            write(new Socket.CloseEvent(GOING_AWAY_CLOSE_CODE, STOPPING_CLOSE_REASON)),
          ),
        };
        openSockets.add(open);
        noOpenSockets.closeUnsafe();
        return { socket, open };
      }).pipe(Effect.ensuring(endRequest)),
    );

  const closeAndForget = ({ open }: OpenedSocket) =>
    Effect.andThen(
      open.close,
      Effect.sync(() => {
        openSockets.delete(open);
        if (openSockets.size === 0) noOpenSockets.openUnsafe();
      }),
    );

  return {
    /**
     * Wraps the whole application. Once the drain has begun, answers every
     * request with the 503 and runs nothing. Before that, counts a request
     * until its request scope closes. A request that asks for a WebSocket is
     * not counted, because its scope lasts as long as the connection.
     */
    track: <E, R>(
      app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    ): Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      E,
      R | HttpServerRequest.HttpServerRequest | Scope.Scope
    > =>
      Effect.gen(function* () {
        if (draining) return buildStoppingResponse();
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers["upgrade"]?.toLowerCase() !== "websocket") {
          yield* Effect.acquireRelease(startRequest, () => endRequest);
        }
        return yield* app;
      }),

    /**
     * Upgrades a request to a WebSocket and registers the socket until the
     * scope closes. Fails with `ListenerStopping` once the drain has begun,
     * so a route turns that into `buildStoppingResponse()`; fails with the
     * platform's error when the request cannot be upgraded.
     *
     * The check, the upgrade and the registration are one step that cannot be
     * interrupted, so no socket is left open and unknown to the drain.
     * Closing the scope sends the going-away close, if the socket is still
     * open, and forgets the socket.
     */
    upgrade: (
      request: HttpServerRequest.HttpServerRequest,
    ): Effect.Effect<Socket.Socket, ListenerStopping | HttpServerError, Scope.Scope> =>
      Effect.acquireRelease(
        Effect.suspend(
          (): Effect.Effect<OpenedSocket, ListenerStopping | HttpServerError, Scope.Scope> =>
            draining ? Effect.fail(new ListenerStopping()) : openSocket(request),
        ),
        closeAndForget,
      ).pipe(Effect.map(({ socket }) => socket)),

    /**
     * Begins the drain, then waits until every request admitted before it has
     * finished. Safe to call more than once.
     */
    finishRequests: Effect.suspend(() => {
      draining = true;
      return noRequestsInFlight.await;
    }),

    /**
     * Closes every open socket with the going-away code, then waits until
     * every one has been forgotten, which happens when its route has ended.
     */
    closeSockets: Effect.suspend(() =>
      Effect.andThen(
        Effect.forEach([...openSockets], (open) => open.close, { discard: true }),
        noOpenSockets.await,
      ),
    ),
  };
});

/** The listener's drain. */
export class ListenerDrain extends Context.Service<ListenerDrain, Effect.Success<typeof make>>()(
  "hercule/controller/http/ListenerDrain",
) {}

export const ListenerDrainLayer: Layer.Layer<ListenerDrain> = Layer.effect(ListenerDrain)(make);
