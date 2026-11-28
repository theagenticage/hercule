/**
 * The Project a new Task of an outside thing is filed under. A take-on and a
 * handoff from a card both make Tasks for outside things, so they share one
 * rule.
 */
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import type { resourceRepository } from "../resources";

/**
 * Returns the Project for the Task of an outside thing: the only Project that
 * is not deleted and that the Resource whose canonical remote is the
 * repository the work lands in is filed under. With no repository, no such
 * Resource, or a Resource in no live Project or in several, there is none. A
 * GitHub repository or a Linear project is never a Project.
 */
export const findProjectOfRemote = (
  resources: Effect.Success<typeof resourceRepository>,
  remote: string | undefined,
): Effect.Effect<string | undefined, SqlError> =>
  Effect.gen(function* () {
    if (remote === undefined) return undefined;
    const projects = yield* resources.listLiveProjectsOfRemote(remote);
    return projects.length === 1 ? projects[0] : undefined;
  });
