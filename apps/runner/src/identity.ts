/**
 * Serves this runner's id on loopback, so the web app can tell which runner is
 * on the machine the user is sitting at. The fleet list cannot show that, so
 * the page asks 127.0.0.1 directly.
 *
 * Any DNS name that resolves to 127.0.0.1 also reaches this listener. So a
 * page on any website could query it through the visitor's browser, and would
 * get a response as if it were same-origin. The server checks the `Host`
 * header to reject those requests.
 *
 * The port is a preference, because two runners on one machine must both be
 * able to start. The web app only tries a small fixed set of ports, so the
 * server tries those first and then takes any free port. A runner on a port
 * outside the set still runs, but the web app cannot recognise it.
 */
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { IDENTITY_PORT_COUNT } from "@hercule/protocol";
const LOOPBACK = "127.0.0.1";

const IDENTITY_PATH = "/identity";

/** Includes `localhost` because a person debugging this by hand will type it. */
const LOOPBACK_HOSTS = new Set([LOOPBACK, "localhost"]);

export interface IdentityOptions {
  readonly runnerId: string;
  /** Only pages from this URL's origin may read the response. */
  readonly controllerUrl: string;
  /** The first port to try. When it is taken, the next few ports are tried. */
  readonly port: number;
}

const isLoopbackRequest = (request: Request): boolean => {
  const host = request.headers.get("host");
  if (host === null) return false;
  // Parse the header as a URL instead of splitting on the last colon. That
  // strips the port from any host shape and lower-cases the name.
  const parsed = URL.parse(`http://${host}`);
  return parsed !== null && LOOPBACK_HOSTS.has(parsed.hostname);
};

/**
 * Returns the request handler for `GET /identity`. Any other request gets a
 * 404.
 *
 * The CORS header allows the controller's origin, because the web app is
 * served from there. A plain GET needs no preflight, so this one header is all
 * a browser needs.
 */
const buildIdentityHandler =
  (runnerId: string, allowOrigin: string) =>
  (request: Request): Response =>
    request.method === "GET" &&
    new URL(request.url).pathname === IDENTITY_PATH &&
    isLoopbackRequest(request)
      ? Response.json({ runnerId }, { headers: { "access-control-allow-origin": allowOrigin } })
      : new Response(null, { status: 404 });

/** Serves `GET /identity` while the scope is open. Returns the port the server bound. */
export const serveIdentity = (
  options: IdentityOptions,
): Effect.Effect<number, never, Scope.Scope> =>
  Effect.map(
    Effect.acquireRelease(
      Effect.gen(function* () {
        const fetch = buildIdentityHandler(options.runnerId, new URL(options.controllerUrl).origin);
        const serve = (port: number) => Bun.serve({ hostname: LOOPBACK, port, fetch });
        for (let offset = 0; offset < IDENTITY_PORT_COUNT; offset += 1) {
          const port = options.port + offset;
          const bound = yield* Effect.result(Effect.try(() => serve(port)));
          if (bound._tag === "Success") return bound.success;
          // Not a failure, but the web app may now miss this runner, so log it.
          yield* Effect.logWarning(`cannot listen on port ${String(port)}`, bound.failure);
        }
        // The web app does not try ports outside the set, so a random port is
        // only useful to a person with `curl`. That is still better than a
        // runner that does not start.
        yield* Effect.logWarning(
          `none of the ${String(IDENTITY_PORT_COUNT)} ports from ${String(options.port)} was free; ` +
            "the web app cannot recognise this machine",
        );
        // A machine with no free port at all cannot host sessions either, so
        // the runner stops here with a defect.
        return yield* Effect.orDie(Effect.try(() => serve(0)));
      }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
    // A server has no port only when it listens on a unix socket.
    (server) => server.port!,
  );
