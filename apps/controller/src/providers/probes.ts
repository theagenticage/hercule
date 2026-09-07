/**
 * Asks runners what each provider instance can do, and stores the answers.
 *
 * Probing is controller-driven: the config lives here, so a runner cannot start
 * one. Requests carry an id because several are in flight on one connection.
 *
 * A sweep gathers facts rather than performing an operation: no grant reaches
 * it, and every row it writes is the system's.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { notFound, type CapabilitySnapshot, type NotFound } from "@hydra/contract";
import { announce, nowIso, withTransaction } from "../db";
import { RunnerPresence, runnerRepository } from "../runners";
import { providerRepository, type StoredInstance } from "./repository";
import { floorFor, versionVerdict } from "./version";

/**
 * The runner's own 15s probe budget plus the round trip, so its "did not
 * answer" is stored rather than cut off here.
 */
const PROBE_DEADLINE: Duration.Duration = Duration.seconds(20);

/** Tests hand over a deadline they can wait out. */
export const ProviderProbeDeadline = Context.Reference<Duration.Duration>(
  "hydra/controller/providers/ProviderProbeDeadline",
  { defaultValue: (): Duration.Duration => PROBE_DEADLINE },
);

/**
 * A login can expire and a harness be upgraded outside Hydra, so an older
 * snapshot is a guess.
 */
const PROBE_INTERVAL: Duration.Duration = Duration.hours(1);

export const ProviderProbeInterval = Context.Reference<Duration.Duration>(
  "hydra/controller/providers/ProviderProbeInterval",
  { defaultValue: (): Duration.Duration => PROBE_INTERVAL },
);

type StoreError = SqlError | Schema.SchemaError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const instances = yield* providerRepository;
  const runners = yield* runnerRepository;
  const presence = yield* RunnerPresence;

  /**
   * A late report is dropped rather than stored: nobody is correlating that
   * request any more.
   */
  const probeOne = (
    runnerId: string,
    instance: StoredInstance,
  ): Effect.Effect<Option.Option<CapabilitySnapshot>, StoreError> =>
    Effect.gen(function* () {
      const answer = yield* presence.asked(
        runnerId,
        {
          _tag: "probeRequest",
          requestId: crypto.randomUUID(),
          instanceId: instance.id,
          providerId: instance.providerId,
          config: instance.config,
        },
        yield* ProviderProbeDeadline,
      );
      if (Option.isNone(answer) || answer.value._tag !== "probeReport") return Option.none();
      const result = answer.value.result;
      return yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          yield* instances.recordSnapshot(instance.id, runnerId, result, at);
          // No audit row: what a machine has is not an event anyone reads back,
          // so the instance's watchers are told here instead.
          yield* announce({ _tag: "record", topic: "provider", id: instance.id, kind: "updated" });
          return Option.some({
            runnerId,
            probedAt: at,
            harnessVersion: result.harnessVersion,
            versionVerdict: versionVerdict(result.harnessVersion, floorFor(instance.providerId)),
            auth: result.auth,
            models: result.models,
          });
        }),
      );
    });

  /**
   * Each pair absorbs its own failure: one instance deleted mid-sweep must not
   * discard the rest of the fleet's snapshots.
   */
  const sweep = (
    runnerIds: ReadonlyArray<string>,
    over: ReadonlyArray<StoredInstance>,
  ): Effect.Effect<void> =>
    Effect.forEach(
      runnerIds.flatMap((runnerId) => over.map((instance) => ({ runnerId, instance }))),
      ({ runnerId, instance }) =>
        Effect.catchCause(probeOne(runnerId, instance), (cause) =>
          Effect.logError("A provider probe could not be recorded", cause),
        ),
      { concurrency: "unbounded", discard: true },
    );

  /** Nobody is waiting on a sweep, so a listing that will not answer is logged. */
  const inTheBackground = (swept: Effect.Effect<void, StoreError>): Effect.Effect<void> =>
    Effect.catchCause(swept, (cause) =>
      Effect.logError("A provider sweep could not be started", cause),
    );

  const sweepRunner = (runnerId: string): Effect.Effect<void> =>
    inTheBackground(Effect.flatMap(instances.list(), (all) => sweep([runnerId], all)));

  return {
    probe: (
      runnerId: string,
      instanceId: string,
    ): Effect.Effect<Option.Option<CapabilitySnapshot>, StoreError | NotFound> =>
      Effect.flatMap(
        instances.one(instanceId),
        (found): Effect.Effect<Option.Option<CapabilitySnapshot>, StoreError | NotFound> =>
          Option.isNone(found)
            ? Effect.fail(notFound("no such provider instance"))
            : probeOne(runnerId, found.value),
      ),

    sweepRunner,

    /**
     * The config is what a probe runs under, so an edit stales every machine's
     * snapshot at once.
     */
    sweepInstance: (instanceId: string): Effect.Effect<void> =>
      inTheBackground(
        Effect.gen(function* () {
          const found = yield* instances.one(instanceId);
          if (Option.isNone(found)) return;
          yield* sweep(yield* runners.connected(), [found.value]);
        }),
      ),

    driving: Effect.all(
      [
        // Forked, because a machine that answers slowly must not hold up the
        // next machine's sweep.
        Stream.runForEach(presence.arrivals, (runnerId) => Effect.forkChild(sweepRunner(runnerId))),
        Effect.gen(function* () {
          const interval = yield* ProviderProbeInterval;
          while (true) {
            yield* Effect.sleep(interval);
            yield* inTheBackground(
              Effect.gen(function* () {
                const online = yield* runners.connected();
                if (online.length === 0) return;
                yield* sweep(online, yield* instances.list());
              }),
            );
          }
        }),
      ],
      { concurrency: "unbounded", discard: true },
    ),
  };
});

/** What asks the fleet about provider instances and keeps what it says. */
export class ProviderProbes extends Context.Service<ProviderProbes, Effect.Success<typeof make>>()(
  "hydra/controller/providers/ProviderProbes",
) {}

export const ProviderProbesLayer: Layer.Layer<
  ProviderProbes,
  never,
  SqlClient.SqlClient | RunnerPresence
> = Layer.effect(ProviderProbes)(make);
