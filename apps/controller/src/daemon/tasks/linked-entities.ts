/**
 * Linked Entities: answers the tasks domain's question "what do we hold of the
 * things this Task links" from the stored rows alone.
 *
 * It lives in the controller daemon because the port belongs to the tasks
 * domain, and the External Entities and plugin domains that hold the rows
 * depend on the tasks domain. It reads `externalEntityRepository` and the
 * stored plugin catalog, never `PluginHost` or `ExternalEntityService`
 * (compare `board-facts.ts`, which may). The ingest that writes entities calls
 * the Task service, so a read here that required either would be a cycle of
 * layers.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import { externalEntityRepository } from "../../external-entities";
import { pluginRepository } from "../../plugins";
import { LinkedEntities, type LinkedEntityState } from "../../tasks";

/**
 * Answers the `LinkedEntities` port with two statements on the records and
 * their observations, and a third on the catalog only when a ref needs it.
 *
 * - A full record says itself whether it is work, and what it is stays so
 *   after its plugin is removed.
 * - A partial record, or a ref with no record, is classified by the entity
 *   kind the catalog declares for the ref's prefix. With no such kind
 *   nothing is known of the ref, and it is left out of the answer.
 */
export const LinkedEntitiesLayer: Layer.Layer<LinkedEntities, never, SqlClient.SqlClient> =
  Layer.effect(LinkedEntities)(
    Effect.gen(function* () {
      const entities = yield* externalEntityRepository;
      const plugins = yield* pluginRepository;

      return {
        readMany: (refs: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const states = new Map<string, LinkedEntityState>();
            if (refs.length === 0) return states;
            const records = yield* entities.readStoredRecordStates(refs);
            const needsCatalog = refs.some((ref) => records.get(ref)?.completeness !== "full");
            const declared = needsCatalog ? yield* plugins.listDeclaredEntityKinds() : [];
            for (const ref of refs) {
              const record = records.get(ref);
              if (record?.completeness === "full") {
                states.set(ref, {
                  kind: record.kind,
                  classification: record.isWorkRecord ? "work" : "context",
                  isFullRecord: true,
                  lifecycle: record.lifecycle,
                  isReadable: record.access === "ok",
                });
                continue;
              }
              const kind = declared.find(({ refPrefix }) => ref.startsWith(refPrefix));
              if (kind === undefined) continue;
              states.set(ref, {
                kind: record?.kind || kind.kind,
                classification: kind.classification,
                isFullRecord: false,
                lifecycle: record?.lifecycle ?? null,
                isReadable: record?.access === "ok",
              });
            }
            return states;
          }),
      };
    }),
  );
