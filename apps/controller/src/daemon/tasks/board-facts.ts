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
import type { SqlError } from "effect/sql/SqlError";
import { MAX_BOARD_GROUPINGS, MAX_BOARD_PLACES } from "@hercule/contract";
import { externalEntityRepository, type ContextRead } from "../../external-entities";
import { PluginHost } from "../../plugins";
import { runRepository } from "../../runs";
import { sessionRepository } from "../../sessions";
import {
  TaskBoardFacts,
  taskRepository,
  type BoardCardFacts,
  type BoardEntityContext,
  type BoardFacts,
  type BoardFactsRequest,
} from "../../tasks";
import { readEntityEnvironment } from "./entity-environment";

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

/** Orders text by code unit, which is how refs sort in the database. */
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Builds what the board shows of the outside things its Tasks link, and the
 * marks and context refs of each Task.
 *
 * - A Task's `contextRefs` are its linked refs, then the refs above them from
 *   `read`, each once. The walk only follows `part of`, so a linked peer
 *   adds nothing.
 * - A Task's `entityMarks` are one per kind among its linked refs that have a
 *   record, in the order the refs were linked.
 * - `groupings` lists each kind that has a caption among the places, once, in
 *   kind order, at most `MAX_BOARD_GROUPINGS`. Kinds beyond that are left
 *   out, and `contextComplete` is false.
 * - `contextComplete` is false when a limit cut the walk or the places, or a
 *   ref above a link is missing, unreadable, stale or backing off.
 */
const buildEntityContext = (
  linksByTask: ReadonlyMap<string, ReadonlyArray<string>>,
  read: ContextRead,
): {
  readonly context: BoardEntityContext;
  readonly cardFactsByTask: ReadonlyMap<
    string,
    Pick<BoardCardFacts, "entityMarks" | "contextRefs">
  >;
} => {
  const { places } = read;
  const placeKinds = new Map(places.map((place) => [place.ref, place.kind] as const));
  const captions = new Map<string, string>();
  for (const place of places) {
    if (place.caption !== undefined) captions.set(place.kind, place.caption);
  }
  const groupings = [...captions]
    .toSorted(([left], [right]) => compareText(left, right))
    .map(([kind, caption]) => ({ kind, caption }));
  const cardFactsByTask = new Map(
    [...linksByTask].map(([taskId, links]) => {
      const kinds = new Set(
        links.flatMap((ref) => {
          const kind = placeKinds.get(ref);
          return kind === undefined ? [] : [kind];
        }),
      );
      return [
        taskId,
        {
          entityMarks: [...kinds].map((kind) => ({ plugin: kind.split("/")[0]!, kind })),
          contextRefs: [
            ...new Set([...links, ...links.flatMap((ref) => read.ancestors.get(ref) ?? [])]),
          ],
        },
      ] as const;
    }),
  );
  return {
    context: {
      places,
      edges: read.edges,
      groupings: groupings.slice(0, MAX_BOARD_GROUPINGS),
      contextComplete:
        [...read.contextComplete.values()].every(Boolean) &&
        groupings.length <= MAX_BOARD_GROUPINGS,
    },
    cardFactsByTask,
  };
};

/**
 * Answers the tasks domain's `TaskBoardFacts` port from the sessions and runs
 * repositories, and from the entity records. Each read covers all the listed
 * Tasks at once, so the number of statements is the same for ten Tasks and
 * for a thousand:
 *
 * - the sessions' counts and times, and the sessions the board looks into;
 * - when the latest run of each Task ended;
 * - the workflow name and cause of each failed run a Task shows;
 * - the refs every Task links, one walk up `part of` from all of them, and
 *   the records and observations of the refs found, which tell whether each
 *   place can be read now.
 *
 * The failed run is the one `tasks.failed_run_id` names. It is read by its
 * id, never found as the Task's newest run: a run that started later and
 * completed does not clear a failure, and a failure can be older than the
 * newest run.
 *
 * It needs the SQL client and the plugin host, which says which plugins are
 * running. In particular it reads the entity repositories, never
 * `ExternalEntityService`, which needs the Task service and would make the
 * layers a cycle.
 */
export const TaskBoardFactsLayer: Layer.Layer<
  TaskBoardFacts,
  never,
  SqlClient.SqlClient | PluginHost
> = Layer.effect(TaskBoardFacts)(
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    const runs = yield* runRepository;
    const tasksRepository = yield* taskRepository;
    const entities = yield* externalEntityRepository;
    const host = yield* PluginHost;

    return {
      readFacts: (tasks: ReadonlyArray<BoardFactsRequest>): Effect.Effect<BoardFacts, SqlError> =>
        Effect.gen(function* () {
          const taskIds = tasks.map((task) => task.id);
          const { totals, notable } = yield* sessions.listBoardFacts(taskIds);
          const lastRunEndings = yield* runs.listLastEndings(taskIds);
          const failures = new Map(
            (yield* runs.listFailures(
              tasks.flatMap((task) => (task.failedRunId === undefined ? [] : [task.failedRunId])),
            )).map((failure) => [failure.runId, failure] as const),
          );
          const linksByTask = yield* tasksRepository.listEntityLinks(taskIds);
          const linkedRefs = [...new Set([...linksByTask.values()].flat())];
          const read = yield* entities.readContext({
            starts: linkedRefs,
            alsoPlaces: linkedRefs,
            maxAncestors: MAX_BOARD_PLACES,
            maxPlaces: MAX_BOARD_PLACES,
            environment: yield* readEntityEnvironment(host),
          });
          const { context, cardFactsByTask } = buildEntityContext(linksByTask, read);
          const totalsByTask = new Map(totals.map((total) => [total.taskId, total] as const));
          const notableByTask = groupByTask(notable);
          return {
            cards: tasks.map((task): BoardCardFacts => {
              const total = totalsByTask.get(task.id);
              return {
                sessions: notableByTask.get(task.id) ?? [],
                threadCount: total?.threadCount ?? 0,
                lastTurnEndedAt: total?.lastTurnEndedAt,
                lastRunEndedAt: lastRunEndings.get(task.id),
                failure:
                  task.failedRunId === undefined ? undefined : failures.get(task.failedRunId),
                entityMarks: cardFactsByTask.get(task.id)?.entityMarks ?? [],
                contextRefs: cardFactsByTask.get(task.id)?.contextRefs ?? [],
              };
            }),
            context,
          };
        }),
    };
  }),
);
