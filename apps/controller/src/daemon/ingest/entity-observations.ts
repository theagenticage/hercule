import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { ExternalEntityIngest, ExternalEntityIngestLayer } from "../../external-entities";
import { AuditLog, PlatformEvents } from "../../events";
import { Notifier } from "../../notifications";
import type { EntityObservation } from "@hercule/plugin-host";
import { EntityObservations } from "../../plugins";
import { absorbFailures } from "../../absorbing";
import { BranchLinks, BranchLinksLayer, TaskServiceWithPortsLayer } from "../tasks";

/** Tells whether an observation names the branch its work comes from, so it may belong to a Task's branch. */
const hasHead = (observation: EntityObservation): boolean =>
  observation.repository?.head !== undefined;

const make = Effect.gen(function* () {
  const ingest = yield* ExternalEntityIngest;
  const branchLinks = yield* BranchLinks;

  // The scan or refresh is committed when this runs, and the plugin must not
  // see it fail because the link step did: the next scan runs the step again.
  const linkEntitiesAfter = (
    observations: ReadonlyArray<EntityObservation>,
  ): Effect.Effect<void> =>
    observations.some(hasHead)
      ? absorbFailures(
          "Linking the pull requests on a Task's branch failed",
          Effect.asVoid(branchLinks.linkEntitiesByBranch()),
        )
      : Effect.void;

  return EntityObservations.of({
    reconcile: (reporter, inventory, recognize) =>
      Effect.tap(ingest.reconcile(reporter, inventory, recognize), () =>
        inventory.complete ? linkEntitiesAfter(inventory.observations) : Effect.void,
      ),
    refresh: (reporter, observations, recognize) =>
      Effect.tap(ingest.refresh(reporter, observations, recognize), () =>
        linkEntitiesAfter(observations),
      ),
    listWanted: (reporter, kind, limit) => Effect.orDie(ingest.listWanted(reporter, kind, limit)),
    listTrackedBranches: (reporter, remotePrefix, limit) =>
      Effect.orDie(
        branchLinks.listTrackedBranches({
          connectionId: reporter.connectionId,
          remotePrefix,
          limit,
        }),
      ),
    reportMissing: ingest.reportMissing,
  });
});

/**
 * Implements the plugins domain's `EntityObservations` port from the External
 * Entities ingest: an event source reports through it what a poll read of
 * entities. The plugins domain cannot import the External Entities domain
 * without making the domain graph a cycle, so the controller daemon joins the
 * two.
 *
 * The ingest records the facts that an entity write makes about the things
 * Tasks link, so it needs the Task service. That service reads the database
 * alone (its `LinkedEntities` port is answered from stored rows), so this
 * layer still cannot reach back into the plugin host, which requires this
 * layer.
 *
 * After a complete scan or a refresh that wrote entities with a head, it also
 * links the entities that sit on a Task's branch (`BranchLinks`), and it
 * answers which branches a plugin should look up pull requests for.
 */
export const EntityObservationsLayer: Layer.Layer<
  EntityObservations,
  never,
  SqlClient.SqlClient | AuditLog | PlatformEvents | Notifier
> = Layer.effect(EntityObservations)(make).pipe(
  Layer.provide(
    Layer.mergeAll(ExternalEntityIngestLayer, BranchLinksLayer).pipe(
      Layer.provide(TaskServiceWithPortsLayer),
    ),
  ),
);
