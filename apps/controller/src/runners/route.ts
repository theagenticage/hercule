/**
 * The HTTP route for joining a runner. It is not in the derived operation
 * table, because the caller is not a user: a runner holding a join token has no
 * credential, no grant and no profile, and the token allows exactly this one
 * call.
 *
 * It is also outside the pre-setup gate, because the controller's own runner
 * joins at first boot, before anybody has set Hercule up. That opens nothing:
 * without a created join token there is nothing to present.
 */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  createDecodeValidationError,
  createUnauthenticatedError,
  createValidationError,
} from "@hercule/contract";
import { JoinRequest } from "@hercule/protocol";
import { readBearerToken } from "../http/bearer";
import { buildErrorResponse, respondToFailures } from "../http/envelope";
import { RunnerJoin } from "./join";

const JOIN_PATH = "/api/v1/runners/join";

const NO_TOKEN = "joining needs a join token as the bearer credential";

const NO_BODY = "the join request needs a JSON body";

/**
 * Makes an unknown key an error rather than a dropped field, so a misspelled
 * `reserved` cannot join a shared runner while its owner believes they asked
 * for a personal one. It is set here rather than in the schema because
 * `closedStruct`, which does this for the derived payloads, lives in
 * `@hercule/contract`, and `@hercule/protocol` cannot import it: the runner
 * imports the protocol, and the contract pulls in the plugin host, which the
 * runner's import graph must never reach.
 */
const CLOSED = { onExcessProperty: "error" } as const;

/**
 * The join request's body, decoded. Fails with `Validation` when the body is
 * not JSON or does not match `JoinRequest`. It is decoded here, not by a
 * derived route, because this route is not derived: the caller holds a join
 * token and no credential.
 */
const joinRequestBody = Effect.mapError(
  HttpServerRequest.schemaBodyJson(JoinRequest, CLOSED),
  (error) =>
    error._tag === "SchemaError"
      ? createDecodeValidationError(error)
      : createValidationError([{ path: [], message: NO_BODY }]),
);

/** Returns `201`, because the response is a runner that did not exist before the request. */
export const RunnerJoinRouteLayer = HttpRouter.add("POST", JOIN_PATH, (request) =>
  Effect.gen(function* () {
    const enlist = yield* RunnerJoin;
    const token = readBearerToken(request);
    if (token === undefined) return buildErrorResponse(createUnauthenticatedError(NO_TOKEN));
    return yield* Effect.flatMap(joinRequestBody, (body) =>
      enlist.join(token, body.reserved ?? false),
    ).pipe(
      Effect.map((answer) => HttpServerResponse.jsonUnsafe(answer, { status: 201 })),
      respondToFailures("A runner presenting a join token could not join"),
    );
    // The derived routes get their span from the router middleware, which this
    // route sits outside of.
  }).pipe(Effect.withSpan("runner.join")),
);
