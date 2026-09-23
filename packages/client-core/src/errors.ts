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
import * as HttpClientError from "effect/unstable/http/HttpClientError";

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

/** The controller could not be reached: there was no response, so there is no envelope. */
export class ConnectionError extends Error {
  override readonly name = "ConnectionError";
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`cannot reach ${url}`, { cause });
    this.url = url;
  }
}

/** Returns true when the error is a `not_found` response from the controller. */
export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.code === "not_found";

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
 * Converts any failure of the derived client into a `RequestError`, an
 * `ApiError` or a `ConnectionError`.
 *
 * `sent` is true when the request reached the transport. A schema error
 * before that point comes from the caller's input, not from the controller,
 * so it becomes a `RequestError` rather than an envelope the controller never
 * sent.
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
    const reason = failure.reason._tag;
    if (reason === "TransportError" || reason === "InvalidUrlError") {
      return new ConnectionError(url, failure);
    }
  }

  const message = failure instanceof Error ? failure.message : String(failure);
  return new ApiError("internal", message, undefined, failure);
};
