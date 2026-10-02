/**
 * Asks runners what each provider instance can do, and stores the results.
 *
 * The controller starts every probe, because the config lives here and a
 * runner does not have it. Requests carry an id because several can be in
 * flight on one connection.
 *
 * A sweep gathers facts rather than performing an operation: it checks no
 * grant, and the system is the actor for every row it writes.
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
import { createNotFoundError, type CapabilitySnapshot, type NotFound } from "@hercule/contract";
import { announce, nowIso, withTransaction } from "../db";
import { PluginHost } from "../plugins";
import { RunnerConnections, runnerRepository } from "../runners";
import { readInstanceSecrets, Secrets, type SecretDecryptError } from "../secrets";
import { providerRepository, type StoredInstance } from "./repository";
import { findVersionFloor, computeVersionVerdict } from "./version";

/**
 * The runner's own 15s probe timeout plus the round trip, so the runner's
 * "did not answer" result is stored rather than cut off by this deadline.
 */
const PROBE_DEADLINE: Duration.Duration = Duration.seconds(20);

/** Lets tests set a deadline short enough to wait for. */
export const ProviderProbeDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/providers/ProviderProbeDeadline",
  { defaultValue: (): Duration.Duration => PROBE_DEADLINE },
);

/**
 * A login can expire and a harness can be upgraded outside Hercule, so a
 * snapshot older than this is unreliable.
 */
const PROBE_INTERVAL: Duration.Duration = Duration.hours(1);

export const ProviderProbeInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/providers/ProviderProbeInterval",
  { defaultValue: (): Duration.Duration => PROBE_INTERVAL },
);

