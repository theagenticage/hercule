/**
 * Permission Requests: a session asks for a grant its profile lacks, and the
 * user decides (spec 13 §6.4, spec 10 §7.6).
 *
 * `permission.request` is open to every caller: asking is never forbidden.
 * Only a session can ask, because a request is for one session's grants.
 * `permission.decide` needs `permission.write`, and is bound as the answers
 * of the request's decision notification, so the user answers from the
 * notification or from the session view alike.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { closedStruct } from "../closed";
import {
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { GrantSchema } from "../grants";
import { Id, Timestamp } from "../ids";
import { Authenticated } from "../security";
import { bounded } from "../strings";
import { BoundOperation } from "./notification";

/** The longest reason a session may give for a request. */
const MAX_PERMISSION_REQUEST_REASON_LENGTH = 2000;

/**
 * The user's decision on a Permission Request:
 *
 * - `session`: the session holds the grant until it ends;
 * - `profile`: the grant is added to the session's permission profile, so
 *   every session on that profile holds it from its next call;
 * - `deny`: nothing changes.
 */
export const PERMISSION_DECISION_OUTCOMES = ["session", "profile", "deny"] as const;

export const PermissionDecisionOutcome = Schema.Literals(PERMISSION_DECISION_OUTCOMES);

export type PermissionDecisionOutcome = Schema.Schema.Type<typeof PermissionDecisionOutcome>;

/** The payload of `permission.request`. */
export const PermissionRequestInput = Schema.Struct({
  /** The grant the session asks for, spelled as a 403 names it: `task.delete`. */
  grant: GrantSchema,
  /** Why the session needs the grant, in the agent's words, shown to the user. */
  reason: bounded(1, MAX_PERMISSION_REQUEST_REASON_LENGTH),
  /**
   * The call the session wanted to make, so the user sees what it is trying
   * to do and not only which grant it lacks. It is shown, never run. An
   * operation whose input can carry a credential or a secret value is
   * refused (see `canCarrySecrets`), because the notification shows the
   * input in full; describe such a call in `reason` instead.
   */
  operation: Schema.optionalKey(BoundOperation),
});

export type PermissionRequestInput = Schema.Schema.Type<typeof PermissionRequestInput>;

/** What `permission.request` returns. */
export const PermissionRequestResult = Schema.Struct({
  requestId: Id,
  /** The subscription that delivers the decision to the asking session as queued input. */
  subscriptionId: Id,
});

export type PermissionRequestResult = Schema.Schema.Type<typeof PermissionRequestResult>;

/** An open Permission Request, as a session record lists it. */
export const PermissionRequest = Schema.Struct({
  id: Id,
  grant: GrantSchema,
  reason: Schema.String,
  operation: Schema.optionalKey(BoundOperation),
  createdAt: Timestamp,
});

export type PermissionRequest = Schema.Schema.Type<typeof PermissionRequest>;

/**
 * The whole input of `permission.decide` as one object, the request's id
 * included, for an answer that binds it.
 */
export const PermissionDecideCall = closedStruct({
  requestId: Id,
  outcome: PermissionDecisionOutcome,
});

export type PermissionDecideCall = Schema.Schema.Type<typeof PermissionDecideCall>;

/**
 * The payload of `permission.decided`, the platform event written when a
 * request is decided. A `{ kind: "request" }` subscription matches it, so the
 * asking session reads it as queued input and retries `operation` itself.
 */
export const PermissionDecidedEventPayload = Schema.Struct({
  requestId: Id,
  sessionId: Id,
  grant: GrantSchema,
  outcome: PermissionDecisionOutcome,
  operation: Schema.optionalKey(BoundOperation),
});

export type PermissionDecidedEventPayload = Schema.Schema.Type<
  typeof PermissionDecidedEventPayload
>;

export const permission = HttpApiGroup.make("permission")
  .add(
    /**
     * Asks the user for a grant on behalf of the calling session, and
     * registers the subscription that tells the session the decision. Fails
     * with `validation` when the caller is not a session or `operation` can
     * carry a secret, and with `invalid_state` when the session already holds
     * the grant, already waits on a request for it, or has ended.
     */
    HttpApiEndpoint.post("request", "/permissions/request", {
      payload: PermissionRequestInput,
      success: PermissionRequestResult,
      error: [Unauthenticated, Validation, InvalidState, Internal],
    }),
    /**
     * Decides a Permission Request and resolves its notification. Fails with
     * `invalid_state` when the request is already decided or withdrawn, when
     * its session has ended, and, for `session` and `profile`, when the
     * session has moved to another permission profile since it asked.
     */
    HttpApiEndpoint.post("decide", "/permissions/requests/:id/decide", {
      params: { id: Id },
      payload: Schema.Struct({ outcome: PermissionDecisionOutcome }),
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
