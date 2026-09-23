/**
 * Declares the lookups other domains need for the event kinds that plugins
 * declare: which schema an event kind's payload must satisfy, and which kinds a
 * trigger can listen for. Only the interface lives here.
 *
 * A plugin declares its kinds at registration, so the data lives in the
 * plugins domain. That domain appends audit entries to this log, so it already
 * depends on this one, and an import the other way would create a cycle. So
 * the interface is declared here and the plugins domain provides the Layer, in
 * the same way the database layer declares `AfterCommit` and the live domain
 * implements it.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

/**
 * An event kind that a trigger can listen for, as the controller stores it.
 * It is the contract's `DeclaredEventKind` with the qualified Connection type
 * in place of the `connectionRequired` flag. Validating a trigger compares this
 * type with the type of the trigger's Connection. An API client only needs to
 * know whether a Connection is required.
 */
export interface DeclaredEventKindWithConnectionType {
  readonly kind: string;
  /** A one-line description of what an event of this kind means. */
  readonly description: string;
  /**
   * The qualified Connection type that events of this kind arrive through,
   * such as `github/github`. Absent for a core event kind, because its events
   * do not arrive through a Connection.
   */
  readonly connectionType?: string;
}

export class EventKindCatalog extends Context.Service<
  EventKindCatalog,
  {
    /**
     * Returns the schema a payload of this kind must satisfy, or none if no
     * plugin declares the kind.
     */
    readonly readPayloadSchema: (kind: string) => Effect.Effect<Option.Option<Schema.Top>>;
    /**
     * Returns the event kinds of every plugin that is running now. The kinds
     * of a disabled plugin, or of a plugin that failed to start, are left out,
     * because no event of those kinds arrives while the plugin is not running.
     */
    readonly listActiveEventKinds: () => Effect.Effect<
      ReadonlyArray<DeclaredEventKindWithConnectionType>
    >;
  }
>()("hercule/controller/events/EventKindCatalog") {}
