/**
 * The join exchange. Outside the derived operation table because the caller is
 * not a user: a machine holding a join token has no credential, no grant and no
 * profile, and the token buys it exactly this one call.
 *
 * Outside the pre-setup gate too, because the controller's own runner joins at
 * first boot before anybody has set Hercule up. Nothing is opened by that: with no
 * minted token there is nothing to present.
 */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  internal,
  Unauthenticated,
  unauthenticated,
  Validation,
  validation,
  validationOf,
} from "@hercule/contract";
import { JoinRequest } from "@hercule/protocol";
import { bearerOf } from "../http/bearer";
import { responseFor } from "../http/envelope";
import { RunnerJoin } from "./join";

const JOIN_PATH = "/api/v1/runners/join";

const NO_TOKEN = "a join needs a join token as a bearer credential";

const NO_BODY = "a join takes a JSON body";

/**
 * A key nobody declared is an error rather than a dropped field, so a
 * misspelled `reserved` cannot enlist a shared machine while its owner believes
 * they asked for a personal one. It is set here rather than in the schema
 * because `closedStruct`, which does this for the derived payloads, lives in
 * `@hercule/contract`, and `@hercule/protocol` cannot reach it: the runner links
 * the protocol, and the contract pulls in the plugin host the runner's graph
 * must never touch.
 */
const CLOSED = { onExcessProperty: "error" } as const;

/**
 * Decoded here rather than by a derived route, because this one is not derived:
 * the caller holds a join token and no credential.
 */
const requestIn = Effect.mapError(HttpServerRequest.schemaBodyJson(JoinRequest, CLOSED), (error) =>
  error._tag === "SchemaError" ? validationOf(error) : validation([{ path: [], message: NO_BODY }]),
);

/** `201`: the answer is a runner that did not exist before the request. */
export const RunnerJoinRouteLayer = HttpRouter.add("POST", JOIN_PATH, (request) =>
  Effect.gen(function* () {
    const enlist = yield* RunnerJoin;
    const token = bearerOf(request);
    if (token === undefined) return responseFor(unauthenticated(NO_TOKEN));
    return yield* Effect.flatMap(requestIn, (body) =>
      enlist.join(token, body.reserved ?? false),
    ).pipe(
      Effect.map((answer) => HttpServerResponse.jsonUnsafe(answer, { status: 201 })),
      Effect.catch((error) =>
        error instanceof Unauthenticated || error instanceof Validation
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
