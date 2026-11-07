/**
 * Task Detail Facts: reads, for `task.readDetail`, the sessions of one Task,
 * the number of its runs, and the outside things it links.
 *
 * It lives in the controller daemon because the port belongs to the tasks
 * domain and is answered from the sessions, runs and entity repositories, and
 * all of those domains depend on the tasks domain. Only the layer above them
 * can join them. It reads the entity repository, never
 * `ExternalEntityService`, which needs the Task service and would make the
 * layers a cycle.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import { MAX_CARD_CONTEXTS, MAX_ENTITY_ANCESTORS } from "@hercule/contract";
import { externalEntityRepository } from "../../external-entities";
import { PluginHost } from "../../plugins";
import { runRepository } from "../../runs";
import { buildOpenRequests, sessionRepository } from "../../sessions";
import { TaskDetailFacts, taskRepository } from "../../tasks";
import { readEntityEnvironment } from "./entity-environment";

/**
 * Answers the tasks domain's `TaskDetailFacts` port from the sessions, runs
 * and entity repositories: one statement for the sessions, one for the run
 * count, and for the linked things the Task's links and one `readContext` over
 * them, whatever the number of links. A session's open Requests are built by
 * the code that builds them for the `Session` record, so the pane and the
 * session itself never disagree.
 */
export const TaskDetailFactsLayer: Layer.Layer<
  TaskDetailFacts,
  never,
  SqlClient.SqlClient | PluginHost
> = Layer.effect(TaskDetailFacts)(
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    const runs = yield* runRepository;
    const tasks = yield* taskRepository;
    const entities = yield* externalEntityRepository;
    const host = yield* PluginHost;

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
      readLinkedEntities: (taskId: string) =>
        Effect.gen(function* () {
          const linkedRefs = ((yield* tasks.listEntityLinks([taskId])).get(taskId) ?? []).slice(
            0,
            MAX_CARD_CONTEXTS,
          );
          const read = yield* entities.readContext({
            starts: linkedRefs,
            alsoPlaces: linkedRefs,
            maxAncestors: MAX_ENTITY_ANCESTORS,
            maxPlaces: MAX_CARD_CONTEXTS,
            environment: yield* readEntityEnvironment(host),
          });
          const placeByRef = new Map(read.places.map((place) => [place.ref, place] as const));
          return {
            // A linked ref with no record has no row to draw, so it is left out.
            entities: linkedRefs.flatMap((ref) => placeByRef.get(ref) ?? []),
            places: read.places,
            edges: read.edges,
          };
        }),
    };
  }),
);
