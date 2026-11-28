import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import type { Id } from "@hercule/contract";

/**
 * The port through which `ConnectionService` keeps Task facts true when it
 * deletes a Connection.
 *
 * Deleting a Connection deletes the rows of what it read of External Entities.
 * If it was the only Connection that could read a thing that a Task links, the
 * thing becomes unreadable, and what the Task counts as open or completed
 * changes. That is a fact about the Task (`task.entityChanged`), like any
 * other change of an entity write.
 *
 * The connections domain cannot know which things a Connection read, or what
 * a Task makes of them: the External Entities domain depends on this one, and
 * the tasks domain holds the rules. So this domain declares what it needs and
 * the controller daemon provides it (`ConnectionServiceWithReferencesLayer`),
 * as for `ConnectionReferences`.
 */
export class ConnectionEntityFacts extends Context.Service<
  ConnectionEntityFacts,
  {
    /**
     * Runs `deletion`, which deletes the Connection `connectionId`, and
     * records the facts that the loss of its reads makes about the things
     * Tasks link. Call it inside the transaction of the delete, so the facts
     * commit with it.
     */
    readonly recordFactsOfDeletion: <A, E, R>(
      connectionId: Id,
      deletion: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | SqlError, R>;
  }
>()("hercule/controller/connections/ConnectionEntityFacts") {}
