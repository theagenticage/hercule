/**
 * Reads the Model Catalogs of Provider Accounts from the runners.
 *
 * A catalog read is always a probe of its own: the account is probed in the
 * provider's source harness on one runner, and the outcome is stored as the
 * read (`ModelCatalogs.recordCatalogRead`). No sweep probe or sign-in probe
 * is reused as a read, so a read has one meaning wherever it came from.
 *
 * The runner is chosen before the probe is sent: the controller's own runner
 * when the account is ready there, else the first connected runner where it
 * is (`ModelCatalogs.chooseDueReads`). A read of an account that no connected
 * runner can serve is recorded as a failed read, with what the user can do
 * about it.
 *
 * Only one read per account is in flight. See `readCatalog` and
 * `readDueCatalogs` for what happens to a read that finds another running.
 *
 * Probing builds this module once (see `makeCatalogReading`), because both
 * need the same per-runner probe slots and the sweeps ask for the reads.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import { NotFound } from "@hercule/contract";
import {
  ModelCatalogs,
  ProviderAccountProbes,
  type ChosenReads,
  type ProbePair,
  type UnservedRead,
} from "../../provider-accounts";
import { LocalRunnerId } from "../../runners";

type RecordError = SqlError | Schema.SchemaError;

/** Sends the probe of a catalog read in a free slot of its runner. Logs a failure instead of returning it. */
export type SendCatalogProbe = (pair: ProbePair) => Effect.Effect<void>;

/**
 * Builds the catalog reading of the controller, sending its probes with
 * `sendCatalogProbe`. Call it once per process: the reads in flight are state
 * in memory.
 */
export const makeCatalogReading = (sendCatalogProbe: SendCatalogProbe) =>
  Effect.gen(function* () {
    const catalogs = yield* ModelCatalogs;
    const probes = yield* ProviderAccountProbes;
    const localRunnerId = yield* LocalRunnerId;

    // The accounts whose catalog read is running, each with a Deferred that
    // completes when the read ends. Without it, runners that arrive together
    // would each send a read of the same catalog.
    const reading = new Map<string, Deferred.Deferred<void>>();
    // The accounts with a forced read waiting for the running read to end.
    const queuedForcedReads = new Set<string>();

    /**
     * Runs `read`, the catalog read of one account, unless that account is
     * being read already. Does nothing when `read` did not run.
     *
     * - An ordinary read (`forced` is false) is skipped: the running read
     *   serves it.
     * - A forced read waits for the running read to end and then runs, because
     *   the running one may have been sent before the change that forced this
     *   one (for example a new credential, which makes its answer stale).
     *   While one forced read waits, another is skipped: the waiting one is
     *   sent after both requests.
     */
    const readOnce = (
      providerAccountId: string,
      forced: boolean,
      read: Effect.Effect<void, RecordError>,
    ): Effect.Effect<void, RecordError> =>
      Effect.gen(function* () {
        while (true) {
          const running = reading.get(providerAccountId);
          if (running === undefined) break;
          if (!forced || queuedForcedReads.has(providerAccountId)) return;
          queuedForcedReads.add(providerAccountId);
          yield* Deferred.await(running).pipe(
            Effect.ensuring(Effect.sync(() => queuedForcedReads.delete(providerAccountId))),
          );
        }
        const ended = yield* Deferred.make<void>();
        reading.set(providerAccountId, ended);
        yield* read.pipe(
          Effect.ensuring(
            Effect.andThen(
              Effect.sync(() => reading.delete(providerAccountId)),
              Deferred.succeed(ended, undefined),
            ),
          ),
        );
      });

    /**
     * Records that no connected runner can read the account's catalog. The
     * models stay. Does nothing when the account was deleted meanwhile.
     */
    const recordUnservedRead = ({ providerAccountId, message }: UnservedRead) =>
      probes.readProbeStamp(providerAccountId, false).pipe(
        Effect.flatMap((stamp) =>
          catalogs.recordCatalogRead(providerAccountId, { _tag: "failed", message }, stamp),
        ),
        Effect.catchIf(
          (error): error is NotFound => error instanceof NotFound,
          () => Effect.void,
        ),
      );

    /** Lists, by account, the work of the chosen reads: a probe on the chosen runner, or the record of why none was chosen. */
    const listWork = (chosen: ChosenReads) => [
      ...chosen.reads.map((read) => ({
        providerAccountId: read.providerAccountId,
        work: sendCatalogProbe(read),
      })),
      ...chosen.unserved.map((one) => ({
        providerAccountId: one.providerAccountId,
        work: recordUnservedRead(one),
      })),
    ];

    const logReadFailure = (read: Effect.Effect<void, RecordError>): Effect.Effect<void> =>
      Effect.catchCause(read, (cause) =>
        Effect.logError("A provider account catalog read could not be recorded", cause),
      );

    return {
      /**
       * Reads the account's catalog now, whether or not it is due, and returns
       * when the read ends. Use it when something changed that the catalog may
       * not show: the account was added, its credential changed, a sign-in was
       * accepted, or the user asked. Logs a failure instead of returning it.
       *
       * If the account is being read already, this waits for that read to end
       * and then reads again, and forced reads that wait together are one read.
       * The runner is chosen after the wait, so it is chosen with what the
       * world looks like by then.
       */
      readCatalog: (providerAccountId: string): Effect.Effect<void> =>
        logReadFailure(
          readOnce(
            providerAccountId,
            true,
            Effect.flatMap(
              Effect.suspend(() =>
                catalogs.chooseDueReads({
                  accountIds: [providerAccountId],
                  force: true,
                  localRunnerId: localRunnerId.read(),
                }),
              ),
              (chosen) => Effect.forEach(listWork(chosen), ({ work }) => work, { discard: true }),
            ),
          ),
        ),

      /**
       * Reads the catalogs that are due, one probe each, and returns when the
       * reads end. Skips an account that is being read already. Logs a failure
       * instead of returning it.
       *
       * Call it after the probes of a sweep, because a probe can be what finds
       * a per-machine account signed in. With `servedBy`, only the accounts
       * that runner can serve are read, and no account is recorded as unserved:
       * a runner that just connected knows nothing about an account whose
       * machine has not connected yet. Without it, an account that no
       * connected runner can serve is recorded as a failed read.
       */
      readDueCatalogs: (servedBy?: string): Effect.Effect<void> =>
        logReadFailure(
          Effect.flatMap(
            Effect.suspend(() =>
              catalogs.chooseDueReads({
                force: false,
                localRunnerId: localRunnerId.read(),
                ...(servedBy === undefined ? {} : { servedBy }),
              }),
            ),
            (chosen) =>
              Effect.forEach(
                listWork(chosen),
                ({ providerAccountId, work }) => readOnce(providerAccountId, false, work),
                { concurrency: "unbounded", discard: true },
              ),
          ),
        ),
    };
  });
