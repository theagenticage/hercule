import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import { ConnectionEntityFacts } from "../../connections";
import { externalEntityRepository } from "../../external-entities";
import { TaskService } from "../../tasks";

/**
 * Provides the connections domain's `ConnectionEntityFacts` from the External
 * Entities rows and the Task service. It lives in the controller daemon
 * because the External Entities domain depends on the connections domain, so
 * the connections domain cannot read it back.
 *
 * It takes the snapshot of the things the Connection holds a row for and a
 * live Task links, before the delete, and records the facts after it, as the
 * ingest does for a write.
 */
export const ConnectionEntityFactsLayer: Layer.Layer<
  ConnectionEntityFacts,
  never,
  SqlClient.SqlClient | TaskService
> = Layer.effect(ConnectionEntityFacts)(
  Effect.gen(function* () {
    const entities = yield* externalEntityRepository;
    const tasks = yield* TaskService;
    return {
      recordFactsOfDeletion: (connectionId, deletion) =>
        Effect.gen(function* () {
          const snapshot = yield* tasks.snapshotLinkedEntities(
            yield* entities.listLinkedObservedRefs(connectionId),
          );
          const deleted = yield* deletion;
          yield* tasks.recordEntityFacts(snapshot);
          return deleted;
        }),
    };
  }),
);
