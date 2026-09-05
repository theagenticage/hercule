/**
 * The one question a runner answers to nobody in particular: who is on this
 * machine?
 *
 * A browser can tell which controller it is talking to, but nothing in the
 * fleet listing says which of those machines is the one the person is sitting
 * at. Only a process on that machine can answer that, so the runner serves its
 * own id on loopback and the page asks 127.0.0.1 directly.
 *
 * Loopback is most of the security story, but not all of it: a name that
 * resolves to 127.0.0.1 is loopback too, so a page on any website could reach
 * this listener through the visitor's own browser and be answered as if it were
 * same-origin. The `Host` header is what tells the two apart, and it is checked
 * for that reason. What is behind it is only an id the fleet listing already
 * carries, so the cost of getting this wrong is small - but a listener every
 * runner holds open should not be readable by every page the machine's owner
 * visits.
 *
 * The port it is asked for is a preference, not a requirement: two runners on
 * one machine, or an unrelated service on the number, must not stop a runner
 * from starting. Whatever it ends up on is reported in the facts, so the
 * browser is told where to look.
 */
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
/** The only address the listener binds. */
const LOOPBACK = "127.0.0.1";

/** The only path it answers. */
const IDENTITY_PATH = "/identity";

/**
 * The only hosts a request may name. `localhost` is here beside the address
 * because a person diagnosing this by hand will type it, and being told there
 * is nothing there would be a lie.
 */
const LOOPBACK_HOSTS = new Set([LOOPBACK, "localhost"]);

export interface IdentityOptions {
  /** The id this machine's runner joined under. */
  readonly runnerId: string;
  /** The controller this runner belongs to; its origin is who may read the answer. */
  readonly controllerUrl: string;
  /** The port to prefer. Any free one will do when this one is taken. */
  readonly port: number;
}

/** Whether a request arrived at loopback by its address rather than by a name. */
const cameToLoopback = (request: Request): boolean => {
  const host = request.headers.get("host");
  if (host === null) return false;
  // Read as a URL rather than split on the last colon, so the port comes off
  // whatever shape the host is, and the name arrives lower-cased as host names
  // compare.
  const parsed = URL.parse(`http://${host}`);
  return parsed !== null && LOOPBACK_HOSTS.has(parsed.hostname);
};

/**
 * Answers the one path, to the one method, and nothing else.
 *
 * The CORS header names the controller's origin because that is where the page
 * asking comes from; a plain GET with no custom header needs no preflight, so
 * this single header is the whole of what a browser requires.
 */
const answer =
  (runnerId: string, allowOrigin: string) =>
  (request: Request): Response =>
    request.method === "GET" &&
    new URL(request.url).pathname === IDENTITY_PATH &&
    cameToLoopback(request)
      ? Response.json({ runnerId }, { headers: { "access-control-allow-origin": allowOrigin } })
      : new Response(null, { status: 404 });

/**
 * Serves `GET /identity` for as long as the scope is open, and says which port
 * it got.
 */
export const identityListener = (
  options: IdentityOptions,
): Effect.Effect<number, never, Scope.Scope> =>
  Effect.map(
    Effect.acquireRelease(
      Effect.gen(function* () {
        const fetch = answer(options.runnerId, new URL(options.controllerUrl).origin);
        const serve = (port: number) => Bun.serve({ hostname: LOOPBACK, port, fetch });
        const bound = yield* Effect.result(Effect.try(() => serve(options.port)));
        if (bound._tag === "Success") return bound.success;
        // Falling back is not a failure, but it does move where the browser has
        // to look, so it is never done quietly.
        yield* Effect.logWarning(`cannot answer on port ${String(options.port)}`, bound.failure);
        // A machine that will not give this process any port at all is not a
        // machine that can host sessions either, so there is nothing to fall
        // back to and nothing to carry on with.
        return yield* Effect.orDie(Effect.try(() => serve(0)));
      }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
    // A server has no port only when it was asked for a unix socket.
    (server) => server.port!,
  );
