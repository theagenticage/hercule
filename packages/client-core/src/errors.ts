/**
 * The two failures a client call can reject with.
 *
 * Nothing Effect-shaped crosses this boundary: `client-core` is the only client
 * package that writes Effect code (ADR 0017, ADR 0031), so every failure the
 * derived client can produce is folded into one of these two plain errors
 * before it reaches the web app or the CLI.
 */
import { ERROR_CODES, ERROR_STATUS, type ErrorCode } from "@hydra/contract";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

/** The wire envelope, exactly as spec 11 section 1.5 defines it. */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: unknown;
  };
}

/**
 * The API answered with the error envelope.
 *
 * Discriminate on `code`, never on a `_tag`: the envelope carries none. The
 * shape of `details` is fixed per code by the contract (`{ grant }` for
 * `forbidden`, `{ issues }` for `validation`, a size or a count for
 * `cap_exceeded`, absent otherwise).
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

  /** The envelope again, so `JSON.stringify(err)` is what `--json` prints. */
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

/** The controller could not be reached at all: no response, so no envelope. */
export class ConnectionError extends Error {
  override readonly name = "ConnectionError";
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`cannot reach ${url}`, { cause });
    this.url = url;
  }
}

const isErrorCode = (u: unknown): u is ErrorCode =>
  typeof u === "string" && ERROR_CODES.includes(u as ErrorCode);

/** An envelope the derived client decoded into one of the contract's classes. */
const asEnvelope = (u: unknown): ErrorEnvelope | undefined => {
  if (typeof u !== "object" || u === null || !("error" in u)) return undefined;
  const error: unknown = u.error;
  if (typeof error !== "object" || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (!isErrorCode(code) || typeof message !== "string") return undefined;
  return u as ErrorEnvelope;
};

/**
 * Fold anything the derived client can fail with into `ApiError` or
 * `ConnectionError`.
 *
 * A response that arrived but could not be decoded - an undeclared status, a
 * body that is not the envelope, a success that does not match its schema -
 * becomes `internal`. The caller got something it cannot act on structurally,
 * which is exactly what `internal` means; the original is kept as `cause`.
 */
export const toClientError = (failure: unknown, url: string): ApiError | ConnectionError => {
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
