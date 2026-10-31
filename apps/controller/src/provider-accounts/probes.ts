/**
 * Asks runners what each Provider Account can do in its harness, and stores
 * the results.
 *
 * The controller starts every probe, because the account's home, credential
 * and model argument live here and a runner does not have them. Requests
 * carry an id because several can be in flight on one connection.
 *
 * A sweep probes each account in its default harness. It gathers facts rather
 * than performing an operation: it checks no grant, and the system is the
 * actor for every row it writes.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createNotFoundError,
  NotFound,
  type CapabilitySnapshot,
  type InvalidState,
} from "@hercule/contract";
import type { RunnerFacts } from "@hercule/protocol";
import { afterCommit, announce, nowIso, withTransaction } from "../db";
import { computeVersionVerdict, findVersionFloor } from "../harnesses";
import { PromotionState } from "../promotion";
import { RunnerConnections, runnerRepository } from "../runners";
import { PluginHost, type RegisteredHarness } from "../plugins";
import { HarnessAccounts } from "./harness-account";
import { providerAccountRepository, type StoredProviderAccount } from "./repository";

/**
 * The runner's own 15s probe timeout plus the round trip, so the runner's
 * "did not answer" result is stored rather than cut off by this deadline.
 */
const PROBE_DEADLINE: Duration.Duration = Duration.seconds(20);

/** Lets tests set a deadline short enough to wait for. */
export const ProviderAccountProbeDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/provider-accounts/ProviderAccountProbeDeadline",
  { defaultValue: (): Duration.Duration => PROBE_DEADLINE },
);

/**
 * A login can expire and a harness can be upgraded outside Hercule, so a
 * snapshot older than this is unreliable.
 */
const PROBE_INTERVAL: Duration.Duration = Duration.hours(1);

export const ProviderAccountProbeInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/provider-accounts/ProviderAccountProbeInterval",
  { defaultValue: (): Duration.Duration => PROBE_INTERVAL },
);

type StoreError = SqlError | Schema.SchemaError | InvalidState;

const NO_SUCH_PROVIDER_ACCOUNT = "no such provider account";

/**
 * Checks from a runner's facts that it could run the harness: its build has
 * an adapter for it and its binary is on the machine. A probe on a runner
 * without either could only report that the harness is missing, and would
 * send the account's key there for nothing.
 */
const canRunHarness = (facts: RunnerFacts | null, harness: RegisteredHarness): boolean =>
  facts !== null &&
  facts.adapters.includes(harness.id) &&
  facts.harnesses.some((binary) => binary.name === harness.binaryName && binary.present);

/**
 * Logs a probe that failed because its account was deleted meanwhile at info,
 * since that is a race with the user and nothing is wrong, and any other
 * failure at error. Nothing is waiting on the probe, so the log is the only
 * place the failure can go.
 */
const logProbeFailure = (
  probed: Effect.Effect<unknown, StoreError | NotFound>,
  message: string,
): Effect.Effect<void> =>
  probed.pipe(
    Effect.asVoid,
    Effect.catchIf(
      (error): error is NotFound => error instanceof NotFound,
      () => Effect.logInfo(`${message}, because the provider account was deleted meanwhile`),
    ),
    Effect.catchCause((cause) => Effect.logError(message, cause)),
  );

/** A login whose end the controller waits for the runner to report. */
interface AwaitedLogin {
  readonly runnerId: string;
  readonly providerAccountId: string;
  /** The harness the login runs in, which the probe after its end asks about. */
  readonly harnessId: string;
  /** True once the login's `loginStart` was answered with its URL. */
  printed: boolean;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const accounts = yield* providerAccountRepository;
  const runners = yield* runnerRepository;
  const connections = yield* RunnerConnections;
  const promotion = yield* PromotionState;
  const harnessAccounts = yield* HarnessAccounts;
  const host = yield* PluginHost;
  // A wake needs no payload, and one unread change already says that a
  // snapshot was stored, so the PubSub keeps only the latest.
  const snapshotWrites = yield* PubSub.sliding<void>(1);

