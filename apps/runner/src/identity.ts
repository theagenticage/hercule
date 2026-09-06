/**
 * Who is on this machine? Nothing in a fleet listing says which member the
 * person is sitting at, so the runner serves its own id on loopback and the page
 * asks 127.0.0.1 directly.
 *
 * A name that resolves to 127.0.0.1 is loopback too, so a page on any website
 * could reach this listener through the visitor's browser and be answered as if
 * it were same-origin. The `Host` header is what tells the two apart.
 *
 * The port is a preference: two runners on one machine must not stop either from
 * starting. A browser may only ask a small fixed set of ports, so the search
 * walks that set before it takes anything free, and a runner outside it still
 * runs without being recognisable in a page.
 */
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { IDENTITY_PORT_COUNT } from "@hydra/protocol";
const LOOPBACK = "127.0.0.1";

const IDENTITY_PATH = "/identity";

/** `localhost` is here because a person diagnosing this by hand will type it. */
const LOOPBACK_HOSTS = new Set([LOOPBACK, "localhost"]);

export interface IdentityOptions {
  readonly runnerId: string;
  /** Its origin is who may read the answer. */
  readonly controllerUrl: string;
  /** The first port to try; the next few will do when it is taken. */
  readonly port: number;
}

const cameToLoopback = (request: Request): boolean => {
  const host = request.headers.get("host");
  if (host === null) return false;
  // Read as a URL rather than split on the last colon, so the port comes off
  // whatever shape the host is and the name arrives lower-cased.
  const parsed = URL.parse(`http://${host}`);
  return parsed !== null && LOOPBACK_HOSTS.has(parsed.hostname);
};

/**
 * The CORS header names the controller's origin because that is where the asking
 * page comes from, and a plain GET needs no preflight, so it is all a browser wants.
 */
const answer =
  (runnerId: string, allowOrigin: string) =>
  (request: Request): Response =>
    request.method === "GET" &&
    new URL(request.url).pathname === IDENTITY_PATH &&
    cameToLoopback(request)
      ? Response.json({ runnerId }, { headers: { "access-control-allow-origin": allowOrigin } })
      : new Response(null, { status: 404 });

/** Serves `GET /identity` while the scope is open, and says which port it got. */
export const identityListener = (
  options: IdentityOptions,
): Effect.Effect<number, never, Scope.Scope> =>
  Effect.map(
    Effect.acquireRelease(
      Effect.gen(function* () {
        const fetch = answer(options.runnerId, new URL(options.controllerUrl).origin);
        const serve = (port: number) => Bun.serve({ hostname: LOOPBACK, port, fetch });
        for (let offset = 0; offset < IDENTITY_PORT_COUNT; offset += 1) {
          const port = options.port + offset;
          const bound = yield* Effect.result(Effect.try(() => serve(port)));
          if (bound._tag === "Success") return bound.success;
          // Not a failure, but it moves where the browser looks, so never quiet.
          yield* Effect.logWarning(`cannot answer on port ${String(port)}`, bound.failure);
        }
        // Past the ports a browser may ask, this is only good to a person with
        // `curl`. Better that than a runner that will not start.
        yield* Effect.logWarning(
          `no port from ${String(options.port)} on was free; ` +
            "this machine cannot be recognised in a browser",
        );
        // A machine that will give up no port at all cannot host sessions either.
        return yield* Effect.orDie(Effect.try(() => serve(0)));
      }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
    // A server has no port only when it was asked for a unix socket.
    (server) => server.port!,
  );
