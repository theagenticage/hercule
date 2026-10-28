/**
 * The permission profile operations of the API: `profile.query`, `read`,
 * `create` and `update`, and the part of delete that this domain checks.
 *
 * The three shipped profiles can be edited but not deleted. Editing one is an
 * ordinary update, because the user should be able to widen or narrow what an
 * assistant may do. Deleting one would leave the agents that use it pointing
 * at nothing, so it fails with `invalid_state` rather than deleting those
 * agents too.
 *
 * `profile.delete` itself is the controller daemon's `deleteProfile`, because
 * its checks also read the sessions and agents that use the profile, and those
 * rows belong to other domains.
 *
 * Users know a profile by its name, so a name that another profile already has
 * fails with `conflict` rather than creating a second "reviewer" that is
 * silently renamed.
 *
 * Only the user gives a profile `skill.write` or `skill.apply`. A session is
 * refused when its `profile.create` or `profile.update` would add either one,
 * even when it holds `permission.write`. See `GRANTS_ONLY_THE_USER_GIVES`.
 * For the same reason, a session is refused when it puts an Agent or an
 * assistant on a profile that holds either one: see
 * `requireMayAssignAgentProfile`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createConflictError,
  createForbiddenError,
  createInvalidStateError,
  createNotFoundError,
  createDecodeValidationError,
  createValidationError,
  DEFAULT_PAGE_LIMIT,
  GRANTS_ONLY_THE_USER_GIVES,
  GRANTS_ONLY_THE_USER_GIVES_TEXT,
  PROFILE_SORT_FIELDS,
  type Conflict,
  type Forbidden,
  type Grant,
  type InvalidState,
  type NotFound,
  type Profile,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant, type Actor } from "../actor";
import {
  afterCommit,
  buildPageInputFields,
  refuseCursor,
  resolveSortDirection,
  withTransaction,
} from "../db";
import { AuditLog } from "../events";
import { PermissionProfiles, type GrantsError } from "./profiles";
import { SessionTokens } from "./tokens";

/** The input of `profile.query`. An absent field means its default value. */
const QueryInput = Schema.Struct(buildPageInputFields(PROFILE_SORT_FIELDS));

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);

/** One page of profiles, in the contract's shape. */
export interface ProfilePage {
  readonly items: ReadonlyArray<Profile>;
  readonly nextCursor?: string;
}

/** Sorted by name, ascending, because people look for a profile by its name. */
const DEFAULT_DIRECTION: SortDirection = "asc";

/** Returns the conflict error for a taken name, so create and update use the same message. */
const NAME_TAKEN = (name: string): Conflict =>
  createConflictError(`a profile named ${name} already exists`);

const NO_SUCH_PROFILE = "no such permission profile";

/** The refusal for a session that would give a grant only the user gives. */
const ONLY_THE_USER_GIVES_SKILL_GRANTS =
  `Only the user gives a profile ${GRANTS_ONLY_THE_USER_GIVES_TEXT}, so a session token is refused ` +
  "whatever grants its profile holds. Ask for the grant with `hercule permission request <grant>`; " +
  "the user decides it.";

/**
 * The refusal for a session that would put an Agent or an assistant on a
 * profile holding a grant only the user gives.
 */
const ONLY_THE_USER_ASSIGNS_SKILL_GRANTS =
  `Only the user puts an Agent or an assistant on a profile that holds ${GRANTS_ONLY_THE_USER_GIVES_TEXT}, ` +
  "because its sessions run with that profile's grants, a workflow's agent step included. " +
  "So a session token is refused whatever grants its profile holds. " +
  "Name a profile without them, or ask the user to make this change.";

/** Checks whether `actor` is a session and `grants` holds a grant only the user gives. */
const isSessionGivingUserOnlyGrant = (actor: Actor, grants: ReadonlyArray<Grant>): boolean =>
  actor._tag === "session" && grants.some((grant) => GRANTS_ONLY_THE_USER_GIVES.includes(grant));

