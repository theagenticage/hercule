/**
 * The event kinds that plugins declare, asked for as a question rather than
 * taken from whoever answers it: the schema an event kind's payload must
 * satisfy, and the kinds a trigger can name.
 *
 * A kind is declared by a plugin at registration, so the answer lives in the
 * plugins domain. That domain appends audit entries to this log, so it already
 * depends on this one, and an import the other way would make the two a cycle.
 * The question is therefore declared here and the plugins domain provides the
 * Layer, the way the database layer declares `AfterCommit` and the live domain
 * answers it.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

/**
 * An event kind that a trigger can name, as the controller holds it: the
 * contract's `DeclaredEventKind`, with the qualified Connection type in place
 * of `connectionRequired`. The check of a trigger compares the type with the
 * type of the Connection that the trigger names. A client of the API needs to
 * know only whether a trigger names a Connection.
 */
export interface DeclaredEventKindWithConnectionType {
  readonly kind: string;
  /** One line that says what an event of this kind means. */
  readonly description: string;
  /**
   * The qualified Connection type that events of this kind arrive through,
   * such as `github/github`. Absent for a kind the core declares, because its
   * events arrive through no Connection.
   */
  readonly connectionType?: string;
}

export class EventKindCatalog extends Context.Service<
  EventKindCatalog,
  {
    /** What a payload of this kind must be, or nothing for a kind nobody declared. */
    readonly readPayloadSchema: (kind: string) => Effect.Effect<Option.Option<Schema.Top>>;
    /**
     * The kinds of every plugin that runs now. The kinds of a plugin that is
     * disabled, or that did not start, are not in it: no event of theirs
     * arrives while the plugin does not run.
     */
    readonly listActiveEventKinds: () => Effect.Effect<
      ReadonlyArray<DeclaredEventKindWithConnectionType>
    >;
  }
>()("hercule/controller/events/EventKindCatalog") {}
