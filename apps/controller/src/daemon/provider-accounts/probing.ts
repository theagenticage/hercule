/**
 * Asks runners what each Provider Account can do in its harness, and hands
 * the answers to the provider-accounts domain to store.
 *
 * The controller starts every probe, because the account's home, credential
 * and model argument live here and a runner does not have them. Requests
 * carry an id because several can be in flight on one connection.
 *
 * A sweep probes every harness an account can run in, on each runner that has
 * that harness and could run the account there. The domain decides which
 * (account, harness) pairs those are (`ProviderAccountProbes`); this service
 * sends the probes.
 *
 * It also tracks the device logins this controller started, so that a
 * runner's report that one ended is accepted only for a login the controller
 * is waiting for. That state lives in memory, so there must be one instance
 * per process: the boot builds it once and the sign-in operations and the
 * inbound driver share it.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { SqlError } from "effect/sql/SqlError";
import {
  createInvalidStateError,
  NotFound,
  type CapabilitySnapshot,
  type InvalidState,
} from "@hercule/contract";
import {
  HarnessAccounts,
  ProviderAccountProbes,
  type ProbeOutcome,
  type ProbePair,
} from "../../provider-accounts";
import { RunnerConnections } from "../../runners";

/**
 * The runner's own 15s probe timeout plus the round trip, so the runner's
 * "did not answer" result is stored rather than cut off by this deadline.
 */
const PROBE_DEADLINE: Duration.Duration = Duration.seconds(20);

/** Lets tests set a deadline short enough to wait for. */
export const ProviderAccountProbeDeadline = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/ProviderAccountProbeDeadline",
  { defaultValue: (): Duration.Duration => PROBE_DEADLINE },
);

type StoreError = SqlError | Schema.SchemaError | InvalidState;

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

/**
 * Logs the error of a sweep that fails to start, for example because the
 * account list cannot be read. Nothing is waiting on the sweep, so the log
 * is the only place the error can go.
 */
const logSweepFailure = (swept: Effect.Effect<void, StoreError>): Effect.Effect<void> =>
  Effect.catchCause(swept, (cause) =>
    Effect.logError("A provider account sweep could not be started", cause),
  );

/**
 * How many sweep probes the controller has in flight on one runner at once,
 * however many sweeps overlap. Each probe starts a harness process on the
 * runner, so no number of accounts or sweeps can start that many at the same
 * time.
 */
const MAX_CONCURRENT_PROBES_PER_RUNNER = 2;

const accountChangedDuringSignIn = (): InvalidState =>
  createInvalidStateError("The account changed while this sign-in was checked. Sign in again.");

/** A login whose end the controller waits for the runner to report. */
interface AwaitedLogin {
  readonly runnerId: string;
  readonly providerAccountId: string;
  /** The harness the login runs in, which the probe after its end asks about. */
  readonly harnessId: string;
  /** True once the login's `loginStart` was answered with its URL. */
  printed: boolean;
  /**
   * Runs when the probe after this login's end finds the account signed in.
   * It carries the actor that started the login, because nobody calls the
   * controller when the runner reports the end.
   */
  readonly onSignedIn: Effect.Effect<void>;
}

