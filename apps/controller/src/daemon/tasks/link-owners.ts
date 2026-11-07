/**
 * Task Link Owners: moves the sessions and the runs of one Task to another,
 * for `task.merge`.
 *
 * It lives in the controller daemon because the port belongs to the tasks
 * domain and is answered from the sessions and runs repositories, and both of
 * those domains depend on the tasks domain. Only the layer above them can join
 * them.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import { runRepository } from "../../runs";
import { sessionRepository } from "../../sessions";
import { TaskLinkOwners } from "../../tasks";

/**
 * Answers the tasks domain's `TaskLinkOwners` port with one statement on the
 * sessions and one on the runs. Each statement uses the index on the Task id.
 */
export const TaskLinkOwnersLayer: Layer.Layer<TaskLinkOwners, never, SqlClient.SqlClient> =
  Layer.effect(TaskLinkOwners)(
    Effect.gen(function* () {
      const sessions = yield* sessionRepository;
      const runs = yield* runRepository;

      return {
        moveTask: (sourceId: string, targetId: string) =>
          Effect.andThen(
            sessions.moveTaskLinks(sourceId, targetId),
            runs.moveTaskLinks(sourceId, targetId),
          ),
      };
    }),
  );
