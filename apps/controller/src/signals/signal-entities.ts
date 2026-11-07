/**
 * Signal Entities: the port through which the signals domain reads the
 * External Entity a signal is about.
 *
 * A signal and its entity meet by exact equality of `signals.thread_ref` and
 * `external_entities.ref`, on read. The external-entities domain imports the
 * signals domain, so the signals domain cannot import it. It declares what it
 * needs here and the controller daemon implements it, from the external
 * entities repository.
 */
import type { SignalEntity } from "@hercule/contract";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

export class SignalEntities extends Context.Service<
  SignalEntities,
  {
    /**
     * Returns the entity of each of `refs` that has a full record of a work
     * kind, by ref. A ref with no such record is left out: a place, a partial
     * record and an unknown ref all stay on their own. It reads in one
     * statement however many refs there are, and checks no grant.
     */
    readonly readByRefs: (
      refs: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, SignalEntity>, SqlError>;
    /**
     * Records that an open signal landed on the entity of `ref`. When the
     * entity was off the clock, it becomes an arrival, as a new concern would.
     * It does nothing for a ref with no entity. It runs in the caller's
     * transaction and checks no grant.
     */
    readonly recordArrival: (ref: string) => Effect.Effect<void, SqlError>;
  }
>()("hercule/controller/signals/SignalEntities") {}
