/**
 * The join exchange, served beside the API's own routes.
 *
 * It is one request and one response, so it is HTTP rather than anything on the
 * socket, and it sits outside the derived operation table because the caller is
 * not a user: a machine holding a join token has no credential, no grant and no
 * profile, and the token it presents buys it exactly this one call.
 *
 * It is also outside the pre-setup gate, deliberately. The controller's own
 * local runner joins at first boot, before anybody has set Hydra up, with a
 * token the controller minted for it; a gated route would refuse it. Nothing is
 * opened by that: without a token minted through `runner.createJoinToken`, or
 * by the boot for its own child, there is nothing here to present.
 */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { internal, Unauthenticated, unauthenticated } from "@hydra/contract";
import { bearerOf } from "../http/bearer";
import { responseFor } from "../http/envelope";
import { RunnerJoin } from "./join";

/** Where a machine joins. Not in the operation table, so it is written here. */
const JOIN_PATH = "/api/v1/runners/join";

const NO_TOKEN = "a join needs a join token as a bearer credential";

/**
 * The join route. `201`: the answer is a runner that did not exist before the
 * request, and the credential in it is the only copy anybody will ever hold.
 */
export const RunnerJoinRouteLayer = HttpRouter.add("POST", JOIN_PATH, (request) =>
  Effect.gen(function* () {
    const enlist = yield* RunnerJoin;
    const token = bearerOf(request);
    if (token === undefined) return responseFor(unauthenticated(NO_TOKEN));
    return yield* enlist.join(token).pipe(
      Effect.map((answer) => HttpServerResponse.jsonUnsafe(answer, { status: 201 })),
      Effect.catch((error) =>
        error instanceof Unauthenticated
          ? Effect.succeed(responseFor(error))
          : Effect.as(
              Effect.logError("A machine presenting a join token could not be enlisted", error),
              responseFor(internal("something went wrong")),
            ),
      ),
    );
    // The derived routes get their span from the router middleware, which this
    // route sits outside of; without one it is the only call in the controller
    // whose service and repository work hangs off nothing.
  }).pipe(Effect.withSpan("runner.join")),
);
