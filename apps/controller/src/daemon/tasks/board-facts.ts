/**
 * Task Board Facts: reads, for `task.queryBoard`, the facts from the sessions
 * and runs of the listed Tasks that their cards show.
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
import { TaskBoardFacts, type BoardCardFacts, type BoardFactsRequest } from "../../tasks";

/** Groups the items by their Task id, keeping their order. */
const groupByTask = <Item extends { readonly taskId: string }>(
  items: ReadonlyArray<Item>,
): ReadonlyMap<string, ReadonlyArray<Item>> => {
  const byTask = new Map<string, Array<Item>>();
  for (const item of items) {
    const group = byTask.get(item.taskId);
    if (group === undefined) byTask.set(item.taskId, [item]);
    else group.push(item);
  }
  return byTask;
};

/**
 * Answers the tasks domain's `TaskBoardFacts` port from the sessions and runs
 * repositories. Each read covers all the listed Tasks at once, so the number
 * of statements is the same for ten Tasks and for a thousand:
 *
 * - the sessions' counts and times, and the sessions the board looks into;
 * - when the latest run of each Task ended;
 * - the workflow name and cause of each failed run a Task shows.
 *
 * The failed run is the one `tasks.failed_run_id` names. It is read by its
 * id, never found as the Task's newest run: a run that started later and
 * completed does not clear a failure, and a failure can be older than the
 * newest run.
 */
export const TaskBoardFactsLayer: Layer.Layer<TaskBoardFacts, never, SqlClient.SqlClient> =
  Layer.effect(TaskBoardFacts)(
    Effect.gen(function* () {
      const sessions = yield* sessionRepository;
      const runs = yield* runRepository;

      return {
        readFacts: (tasks: ReadonlyArray<BoardFactsRequest>) =>
          Effect.gen(function* () {
            const taskIds = tasks.map((task) => task.id);
            const { totals, notable } = yield* sessions.listBoardFacts(taskIds);
            const lastRunEndings = yield* runs.listLastEndings(taskIds);
            const failures = new Map(
              (yield* runs.listFailures(
                tasks.flatMap((task) => (task.failedRunId === undefined ? [] : [task.failedRunId])),
              )).map((failure) => [failure.runId, failure] as const),
            );
            const totalsByTask = new Map(totals.map((total) => [total.taskId, total] as const));
            const notableByTask = groupByTask(notable);
            return tasks.map((task): BoardCardFacts => {
              const total = totalsByTask.get(task.id);
              return {
                sessions: notableByTask.get(task.id) ?? [],
                threadCount: total?.threadCount ?? 0,
                lastTurnEndedAt: total?.lastTurnEndedAt,
                lastRunEndedAt: lastRunEndings.get(task.id),
                failure:
                  task.failedRunId === undefined ? undefined : failures.get(task.failedRunId),
              };
            });
          }),
      };
    }),
  );