type StoreError = SqlError | Schema.SchemaError | SecretDecryptError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const instances = yield* providerRepository;
  const runners = yield* runnerRepository;
  const connections = yield* RunnerConnections;
  const secrets = yield* Secrets;
  const host = yield* PluginHost;

  /**
   * Probes one instance on one runner, stores the snapshot, and returns it.
   * Returns `none` if the runner does not answer before the deadline. A late
   * report is dropped rather than stored, because nothing is waiting for that
   * request any more.
   */
  const probeOne = (
    runnerId: string,
    instance: StoredInstance,
  ): Effect.Effect<Option.Option<CapabilitySnapshot>, StoreError> =>
    Effect.gen(function* () {
      const answer = yield* connections.asked(
        runnerId,
        {
          _tag: "probeRequest",
          requestId: crypto.randomUUID(),
          instanceId: instance.id,
          providerId: instance.providerId,
          config: instance.config,
          // Decrypted here, at send time: the probe runs the harness's own auth
          // check, which is only meaningful with the credential.
          secrets: yield* readInstanceSecrets(
            secrets,
            yield* host.providers(),
            instance.id,
            instance.providerId,
          ),
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
          // No audit row: a probe result is not an event anyone reads back, so
          // the instance's live subscribers are notified instead.
          yield* announce({ _tag: "record", topic: "provider", id: instance.id, kind: "updated" });
          return Option.some({
            runnerId,
            probedAt: at,
            harnessVersion: result.harnessVersion,
            versionVerdict: computeVersionVerdict(
              result.harnessVersion,
              findVersionFloor(instance.providerId),
            ),
            auth: result.auth,
            models: result.models,
          });
        }),
      );
    });

  /**
   * Probes every instance on every given runner, concurrently. Each probe logs
   * its own failure, so one instance deleted mid-sweep does not discard the
   * rest of the fleet's snapshots.
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

  /**
   * Logs the error of a sweep that fails to start, for example because the
   * instance list cannot be read. Nothing is waiting on the sweep, so the log
   * is the only place the error can go.
   */
  const logSweepFailure = (swept: Effect.Effect<void, StoreError>): Effect.Effect<void> =>
    Effect.catchCause(swept, (cause) =>
      Effect.logError("A provider sweep could not be started", cause),
    );

  const sweepRunner = (runnerId: string): Effect.Effect<void> =>
    logSweepFailure(Effect.flatMap(instances.list(), (all) => sweep([runnerId], all)));

  /**
   * Probes the instance with this id on the runner, stores the snapshot, and
   * returns it. Fails with `NotFound` if no such instance exists.
   */
  const probeInstance = (
    runnerId: string,
    instanceId: string,
  ): Effect.Effect<Option.Option<CapabilitySnapshot>, StoreError | NotFound> =>
    Effect.flatMap(
      instances.one(instanceId),
      (found): Effect.Effect<Option.Option<CapabilitySnapshot>, StoreError | NotFound> =>
        Option.isNone(found)
          ? Effect.fail(createNotFoundError("no such provider instance"))
          : probeOne(runnerId, found.value),
    );

  // The device logins whose end this controller waits to hear about, and the
  // probes they cause, keyed by runner and instance. A runner reports the end
  // of a login, so without these a runner could make the controller probe
  // whenever it likes. Nothing is removed when a runner disconnects: the
  // login's child keeps running on the runner, and its end is reported once
  // the runner is back.
  const awaitedLoginEnds = new Set<string>();
  const probingAfterLoginEnd = new Set<string>();
  const probeAgainAfterLoginEnd = new Set<string>();
  const buildLoginKey = (runnerId: string, instanceId: string): string =>
    `${runnerId}:${instanceId}`;

  /**
   * Probes the instance once, then again for as long as another login ended
   * while the probe ran. Removes the key from `probingAfterLoginEnd` when the
   * last probe ends, also when it fails.
   */
  const probeUntilSettled = (
    runnerId: string,
    instanceId: string,
    key: string,
  ): Effect.Effect<void, StoreError | NotFound> =>
    Effect.gen(function* () {
      do {
        probeAgainAfterLoginEnd.delete(key);
        yield* probeInstance(runnerId, instanceId);
      } while (probeAgainAfterLoginEnd.has(key));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          probingAfterLoginEnd.delete(key);
          probeAgainAfterLoginEnd.delete(key);
        }),
      ),
    );

  return {
    probe: probeInstance,

    /**
     * Records that a login is starting on this runner for this instance, so
     * that its end, if the runner reports one, is accepted. Call it before the
     * runner is asked to start the login: the runner may report the end before
     * the caller has read the answer.
     */
    expectLoginEnd: (runnerId: string, instanceId: string): Effect.Effect<void> =>
      Effect.sync(() => {
        awaitedLoginEnds.add(buildLoginKey(runnerId, instanceId));
      }),

    /**
     * Stops waiting for the end of the login on this runner for this
     * instance, because the login will not report one: it did not start, or
     * the user finishes it by pasting a code.
     */
    forgetLoginEnd: (runnerId: string, instanceId: string): Effect.Effect<void> =>
      Effect.sync(() => {
        awaitedLoginEnds.delete(buildLoginKey(runnerId, instanceId));
      }),

    /**
     * Probes the instance on the runner after the runner reported that a
     * device login ended. Returns when the probe is stored.
     *
     * Ignores the report, and logs it, unless `expectLoginEnd` was called for
     * this runner and instance and no end has been accepted since. An honest
     * runner can send such a report too, for example when the login's answer
     * came after the controller stopped waiting for it, so ignoring it does not
     * close the connection.
     *
     * At most one probe runs per runner and instance. A login started and
     * ended while that probe runs causes exactly one more probe after it,
     * because the running probe may have read the state from before the login.
     */
    probeAfterLoginEnd: (
      runnerId: string,
      instanceId: string,
    ): Effect.Effect<void, StoreError | NotFound> =>
      Effect.suspend(() => {
        const key = buildLoginKey(runnerId, instanceId);
        if (!awaitedLoginEnds.delete(key)) {
          return Effect.logInfo(
            "Ignored a runner's report that a login ended, because no login was waiting for it",
          ).pipe(Effect.annotateLogs({ runnerId, instanceId }));
        }
        if (probingAfterLoginEnd.has(key)) {
          probeAgainAfterLoginEnd.add(key);
          return Effect.void;
        }
        probingAfterLoginEnd.add(key);
        return probeUntilSettled(runnerId, instanceId, key);
      }),

    sweepRunner,

    /**
     * Probes one instance on every connected runner. A probe runs under the
     * instance's config, so a config change makes every runner's snapshot
     * stale at once.
     */
    sweepInstance: (instanceId: string): Effect.Effect<void> =>
      logSweepFailure(
        Effect.gen(function* () {
          const found = yield* instances.one(instanceId);
          if (Option.isNone(found)) return;
          yield* sweep(yield* runners.connected(), [found.value]);
        }),
      ),

    driving: Effect.all(
      [
        // Forked, because a runner that answers slowly must not hold up the
        // next runner's sweep.
        Stream.runForEach(connections.arrivals, (runnerId) =>
          Effect.forkChild(sweepRunner(runnerId)),
        ),
        Effect.gen(function* () {
          const interval = yield* ProviderProbeInterval;
          while (true) {
            yield* Effect.sleep(interval);
            yield* logSweepFailure(
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

/** The service that probes the fleet for provider instances and stores the snapshots. */
export class ProviderProbes extends Context.Service<ProviderProbes, Effect.Success<typeof make>>()(
  "hercule/controller/providers/ProviderProbes",
) {}

export const ProviderProbesLayer: Layer.Layer<
  ProviderProbes,
  never,
  SqlClient.SqlClient | RunnerConnections | Secrets | PluginHost
> = Layer.effect(ProviderProbes)(make);
