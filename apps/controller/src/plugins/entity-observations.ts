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
} from "@hercule/plugin-host";

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
 * A thing that a plugin recognized but cannot place without reading it. `kind`
 * is the qualified kind word and `scopeHint` the scope the text named, either
 * of which may be absent. A pending claim keeps the same four fields in its
 * target (see `PendingTarget`).
 */
export interface ScopedTarget {
  readonly pluginId: string;
  readonly kind?: string;
  readonly scopeHint?: string;
  readonly identifier: string;
}

/** What recognition found a reference to. A `ref` names exactly one thing. A `scoped` target needs a read to place. */
export type RecognizedTarget =
  | { readonly recognized: "ref"; readonly ref: string }
  | ({ readonly recognized: "scoped" } & ScopedTarget);

/**
 * What the active plugins made of the web addresses and the texts of one
 * observation. The plugins domain computes it before the port is called,
 * because only it can reach the plugins' lookups.
 */
export interface RecognizedClaims {
  /**
   * One entry for each web address the observation's `relations.linkedUrls`
   * lists. `target` is absent when no active plugin recognizes the address.
   */
  readonly urls: ReadonlyArray<{ readonly url: string; readonly target?: RecognizedTarget }>;
  /**
   * One entry for each text of the observation. `targets` lists every thing
   * the text names, each once. It is absent when the text was not searched
   * because its stored claims were made from the same `revision`: the claims
   * stay as they are.
   */
  readonly texts: ReadonlyArray<{
    readonly evidenceKey: string;
    readonly revision?: string;
    readonly targets?: ReadonlyArray<RecognizedTarget>;
  }>;
}

/** The recognized claims of a call, by the ref of the observation they belong to. */
export type RecognizedClaimsByRef = ReadonlyMap<string, RecognizedClaims>;

/**
 * The revision that the stored `text` claims of the reporter's Connection were
 * made from, by ref and then by evidence key. A key is listed only when all
 * of its claims were made from one revision.
 */
export type StoredTextRevisions = ReadonlyMap<string, ReadonlyMap<string, string>>;

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
     * the inventory breaks a rule of the contract. `claims` is what the
     * plugins domain recognized in the observations' web addresses and texts;
     * leave it out when nothing was recognized.
     */
    readonly reconcile: (
      reporter: EntityReporter,
      inventory: EntityInventory,
      claims?: RecognizedClaimsByRef,
    ) => Effect.Effect<void, PluginError>;
    /** Updates what is known of entities without touching any concern. Fails like `reconcile`. */
    readonly refresh: (
      reporter: EntityReporter,
      observations: ReadonlyArray<EntityObservation>,
      claims?: RecognizedClaimsByRef,
    ) => Effect.Effect<void, PluginError>;
    /**
     * Returns the revisions that the stored `text` claims of the reporter's
     * Connection were made from, for the given refs. The host reads them
     * before it searches a text, so a text whose revision did not change is
     * not searched again.
     */
    readonly readStoredTextRevisions: (
      reporter: EntityReporter,
      refs: ReadonlyArray<string>,
    ) => Effect.Effect<StoredTextRevisions>;
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
    /** Records that a ref could not be read. Fails with a `PluginError` when no declared kind owns the ref. */
    readonly reportMissing: (
      reporter: EntityReporter,
      ref: string,
      reason: "inaccessible" | "deleted",
    ) => Effect.Effect<void, PluginError>;
  }
>()("hercule/controller/plugins/EntityObservations") {}
