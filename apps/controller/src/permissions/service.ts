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
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createConflictError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  DEFAULT_PAGE_LIMIT,
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
import { currentStamp, requireGrant } from "../actor";
import { afterCommit, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PermissionProfiles, type GrantsError } from "./profiles";
import { SessionTokens } from "./tokens";

/** The input of `profile.query`. An absent field means its default value. */
export interface QueryInput {
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: { readonly field: "name"; readonly direction?: SortDirection };
}

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
        const page = yield* profiles
          .list({
            limit: input.limit ?? DEFAULT_PAGE_LIMIT,
            cursor: input.cursor,
            direction: input.sort?.direction ?? DEFAULT_DIRECTION,
          })
          .pipe(
            Effect.catchTag("CursorError", (error) =>
              Effect.fail(createValidationError([{ path: ["cursor"], message: error.message }])),
            ),
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
     * is taken. Shipped profiles are seeded, never created here.
     */
    create: (input: {
      readonly name: string;
      readonly grants: ReadonlyArray<Grant>;
    }): Effect.Effect<Profile, Unauthenticated | Forbidden | Conflict | GrantsError | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("profile.create");
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
        yield* requireGrant("profile.update");
        if (input.name === undefined && input.grants === undefined) {
          return yield* Effect.fail(
            createValidationError([{ path: [], message: "name a field to change" }]),
          );
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
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
