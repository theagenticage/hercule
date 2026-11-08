/**
 * The Entity Observations port: how an event source's ingest reports what it
 * read of External Entities, through `IngestContext.entities`.
 *
 * External Entities are their own domain, and that domain already depends on
 * the plugins domain (a kind's declaration comes from a plugin). So the
 * plugins domain cannot import it. It declares this port instead, and the
 * controller daemon implements it from the External Entities ingest (ADR 0033).
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {
  EntityInventory,
  EntityObservation,
  PluginError,
  QualifiedEntityKindDeclaration,
  TrackedBranch,
} from "@hercule/plugin-host";
import type { RecognizeText } from "./entity-recognition";

/**
 * Who is reporting: one Connection of one plugin, and the entity kinds that
 * plugin declared. The host passes the declarations in, because the
 * implementation cannot read the plugin catalog without importing the plugins
 * domain's host, which needs this port.
 */
export interface EntityReporter {
  readonly connectionId: string;
  readonly pluginId: string;
  readonly kinds: ReadonlyArray<QualifiedEntityKindDeclaration>;
}

/**
 * The Entity Observations port, which the controller daemon implements. It has
 * the shape of `IngestContext.entities`, with the reporter first. A database
 * failure is a defect: the plugin cannot recover from it.
 */
export class EntityObservations extends Context.Service<
  EntityObservations,
  {
    /**
     * Replaces what the reporter's Connection says about one kind, in one
     * transaction. Fails with a `PluginError`, before writing anything, when
     * the inventory breaks a rule of the contract. `recognize` reads the web
     * addresses and texts of the observations over the plugins that are
     * active now, because only the plugins domain can reach their lookups. It
     * is pure and fetches nothing; the ingest calls it after it checked the
     * observations and before it opens its transaction. Leave it out to
     * recognize nothing.
     */
    readonly reconcile: (
      reporter: EntityReporter,
      inventory: EntityInventory,
      recognize?: RecognizeText,
    ) => Effect.Effect<void, PluginError>;
    /** Updates what is known of entities without touching any concern. Fails like `reconcile`. */
    readonly refresh: (
      reporter: EntityReporter,
      observations: ReadonlyArray<EntityObservation>,
      recognize?: RecognizeText,
    ) => Effect.Effect<void, PluginError>;
    /**
     * Returns up to `limit` refs of the unqualified kind that the Connection
     * should read now. Dies with a `PluginError` when the plugin did not
     * declare the kind.
     */
    readonly listWanted: (
      reporter: EntityReporter,
      kind: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<string>>;
    /**
     * Returns up to `limit` branches, as `(remote, branch)` pairs on remotes
     * that start with `remotePrefix`, that the Connection should look up pull
     * requests for now: branches of ephemeral checkouts on live Tasks, not the
     * default branch, existing on the remote, and not already the head of an
     * entity that Task links. Each call moves on in a durable rotation per
     * Connection.
     */
    readonly listTrackedBranches: (
      reporter: EntityReporter,
      remotePrefix: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<TrackedBranch>>;
    /** Records that a ref could not be read. Fails with a `PluginError` when no declared kind owns the ref. */
    readonly reportMissing: (
      reporter: EntityReporter,
      ref: string,
      reason: "inaccessible" | "deleted",
    ) => Effect.Effect<void, PluginError>;
  }
>()("hercule/controller/plugins/EntityObservations") {}
