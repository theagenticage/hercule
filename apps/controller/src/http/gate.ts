/**
 * The pre-setup gate (spec 15 section 7).
 *
 * Before the password exists, exactly two API surfaces are reachable and
 * everything else answers 401 - a valid-looking bearer included, because until
 * setup completes there is no user for one to belong to. The gate runs before
 * routing, so it covers every operation without each one knowing about it.
 *
 * Paths outside `/api/v1` are not the gate's business: the static web bundle is
 * always served, and until it is embedded those paths fall through to a 404.
 *
 * Setup completes once and never un-completes, so the answer is read from the
 * database until it is yes and never again.
 */
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type { HttpServerResponse } from "effect/unstable/http/HttpServerResponse";
import { API_PREFIX, OPERATIONS, unauthenticated } from "@hydra/contract";
import { Setup } from "../setup";
import { responseFor } from "./envelope";

/** The two operations of spec 15 section 7, as their routes. Neither takes a parameter. */
const OPEN_BEFORE_SETUP = new Set([
  `GET ${OPERATIONS["setup.read"].path}`,
  `POST ${OPERATIONS["setup.complete"].path}`,
]);

const NOT_SET_UP = "Hydra is not set up yet. Open the setup URL to finish first run.";

/**
 * Builds the gate. Effectful because it takes the setup service once and keeps
 * the answer, rather than reading the row on every request forever.
 */
export const makeSetupGate = Effect.gen(function* () {
  const setup = yield* Setup;
  let complete = false;

  const isComplete = Effect.suspend(() => {
    if (complete) return Effect.succeed(true);
    return Effect.map(Effect.orDie(setup.state()), (state) => {
      complete = state.complete;
      return complete;
    });
  });

  return <E, R>(
    app: Effect.Effect<HttpServerResponse, E, R>,
  ): Effect.Effect<HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest> =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = request.url.split("?")[0] ?? "/";
      const isApi = path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
      if (!isApi || OPEN_BEFORE_SETUP.has(`${request.method} ${path}`)) return yield* app;
      if (yield* isComplete) return yield* app;
      return responseFor(unauthenticated(NOT_SET_UP));
    });
});
