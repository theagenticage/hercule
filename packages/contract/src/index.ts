/**
 * `@hydra/contract`: the public API declared once, in Effect Schema.
 *
 * The controller derives its routes and its request validation from `api`, the
 * CLI and `client-core` derive their client from it, and the OpenAPI document
 * is generated from it. `OPERATIONS` is the route and grant table every 403 and
 * every `hydra ... --help` reads.
 */
/** Version of the public API surface this build speaks. */
export const API_VERSION = 1;

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

export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  SortDirection,
  page,
  pageParams,
  sortFieldsOf,
  sortParam,
} from "./pagination";

export {
  MAX_PASSWORD_LENGTH,
  MAX_TIMEZONE_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  NewPassword,
  PresentedPassword,
  Timezone,
  Username,
  bounded,
} from "./strings";

export { LoginForm, SetupForm } from "./forms";

/** The form-validation interface the schemas above answer to. */
export type { StandardSchemaV1 } from "effect/StandardSchema";

export { Actor, ExternalRef, Id, MAX_EXTERNAL_REF_LENGTH, NullableActor, Timestamp } from "./ids";

export { Authenticated, SetupToken } from "./security";

export { SetupPayload, SetupResult, SetupState } from "./groups/setup";
export { LoginPayload, LoginResult } from "./groups/auth";
export { ApiKey, MintedApiKey } from "./groups/api-key";
export {
  AccessMode,
  ControllerSettings,
  SETTING_VALUES,
  SettingsPatch,
  SettingsState,
  ThreadRows,
  UserSettings,
} from "./groups/settings";
export { Profile } from "./groups/profile";
export { OwnerKind, SecretRef } from "./groups/secret";
export { ControllerInfo } from "./groups/controller";
export {
  Label,
  MAX_LABEL_LENGTH,
  MAX_SEARCH_TEXT_LENGTH,
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  ProvenanceEntry,
  TASK_SORT_FIELDS,
  Task,
  TaskFilter,
  TaskPriority,
  TaskStatus,
} from "./groups/task";
export {
  MAX_PROJECT_DESCRIPTION_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
  PROJECT_SORT_FIELDS,
  Project,
} from "./groups/project";
export { EVENT_SORT_FIELDS, Event, MAX_EVENT_KIND_LENGTH } from "./groups/event";