  /**
   * Probes one account in one harness on one runner, stores the snapshot, and
   * returns it. Returns `none` if the runner does not answer before the
   * deadline. A late report is dropped rather than stored, because nothing is
   * waiting for that request any more.
   *
   * Fails with `InvalidState` before anything is sent when the account cannot
   * run in the harness, or its stored key does not decrypt.
   *
   * Only the store passes the promotion gate, not the wait for the runner, so
   * a freeze never waits up to a probe's deadline for its answer. While a
   * promotion freezes the controller, the store waits until the freeze ends.
   * Once the controller is sealed, the snapshot is dropped and `none` is
   * returned: the runner reconnects to the new machine, which probes it again
   * when it arrives.
   */
  const probeOne = (
    runnerId: string,
    providerAccountId: string,
    harnessId: string,
  ): Effect.Effect<Option.Option<CapabilitySnapshot>, StoreError | NotFound> =>
    Effect.gen(function* () {
      const answer = yield* connections.asked(
        runnerId,
        {
          _tag: "probeRequest",
          requestId: crypto.randomUUID(),
          harnessId,
          // Decrypted here, at send time: the probe runs the harness's own auth
          // check, which is only meaningful with the credential.
          harnessAccount: yield* harnessAccounts.prepare(providerAccountId, harnessId),
        },
        yield* ProviderAccountProbeDeadline,
      );
      if (Option.isNone(answer) || answer.value._tag !== "probeReport") return Option.none();
      const result = answer.value.result;
      const store = withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          // The account may have been deleted while the runner was answering,
          // and a snapshot cannot be stored for an account that is gone.
          if (Option.isNone(yield* accounts.one(providerAccountId))) {
            return yield* Effect.fail(createNotFoundError(NO_SUCH_PROVIDER_ACCOUNT));
          }
          yield* accounts.recordSnapshot(providerAccountId, harnessId, runnerId, result, at);
          yield* afterCommit(() => {
            PubSub.publishUnsafe(snapshotWrites, undefined);
          });
          // No audit row: a probe result is not an event anyone reads back, so
          // the account's live subscribers are notified instead.
          yield* announce({
            _tag: "record",
            topic: "provider",
            id: providerAccountId,
            kind: "updated",
          });
          return Option.some({
            runnerId,
            harnessId,
            probedAt: at,
            harnessVersion: result.harnessVersion,
            versionVerdict: computeVersionVerdict(
              result.harnessVersion,
              findVersionFloor(harnessId),
            ),
            auth: result.auth,
            models: result.models,
          });
        }),
      );
      return yield* promotion.whenServingOr(store, () => Effect.succeed(Option.none()));
    });

  /**
   * Probes every account, in its default harness, on every given runner that
   * could run that harness (`canRunHarness`), concurrently. Each probe logs
   * its own failure, so one account deleted mid-sweep, or one that cannot run
   * in its default harness, does not discard the rest of the fleet's
   * snapshots. Fails only when the runners cannot be read.
   */
  const sweep = (
    runnerIds: ReadonlyArray<string>,
    over: ReadonlyArray<StoredProviderAccount>,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const harnesses = yield* host.harnesses();
      const factsByRunner = new Map(
        (yield* runners.listFacts()).map((runner) => [runner.id, runner.facts]),
      );
      const probes = runnerIds.flatMap((runnerId) =>
        over
          .filter((account) => {
            const harness = harnesses.find((one) => one.id === account.defaultHarnessId);
            // A harness this build does not carry is probed anyway, so the
            // probe fails with a message that says so.
            return (
              harness === undefined || canRunHarness(factsByRunner.get(runnerId) ?? null, harness)
            );
          })
          .map((account) => ({ runnerId, account })),
      );
      yield* Effect.forEach(
        probes,
        ({ runnerId, account }) =>
          logProbeFailure(
            probeOne(runnerId, account.id, account.defaultHarnessId),
            "A provider account probe could not be recorded",
          ),
        { concurrency: "unbounded", discard: true },
      );
    });

  /**
   * Logs the error of a sweep that fails to start, for example because the
   * account list cannot be read. Nothing is waiting on the sweep, so the log
   * is the only place the error can go.
   */
  const logSweepFailure = (swept: Effect.Effect<void, StoreError>): Effect.Effect<void> =>
    Effect.catchCause(swept, (cause) =>
      Effect.logError("A provider account sweep could not be started", cause),
    );

  const sweepRunner = (runnerId: string): Effect.Effect<void> =>
    logSweepFailure(Effect.flatMap(accounts.list(), (all) => sweep([runnerId], all)));

  /**
   * Probes the account in the harness on the runner, stores the snapshot, and
   * returns it. Fails with `NotFound` if no such account exists.
   */
  const probeProviderAccount = (
    runnerId: string,
    providerAccountId: string,
    harnessId: string,
  ): Effect.Effect<Option.Option<CapabilitySnapshot>, StoreError | NotFound> =>
    Effect.flatMap(
      accounts.one(providerAccountId),
      (found): Effect.Effect<Option.Option<CapabilitySnapshot>, StoreError | NotFound> =>
        Option.isNone(found)
          ? Effect.fail(createNotFoundError(NO_SUCH_PROVIDER_ACCOUNT))
          : probeOne(runnerId, providerAccountId, harnessId),
    );

  // The logins whose end this controller waits to hear about, keyed by runner
  // and the request id of the login's `loginStart`. A runner reports the end
  // of a login, so without this map a runner could make the controller probe
  // whenever it likes, and the runner in the key keeps one runner from ending
  // another's login. Nothing is removed when a runner disconnects: the
  // login's child keeps running on the runner, and its end is reported once
  // the runner is back.
  //
  // The map stays small without timers. A login that has not printed its URL
  // yet leaves the map when its answer arrives or its wait runs out. A login
  // that printed its URL leaves it when it ends, or when a newer login on the
  // same runner and account in the same harness prints its URL, because the
  // runner stops the older login to start the newer one. So the map holds at
  // most one printed login per runner, account and harness, plus the logins
  // still starting.
  const awaitedLoginEnds = new Map<string, AwaitedLogin>();
  const buildLoginKey = (runnerId: string, requestId: string): string => `${runnerId}:${requestId}`;

  // The probes that ended logins cause, keyed by runner, account and harness,
  // so at most one runs per account in a harness on a runner.
  const probingAfterLoginEnd = new Set<string>();
  const probeAgainAfterLoginEnd = new Set<string>();
  const buildProviderAccountKey = (
    runnerId: string,
    providerAccountId: string,
    harnessId: string,
  ): string => `${runnerId}:${providerAccountId}:${harnessId}`;

  /**
   * Probes the account in the harness once, then again for as long as another
   * login ended while the probe ran. Removes the key from
   * `probingAfterLoginEnd` when the last probe ends, also when it fails.
   */
  const probeUntilSettled = (
    runnerId: string,
    providerAccountId: string,
    harnessId: string,
    key: string,
  ): Effect.Effect<void, StoreError | NotFound> =>
    Effect.gen(function* () {
      do {
        probeAgainAfterLoginEnd.delete(key);
        yield* probeProviderAccount(runnerId, providerAccountId, harnessId);
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
    probe: probeProviderAccount,

    /**
     * Emits once each time a stored snapshot commits, so a run whose
     * text generation step waits for a runner can check again whether one
     * can take its call: a snapshot can show a login or a model that was not
     * there before. A subscriber that falls behind gets one emission for all
     * the snapshots it missed.
     */
    snapshotChanges: Stream.fromPubSub(snapshotWrites),

    /**
     * Records that the login sent as the `loginStart` with this request id is
     * starting on this runner for this account in this harness, so that its
     * end, if the runner reports one, is accepted. Call it before the runner
     * is asked to start the login: the runner may report the end before the
     * caller has read the answer.
     */
    expectLoginEnd: (
      runnerId: string,
      providerAccountId: string,
      harnessId: string,
      requestId: string,
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        awaitedLoginEnds.set(buildLoginKey(runnerId, requestId), {
          runnerId,
          providerAccountId,
          harnessId,
          printed: false,
        });
      }),

    /**
     * Stops waiting for the end of the login sent as the `loginStart` with
     * this request id. Call it when the runner refused the login or the
     * caller stopped waiting for the answer: the login either did not start
     * or its URL never reached the user.
     */
    forgetLoginEnd: (runnerId: string, requestId: string): Effect.Effect<void> =>
      Effect.sync(() => {
        awaitedLoginEnds.delete(buildLoginKey(runnerId, requestId));
      }),

    /**
     * Records that the login sent as the `loginStart` with this request id
     * printed its URL. The runner stopped every earlier login on this runner
     * for this account and harness to start this one, so the ends of those that had
     * printed their URL are no longer awaited. An earlier login still waiting
     * for its URL is left alone: its own answer, a failure, removes it.
     *
     * This login's end stays awaited only when `reportsEnd` is true, which is
     * the case for a device login: a login finished by pasting a code reports
     * no end.
     */
    recordPrintedLogin: (
      runnerId: string,
      providerAccountId: string,
      harnessId: string,
      requestId: string,
      { reportsEnd }: { readonly reportsEnd: boolean },
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        for (const [key, login] of awaitedLoginEnds) {
          if (
            login.printed &&
            login.runnerId === runnerId &&
            login.providerAccountId === providerAccountId &&
            login.harnessId === harnessId
          ) {
            awaitedLoginEnds.delete(key);
          }
        }
        const key = buildLoginKey(runnerId, requestId);
        const login = awaitedLoginEnds.get(key);
        // Absent when the runner reported the end before this answer was read.
        if (login === undefined) return;
        if (reportsEnd) login.printed = true;
        else awaitedLoginEnds.delete(key);
      }),

    /**
     * Probes the login's account, in the login's harness, on the runner after the runner reported
     * that the device login with this request id ended. Returns when the
     * probe is stored.
     *
     * Ignores the report, and logs it, unless `expectLoginEnd` was called for
     * this runner and request id and no end has been accepted for it since.
     * An honest runner can send such a report too, for example when the
     * login's answer came after the controller stopped waiting for it, so
     * ignoring it does not close the connection.
     *
     * At most one probe runs per runner, account and harness. A login started and
     * ended while that probe runs causes exactly one more probe after it,
     * because the running probe may have read the state from before the login.
     */
    probeAfterLoginEnd: (runnerId: string, requestId: string): Effect.Effect<void, StoreError> =>
      Effect.suspend(() => {
        const loginKey = buildLoginKey(runnerId, requestId);
        const login = awaitedLoginEnds.get(loginKey);
        if (login === undefined) {
          return Effect.logInfo(
            "Ignored a runner's report that a login ended, because no login was waiting for it",
          ).pipe(Effect.annotateLogs({ runnerId, requestId }));
        }
        awaitedLoginEnds.delete(loginKey);
        const { providerAccountId, harnessId } = login;
        const key = buildProviderAccountKey(runnerId, providerAccountId, harnessId);
        if (probingAfterLoginEnd.has(key)) {
          probeAgainAfterLoginEnd.add(key);
          return Effect.void;
        }
        probingAfterLoginEnd.add(key);
        return probeUntilSettled(runnerId, providerAccountId, harnessId, key).pipe(
          // The user may have deleted the account while the login ran. That is
          // a race, not a failure of the controller.
          Effect.catchIf(
            (error): error is NotFound => error instanceof NotFound,
            () =>
              Effect.logInfo(
                "Did not probe after a login ended, because the provider account was deleted meanwhile",
              ).pipe(Effect.annotateLogs({ runnerId, requestId })),
          ),
        );
      }),

    sweepRunner,

    /**
     * Probes one account, in its default harness, on every connected runner.
     * A probe runs with the account's credential, so a new credential makes
     * every runner's snapshot stale at once.
     */
    sweepProviderAccount: (providerAccountId: string): Effect.Effect<void> =>
      logSweepFailure(
        Effect.gen(function* () {
          const found = yield* accounts.one(providerAccountId);
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
          const interval = yield* ProviderAccountProbeInterval;
          while (true) {
            yield* Effect.sleep(interval);
            yield* logSweepFailure(
              Effect.gen(function* () {
                const online = yield* runners.connected();
                if (online.length === 0) return;
                yield* sweep(online, yield* accounts.list());
              }),
            );
          }
        }),
      ],
      { concurrency: "unbounded", discard: true },
    ),
  };
});

/** The service that probes the fleet for Provider Accounts and stores the snapshots. */
export class ProviderAccountProbes extends Context.Service<
  ProviderAccountProbes,
  Effect.Success<typeof make>
>()("hercule/controller/provider-accounts/ProviderAccountProbes") {}

export const ProviderAccountProbesLayer: Layer.Layer<
  ProviderAccountProbes,
  never,
  SqlClient.SqlClient | RunnerConnections | HarnessAccounts | PluginHost | PromotionState
> = Layer.effect(ProviderAccountProbes)(make);
