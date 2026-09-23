/**
 * The error envelope: one response format for every failure the transport can
 * produce.
 *
 * A failing operation returns `{ error: { code, message, details? } }` and
 * nothing else. The service layer already fails with the contract's error
 * classes, and the derived route encodes those itself. This module handles
 * everything the route does not encode:
 *
 * - a request the derived route could not decode, which Effect's HttpApi
 *   raises as a defect with an `HttpApiSchemaError`: returned as `validation`,
 *   with the schema library's issue tree flattened into the neutral
 *   `{ path, message }` format the contract defines (the wire contract does
 *   not depend on a schema library);
 * - a path no route matched: `not_found`;
 * - anything else, which is a bug rather than something the caller can act
 *   on: `internal`, with the detail logged and never returned.
 *
 * A request the client aborted is left alone: the interrupt keeps its own
 * response (499), so it is not reported as a server error.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerError from "effect/unstable/http/HttpServerError";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { HttpApiSchemaError } from "effect/unstable/httpapi/HttpApiError";
import {
  ERROR_STATUS,
  createInternalError,
  createNotFoundError,
  createValidationError,
  listDecodeIssues,
  type ApiError,
} from "@hercule/contract";

/** Builds the HTTP response for a contract error, with the status its code maps to. */
export const buildErrorResponse = (error: ApiError): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe({ error: error.error }, { status: ERROR_STATUS[error.error.code] });

/** The name, in an error message, of each part of a request or response that can fail to decode. */
const PART: Record<HttpApiSchemaError["kind"], string> = {
  Payload: "request body",
  Query: "query string",
  Params: "path",
  Headers: "request headers",
  Body: "response body",
  ResponseHeaders: "response headers",
};

/**
 * Returns the contract error to respond with for a cause, or `undefined` for
 * an interrupt, which the server responds to itself.
 *
 * This function has no side effects and holds the whole mapping.
 * `withEnvelope` turns the result into a response, and logs the errors the
 * caller cannot act on.
 */
export const findApiError = (cause: Cause.Cause<unknown>): ApiError | undefined => {
  let internalDetail: string | undefined;
  for (const reason of cause.reasons) {
    if (reason._tag === "Interrupt") continue;
    const error = reason._tag === "Fail" ? reason.error : reason.defect;
    if (HttpApiSchemaError.is(error)) {
      // Encoding a response is the controller's own bug, not bad input.
      if (error.kind === "Body" || error.kind === "ResponseHeaders") {
        internalDetail ??= `cannot encode the ${PART[error.kind]}`;
        continue;
      }
      return createValidationError(
        listDecodeIssues(error.cause),
        `the ${PART[error.kind]} is not valid`,
      );
    }
    if (HttpServerError.isHttpServerError(error)) {
      if (error.reason._tag === "RouteNotFound") return createNotFoundError("no such route");
      if (error.reason._tag === "RequestParseError") {
        return createValidationError([{ path: [], message: "the request could not be read" }]);
      }
    }
    internalDetail ??= String(error);
  }
  if (internalDetail === undefined) return undefined;
  return createInternalError("something went wrong");
};

/**
 * Converts every failure of `app` into an envelope response. It wraps the
 * whole application, so it also covers requests that matched no route.
 */
export const withEnvelope = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> =>
  Effect.catchCause(app, (cause) => {
    const error = findApiError(cause);
    if (error === undefined) return Effect.failCause(cause);
    const respond = Effect.succeed(buildErrorResponse(error));
    // The detail of an `internal` is for the operator's log and never for the
    // caller, who can do nothing with it.
    return error.error.code === "internal"
      ? Effect.andThen(Effect.logError("Unhandled failure while serving a request", cause), respond)
      : respond;
  });
