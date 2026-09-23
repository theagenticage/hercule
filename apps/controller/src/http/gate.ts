/**
 * The pre-setup gate.
 *
 * Before the password exists, only two operations can be called: `setup.read`
 * and `setup.complete`. Every other operation returns 401, even with a
 * valid-looking bearer token, because until setup completes there is no user
 * for a token to belong to.
 *
 * The gate is route middleware rather than a wrapper around the whole
 * application, so it checks the operation the router matched, not the raw
 * `request.url`. The router matches case-insensitively and normalizes the
 * path. A gate that read the raw URL disagreed with the router, and requests
 * like `POST /API/v1/AUTH/LOGIN` or `//api/v1/secrets` reached their operation
 * without passing the gate.
 *
 * A request that matches no route never reaches this middleware, and gets a
 * 404 through the envelope, whatever its path. The gate does not decide
 * whether the static web bundle or an unknown path exists.
 *
 * Setup completes once and never reverts, so the gate reads the setup state
 * from the database only until it is complete.
 */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { OPERATIONS, createUnauthenticatedError } from "@hercule/contract";
import { Setup } from "../setup";
import { buildErrorResponse } from "./envelope";

/** The two operations open before setup, as `METHOD path` of the routes the router matches. */
const OPEN_BEFORE_SETUP = new Set([
  `GET ${OPERATIONS["setup.read"].path}`,
  `POST ${OPERATIONS["setup.complete"].path}`,
]);

const NOT_SET_UP = "Hercule is not set up yet. Open the setup URL to finish first run.";

/**
 * The gate, as route middleware. It is built with an effect so that it gets
 * the setup service once and remembers when setup is complete, rather than
 * reading the row on every request forever.
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
        return buildErrorResponse(createUnauthenticatedError(NOT_SET_UP));
      });
  }),
);
