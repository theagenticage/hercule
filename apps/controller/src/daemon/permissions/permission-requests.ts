/**
 * Permission Requests: a session asks the user for a grant its permission
 * profile lacks, and the user decides (spec 13 §6.4, spec 10 §7.6).
 *
 * Asking writes to four domains in one transaction: the request row
 * (permissions), the subscription that tells the session the decision
 * (subscriptions), the decision notification (notifications), and the audit
 * entry about the session (events). Deciding writes the decision, may widen
 * the session's profile, and resolves the notification. Both read the asking
 * session and its Agent. The sessions and agents domains already depend on
 * the permissions domain, so the permissions domain cannot read them without
 * closing a cycle in the domain graph. Breaking that cycle is why these
 * operations live in the controller daemon (ADR 0033).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  canCarrySecrets,
  Conflict,
  createInvalidStateError,
  createNotFoundError,
  createUnauthenticatedError,
  createValidationError,
  isOperationId,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type PermissionDecideCall,
  type PermissionRequestInput,
  type PermissionRequestResult,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { agentRepository } from "../../agents";
import { CurrentActor, NO_CREDENTIAL, currentStamp, requireGrant } from "../../actor";
import { afterCommit, announce, nowIso, withTransaction } from "../../db";
import { AuditLog, PlatformEvents } from "../../events";
import { Notifier } from "../../notifications";
import {
  buildPermissionRequestNotification,
  buildPermissionRequestSubject,
  permissionRequestRepository,
  PermissionProfiles,
  Profiles,
  SessionTokens,
  type PermissionProfile,
  type StoredPermissionRequest,
} from "../../permissions";
import { sessionRepository, type StoredSession } from "../../sessions";
import { permissionRequestSubscriptions } from "../../subscriptions";

/** The refusal for a caller that is not a session. */
const ONLY_A_SESSION_ASKS =
  "only a session can ask for a grant, because a Permission Request widens one " +
  "session's grants; the user already holds every grant";

/** Returns why a request cannot carry this operation: its input may hold a secret. */
const describeSecretOperation = (op: string): string =>
  `${op} can take a password, a credential or a secret value, and the call a request ` +
  "names is copied into its notification, its audit entry and its decision event; " +
  "send the request without operation, and describe the call in reason instead";

/** Returns why a session that has ended can neither ask nor be given a grant. */
const describeEndedSession = (sessionId: string): string =>
  `the session ${sessionId} has ended, so it can neither ask for a grant nor be given one; ` +
  "resume it, and it can ask again";

/** Returns why a request cannot be decided after its session moved to another profile. */
const describeMovedSession = (request: StoredPermissionRequest): string =>
  `the session moved to another permission profile after it asked for ${request.grant}, ` +
  "and the request named the profile it was on; decide deny, and the session can ask " +
  "again under its new profile";

