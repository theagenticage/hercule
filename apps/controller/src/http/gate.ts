/**
 * The pre-setup gate.
 *
 * Before the password exists, exactly two operations are reachable -
 * `setup.read` and `setup.complete` - and every other operation answers 401, a
 * valid-looking bearer included, because until setup completes there is no user
 * for one to belong to.
 *
 * The gate is route middleware rather than a wrapper around the whole
 * application, so what it decides on is the operation the router matched, not
 * the bytes in `request.url`. The router matches case-insensitively and
 * normalizes the path; a gate that read the raw URL disagreed with it, and
 * `POST /API/v1/AUTH/LOGIN` or `//api/v1/secrets` reached their operation
 * without passing the gate.
 *
 * A request that matches no route never reaches this middleware and answers 404
 * through the envelope, whatever its path: the gate does not decide whether the
 * static web bundle or an unknown path exists.
 *
 * Setup completes once and never un-completes, so the answer is read from the
 * database until it is yes and never again.
 */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { OPERATIONS, createUnauthenticatedError } from "@hercule/contract";
import { Setup } from "../setup";
import { responseFor } from "./envelope";

/** The two operations open before setup, as the routes the router matches. */
const OPEN_BEFORE_SETUP = new Set([
  `GET ${OPERATIONS["setup.read"].path}`,
  `POST ${OPERATIONS["setup.complete"].path}`,
]);

const NOT_SET_UP = "Hercule is not set up yet. Open the setup URL to finish first run.";

/**
 * The gate as one route middleware. Effectful because it takes the setup
 * service once and keeps the answer, rather than reading the row on every
 * request forever.
 */
export const setupGate = HttpRouter.middleware(
  Effect.gen(function* () {
    const setup = yield* Setup;
    let complete = false;

    const isComplete = Effect.suspend(() => {
      if (complete) return Effect.succeed(true);
      return Effect.map(Effect.orDie(setup.state()), (state) => {
        complete = state.complete;
        return complete;
      });
    });

    return (httpEffect) =>
      Effect.gen(function* () {
        const { route } = yield* HttpRouter.RouteContext;
        if (OPEN_BEFORE_SETUP.has(`${route.method} ${route.path}`)) return yield* httpEffect;
        if (yield* isComplete) return yield* httpEffect;
        return responseFor(createUnauthenticatedError(NOT_SET_UP));
      });
  }),
);