/**
 * Checks that `actor` may give every grant in `grants`, to a profile or by
 * deciding a Permission Request. Fails with `Forbidden` naming
 * `permission.write` when the actor is a session and `grants` holds one of
 * `GRANTS_ONLY_THE_USER_GIVES`.
 *
 * A run passes, as it passes every grant check: it acts for the user, who
 * saved its workflow.
 */
export const requireMayGiveGrants = (
  actor: Actor,
  grants: ReadonlyArray<Grant>,
): Effect.Effect<void, Forbidden> =>
  isSessionGivingUserOnlyGrant(actor, grants)
    ? Effect.fail(createForbiddenError("permission.write", ONLY_THE_USER_GIVES_SKILL_GRANTS))
    : Effect.void;

/**
 * Checks that `actor` may put an Agent or an assistant on a profile that
 * holds `grants`. Fails with `Forbidden` naming `agent.write` when the actor
 * is a session and `grants` holds one of `GRANTS_ONLY_THE_USER_GIVES`.
 *
 * Choosing the profile gives its grants to the Agent's sessions. A workflow's
 * agent step runs with its Agent's profile, with no check against the
 * session that made the Agent, so without this a session could pass on a
 * grant it may not give. A run passes, as in `requireMayGiveGrants`.
 */
export const requireMayAssignAgentProfile = (
  actor: Actor,
  grants: ReadonlyArray<Grant>,
): Effect.Effect<void, Forbidden> =>
  isSessionGivingUserOnlyGrant(actor, grants)
    ? Effect.fail(createForbiddenError("agent.write", ONLY_THE_USER_ASSIGNS_SKILL_GRANTS))
    : Effect.void;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const profiles = yield* PermissionProfiles;
  const tokens = yield* SessionTokens;
  const audit = yield* AuditLog;

  /**
   * Returns the profile with this id if the permissions domain allows it to be
   * deleted. Fails with `NotFound` if there is no such profile, and with
   * `invalid_state` for a shipped profile: the user changes a shipped profile
   * by editing it.
   *
   * The controller daemon's `deleteProfile` checks whether a running session
   * or an Agent still uses the profile, because those rows belong to other
   * domains. This function checks only what the permissions domain knows.
   */
  const requireDeletable = (
    id: string,
  ): Effect.Effect<Profile, NotFound | InvalidState | GrantsError | SqlError> =>
    Effect.gen(function* () {
      const found = yield* profiles.getById(id);
      if (Option.isNone(found)) return yield* Effect.fail(createNotFoundError(NO_SUCH_PROFILE));
      if (found.value.shipped) {
        return yield* Effect.fail(
          createInvalidStateError(
            `${found.value.name} is a shipped profile, so it cannot be deleted. Edit it instead.`,
          ),
        );
      }
      return found.value;
    });

  return {
    /** Returns one page of profiles, shipped ones included, sorted by name. */
    query: (
      input: QueryInput,
    ): Effect.Effect<
      ProfilePage,
      Unauthenticated | Forbidden | Validation | GrantsError | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("profile.query");
        const { limit, cursor, sort } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
        );
        const page = yield* refuseCursor(
          profiles.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: resolveSortDirection(sort, DEFAULT_DIRECTION),
          }),
        );
        return {
          items: page.items,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
      }),

    /** Returns one profile by id. Fails with `NotFound` if there is none. */
    read: (input: {
      readonly id: string;
    }): Effect.Effect<Profile, Unauthenticated | Forbidden | NotFound | GrantsError | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("profile.read");
        const found = yield* profiles.getById(input.id);
        return yield* Option.match(found, {
          onNone: () => Effect.fail(createNotFoundError(NO_SUCH_PROFILE)),
          onSome: Effect.succeed,
        });
      }),

    /**
     * Creates a user profile and returns it. Fails with `conflict` if the name
     * is taken, and with `Forbidden` when a session asks for a grant only the
     * user gives. Shipped profiles are seeded, never created here.
     */
    create: (input: {
      readonly name: string;
      readonly grants: ReadonlyArray<Grant>;
    }): Effect.Effect<Profile, Unauthenticated | Forbidden | Conflict | GrantsError | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("profile.create");
        yield* requireMayGiveGrants(actor, input.grants);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const created = yield* profiles.create(input.name, input.grants);
            if (Option.isNone(created)) return yield* Effect.fail(NAME_TAKEN(input.name));
            yield* audit.append({
              kind: "profile.created",
              actor: yield* currentStamp,
              payload: { id: created.value.id, name: created.value.name },
            });
            return created.value;
          }),
        );
      }),

    /**
     * Edits a profile, shipped ones included, and returns it.
     *
     * A patch with no field fails with a validation error. Otherwise it would
     * succeed and record a `profile.updated` event for an edit that did not
     * happen. To read a profile without changing it, use `profile.read`.
     *
     * Fails with `Forbidden` when a session's patch adds a grant only the user
     * gives. A grant the profile already holds is not added, so a session may
     * still send it back unchanged, or remove it.
     */
    update: (input: {
      readonly id: string;
      readonly name?: string;
      readonly grants?: ReadonlyArray<Grant>;
    }): Effect.Effect<
      Profile,
      Unauthenticated | Forbidden | NotFound | Conflict | Validation | GrantsError | SqlError
    > =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("profile.update");
        if (input.name === undefined && input.grants === undefined) {
          return yield* Effect.fail(
            createValidationError([{ path: [], message: "name a field to change" }]),
          );
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const grants = input.grants;
            // Only a session can be refused, so only a session's patch needs
            // the grants the profile holds now.
            if (actor._tag === "session" && grants !== undefined) {
              // An unknown id has nothing to add to: the update below fails
              // with `not_found` for it.
              const held = Option.match(yield* profiles.getById(input.id), {
                onNone: () => grants,
                onSome: (profile) => profile.grants,
              });
              yield* requireMayGiveGrants(
                actor,
                grants.filter((grant) => !held.includes(grant)),
              );
            }
            const outcome = yield* profiles.update(input.id, {
              ...(input.name === undefined ? {} : { name: input.name }),
              ...(input.grants === undefined ? {} : { grants: input.grants }),
            });
            switch (outcome._tag) {
              case "absent":
                return yield* Effect.fail(createNotFoundError(NO_SUCH_PROFILE));
              case "nameTaken":
                // Only the unique `name` column can make `UPDATE OR IGNORE`
                // skip the row, so a patch that gets here has a name.
                return yield* Effect.fail(NAME_TAKEN(input.name!));
              case "updated":
                // The running sessions on this profile have the old grants
                // cached. Clearing the cache makes their next call read the
                // new grants. It runs after the commit, so a call that is
                // running meanwhile cannot cache the old grants again.
                yield* afterCommit(() => {
                  tokens.forgetProfile(outcome.profile.id);
                });
                yield* audit.append({
                  kind: "profile.updated",
                  actor: yield* currentStamp,
                  payload: { id: outcome.profile.id, name: outcome.profile.name },
                });
                return outcome.profile;
            }
          }),
        );
      }),

    requireDeletable,

    /**
     * Deletes a profile after this domain's own checks, and records a
     * `profile.deleted` event. The caller is the controller daemon's
     * `deleteProfile`, which checks the grant and fails for a profile that
     * rows in other domains still use.
     */
    delete: (input: {
      readonly id: string;
    }): Effect.Effect<Record<string, never>, NotFound | InvalidState | GrantsError | SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const profile = yield* requireDeletable(input.id);
          yield* profiles.delete(profile.id);
          yield* audit.append({
            kind: "profile.deleted",
            actor: yield* currentStamp,
            payload: { id: profile.id, name: profile.name },
          });
          return {};
        }),
      ),
  };
});

/** The profile service. */
export class Profiles extends Context.Service<Profiles, Effect.Success<typeof make>>()(
  "hercule/controller/permissions/Profiles",
) {}

export const ProfilesLayer: Layer.Layer<
  Profiles,
  never,
  SqlClient.SqlClient | PermissionProfiles | SessionTokens | AuditLog
> = Layer.effect(Profiles)(make);
