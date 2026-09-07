/**
 * Asking the fleet what it can do, and keeping the answers.
 *
 * Probing is controller-driven: instance ids and their configs live here, so a
 * runner cannot start one on its own. Every request carries an id and is
 * answered by one report, because probes for several instances are in flight on
 * one connection at once.
 *
 * A sweep is a fact-gathering pass, not an operation: no grant reaches it and
 * every row it writes is the system's. It runs after a runner says hello, after
 * an install, when an instance's config changed, on the tick, and when somebody
 * presses the button - and only that last one has anybody waiting for it.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { notFound, type CapabilitySnapshot, type NotFound } from "@hydra/contract";
import type { ProbeResult } from "@hydra/protocol";
import { announce, nowIso, withTransaction } from "../db";
// The two runner modules directly rather than the domain's index: the runner
// service reaches this one, so going through it would close a cycle.
import { RunnerPresence } from "../runners/presence";
import { runnerRepository } from "../runners/repository";
import { providerRepository, type StoredInstance } from "./repository";
import { floorFor, versionVerdict } from "./version";

/**
 * The runner gives its own probe fifteen seconds; this is that plus the round
 * trip, so a harness that timed out still gets its "did not answer" stored as
 * the snapshot rather than being cut off by the end that asked.
 */
const PROBE_DEADLINE: Duration.Duration = Duration.seconds(20);

/** Tests hand over a deadline they can wait out. */
export const ProviderProbeDeadline = Context.Reference<Duration.Duration>(
  "hydra/controller/providers/ProviderProbeDeadline",
  { defaultValue: (): Duration.Duration => PROBE_DEADLINE },
);

/**
 * How often the whole fleet is asked again. A login can expire and a harness
 * can be upgraded outside Hydra, so a snapshot older than this is a guess.
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

  const snapshotOf = (
    runnerId: string,
    providerId: string,
    result: ProbeResult,
    at: string,
  ): CapabilitySnapshot => ({
    runnerId,
    probedAt: at,
    harnessVersion: result.harnessVersion,
    versionVerdict: versionVerdict(result.harnessVersion, floorFor(providerId)),
    auth: result.auth,
    models: result.models,
  });

  /**
   * One instance on one runner. `none` when the machine is not holding a
   * connection or did not answer in time; a report that arrives late is
   * dropped rather than stored, because by then it describes a request nobody
   * is correlating any more.
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
          return Option.some(snapshotOf(runnerId, instance.providerId, result, at));
        }),
      );
    });

  /**
   * Every pair, at once. A machine answers its instances in parallel, and one
   * unreachable machine must not hold up the rest of the fleet.
   *
   * Each pair absorbs its own failure, because the alternative interrupts its
   * siblings: one instance deleted mid-sweep would otherwise discard every
   * snapshot the rest of the fleet had just reported.
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

  return {
    /**
     * Probes one instance on one runner for a caller that is waiting. `none`
     * says the machine answered nothing in time, which the operation reports as
     * a state rather than as a snapshot that is not there.
     */
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

    /** Everything one machine can be asked: after its hello, and after an install. */
    sweepRunner: (runnerId: string): Effect.Effect<void> =>
      inTheBackground(Effect.flatMap(instances.list(), (all) => sweep([runnerId], all))),

    /**
     * One instance across the fleet, because its config is what the probe runs
     * under: an edit makes every machine's snapshot of it stale at once.
     */
    sweepInstance: (instanceId: string): Effect.Effect<void> =>
      inTheBackground(
        Effect.gen(function* () {
          const found = yield* instances.one(instanceId);
          if (Option.isNone(found)) return;
          yield* sweep(yield* runners.connected(), [found.value]);
        }),
      ),

    /**
     * The tick. Held open for the life of the listener, so it stops when the
     * controller does.
     */
    refreshing: Effect.gen(function* () {
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
