/**
 * The join exchange. Outside the derived operation table because the caller is
 * not a user: a machine holding a join token has no credential, no grant and no
 * profile, and the token buys it exactly this one call.
 *
 * Outside the pre-setup gate too, because the controller's own runner joins at
 * first boot before anybody has set Hydra up. Nothing is opened by that: with no
 * minted token there is nothing to present.
 */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { internal, Unauthenticated, unauthenticated } from "@hydra/contract";
import { bearerOf } from "../http/bearer";
import { responseFor } from "../http/envelope";
import { RunnerJoin } from "./join";

const JOIN_PATH = "/api/v1/runners/join";

const NO_TOKEN = "a join needs a join token as a bearer credential";

/** `201`: the answer is a runner that did not exist before the request. */
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
    // route sits outside of.
  }).pipe(Effect.withSpan("runner.join")),
);
