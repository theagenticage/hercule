/**
 * Checks the runner credential on the HTTP routes a runner calls outside the
 * operation table: the attachment routes and the Skill Revision fetch. These
 * routes sit outside the derived operation table because no operation
 * accepts a runner's credential and no grant applies to it.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { createUnauthenticatedError } from "@hercule/contract";
import { readBearerToken } from "../http/bearer";
import { buildErrorResponse, respondToFailures } from "../http/envelope";
import { RunnerConnections } from "./connections";

const UNKNOWN_CREDENTIAL = "unknown credential";

/**
 * Checks the runner credential the request carries, then runs `respond` with
 * the id of the runner that holds it, and returns `respond`'s response.
 * `action` names what the runner is doing, as in "fetching an attachment",
 * for the messages. Returns:
 *
 * - `401` without a credential, or with one no runner holds;
 * - the error envelope when `respond` fails with an error of the contract,
 *   such as `NotFound` or `Validation`;
 * - `500` for any other failure, which is logged.
 */
export const respondToRunner = <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  action: string,
  respond: (runnerId: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const credential = readBearerToken(request);
    if (credential === undefined)
      return buildErrorResponse(
        createUnauthenticatedError(`${action} needs a runner's credential`),
      );
    const runnerId = yield* (yield* RunnerConnections).admits(credential);
    if (Option.isNone(runnerId))
      return buildErrorResponse(createUnauthenticatedError(UNKNOWN_CREDENTIAL));
    return yield* respond(runnerId.value);
  }).pipe(respondToFailures(`A runner failed ${action}`));
