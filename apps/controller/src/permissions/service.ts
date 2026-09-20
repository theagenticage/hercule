/**
 * Permission profiles as the API sees them: `profile.query`, `read`, `create`,
 * `update` and `delete`.
 *
 * The three shipped profiles are editable and not deletable. Editing one is an
 * ordinary update - the user is meant to be able to widen or narrow what an
 * assistant may do - but deleting one would leave the agents that reference it
 * pointing at nothing, so it is `invalid_state` rather than a cascade.
 *
 * A name is the key the user knows a profile by, so a name another profile
 * already holds is `conflict` rather than a silently disambiguated second
 * "reviewer".
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  conflict,
  DEFAULT_PAGE_LIMIT,
  invalidState,
  notFound,
  validation,
  type Conflict,
  type Forbidden,
  type Grant,
  type InvalidState,
  type NotFound,
  type Profile,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { currentStamp, requireGrant } from "../actor";
import { afterCommit, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PermissionProfiles, type GrantsError } from "./profiles";
import { SessionTokens } from "./tokens";

/** What listing takes. Absent fields are the defaults, not "no page". */
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

/** By name, ascending: a profile list is read to find one by the name it is known by. */
const DEFAULT_DIRECTION: SortDirection = "asc";

/** The one message a name collision gets, whichever operation hit it. */
const NAME_TAKEN = (name: string): Conflict => conflict(`a profile named ${name} already exists`);

const NO_SUCH_PROFILE = "no such permission profile";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const profiles = yield* PermissionProfiles;
  const tokens = yield* SessionTokens;
  const audit = yield* AuditLog;

  return {
    /** Every profile, shipped ones included, by name. */
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
              Effect.fail(validation([{ path: ["cursor"], message: error.message }])),
            ),
          );
        return {
          items: page.items,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
      }),

    /** One profile by id. */
    read: (input: {
      readonly id: string;
    }): Effect.Effect<Profile, Unauthenticated | Forbidden | NotFound | GrantsError | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("profile.read");
        const found = yield* profiles.getById(input.id);
        return yield* Option.match(found, {
          onNone: () => Effect.fail(notFound(NO_SUCH_PROFILE)),
          onSome: Effect.succeed,
        });
      }),

    /** Creates a profile the user owns. Shipped profiles are seeded, never created here. */
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
     * Edits a profile, shipped ones included.
     *
     * A patch that changes nothing is `validation`. It would otherwise answer
     * 200 and stamp a `profile.updated` row for an edit that did not happen,
     * and the operation that reads a profile without touching it is
     * `profile.read`.
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
          return yield* Effect.fail(validation([{ path: [], message: "name a field to change" }]));
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
                return yield* Effect.fail(notFound(NO_SUCH_PROFILE));
              case "nameTaken":
                // Only the unique `name` column can make the update an ignore,
                // so a patch that got here carried one.
                return yield* Effect.fail(NAME_TAKEN(input.name!));
              case "updated":
                // Every live session on this profile is carrying the grants it
                // held a moment ago; the next call each makes reads the row
                // this write just changed. After the commit, so a call in
                // flight cannot cache the old grants again in between.
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

    /**
     * Deletes a profile the user made. A shipped profile is `invalid_state`:
     * it is part of what Hydra ships, and the user's way to change it is to
     * edit it.
     */
    delete: (input: {
      readonly id: string;
    }): Effect.Effect<
      Record<string, never>,
      Unauthenticated | Forbidden | NotFound | InvalidState | GrantsError | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("profile.delete");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const found = yield* profiles.getById(input.id);
            if (Option.isNone(found)) return yield* Effect.fail(notFound(NO_SUCH_PROFILE));
            if (found.value.shipped) {
              return yield* Effect.fail(
                invalidState(`${found.value.name} is a profile Hydra ships; it cannot be deleted.`),
              );
            }
            // A session is bounded by the grants it copied from this row for as
            // long as it runs. Deleting it underneath one would kill that
            // session's credential without saying so, so the delete waits for
            // the sessions to end rather than the sessions for the delete.
            if (yield* profiles.heldByLiveSession(input.id)) {
              return yield* Effect.fail(
                invalidState(
                  `${found.value.name} is carried by a session that has not exited; ` +
                    "it can be deleted once they have.",
                ),
              );
            }
            // An Agent names the profile for the sessions it has not spawned
            // yet. That is the same promise, one step earlier: an agent whose
            // profile is gone could only spawn a session that no actor can
            // act as.
            const agent = yield* profiles.findOldestAgentNameUnderProfile(input.id);
            if (Option.isSome(agent)) {
              return yield* Effect.fail(
                invalidState(
                  `the agent ${agent.value} spawns its sessions under ${found.value.name}; ` +
                    "point that agent at another profile first, then delete this one",
                ),
              );
            }
            yield* profiles.delete(input.id);
            yield* audit.append({
              kind: "profile.deleted",
              actor: yield* currentStamp,
              payload: { id: found.value.id, name: found.value.name },
            });
            return {};
          }),
        );
      }),
  };
});

/** The profile service. */
export class Profiles extends Context.Service<Profiles, Effect.Success<typeof make>>()(
  "hydra/controller/permissions/Profiles",
) {}

export const ProfilesLayer: Layer.Layer<
  Profiles,
  never,
  SqlClient.SqlClient | PermissionProfiles | SessionTokens | AuditLog
> = Layer.effect(Profiles)(make);
