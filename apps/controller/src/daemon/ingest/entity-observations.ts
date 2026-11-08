import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { ExternalEntityIngest, ExternalEntityIngestLayer } from "../../external-entities";
import { EntityObservations } from "../../plugins";

const make = Effect.gen(function* () {
  const ingest = yield* ExternalEntityIngest;
  return EntityObservations.of({
    reconcile: ingest.reconcile,
    refresh: ingest.refresh,
    listWanted: (reporter, kind, limit) => Effect.orDie(ingest.listWanted(reporter, kind, limit)),
    // TODO(#1035 phase 3): answer from the tracked branches of live Tasks. Until then no branch is tracked.
    listTrackedBranches: () => Effect.succeed([]),
    reportMissing: ingest.reportMissing,
  });
});

/**
 * Implements the plugins domain's `EntityObservations` port from the External
 * Entities ingest: an event source reports through it what a poll read of
 * entities. The plugins domain cannot import the External Entities domain
 * without making the domain graph a cycle, so the controller daemon joins the
 * two. The ingest needs only the database, so this layer cannot reach back
 * into the plugin host.
 */
export const EntityObservationsLayer: Layer.Layer<EntityObservations, never, SqlClient.SqlClient> =
  Layer.effect(EntityObservations)(make).pipe(Layer.provide(ExternalEntityIngestLayer));
