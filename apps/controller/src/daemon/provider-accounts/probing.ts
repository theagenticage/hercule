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
 * It also starts the logins on runners and tracks the device logins this
 * controller started, so that a runner's report that one ended is accepted
 * only for a login the controller is waiting for. That state lives in memory,
 * so there must be one instance per process: the boot builds it once and the
 * sign-in operations and the inbound driver share it.
 *
 * `driving` keeps the snapshots fresh for the life of the controller: it
 * probes every account on a runner when it connects, and sweeps the whole
 * fleet on a timer, because a login can expire and a harness can be upgraded
 * outside Hercule, which makes a snapshot older than the interval unreliable.
 * A watcher of its own announces a stored token on the `provider` topic when
 * it expires, because nothing else changes at that moment. It never waits on
 * a sweep.
 *
 * After the probes of a sweep, the catalogs that are due are read
 * (`catalog-reading.ts`). A catalog read is a probe of its own, never a sweep
 * probe reused, and it takes a probe slot of its runner like a sweep probe. A
 * new credential, an accepted sign-in and a refresh force a read whether or
 * not it is due.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/sql/SqlError";
import type { LoginCode, LoginFailed, LoginResult, LoginStart, LoginUrl } from "@hercule/protocol";
import {
  createInvalidStateError,
  InvalidState,
  NotFound,
  type CapabilitySnapshot,
} from "@hercule/contract";
import { CurrentActor } from "../../actor";
import {
  HarnessAccounts,
  ModelCatalogs,
  ProviderAccountProbes,
  ProviderAccountService,
  type ProbeOutcome,
  type ProbePair,
} from "../../provider-accounts";
import { PromotionState } from "../../promotion";
import { LocalRunnerId, RunnerConnections, type Answer } from "../../runners";
import { AccountUsage } from "../../usage";
import { makeCatalogReading } from "./catalog-reading";

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

const PROBE_INTERVAL: Duration.Duration = Duration.hours(1);

/** Lets tests set an interval short enough to wait for. */
export const ProviderAccountProbeInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/ProviderAccountProbeInterval",
  { defaultValue: (): Duration.Duration => PROBE_INTERVAL },
);

type StoreError = SqlError | Schema.SchemaError | InvalidState;

/**
 * Runs `probed` and returns its result, or `none` after logging its failure.
 * A failure because the account was deleted meanwhile is a race with the user
 * and nothing is wrong, so it is logged at info; any other failure is logged
 * at error. Nothing is waiting on the probe, so the log is the only place the
 * failure can go.
 */
const logProbeFailure = <A>(
  probed: Effect.Effect<A, StoreError | NotFound>,
  message: string,
): Effect.Effect<Option.Option<A>> =>
  probed.pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      (error): error is NotFound => error instanceof NotFound,
      () =>
        Effect.as(
          Effect.logInfo(`${message}, because the provider account was deleted meanwhile`),
          Option.none(),
        ),
    ),
    Effect.catchCause((cause) => Effect.as(Effect.logError(message, cause), Option.none())),
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

/** What a runner answers to a `loginStart` or a `loginCode`. */
export type LoginAnswer = LoginUrl | LoginFailed | LoginResult;

const isLoginAnswer = (answer: Answer): answer is LoginAnswer =>
  answer._tag === "loginUrl" || answer._tag === "loginFailed" || answer._tag === "loginResult";

/** Returns the message for a sign-in whose answer was not what the exchange needed. */
export const describeSignInFailure = (answer: LoginAnswer): string =>
  answer._tag === "loginFailed" ? answer.message : "the sign-in did not return a URL";

/** What a sign-in asks a runner to start: the `loginStart` frame without its request id. */
export type LoginStartRequest = Omit<LoginStart, "_tag" | "requestId">;

