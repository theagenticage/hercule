/**
 * The three errors a client call can reject with.
 *
 * No Effect types cross this boundary: `client-core` is the only client
 * package that writes Effect code, so every failure of the derived client is
 * converted into one of these three plain errors before it reaches the web
 * app or the CLI.
 */
import {
  ERROR_CODES,
  ERROR_STATUS,
  listDecodeIssues,
  type ErrorCode,
  type Issue,
} from "@hercule/contract";
import { Schema } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";

/** The wire envelope, exactly as the API sends it. */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: unknown;
  };
}

/**
 * The API responded with an error envelope.
 *
 * Tell errors apart by `code`, never by a `_tag`: the envelope has none. The
 * contract fixes the shape of `details` for each code:
 *
 * - `{ grant }` for `forbidden`;
 * - `{ issues }` for `validation`;
 * - a size or a count for `cap_exceeded`;
 * - `{ previousSize, size }` for `shrink_rejected`;
 * - absent for every other code.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown, cause?: unknown) {
    super(message, { cause });
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  /** Returns the envelope again, so `JSON.stringify(err)` is what `--json` prints. */
  toJSON(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/**
 * The request was never sent: the caller's input does not match the
 * operation's input schema.
 *
 * This is the caller's mistake, not the controller's, and it is not an
 * `ApiError`: no request was made, so there is no envelope and no status. The
 * `issues` use the contract's issue type, so a bad flag on the command line
 * and a bad field over HTTP produce the same messages.
 */
export class RequestError extends Error {
  override readonly name = "RequestError";
  readonly issues: ReadonlyArray<Issue>;

  constructor(issues: ReadonlyArray<Issue>, cause: unknown) {
    super(issues.map((issue) => issue.message).join("; "), { cause });
    this.issues = issues;
  }
}

/**
 * No complete answer arrived from the controller, so there is no envelope.
 * The request could not connect, timed out, or lost its connection while the
 * body arrived.
 *
 * The message names the operation and says what went wrong, such as
 * "workspace.query: the controller did not answer within 5 s" or
 * "setup.read: cannot connect to http://127.0.0.1:4937: ECONNREFUSED". The
 * original failure is kept as `cause`.
 */
export class ConnectionError extends Error {
  override readonly name = "ConnectionError";
  /** The controller's address. */
  readonly url: string;
  /** The operation that failed, as `<group>.<name>`, such as `workspace.query`. */
  readonly operation: string;

  constructor(operation: string, url: string, reason: string, cause: unknown) {
    super(`${operation}: ${reason}`, { cause });
    this.url = url;
    this.operation = operation;
  }
}

/**
 * Returns the message of an error. A rejected value that is not an `Error`
 * is converted to a string, so there is always something to show.
 */
export const readErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Returns true when the error is a `not_found` response from the controller. */
export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.code === "not_found";

/**
 * Returns true when the error is a `conflict` response from the controller:
 * the record changed since the caller read it, or a name is already taken.
 */
export const isConflict = (error: unknown): boolean =>
  error instanceof ApiError && error.code === "conflict";

/**
 * Returns the issues of a `validation` error response, in order, or
 * `undefined` for any other error. Only a `validation` response lists what was
 * wrong with the request.
 */
export const readValidationIssues = (error: unknown): ReadonlyArray<Issue> | undefined => {
  if (!(error instanceof ApiError) || error.code !== "validation") return undefined;
  const details = error.details;
  const issues =
    typeof details === "object" && details !== null && "issues" in details
      ? details.issues
      : undefined;
  return Array.isArray(issues) ? (issues as ReadonlyArray<Issue>) : undefined;
};

const isErrorCode = (u: unknown): u is ErrorCode =>
  typeof u === "string" && ERROR_CODES.includes(u as ErrorCode);

/**
 * Returns the failure as an error envelope (the derived client decodes one into
 * a contract error class), or `undefined` when it is not one.
 */
const asEnvelope = (u: unknown): ErrorEnvelope | undefined => {
  if (typeof u !== "object" || u === null || !("error" in u)) return undefined;
  const error: unknown = u.error;
  if (typeof error !== "object" || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (!isErrorCode(code) || typeof message !== "string") return undefined;
  return u as ErrorEnvelope;
};

/**
 * Checks whether the error a response body was read with means the connection
 * was lost while the body arrived, rather than that the body was malformed.
 * Reading a body fails with:
 *
 * - an `AbortError` or a `TimeoutError` when the request's signal was
 *   aborted, for example by a time limit that ran out after the headers;
 * - a `TypeError` when the network failed partway through the body.
 *
 * The error is recognized by its name, not its class. A `DOMException` from
 * another realm, such as the DOM of a test environment, is not an instance of
 * this realm's `Error`.
 */
const isConnectionLoss = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("name" in error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError" || error.name === "TypeError";
};

/**
 * Checks whether `error` is the `TimeoutError` a request's time limit aborts
 * it with. Like `isConnectionLoss`, it recognizes the error by its name.
 */
const isTimeout = (error: unknown): error is { readonly message: string } =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  error.name === "TimeoutError" &&
  "message" in error &&
  typeof error.message === "string";

/**
 * Chromium's message for every request that fails before an answer arrives:
 * a refused connection, an unknown host, a CORS refusal. It says nothing more
 * than that the request failed, so it is left out of a `ConnectionError`.
 */
const CHROMIUM_FETCH_FAILURE = "Failed to fetch";

/**
 * Returns what went wrong with a request to the controller at `url` that
 * failed with `reason`, for the message of a `ConnectionError`.
 *
 * A time limit's own message is used as it is: the code that aborts the
 * request knows the limit, and says it, as in "the controller did not answer
 * within 5 s". A request that could not connect adds the transport's reason
 * where it gives one: Bun does ("ECONNREFUSED: Unable to connect..."),
 * Chromium does not.
 */
const describeConnectionFailure = (
  reason: HttpClientError.HttpClientError["reason"],
  url: string,
): string => {
  const cause: unknown = reason.cause;
  if (isTimeout(cause)) return cause.message;
  if (reason._tag === "InvalidUrlError") return `${url} is not a valid address`;
  if (reason._tag === "DecodeError") {
    return `the connection to ${url} was lost while the answer arrived`;
  }
  const detail = cause instanceof Error ? cause.message : "";
  return detail === "" || detail === CHROMIUM_FETCH_FAILURE
    ? `cannot connect to ${url}`
    : `cannot connect to ${url}: ${detail}`;
};

/**
 * Converts any failure of the derived client into a `RequestError`, an
 * `ApiError` or a `ConnectionError`.
 *
 * `sent` is true when the request reached the transport. A schema error
 * before that point comes from the caller's input, not from the controller,
 * so it becomes a `RequestError` rather than an envelope the controller never
 * sent.
 *
 * A `ConnectionError` means no complete response arrived: the request could
 * not be sent, or the connection was lost or aborted while the body arrived.
 * `operation` (`<group>.<name>`) and `url` go into its message.
 *
 * A response that arrived but could not be decoded becomes an `internal`
 * `ApiError`, with the original failure kept as `cause`. That covers:
 *
 * - a status the contract does not declare;
 * - a body that is not an error envelope;
 * - a success body that does not match its schema.
 *
 * The caller cannot act on any of these, which is what `internal` means.
 */
export const toClientError = (
  failure: unknown,
  operation: string,
  url: string,
  sent: boolean,
): RequestError | ApiError | ConnectionError => {
  if (!sent && Schema.isSchemaError(failure)) {
    return new RequestError(listDecodeIssues(failure), failure);
  }

  const envelope = asEnvelope(failure);
  if (envelope !== undefined) {
    return new ApiError(envelope.error.code, envelope.error.message, envelope.error.details);
  }

  if (HttpClientError.isHttpClientError(failure)) {
    const reason = failure.reason;
    if (
      reason._tag === "TransportError" ||
      reason._tag === "InvalidUrlError" ||
      (reason._tag === "DecodeError" && isConnectionLoss(reason.cause))
    ) {
      return new ConnectionError(operation, url, describeConnectionFailure(reason, url), failure);
    }
  }

  return new ApiError("internal", readErrorMessage(failure), undefined, failure);
};
