/**
 * Task Detail Facts: reads, for `task.readDetail`, the sessions of one Task
 * and the number of its runs.
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
import { buildOpenRequests, sessionRepository } from "../../sessions";
import { TaskDetailFacts } from "../../tasks";

/**
 * Answers the tasks domain's `TaskDetailFacts` port from the sessions and
 * runs repositories, in one statement for the sessions and one for the run
 * count. A session's open Requests are built by the code that builds them for
 * the `Session` record, so the pane and the session itself never disagree.
 */
export const TaskDetailFactsLayer: Layer.Layer<TaskDetailFacts, never, SqlClient.SqlClient> =
  Layer.effect(TaskDetailFacts)(
    Effect.gen(function* () {
      const sessions = yield* sessionRepository;
      const runs = yield* runRepository;

      return {
        readSessions: (taskId: string, limit: number, pinnedSessionId: string | undefined) =>
          Effect.map(
            sessions.listOfTask(taskId, limit, pinnedSessionId),
            ({ sessions: found, total }) => ({
              sessions: found.map((session) => ({
                id: session.id,
                title: session.title,
                role: session.role,
                kind: session.kind,
                status: session.status,
                openRequests: buildOpenRequests(session),
                done: session.done !== null,
              })),
              total,
            }),
          ),
        countRuns: runs.countOfTask,
      };
    }),
  );
