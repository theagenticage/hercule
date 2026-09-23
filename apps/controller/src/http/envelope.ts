/**
 * One error envelope on the wire, for every failure the transport can
 * produce.
 *
 * A failing operation answers `{ error: { code, message, details? } }` and
 * nothing else. The service layer already fails with the contract's error
 * classes and the derived route encodes those itself; what is left for this
 * module is everything the route does not encode:
 *
 * - a request the derived route could not decode, which Effect's HttpApi
 *   raises as a defect carrying `HttpApiSchemaError`: `validation`, with the
 *   schema library's issue tree flattened into the neutral `{ path, message }`
 *   shape the contract names (the wire contract names no schema library);
 * - a path no route matched: `not_found`;
 * - anything else, which is a bug rather than something the caller can act on:
 *   `internal`, with the detail logged and never returned.
 *
 * A client that hung up is left alone: the interrupt keeps its own response
 * (499), so an aborted request is not reported as a server error.
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

/** The eight error classes all carry `error`; this is what puts one on the wire. */
export const buildErrorResponse = (error: ApiError): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe({ error: error.error }, { status: ERROR_STATUS[error.error.code] });

/** Which part of the request failed to decode, in the caller's words. */
const PART: Record<HttpApiSchemaError["kind"], string> = {
  Payload: "request body",
  Query: "query string",
  Params: "path",
  Headers: "request headers",
  Body: "response body",
  ResponseHeaders: "response headers",
};

/**
 * The error a cause answers with, or `undefined` when the cause is not this
 * module's to answer - an interrupt, which the server renders itself.
 *
 * Pure, and the whole of the mapping: the wrapper around the app turns what
 * comes back into a response and logs the ones the caller cannot act on.
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
 * Answers every request with the envelope. Wraps the whole application, so it
 * covers the routes it did not match as well as the ones it did.
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