/** Returns why a request that is no longer open cannot be decided. */
const describeClosedRequest = (request: StoredPermissionRequest): string =>
  request.status === "withdrawn"
    ? "this Permission Request was withdrawn because its session ended; there is nothing left to decide"
    : `this Permission Request was already decided with outcome ${request.outcome ?? ""}; ` +
      "a decision cannot be changed";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const requests = yield* permissionRequestRepository;
  // The repositories, not the services: the services check `session.query`
  // and `agent.query` on the caller, and a session that asks for a grant may
  // hold neither.
  const sessions = yield* sessionRepository;
  const agents = yield* agentRepository;
  const subscriptions = yield* permissionRequestSubscriptions;
  const permissionProfiles = yield* PermissionProfiles;
  const profiles = yield* Profiles;
  const tokens = yield* SessionTokens;
  const notifier = yield* Notifier;
  const platformEvents = yield* PlatformEvents;
  const audit = yield* AuditLog;

  /**
   * Reads the session behind a session actor or a request, and fails with
   * `InvalidState` when it has exited. Its row is never deleted.
   *
   * The check runs inside the caller's transaction. The caller's credential
   * was checked before the transaction began, and the session may have exited
   * since. An exit withdraws the session's open requests, so a request stored
   * after it would stay open with nothing to withdraw it.
   */
  const readLiveSession = (id: string): Effect.Effect<StoredSession, InvalidState | SqlError> =>
    Effect.flatMap(
      sessions.one(id),
      Option.match({
        onNone: () => Effect.die(`the session ${id} of a Permission Request has no row`),
        onSome: (session) =>
          session.status === "exited"
            ? Effect.fail(createInvalidStateError(describeEndedSession(id)))
            : Effect.succeed(session),
      }),
    );

  /**
   * Reads a profile a live session uses, or used when it asked. A profile
   * cannot be deleted while a live session uses it, and stored grants were
   * written with the same schema that reads them, so both failures are bugs.
   */
  const readProfile = (id: string): Effect.Effect<PermissionProfile, SqlError> =>
    Effect.flatMap(
      Effect.catchTag(permissionProfiles.getById(id), "GrantsError", Effect.die),
      Option.match({
        onNone: () => Effect.die(`the profile ${id} of a live session has no row`),
        onSome: Effect.succeed,
      }),
    );

  return {
    /**
     * Asks the user for a grant on behalf of the calling session. Stores the
     * request, opens the session's subscription on its decision, raises the
     * `core.permission-request` notification and records a
     * `permission.requested` audit entry, all in one transaction. Returns the
     * request's id and the subscription's id.
     *
     * Fails with:
     *
     * - `Validation` when the caller is not a session, or when `operation`
     *   names an operation whose input can carry a secret;
     * - `InvalidState` when the session already holds the grant, so it should
     *   retry its call, already waits on a request for the same grant, or has
     *   exited. The grants are read inside the transaction, so a grant given
     *   to the session while this call was on its way counts.
     */
    request: (
      input: PermissionRequestInput,
    ): Effect.Effect<
      PermissionRequestResult,
      Unauthenticated | Validation | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        const actor = yield* CurrentActor;
        if (actor._tag === "none") {
          return yield* Effect.fail(createUnauthenticatedError(NO_CREDENTIAL));
        }
        if (actor._tag !== "session") {
          return yield* Effect.fail(createValidationError([], ONLY_A_SESSION_ASKS));
        }
        // Refused rather than stripped, so the agent learns why the user
        // does not see the call it named.
        const op = input.operation?.op;
        if (op !== undefined && isOperationId(op) && canCarrySecrets(op)) {
          return yield* Effect.fail(
            createValidationError(
              [{ path: ["operation", "op"], message: describeSecretOperation(op) }],
              describeSecretOperation(op),
            ),
          );
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const session = yield* readLiveSession(actor.sessionId);
            const profile = yield* readProfile(session.permissionProfileId);
            // Read here rather than taken from the actor: the actor's grants
            // were read when the call was authenticated, and another request
            // of the session may have been decided since.
            const sessionGrants = yield* requests.listSessionGrants(session.id);
            if (profile.grants.includes(input.grant) || sessionGrants.includes(input.grant)) {
              return yield* Effect.fail(
                createInvalidStateError(
                  `this session already holds ${input.grant}; retry the call instead of asking`,
                ),
              );
            }
            const open = yield* requests.findOpen(session.id, input.grant);
            if (Option.isSome(open)) {
              return yield* Effect.fail(
                createInvalidStateError(
                  `this session already waits on the Permission Request ${open.value} for ` +
                    `${input.grant}; the decision arrives as queued input`,
                ),
              );
            }
            const at = yield* nowIso;
            const agent =
              session.agentId === null ? Option.none() : yield* agents.read(session.agentId);
            const requestId = yield* requests.insert({
              sessionId: session.id,
              profileId: profile.id,
              grant: input.grant,
              reason: input.reason,
              operation: input.operation,
              at,
            });
            const subscriptionId = yield* subscriptions.open(session.id, requestId, at);
            yield* notifier.createCoreNotification(
              buildPermissionRequestNotification({
                requestId,
                sessionId: session.id,
                sessionTitle: session.title,
                agentName: Option.getOrUndefined(Option.map(agent, (found) => found.name)),
                profileName: profile.name,
                grant: input.grant,
                reason: input.reason,
                operation: input.operation,
              }),
            );
            yield* audit.append({
              kind: "permission.requested",
              actor: yield* currentStamp,
              // The session's record lists its open requests, so the entry
              // announces a change to the session.
              record: { topic: "session", id: session.id, conversationId: session.conversationId },
              payload: {
                requestId,
                sessionId: session.id,
                grant: input.grant,
                reason: input.reason,
                ...(input.operation === undefined ? {} : { operation: input.operation }),
              },
              at,
            });
            return { requestId, subscriptionId };
          }),
        );
      }),

    /**
     * Decides a Permission Request and returns an empty object:
     *
     * - `session`: the asking session holds the grant until it ends;
     * - `profile`: the grant is added to the session's current permission
     *   profile, through `profile.update`, which needs the same grant as
     *   deciding;
     * - `deny`: nothing changes.
     *
     * Every outcome resolves the request's notification and emits the
     * `permission.decided` platform event, which reaches the asking session
     * as queued input through the subscription `request` opened.
     *
     * Fails with `NotFound` when there is no such request, and with
     * `InvalidState` when:
     *
     * - it was already decided or was withdrawn;
     * - its session has exited;
     * - the outcome is `session` or `profile` and the session has moved to
     *   another profile since it asked. The notification named the old
     *   profile, and a `session` grant applies only under the profile it
     *   was given under, so either outcome would not do what the user read.
     */
    decide: (
      input: PermissionDecideCall,
    ): Effect.Effect<
      Record<string, never>,
      Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("permission.decide");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const found = yield* requests.read(input.requestId);
            if (Option.isNone(found)) {
              return yield* Effect.fail(
                createNotFoundError("there is no Permission Request with this id"),
              );
            }
            const request = found.value;
            if (request.status !== "open") {
              return yield* Effect.fail(createInvalidStateError(describeClosedRequest(request)));
            }
            const at = yield* nowIso;
            const session = yield* readLiveSession(request.sessionId);
            if (input.outcome !== "deny" && session.permissionProfileId !== request.profileId) {
              return yield* Effect.fail(createInvalidStateError(describeMovedSession(request)));
            }
            yield* requests.decide(request.id, input.outcome, at);
            switch (input.outcome) {
              case "session":
                // The session's cached actor lacks the grant. Clearing it after
                // the commit makes the session's next call read it again.
                yield* afterCommit(() => {
                  tokens.forgetSessions([session.id]);
                });
                break;
              case "profile":
                yield* addGrantToProfile(request);
                break;
              case "deny":
                break;
            }
            // Called from the notification's own answer, this decides the
            // notification first, and `notification.act` then accepts it as
            // decided with the same answer. The request row has already
            // ruled out a second decision, so the outcome needs no check.
            yield* notifier.answerDecisionsAbout(
              buildPermissionRequestSubject(request.id),
              input.outcome,
            );
            yield* platformEvents.emit({
              kind: "permission.decided",
              actor: yield* currentStamp,
              payload: {
                requestId: request.id,
                sessionId: session.id,
                grant: request.grant,
                outcome: input.outcome,
                ...(request.operation === undefined ? {} : { operation: request.operation }),
              },
              at,
            });
            yield* announce({
              _tag: "record",
              topic: "session",
              id: session.id,
              conversationId: session.conversationId,
              kind: "updated",
            });
            return {};
          }),
        );
      }),
  };

  /**
   * Adds the request's grant to the profile the session asked under, unless
   * the profile already grants it. The edit is an ordinary `profile.update`,
   * so it is audited and clears the cached grants of every session on the
   * profile.
   */
  function addGrantToProfile(
    request: StoredPermissionRequest,
  ): Effect.Effect<void, Unauthenticated | Forbidden | Validation | NotFound | SqlError> {
    return Effect.gen(function* () {
      // The repository, not `profile.read`: deciding is not a read of the
      // profile, and the caller may lack `profile.read`.
      const profile = yield* readProfile(request.profileId);
      if (profile.grants.includes(request.grant)) return;
      yield* profiles.update({ id: profile.id, grants: [...profile.grants, request.grant] }).pipe(
        // The patch has no name, so no name can be taken; and the grants
        // are written with the schema that reads them.
        Effect.catchIf((error): error is Conflict => error instanceof Conflict, Effect.die),
        Effect.catchTag("GrantsError", Effect.die),
      );
    });
  }
});

/** The Permission Request use case: `permission.request` and `permission.decide`. */
export class PermissionRequests extends Context.Service<
  PermissionRequests,
  Effect.Success<typeof make>
>()("hercule/controller/daemon/PermissionRequests") {}

export const PermissionRequestsLayer: Layer.Layer<
  PermissionRequests,
  never,
  | SqlClient.SqlClient
  | PermissionProfiles
  | Profiles
  | SessionTokens
  | Notifier
  | PlatformEvents
  | AuditLog
> = Layer.effect(PermissionRequests)(make);
