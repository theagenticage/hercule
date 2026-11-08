/**
 * Linked Entities: the port through which the tasks domain reads what it
 * stored-knows about the External Entities its Tasks link.
 *
 * A Task can link a thing from inside this domain (a handoff, a provenance
 * `ref`), and the domain cannot import `external-entities`, which imports it.
 * So it declares what it needs here and the controller daemon implements it
 * (`daemon/tasks/linked-entities.ts`) from the stored rows alone. The answer
 * never goes through the plugin host or the External Entity service: the
 * ingest that writes entities calls the Task service, so a read that needed
 * either would be a cycle of layers.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import type { EntityLifecycle } from "@hercule/contract";

/**
 * What is stored of one linked thing, as far as counting a Task's linked
 * work needs it (see `countLinkedWork`).
 */
export interface LinkedEntityState {
  /** The qualified kind, such as `github/pull-request`. The empty string when it is not known. */
  readonly kind: string;
  /**
   * Whether the thing is a piece of work (a pull request, a ticket) or a
   * place (a project, a repository). A full record says so itself. A partial
   * record, or a ref with no record, takes it from the kind the catalog
   * declares for the ref.
   */
  readonly classification: "work" | "context";
  /** True when Hercule holds the whole record, false for a partial record or no record. */
  readonly isFullRecord: boolean;
  /** Null when the record has none, or there is no record. */
  readonly lifecycle: EntityLifecycle | null;
  /** True when some Connection reads the thing now. False when no record exists. */
  readonly isReadable: boolean;
}

export class LinkedEntities extends Context.Service<
  LinkedEntities,
  {
    /**
     * Returns the state of each of `refs`, by ref, in one batch however many
     * refs there are. A ref with no record and no declared kind is left out:
     * nothing is known of it, and it is not a piece of work. It reads the
     * caller's transaction, so a write made earlier in it is visible.
     */
    readonly readMany: (
      refs: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, LinkedEntityState>, SqlError>;
  }
>()("hercule/controller/tasks/LinkedEntities") {}
