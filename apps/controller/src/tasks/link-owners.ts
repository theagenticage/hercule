/**
 * Task Link Owners: the port through which the tasks domain moves the links
 * that other domains own.
 *
 * Sessions and runs both point at a Task (`sessions.task_id`, `runs.task_id`).
 * Both domains depend on the tasks domain, so the tasks domain cannot import
 * them. It declares what it needs here and the controller daemon implements it
 * (`daemon/tasks/link-owners.ts`).
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

export class TaskLinkOwners extends Context.Service<
  TaskLinkOwners,
  {
    /**
     * Points every session and every run of the Task `sourceId` at the Task
     * `targetId`. It runs in the caller's transaction and checks no grant: the
     * caller is `task.merge`, which has checked both. It announces nothing,
     * because the merge announces both Tasks.
     */
    readonly moveTask: (sourceId: string, targetId: string) => Effect.Effect<void, SqlError>;
  }
>()("hercule/controller/tasks/TaskLinkOwners") {}
