/**
 * Deleting a permission profile: the one operation that has to know what every
 * other domain still holds.
 *
 * A profile is the grant bundle a Session copies at spawn and an Agent names
 * for the sessions it has not spawned yet. Deleting the row underneath either
 * one would leave an actor with a credential that resolves to nothing, so the
 * delete is refused while either exists. The sessions and the agents are other
 * domains' rows, which is why the operation is here and not in the permissions
 * domain: a domain reads its own table.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  invalidState,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { agentRepository } from "../agents";
import { requireGrant } from "../actor";
import { refuseCursor, withTransaction } from "../db";
import { Profiles, type GrantsError } from "../permissions";
import { LIVE_SESSION_STATUSES, sessionRepository } from "../sessions";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const profiles = yield* Profiles;
  // Both repositories, not the services beside them: those enforce
  // `session.query` and `agent.query` on whoever is calling, and deleting a
  // profile is not a read of anybody's sessions or agents.
  const sessions = yield* sessionRepository;
  const agents = yield* agentRepository;

  return {
    /**
     * Deletes a profile the user made, once nothing holds it any more.
     *
     * The three checks are in one transaction with the delete. A session
     * spawned, or an agent pointed at this profile, between a check and the
     * delete would otherwise be left behind on a profile that is gone.
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
            // What the permissions domain itself says about this id: no such
            // profile, or one of the three Hercule ships.
            const profile = yield* profiles.requireDeletable(input.id);
            // A session is bounded by the grants it copied from this row for
            // as long as it runs. Deleting it underneath one would kill that
            // session's credential without saying so, so the delete waits for
            // the sessions to end rather than the sessions for the delete.
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
                invalidState(
                  `${profile.name} is carried by a session that has not exited; ` +
                    "it can be deleted once they have.",
                ),
              );
            }
            // An Agent names the profile for the sessions it has not spawned
            // yet. That is the same promise, one step earlier: an agent whose
            // profile is gone could only spawn a session that no actor can
            // act as. The oldest such agent is named, so the user knows which
            // agent to point elsewhere.
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
                invalidState(
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
