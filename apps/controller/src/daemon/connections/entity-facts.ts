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
 * It wraps the delete in `recordEntityFactsAround` for the things the
 * Connection holds a row for and a live Task links, as the ingest does for a
 * write.
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
        Effect.flatMap(entities.listLinkedObservedRefs(connectionId), (refs) =>
          tasks.recordEntityFactsAround(refs, deletion),
        ),
    };
  }),
);
