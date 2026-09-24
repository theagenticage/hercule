/**
 * Deleting a permission profile, which must check what other domains still
 * use it.
 *
 * A profile is the set of grants a session copies at spawn, and that an Agent
 * names for the sessions it will spawn. Deleting the profile under either one
 * would leave an actor with a credential that resolves to nothing, so the
 * delete is rejected while a live session or an Agent uses the profile.
 * Sessions and agents belong to other domains, so this operation lives in the
 * controller daemon rather than in the permissions domain, which reads only
 * its own tables.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createInvalidStateError,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { agentRepository } from "../../agents";
import { requireGrant } from "../../actor";
import { refuseCursor, withTransaction } from "../../db";
import { Profiles, type GrantsError } from "../../permissions";
import { LIVE_SESSION_STATUSES, sessionRepository } from "../../sessions";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const profiles = yield* Profiles;
  // The repositories, not the services: the services check `session.query`
  // and `agent.query` on the caller, and deleting a profile is not a read of
  // anyone's sessions or agents.
  const sessions = yield* sessionRepository;
  const agents = yield* agentRepository;

  return {
    /**
     * Deletes a profile the user created. Fails when the profile does not
     * exist, is one of the built-in profiles, or is still used by a live
     * session or an Agent.
     *
     * The three checks run in one transaction with the delete. Otherwise a
     * session spawned, or an agent pointed at this profile, between a check
     * and the delete would be left on a profile that no longer exists.
     */
    deleteProfile: (input: {
      readonly id: string;
    }): Effect.Effect<
      Record<string, never>,
      Unauthenticated | Forbidden | Validation | NotFound | InvalidState | GrantsError | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("profile.delete");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // The permissions domain's own checks: the profile exists and is
            // not one of the three built-in profiles.
            const profile = yield* profiles.requireDeletable(input.id);
            // A session keeps the grants it copied from this profile for as
            // long as it runs. Deleting the profile would silently break that
            // session's credential, so the delete must wait until those
            // sessions have ended.
            const live = yield* refuseCursor(
              sessions.list({
                limit: 1,
                cursor: undefined,
                direction: "asc",
                status: LIVE_SESSION_STATUSES,
                runnerId: undefined,
                agentId: undefined,
                permissionProfileId: input.id,
                thread: undefined,
              }),
            );
            if (live.items.length > 0) {
              return yield* Effect.fail(
                createInvalidStateError(
                  `${profile.name} is used by a session that has not exited; ` +
                    "delete it once every session using it has exited",
                ),
              );
            }
            // An Agent names the profile for the sessions it will spawn. An
            // agent whose profile is gone could only spawn sessions whose
            // token resolves to no actor. The error names the oldest such
            // agent, so the user knows which agent to change.
            const naming = yield* refuseCursor(
              agents.list({
                limit: 1,
                cursor: undefined,
                direction: "asc",
                permissionProfileId: input.id,
              }),
            );
            const agent = naming.items[0];
            if (agent !== undefined) {
              return yield* Effect.fail(
                createInvalidStateError(
                  `the agent ${agent.name} spawns its sessions under ${profile.name}; ` +
                    "point that agent at another profile first, then delete this one",
                ),
              );
            }
            return yield* profiles.delete({ id: input.id });
          }),
        );
      }),
  };
});

export class ProfileRemoval extends Context.Service<ProfileRemoval, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/ProfileRemoval",
) {}

export const ProfileRemovalLayer: Layer.Layer<
  ProfileRemoval,
  never,
  SqlClient.SqlClient | Profiles
> = Layer.effect(ProfileRemoval)(make);
