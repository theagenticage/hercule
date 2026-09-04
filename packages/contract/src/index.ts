/**
 * `@hydra/contract`: the public API declared once, in Effect Schema.
 *
 * The controller derives its routes and its request validation from `api`, the
 * CLI and `client-core` derive their client from it, and the OpenAPI document
 * is generated from it. `OPERATIONS` is the route and grant table every 403 and
 * every `hydra ... --help` reads.
 */
import { Schema } from "effect";

/** Version of the public API surface this build speaks. */
export const API_VERSION = 1;

/**
 * Response of the unauthenticated liveness probe.
 *
 * Scaffolding from the first-run ticket: there is no `health` operation in the
 * catalogue, and this goes when `client-core` stops using it.
 */
export const Health = Schema.Struct({
  status: Schema.Literal("ok"),
  apiVersion: Schema.Number,
});

export type Health = Schema.Schema.Type<typeof Health>;

export { api } from "./api";

export {
  ALL_OPERATIONS,
  API_PREFIX,
  OPERATIONS,
  isOperationId,
  requirementOf,
  type Method,
  type Operation,
  type OperationId,
  type Requirement,
} from "./operations";

export { ALL_GRANTS, GRANT_FAMILIES, GrantSchema, type Grant, type GrantFamily } from "./grants";

export {
  CapExceeded,
  Conflict,
  ERROR_CODES,
  ERROR_STATUS,
  Forbidden,
  Internal,
  InvalidState,
  Issue,
  NotFound,
  Unauthenticated,
  Validation,
  capExceeded,
  conflict,
  forbidden,
  internal,
  invalidState,
  notFound,
  unauthenticated,
  validation,
  type ApiError,
  type CapDetails,
  type ErrorCode,
} from "./errors";

export { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, SortDirection, page, pageParams } from "./pagination";

export { Actor, Id, Timestamp } from "./ids";

export { Authenticated, SetupToken } from "./security";

export { SetupResult, SetupState } from "./groups/setup";
export { LoginResult } from "./groups/auth";
export { ApiKey, MintedApiKey } from "./groups/api-key";
export {
  AccessMode,
  ControllerSettings,
  SettingsPatch,
  SettingsState,
  UserSettings,
} from "./groups/settings";
export { Profile } from "./groups/profile";
export { OwnerKind, SecretRef } from "./groups/secret";
export { ControllerInfo } from "./groups/controller";