const make = Effect.gen(function* () {
  const connections = yield* RunnerConnections;
  const probes = yield* ProviderAccountProbes;
  const harnessAccounts = yield* HarnessAccounts;

  // One semaphore per runner id, made on first use. Runners are few, so the
  // map is never pruned.
  const probeSlots = new Map<string, Semaphore.Semaphore>();
  const readProbeSlots = (runnerId: string): Semaphore.Semaphore => {
    let slots = probeSlots.get(runnerId);
    if (slots === undefined) {
      slots = Semaphore.makeUnsafe(MAX_CONCURRENT_PROBES_PER_RUNNER);
      probeSlots.set(runnerId, slots);
    }
    return slots;
  };

  /**
   * Probes one account in one harness on one runner and stores the snapshot.
   * Returns the outcome (see `ProbeOutcome`): `unanswered` if the runner does
   * not answer before the deadline, `superseded` if the account changed or a
   * newer probe was stored while this one ran. A late report is dropped
   * rather than stored, because nothing is waiting for that request any more.
   *
   * Fails with `NotFound` when the account does not exist, and with
   * `InvalidState` before anything is sent when the account cannot run in the
   * harness, or its stored key does not decrypt.
   */
  const probe = (
    runnerId: string,
    providerAccountId: string,
    harnessId: string,
  ): Effect.Effect<ProbeOutcome, StoreError | NotFound> =>
    Effect.gen(function* () {
      // Taken before the credential is read, so the snapshot never claims to
      // be newer than the state the probe saw.
      const stamp = yield* probes.readProbeStamp(providerAccountId);
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
      if (Option.isNone(answer) || answer.value._tag !== "probeReport") {
        return { _tag: "unanswered" } as const;
      }
      return yield* probes.recordProbe(
        runnerId,
        providerAccountId,
        harnessId,
        answer.value.result,
        stamp,
      );
    });

  /**
   * Probes the account in the harness on the runner to check a sign-in that
   * was just accepted, and returns the snapshot, or `none` when the runner
   * does not answer. A probe whose answer is superseded is sent once more,
   * because a sign-in on another runner can advance the account's credential
   * generation while this probe runs. Fails with `InvalidState` when the
   * second answer is superseded too: the account keeps changing, and no
   * snapshot can be told to describe this sign-in. Also fails as `probe` does.
   */
  const probeToCheckSignIn = (
    runnerId: string,
    providerAccountId: string,
    harnessId: string,
  ): Effect.Effect<Option.Option<CapabilitySnapshot>, StoreError | NotFound> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = yield* probe(runnerId, providerAccountId, harnessId);
        if (outcome._tag === "stored") return Option.some(outcome.snapshot);
        if (outcome._tag === "unanswered") return Option.none();
      }
      return yield* Effect.fail(accountChangedDuringSignIn());
    });

  /**
   * Probes every pair. Each probe waits for a free slot on its runner, so the
   * runners are probed at the same time and a runner is never asked for more
   * than `MAX_CONCURRENT_PROBES_PER_RUNNER` sweep probes at once, also while
   * another sweep is running. The probes a person waits for (a sign-in, the
   * probe operation, the end of a login) take no slot: they would otherwise
   * wait behind a sweep, and they are one probe each. Each probe logs its own
   * failure, so one account deleted mid-sweep, or one that cannot run in the
   * harness probed, does not discard the rest of the fleet's snapshots.
   */
  const probePairs = (pairs: ReadonlyArray<ProbePair>): Effect.Effect<void> =>
    Effect.forEach(
      pairs,
      ({ runnerId, providerAccountId, harnessId }) =>
        logProbeFailure(
          readProbeSlots(runnerId).withPermits(1)(probe(runnerId, providerAccountId, harnessId)),
          "A provider account probe could not be recorded",
        ),
      { concurrency: "unbounded", discard: true },
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
  // The `onSignedIn` of the latest login that ended while a probe ran, keyed
  // like `probingAfterLoginEnd`. The repeated probe completes as that login,
  // so it runs as the actor who started it.
  const latestOnSignedIn = new Map<string, Effect.Effect<void>>();
  const buildProviderAccountKey = (
    runnerId: string,
    providerAccountId: string,
    harnessId: string,
  ): string => `${runnerId}:${providerAccountId}:${harnessId}`;

  /**
   * Probes the account in the harness once, then again for as long as another
   * login ended while the probe ran, and returns the last snapshot. A
   * superseded answer also asks for another probe (the account changed while
   * it ran), and fails with `InvalidState` when two answers in a row are
   * superseded, as `probeToCheckSignIn` does. Removes the key from
   * `probingAfterLoginEnd` when the last probe ends, also when it fails.
   */
  const probeUntilSettled = (
    runnerId: string,
    providerAccountId: string,
    harnessId: string,
    key: string,
  ): Effect.Effect<Option.Option<CapabilitySnapshot>, StoreError | NotFound> =>
    Effect.gen(function* () {
      let supersededInARow = 0;
      while (true) {
        probeAgainAfterLoginEnd.delete(key);
        const outcome = yield* probe(runnerId, providerAccountId, harnessId);
        if (outcome._tag === "superseded") {
          supersededInARow++;
          if (supersededInARow === 2) return yield* Effect.fail(accountChangedDuringSignIn());
          continue;
        }
        supersededInARow = 0;
        if (!probeAgainAfterLoginEnd.has(key)) {
          return outcome._tag === "stored" ? Option.some(outcome.snapshot) : Option.none();
        }
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          probingAfterLoginEnd.delete(key);
          probeAgainAfterLoginEnd.delete(key);
        }),
      ),
    );

  return {
    probe,

    probeToCheckSignIn,

    /**
     * Records that the login sent as the `loginStart` with this request id is
     * starting on this runner for this account in this harness, so that its
     * end, if the runner reports one, is accepted. Call it before the runner
     * is asked to start the login: the runner may report the end before the
     * caller has read the answer.
     *
     * `onSignedIn` runs when the probe after the login's end finds the account
     * signed in. The caller builds it to run as the actor who started the
     * login, and it must handle its own failures.
     */
    expectLoginEnd: (
      runnerId: string,
      providerAccountId: string,
      harnessId: string,
      requestId: string,
      onSignedIn: Effect.Effect<void>,
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        awaitedLoginEnds.set(buildLoginKey(runnerId, requestId), {
          runnerId,
          providerAccountId,
          harnessId,
          printed: false,
          onSignedIn,
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
     * probe is stored. The end of the login is a sign-in that was accepted, so
     * the account's credential generation advances first and the runner's
     * snapshot stops counting as signed in (see `acceptDeviceSignIn`). When
     * the probe finds the account signed in, the login's `onSignedIn` runs.
     * Fails with `InvalidState` as `probeToCheckSignIn` does.
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
     * That probe completes as the latest login that ended: its `onSignedIn`
     * runs, not the one of the login that started the first probe.
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
        const { providerAccountId, harnessId, onSignedIn } = login;
        const key = buildProviderAccountKey(runnerId, providerAccountId, harnessId);
        // For every end, also one that only asks the running probe to repeat:
        // each is a sign-in that was accepted.
        return Effect.andThen(
          probes.acceptDeviceSignIn(providerAccountId, runnerId, harnessId),
          Effect.suspend(() => {
            if (probingAfterLoginEnd.has(key)) {
              probeAgainAfterLoginEnd.add(key);
              latestOnSignedIn.set(key, onSignedIn);
              return Effect.void;
            }
            probingAfterLoginEnd.add(key);
            latestOnSignedIn.set(key, onSignedIn);
            return probeUntilSettled(runnerId, providerAccountId, harnessId, key).pipe(
              Effect.flatMap((snapshot) =>
                Option.isSome(snapshot) && snapshot.value.auth.status === "ok"
                  ? (latestOnSignedIn.get(key) ?? onSignedIn)
                  : Effect.void,
              ),
              Effect.ensuring(Effect.sync(() => latestOnSignedIn.delete(key))),
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
        );
      }),

    /** Probes every account and harness the runner could run. Logs a failure instead of returning it. */
    sweepRunner: (runnerId: string): Effect.Effect<void> =>
      logSweepFailure(Effect.flatMap(probes.listPairsOnRunner(runnerId), probePairs)),

    /** Probes every account on every connected runner. Logs a failure instead of returning it. */
    sweepFleet: (): Effect.Effect<void> =>
      logSweepFailure(Effect.flatMap(probes.listPairsOnFleet(), probePairs)),

    /**
     * Probes one account in every harness it can run in, on every connected
     * runner that could run it there. Logs a failure instead of returning it.
     */
    sweepProviderAccount: (providerAccountId: string): Effect.Effect<void> =>
      logSweepFailure(
        Effect.flatMap(probes.listPairsOfProviderAccount(providerAccountId), probePairs),
      ),
  };
});

/** The service that probes the fleet for Provider Accounts and tracks the device logins it started. */
export class ProviderAccountProbing extends Context.Service<
  ProviderAccountProbing,
  Effect.Success<typeof make>
>()("hercule/controller/daemon/ProviderAccountProbing") {}

export const ProviderAccountProbingLayer: Layer.Layer<
  ProviderAccountProbing,
  never,
  RunnerConnections | ProviderAccountProbes | HarnessAccounts
> = Layer.effect(ProviderAccountProbing)(make);