/** Returns a key that is the same for one account in one harness on one runner. */
const buildProviderAccountKey = (
  runnerId: string,
  providerAccountId: string,
  harnessId: string,
): string => `${runnerId}:${providerAccountId}:${harnessId}`;

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
  const accountUsage = yield* AccountUsage;
  const promotion = yield* PromotionState;
  const catalogs = yield* ModelCatalogs;

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
   * Asks the runner for the account's usage too when `readUsage` is true; the
   * readings in the answer are stored with the snapshot. Returns the outcome
   * (see `ProbeOutcome`): `unanswered` if the runner does not answer before
   * the deadline, `superseded` if the account changed or a newer probe was
   * stored while this one ran. A late report is dropped rather than stored,
   * because nothing is waiting for that request any more.
   *
   * Private on purpose: a usage read starts a harness process that talks to
   * the provider, so it may only be asked for through `readUsageByProbe`,
   * which claims the read first.
   *
   * With `readsCatalog`, the probe is a read of the account's Model Catalog
   * (see `catalog-reading.ts`): its outcome is stored as that read, and when
   * the runner does not answer the read is recorded as failed.
   *
   * Fails with `NotFound` when the account does not exist, and with
   * `InvalidState` before anything is sent when the account cannot run in the
   * harness, or its stored key does not decrypt. With `readsCatalog`, an
   * `InvalidState` is also recorded as the failed read, with its message, so
   * the user sees why the models cannot be listed.
   */
  const probeAndMaybeReadUsage = (
    runnerId: string,
    providerAccountId: string,
    harnessId: string,
    readUsage: boolean,
    options: { readonly readsCatalog: boolean } = { readsCatalog: false },
  ): Effect.Effect<ProbeOutcome, StoreError | NotFound> =>
    Effect.gen(function* () {
      // Taken before the credential is read, so the snapshot never claims to
      // be newer than the state the probe saw.
      const stamp = yield* probes.readProbeStamp(providerAccountId, readUsage);
      const deadline = yield* ProviderAccountProbeDeadline;
      const answer = yield* connections.asked(
        runnerId,
        {
          _tag: "probeRequest",
          requestId: crypto.randomUUID(),
          harnessId,
          // Decrypted here, at send time: the probe runs the harness's own auth
          // check, which is only meaningful with the credential.
          readUsage,
          harnessAccount: yield* harnessAccounts
            .prepare(providerAccountId, harnessId)
            .pipe(
              Effect.tapError((error) =>
                options.readsCatalog && error instanceof InvalidState
                  ? catalogs.recordCatalogRead(
                      providerAccountId,
                      { _tag: "failed", message: error.error.message },
                      stamp,
                    )
                  : Effect.void,
              ),
            ),
        },
        deadline,
      );
      if (Option.isNone(answer) || answer.value._tag !== "probeReport") {
        if (options.readsCatalog) {
          yield* catalogs.recordCatalogRead(
            providerAccountId,
            {
              _tag: "failed",
              message: `The machine that lists this account's models did not answer within ${Duration.format(deadline)}. Try again.`,
            },
            stamp,
          );
        }
        return { _tag: "unanswered" } as const;
      }
      return yield* probes.recordProbe(
        runnerId,
        providerAccountId,
        harnessId,
        answer.value.result,
        stamp,
        options,
      );
    });

  /**
   * Probes one account in one harness on one runner and stores the snapshot,
   * without reading usage. `options` is as in `probeAndMaybeReadUsage`. Returns
   * and fails as it does.
   */
  const probe = (
    runnerId: string,
    providerAccountId: string,
    harnessId: string,
    options?: { readonly readsCatalog: boolean },
  ): Effect.Effect<ProbeOutcome, StoreError | NotFound> =>
    probeAndMaybeReadUsage(runnerId, providerAccountId, harnessId, false, options);

  /**
   * Probes the account in the harness on the runner to check a sign-in that
   * was just accepted, and returns the snapshot, or `none` when the runner
   * does not answer. A probe whose answer is superseded is sent once more,
   * because a sign-in on another runner can advance the account's credential
   * generation while this probe runs. Fails with `InvalidState` when the
   * second answer is superseded too: the account keeps changing, and no
   * snapshot can be told to describe this sign-in. Also fails as `probe` does.
   *
   * When the snapshot shows the account signed in, the account's Model
   * Catalog is read, without waiting.
   */
  const probeToCheckSignIn = (
    runnerId: string,
    providerAccountId: string,
    harnessId: string,
  ): Effect.Effect<Option.Option<CapabilitySnapshot>, StoreError | NotFound> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = yield* probe(runnerId, providerAccountId, harnessId);
        if (outcome._tag === "stored") {
          if (outcome.snapshot.auth.status === "ok") {
            yield* Effect.forkDetach(readCatalog(providerAccountId));
          }
          return Option.some(outcome.snapshot);
        }
        if (outcome._tag === "unanswered") return Option.none();
      }
      return yield* Effect.fail(accountChangedDuringSignIn());
    });

  /**
   * Probes one pair in a free slot of its runner and logs a failure instead of
   * returning it. Each runner is asked for at most
   * `MAX_CONCURRENT_PROBES_PER_RUNNER` of these probes at once, however many
   * sweeps and catalog reads overlap. The probes a person waits for (a
   * sign-in, the probe operation, the end of a login) take no slot: they would
   * otherwise wait behind a sweep, and they are one probe each. One account
   * deleted mid-sweep, or one that cannot run in the harness probed, does not
   * discard the rest of the fleet's snapshots.
   */
  const probeInSlot = (
    pair: ProbePair,
    options?: { readonly readsCatalog: boolean },
  ): Effect.Effect<void> =>
    Effect.asVoid(
      logProbeFailure(
        readProbeSlots(pair.runnerId).withPermits(1)(
          probe(pair.runnerId, pair.providerAccountId, pair.harnessId, options),
        ),
        "A provider account probe could not be recorded",
      ),
    );

  /** Probes the pairs at the same time, each in a free slot of its runner (see `probeInSlot`). */
  const probePairs = (pairs: ReadonlyArray<ProbePair>): Effect.Effect<void> =>
    Effect.forEach(pairs, (pair) => probeInSlot(pair), { concurrency: "unbounded", discard: true });

  const { readCatalog, readDueCatalogs } = yield* makeCatalogReading((pair) =>
    probeInSlot(pair, { readsCatalog: true }),
  );

  /**
   * Sends a login frame and returns the runner's answer. Fails with
   * `InvalidState` when the runner does not answer before the deadline.
   * Private on purpose: a login may only start through `startLogin`, which
   * registers the login before it asks.
   */
  const askLogin = (
    runnerId: string,
    request: LoginStart | LoginCode,
    deadline: Duration.Duration,
  ): Effect.Effect<LoginAnswer, InvalidState> =>
    Effect.gen(function* () {
      const answer = yield* connections.asked(runnerId, request, deadline);
      const login = Option.filter(answer, isLoginAnswer);
      return yield* Option.match(login, {
        // Disconnected, gone or silent all mean the same to the user: the
        // runner did not answer.
        onNone: () =>
          Effect.fail(
            createInvalidStateError(
              `that runner did not answer the sign-in within ${Duration.format(deadline)}`,
            ),
          ),
        onSome: Effect.succeed,
      });
    });

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

  /**
   * Probes the account in the harness once, then again for as long as another
   * login ended while the probe ran, and returns the last probe stored, or
   * `none` when the runner did not answer it. A
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

  /**
   * Starts a login on a runner and returns the URL it printed, with the code
   * to type there for a device login. Registers the login so its end, if the
   * runner reports one, is accepted (see `probeAfterLoginEnd`), and removes
   * the registration again when the runner refuses the login, does not answer,
   * or the caller stops waiting.
   *
   * `onSignedIn` runs once the probe after the login's end finds the account
   * signed in. The runner's report of the end has no caller, so it runs as the
   * actor current when this is called. It must handle its own failures.
   *
   * Fails with `InvalidState` when the runner does not answer before the
   * deadline or answers with anything but a URL.
   */
  const startLogin = (
    runnerId: string,
    providerAccountId: string,
    request: LoginStartRequest,
    deadline: Duration.Duration,
    onSignedIn: Effect.Effect<void>,
  ): Effect.Effect<LoginUrl, InvalidState> =>
    Effect.gen(function* () {
      const actor = yield* CurrentActor;
      const requestId = crypto.randomUUID();
      const loginKey = buildLoginKey(runnerId, requestId);
      // Registered before the runner is asked, because a device login that
      // fails at once can report its end before this fiber reads the answer.
      awaitedLoginEnds.set(loginKey, {
        runnerId,
        providerAccountId,
        harnessId: request.harnessId,
        printed: false,
        onSignedIn: Effect.provideService(onSignedIn, CurrentActor, actor),
      });
      // Forgotten when the ask fails or is interrupted, since a login whose
      // answer is never read would otherwise stay awaited for as long as the
      // controller runs.
      const answer = yield* askLogin(
        runnerId,
        { _tag: "loginStart", requestId, ...request },
        deadline,
      ).pipe(Effect.onError(() => Effect.sync(() => awaitedLoginEnds.delete(loginKey))));
      if (answer._tag !== "loginUrl") {
        awaitedLoginEnds.delete(loginKey);
        return yield* Effect.fail(createInvalidStateError(describeSignInFailure(answer)));
      }
      // The runner stopped every earlier login on this runner for this account
      // and harness to start this one, so the ends of those that had printed
      // their URL are no longer awaited. An earlier login still waiting for
      // its URL is left alone: its own answer, a failure, removes it.
      for (const [key, login] of awaitedLoginEnds) {
        if (
          login.printed &&
          login.runnerId === runnerId &&
          login.providerAccountId === providerAccountId &&
          login.harnessId === request.harnessId
        ) {
          awaitedLoginEnds.delete(key);
        }
      }
      const login = awaitedLoginEnds.get(loginKey);
      // Absent when the runner reported the end before this answer was read.
      // Its end stays awaited only for a device login, which has a user code;
      // a login finished by pasting a code reports no end.
      if (login !== undefined) {
        if (answer.userCode !== undefined) login.printed = true;
        else awaitedLoginEnds.delete(loginKey);
      }
      return answer;
    });

  /**
   * Probes every account and harness the runner could run, and reads the
   * catalogs that are due and that this runner can serve. Logs a failure
   * instead of returning it.
   */
  const sweepRunner = (runnerId: string): Effect.Effect<void> =>
    Effect.andThen(
      logSweepFailure(Effect.flatMap(probes.listPairsOnRunner(runnerId), probePairs)),
      readDueCatalogs(runnerId),
    );

  /**
   * Probes every account on every connected runner, and reads the catalogs
   * that are due. Logs a failure instead of returning it.
   */
  const sweepFleet = (): Effect.Effect<void> =>
    Effect.andThen(
      logSweepFailure(Effect.flatMap(probes.listPairsOnFleet(), probePairs)),
      readDueCatalogs(),
    );

  /**
   * Runs forever. Sweeps the whole fleet every interval, because logins expire
   * and harnesses are upgraded outside Hercule. A sweep can take minutes on a
   * big fleet, so it runs apart from `watchTokenExpiries`.
   */
  const sweepOnTimer: Effect.Effect<void> = Effect.gen(function* () {
    const interval = yield* ProviderAccountProbeInterval;
    while (true) {
      yield* Effect.sleep(interval);
      yield* sweepFleet();
    }
  });

  /**
   * Runs forever. Waits for the next expiry of a stored token and announces
   * the account on the `provider` topic then, because a token that expires
   * changes nothing that is stored. The wait is planned again whenever a
   * snapshot is stored. A new token comes with a sign-in, and a sign-in always
   * ends in a stored snapshot, so this covers a token that changes without a
   * clock of its own. With no token to wait for, it waits for the next
   * snapshot.
   */
  const watchTokenExpiries: Effect.Effect<void> = Effect.gen(function* () {
    const replan = yield* Queue.dropping<void>(1);
    yield* Effect.forkScoped(
      Stream.runForEach(probes.snapshotChanges, () => Queue.offer(replan, undefined)),
    );
    let announcedUntil = yield* Clock.currentTimeMillis;
    while (true) {
      // A database error must not stop the watcher, so it is logged and the
      // watcher waits for the next snapshot.
      const nextExpiry = yield* probes
        .findNextTokenExpiry(announcedUntil)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logError("The next token expiry could not be read", cause),
              Option.none<number>(),
            ),
          ),
        );
      const now = yield* Clock.currentTimeMillis;
      const woken = yield* Effect.raceFirst(
        Option.match(nextExpiry, {
          onNone: () => Effect.never,
          onSome: (at) =>
            Effect.as(Effect.sleep(Duration.millis(Math.max(0, at - now))), "time" as const),
        }),
        Effect.as(Queue.take(replan), "replan" as const),
      );
      if (woken === "replan") continue;
      const awake = yield* Clock.currentTimeMillis;
      yield* probes
        .announceExpiredTokens(announcedUntil, awake)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Expired tokens could not be announced", cause),
          ),
        );
      announcedUntil = awake;
    }
  }).pipe(Effect.scoped);

  /** Runs forever. Sweeps each runner that connects, the fleet on a timer, and watches the tokens' expiry. */
  const driving: Effect.Effect<void> = Effect.all(
    [
      // Forked, because a runner that answers slowly must not hold up the
      // next runner's sweep.
      Stream.runForEach(connections.arrivals, (runnerId) =>
        Effect.forkChild(sweepRunner(runnerId)),
      ),
      sweepOnTimer,
      watchTokenExpiries,
    ],
    { concurrency: "unbounded", discard: true },
  );

  return {
    probe,

    /**
     * Claims the account's next usage read (`AccountUsage.claimRead`) and, when
     * the claim is granted, probes the account in the harness on the runner
     * asking for usage. The runner's readings are stored with the snapshot.
     * This is the only way a probe asks for usage, so a usage read never
     * happens without a claim. The probe is a background one: it waits for a
     * free slot on the runner like a sweep probe does, and the claim is made
     * only once the slot is held, so the 15 minutes do not start running while
     * the read waits.
     *
     * Returns whether the claim was granted. Fails as `probe` does.
     */
    readUsageByProbe: (
      runnerId: string,
      providerAccountId: string,
      harnessId: string,
    ): Effect.Effect<boolean, StoreError | NotFound> =>
      readProbeSlots(runnerId).withPermits(1)(
        Effect.gen(function* () {
          // The claim is a write, so it waits while a promotion freezes the
          // controller and is never made once it is sealed. The probe is not
          // held at the gate: it stores its answer through `recordProbe`,
          // which passes the gate itself.
          const claimed = yield* promotion.whenServing(accountUsage.claimRead(providerAccountId));
          if (!claimed) return false;
          yield* probeAndMaybeReadUsage(runnerId, providerAccountId, harnessId, true);
          return true;
        }),
      ),

    probeToCheckSignIn,

    /**
     * Sends the code the user pasted to the runner that holds the login and
     * returns the runner's answer. Fails with `InvalidState` when the runner
     * does not answer before the deadline.
     */
    submitLoginCode: (
      runnerId: string,
      request: LoginCode,
      deadline: Duration.Duration,
    ): Effect.Effect<LoginAnswer, InvalidState> => askLogin(runnerId, request, deadline),

    startLogin,

    driving,

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
              Effect.flatMap((probed) =>
                Option.isSome(probed) && probed.value.auth.status === "ok"
                  ? Effect.andThen(
                      latestOnSignedIn.get(key) ?? onSignedIn,
                      readCatalog(providerAccountId),
                    )
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

    sweepRunner,

    sweepFleet,

    /**
     * Probes one account in every harness it can run in, on every connected
     * runner that could run it there, and reads its Model Catalog whether or
     * not that is due. Use it when the account's credential changed, because
     * every stored snapshot was taken with the old one. Logs a failure instead
     * of returning it.
     */
    sweepProviderAccount: (providerAccountId: string): Effect.Effect<void> =>
      Effect.andThen(
        logSweepFailure(
          Effect.flatMap(probes.listPairsOfProviderAccount(providerAccountId), probePairs),
        ),
        readCatalog(providerAccountId),
      ),

    readCatalog,
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
  | RunnerConnections
  | ProviderAccountProbes
  | HarnessAccounts
  | AccountUsage
  | PromotionState
  | ModelCatalogs
  | ProviderAccountService
  | LocalRunnerId
> = Layer.effect(ProviderAccountProbing)(make);
