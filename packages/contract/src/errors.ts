/**
 * The one error envelope.
 *
 * Every failing operation answers with `{ error: { code, message, details? } }`
 * and nothing else. `code` is a closed enum, the HTTP status is derived from
 * the code, `details` is typed per code, and `message` is for people and is
 * never parsed. The wire contract names no schema library: a decode failure is
 * mapped into `validation`'s neutral `issues` list by the transport.
 *
 * One error per response. The order the checks run in - `unauthenticated`,
 * the static grant check, `validation`, `not_found`, entity-dependent
 * `forbidden`, business rules, `internal` - is the service layer's and the
 * request middleware's, not this module's.
 */
import { Schema, SchemaIssue } from "effect";
import { GrantSchema, type Grant } from "./grants";

/** The closed code enum, extended additively. */
export const ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "validation",
  "not_found",
  "conflict",
  "invalid_state",
  "cap_exceeded",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The HTTP status each code renders as. Two codes share 409 by design. */
export const ERROR_STATUS = {
  unauthenticated: 401,
  forbidden: 403,
  validation: 400,
  not_found: 404,
  conflict: 409,
  invalid_state: 409,
  cap_exceeded: 422,
  internal: 500,
} as const satisfies Record<ErrorCode, number>;

/** One thing wrong with an input, in schema-library-free vocabulary. */
export const Issue = Schema.Struct({
  path: Schema.Array(Schema.String),
  message: Schema.String,
});

export type Issue = Schema.Schema.Type<typeof Issue>;

/** What a `cap_exceeded` names: a byte size or an item count against its cap. */
export const CapDetails = Schema.Union([
  Schema.Struct({ size: Schema.Int, cap: Schema.Int }),
  Schema.Struct({ count: Schema.Int, cap: Schema.Int }),
]);

export type CapDetails = Schema.Schema.Type<typeof CapDetails>;

/** No credential, or one that does not resolve. */
export class Unauthenticated extends Schema.Error<Unauthenticated>("hercule/Unauthenticated")(
  {
    error: Schema.Struct({
      code: Schema.Literal("unauthenticated"),
      message: Schema.String,
    }),
  },
  { description: "Unauthenticated", httpApiStatus: ERROR_STATUS.unauthenticated },
) {}

/** The caller's permission profile lacks the grant the operation requires. */
export class Forbidden extends Schema.Error<Forbidden>("hercule/Forbidden")(
  {
    error: Schema.Struct({
      code: Schema.Literal("forbidden"),
      message: Schema.String,
      details: Schema.Struct({ grant: GrantSchema }),
    }),
  },
  { description: "Forbidden", httpApiStatus: ERROR_STATUS.forbidden },
) {}

/** The input is wrong. The one code that reports everything wrong at once. */
export class Validation extends Schema.Error<Validation>("hercule/Validation")(
  {
    error: Schema.Struct({
      code: Schema.Literal("validation"),
      message: Schema.String,
      details: Schema.Struct({ issues: Schema.Array(Issue) }),
    }),
  },
  { description: "Validation", httpApiStatus: ERROR_STATUS.validation },
) {}

/** No such entity, for a caller already known to hold the grant. */
export class NotFound extends Schema.Error<NotFound>("hercule/NotFound")(
  {
    error: Schema.Struct({
      code: Schema.Literal("not_found"),
      message: Schema.String,
    }),
  },
  { description: "NotFound", httpApiStatus: ERROR_STATUS.not_found },
) {}

/** The write collides with something that already exists. */
export class Conflict extends Schema.Error<Conflict>("hercule/Conflict")(
  {
    error: Schema.Struct({
      code: Schema.Literal("conflict"),
      message: Schema.String,
    }),
  },
  { description: "Conflict", httpApiStatus: ERROR_STATUS.conflict },
) {}

/** The entity is in a state that does not allow the operation. */
export class InvalidState extends Schema.Error<InvalidState>("hercule/InvalidState")(
  {
    error: Schema.Struct({
      code: Schema.Literal("invalid_state"),
      message: Schema.String,
    }),
  },
  { description: "InvalidState", httpApiStatus: ERROR_STATUS.invalid_state },
) {}

/** A declared cap - a size or a count - would be exceeded. */
export class CapExceeded extends Schema.Error<CapExceeded>("hercule/CapExceeded")(
  {
    error: Schema.Struct({
      code: Schema.Literal("cap_exceeded"),
      message: Schema.String,
      details: CapDetails,
    }),
  },
  { description: "CapExceeded", httpApiStatus: ERROR_STATUS.cap_exceeded },
) {}

/** Something went wrong that the caller cannot act on. */
export class Internal extends Schema.Error<Internal>("hercule/Internal")(
  {
    error: Schema.Struct({
      code: Schema.Literal("internal"),
      message: Schema.String,
    }),
  },
  { description: "Internal", httpApiStatus: ERROR_STATUS.internal },
) {}

/** Every error the API can answer with. */
export type ApiError =
  | Unauthenticated
  | Forbidden
  | Validation
  | NotFound
  | Conflict
  | InvalidState
  | CapExceeded
  | Internal;

/** Creates the error for a missing credential, or for a credential that does not resolve. */
export const createUnauthenticatedError = (message: string): Unauthenticated =>
  new Unauthenticated({ error: { code: "unauthenticated", message } });

/** Creates the error for a caller who lacks the grant that the operation requires. */
export const createForbiddenError = (grant: Grant, message = `missing grant ${grant}`): Forbidden =>
  new Forbidden({ error: { code: "forbidden", message, details: { grant } } });

/** Creates the error for a request that fails validation, with one issue per problem. */
export const createValidationError = (
  issues: ReadonlyArray<Issue>,
  message = "the request is not valid",
): Validation => new Validation({ error: { code: "validation", message, details: { issues } } });

/** Creates the error for an entity that does not exist. */
export const createNotFoundError = (message: string): NotFound =>
  new NotFound({ error: { code: "not_found", message } });

/** Creates the error for a write that collides with something that already exists. */
export const createConflictError = (message: string): Conflict =>
  new Conflict({ error: { code: "conflict", message } });

/** Creates the error for an entity whose state does not allow the operation. */
export const createInvalidStateError = (message: string): InvalidState =>
  new InvalidState({ error: { code: "invalid_state", message } });

/** Creates the error for a size or a count that is more than its cap. */
export const createCapExceededError = (details: CapDetails, message: string): CapExceeded =>
  new CapExceeded({ error: { code: "cap_exceeded", message, details } });

/** Creates the error for a failure that the caller cannot fix. */
export const createInternalError = (message: string): Internal =>
  new Internal({ error: { code: "internal", message } });

const standardIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Lists the issues of a Schema decode failure, one entry per problem, so a
 * caller can fix every field in one retry. Path segments are stringified
 * because a JSON document has no other kind of key.
 *
 * The wire vocabulary names no schema library, and this is the one place the
 * two meet: the transport decodes a request with it and a service decodes an
 * in-process call with it, so the same bad input reads the same either way.
 */
export const listDecodeIssues = (error: Schema.SchemaError): ReadonlyArray<Issue> =>
  standardIssues(error.issue).issues.map((issue) => ({
    path: (issue.path ?? []).map(String),
    message: issue.message,
  }));

/** Creates the validation error for a Schema decode failure, with one issue per problem. */
export const createDecodeValidationError = (error: Schema.SchemaError): Validation =>
  createValidationError(listDecodeIssues(error));
