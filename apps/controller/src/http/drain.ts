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
 *    socket upgrade included. It returns once every request admitted before
 *    has finished, so a request waiting for a runner's reply still gets it.
 *    An open socket does not count: its request is only waiting for the
 *    connection to end.
 * 2. `closeSockets`: closes every socket with the going-away code, then waits
 *    until the route that served each one has ended. A runner's route records
 *    that the runner left as it ends, so that write is done when this returns.
 *
 * `admit` counts every admitted request until its request scope closes, not
 * until its handler returns. The handler of a streamed response returns
 * before the body is sent, and the platform moves the scope onto the body
 * stream, so the scope closes when the last byte has been sent. A request
 * that asks for a WebSocket is counted like any other: a route may still
 * answer it as a plain request, and wait for a runner while it does.
 *
 * A route serves a WebSocket only through `serveSocket`. That is what makes
 * every open socket known to the drain, and what keeps a socket from opening
 * after the drain has begun. A request counts as a socket from the moment
 * `serveSocket` registers it, so `finishRequests` waits for the requests that
 * are not sockets: the requests in flight minus the sockets registered.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import type { HttpServerError } from "effect/http/HttpServerError";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Socket from "effect/socket/Socket";
import { GOING_AWAY_CLOSE_CODE } from "@hercule/protocol";

/**
 * The reason sent with the going-away close. A WebSocket close reason holds at
 * most 123 bytes.
 */
const STOPPING_CLOSE_REASON = "the controller is stopping";

const STOPPING_MESSAGE = "Hercule is stopping; try again once it is back.";

/**
 * Builds the answer to a request that arrives once the drain has begun: a
 * bare 503 with a plain-text message, outside the error envelope, like the
 * transport's bare 413. The contract has no error code that renders as 503
 * and means "stopping" (`controller_sealed` carries the address of a new
 * machine, and there is none), and `internal` renders as 500. The connection
 * is closed, so a client does not send its next request on it.
 */
const buildStoppingResponse = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(STOPPING_MESSAGE, { status: 503, headers: { connection: "close" } });

/** An open socket as the drain holds it: the effect that closes it with the going-away code. */
type CloseSocket = Effect.Effect<void>;

const make = Effect.sync(() => {
  let draining = false;

  let requestsInFlight = 0;
  const openSockets = new Set<CloseSocket>();
  // Open while no request is in flight apart from the open sockets', and
  // while no socket is open.
  const requestsFinished = Latch.makeUnsafe(true);
  const noOpenSockets = Latch.makeUnsafe(true);

  /** Opens or closes the two latches to match the counts. Call it after every change of them. */
  const settle = (): void => {
    if (requestsInFlight <= openSockets.size) requestsFinished.openUnsafe();
    else requestsFinished.closeUnsafe();
    if (openSockets.size === 0) noOpenSockets.openUnsafe();
    else noOpenSockets.closeUnsafe();
  };

  /**
   * Admits a request, unless the drain has begun. The check and the count are
   * one synchronous step, so no request is admitted after `finishRequests`
   * began waiting.
   */
  const admitRequest = Effect.sync((): boolean => {
    if (draining) return false;
    requestsInFlight++;
    settle();
    return true;
  });

  const endRequest = Effect.sync(() => {
    requestsInFlight--;
    settle();
  });

  /**
   * Upgrades the request, takes the socket's writer and registers the socket.
   * The registration follows the platform's upgrade with nothing in between
   * that could be interrupted or could wait.
   *
   * The platform's upgrade waits for Bun's `open` callback, which comes after
   * the handshake. A peer that never completes the handshake keeps this
   * waiting, and its request stays counted as in flight, so only the drain
   * deadline ends the wait.
   */
  const openSocket = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const socket = yield* request.upgrade;
      const { write } = yield* socket.writer;
      // Closing a socket that is already closed does nothing.
      const close: CloseSocket = Effect.ignore(
        write(new Socket.CloseEvent(GOING_AWAY_CLOSE_CODE, STOPPING_CLOSE_REASON)),
      );
      yield* Effect.sync(() => {
        openSockets.add(close);
        settle();
      });
      return { socket, close };
    });

  /** Closes the socket if it is still open, and forgets it. */
  const closeAndForget = (close: CloseSocket) =>
    Effect.andThen(
      close,
      Effect.sync(() => {
        openSockets.delete(close);
        settle();
      }),
    );

  return {
    /**
     * Wraps the application. Once the drain has begun, answers every request
     * with the 503 and runs nothing. Before that, counts every request, one
     * that asks for a WebSocket included, until its request scope closes.
     *
     * The check, the count and the registration of the count's release on the
     * request scope are one step that cannot be interrupted, so a request is
     * never counted without being released.
     */
    admit: <E, R>(
      app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    ): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | Scope.Scope> =>
      Effect.gen(function* () {
        const admitted = yield* Effect.acquireRelease(admitRequest, (wasAdmitted) =>
          wasAdmitted ? endRequest : Effect.void,
        );
        if (!admitted) return buildStoppingResponse();
        return yield* app;
      }),

    /**
     * Serves a WebSocket: upgrades the request, runs `body` with the socket,
     * and returns the route's response. Once the drain has begun, runs
     * nothing and returns the bare 503. After `body` ends, returns an empty
     * response, because an upgraded request has no response left to send.
     * Fails with the platform's error when the request cannot be upgraded,
     * and with `body`'s errors.
     *
     * The check at the start and the registration after the platform's
     * upgrade are both synchronous, and the acquire is uninterruptible, so no
     * socket is left open and unknown to the drain. A request admitted before
     * the drain but upgrading after it is refused. When `body` ends, the
     * socket gets the going-away close if it is still open, and is forgotten.
     */
    serveSocket: <E, R>(
      request: HttpServerRequest.HttpServerRequest,
      body: (socket: Socket.Socket) => Effect.Effect<unknown, E, R>,
    ): Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      E | HttpServerError,
      Exclude<R, Scope.Scope>
    > =>
      Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* Effect.acquireRelease(
            Effect.suspend(
              (): Effect.Effect<
                { readonly socket: Socket.Socket; readonly close: CloseSocket } | undefined,
                HttpServerError,
                Scope.Scope
              > => (draining ? Effect.succeed(undefined) : openSocket(request)),
            ),
            (one) => (one === undefined ? Effect.void : closeAndForget(one.close)),
          );
          if (opened === undefined) return buildStoppingResponse();
          yield* body(opened.socket);
          return HttpServerResponse.empty();
        }),
      ),

    /**
     * Begins the drain, then waits until every request admitted before it has
     * finished. Open sockets are not waited for. Safe to call more than once.
     */
    finishRequests: Effect.suspend(() => {
      draining = true;
      return requestsFinished.await;
    }),

    /**
     * Closes every open socket with the going-away code, then waits until
     * every one has been forgotten, which happens when its route has ended.
     */
    closeSockets: Effect.suspend(() =>
      Effect.andThen(
        Effect.forEach([...openSockets], (close) => close, { discard: true }),
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
