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
     * Runs `write`, which writes an open signal on the thread `ref`, and
     * returns its result. When the write put the entity of `ref` onto the
     * Inbox and the clock, the entity becomes an arrival, as a new concern
     * would. The port looks at the Inbox before `write` runs, so a signal that
     * lands on a card that is on the Inbox already makes no arrival. It does
     * nothing extra for a ref with no entity. It runs in the caller's
     * transaction and checks no grant.
     */
    readonly recordArrivalAfter: <A, E, R>(
      ref: string,
      write: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | SqlError, R>;
  }
>()("hercule/controller/signals/SignalEntities") {}
