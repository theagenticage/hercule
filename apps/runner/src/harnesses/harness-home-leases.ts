/**
 * Keeps one Harness Home from being used by a sign-in and by running processes
 * at the same time. Only Antigravity uses it: a new sign-in writes the
 * account's token file, and an `agy` process that is still running could
 * write the old login back over it when it refreshes its access token.
 *
 * A Harness Home is held in one of two ways:
 *
 * - A read lease belongs to a session or a probe, from before it reads the
 *   account's login until its `agy` process is gone. Any number can exist.
 * - The exclusive lease belongs to a sign-in, from the start of its login
 *   command until that process has exited. It cannot exist beside any other
 *   lease.
 *
 * Acquiring never waits. A refused caller gets a message to show the user:
 * waiting would keep a session slot busy for as long as someone takes to finish
 * a browser sign-in.
 *
 * The registry lives in memory and has no lock file, because one runner
 * process owns a runner storage folder and so its Harness Homes. The runner
 * refuses to start while another daemon listens on the folder's
 * `daemon.sock` (`credentials/socket.ts`, `serveCredentialSocket`).
 *
 * A sign-in that succeeded does not free the home at once. Its lease becomes
 * a "verifying" state, because the controller has not yet checked the new
 * login (it marks the runner's snapshot of the account as not signed in when
 * it accepts the code, but a start frame sent before that, or in flight, can
 * still reach this runner). While a home verifies:
 *
 * - a session start is refused;
 * - a probe is allowed, and is how the check happens;
 * - a new sign-in replaces the state.
 *
 * Verifying ends when the first probe that started after the login exited has
 * finished, whatever its outcome, or after `VERIFYING_BOUND`. A start that
 * reaches the runner during the controller's check is therefore refused, and
 * the controller puts the input back to waiting. A sign-in that fails, is
 * cancelled, times out or is stopped frees the home at once.
 *
 * Homes are keyed by their resolved path, not by account id: the path is the
 * resource that is shared.
 */
import { resolve } from "node:path";

/** What a refused acquire returns: the reason, written for the user. */
export interface LeaseRefused {
  readonly acquired: false;
  readonly message: string;
}

/** A held lease. `release` can be called more than once. */
export interface LeaseHeld {
  readonly acquired: true;
  readonly release: () => void;
  /**
   * Only on the exclusive lease. Ends it and starts the verifying state of the
   * home (see the module comment). Does nothing after `release`.
   */
  readonly verify?: () => void;
}

/**
 * The longest the verifying state lasts. The controller checks a new sign-in
 * with at most two probes, each cut off after 20 seconds
 * (`PROBE_DEADLINE` in the controller's `provider-accounts/probing.ts`); two
 * minutes covers both and the time the frames take.
 */
export const VERIFYING_BOUND_MS = 120_000;

export type LeaseResult = LeaseHeld | LeaseRefused;

/** Who holds a read lease, so a refusal can say what is running. */
export type ReadLeaseKind = "session" | "probe";

export interface HarnessHomeLeases {
  /** Takes a read lease on `home`. Refused while a sign-in holds the exclusive lease. */
  readonly acquireRead: (home: string, kind: ReadLeaseKind) => LeaseResult;
  /** Takes the exclusive lease on `home`. Refused while any lease on it exists. */
  readonly acquireExclusive: (home: string) => LeaseResult;
}

/** Returns the current time in milliseconds. Tests pass their own. */
type Now = () => number;

interface HomeState {
  exclusive: boolean;
  sessions: number;
  probes: number;
  /** When the verifying state ends at the latest, or undefined when the home does not verify. */
  verifyingUntil: number | undefined;
}

const VERIFYING =
  "A sign-in of this account is being checked on this runner. Try again in a moment.";

const SIGN_IN_RUNNING =
  "A sign-in of this account is in progress on this runner. Finish or cancel it, then try again.";

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/** Describes what runs on a home, for the refusal of a sign-in. */
const describeRunning = (state: HomeState): string => {
  const parts = [
    ...(state.sessions > 0 ? [plural(state.sessions, "session")] : []),
    ...(state.probes > 0 ? ["a check of this account"] : []),
  ];
  return `Cannot sign in now: ${parts.join(" and ")} of this account run on this runner. Stop the sessions, wait for the check to end, and try again.`;
};

/** Makes an empty registry. */
export const makeHarnessHomeLeases = (now: Now = Date.now): HarnessHomeLeases => {
  const homes = new Map<string, HomeState>();

  const takeState = (home: string): { key: string; state: HomeState } => {
    const key = resolve(home);
    let state = homes.get(key);
    if (state === undefined) {
      state = { exclusive: false, sessions: 0, probes: 0, verifyingUntil: undefined };
      homes.set(key, state);
    }
    // The bound is checked when the home is next asked for, so no timer runs.
    if (state.verifyingUntil !== undefined && now() >= state.verifyingUntil) {
      state.verifyingUntil = undefined;
    }
    return { key, state };
  };

  /** Forgets a home no lease holds any more, so the map does not grow with every account. */
  const tidy = (key: string, state: HomeState): void => {
    if (
      !state.exclusive &&
      state.sessions === 0 &&
      state.probes === 0 &&
      state.verifyingUntil === undefined
    ) {
      homes.delete(key);
    }
  };

  /** Returns a release that does its work once. */
  const once = (release: () => void): (() => void) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release();
    };
  };

  return {
    acquireRead: (home, kind) => {
      const { key, state } = takeState(home);
      if (state.exclusive || (kind === "session" && state.verifyingUntil !== undefined)) {
        const message = state.exclusive ? SIGN_IN_RUNNING : VERIFYING;
        tidy(key, state);
        return { acquired: false, message };
      }
      // The first probe that starts while the home verifies ends the state when it finishes.
      const endsVerifying = kind === "probe" && state.verifyingUntil !== undefined;
      if (kind === "session") state.sessions += 1;
      else state.probes += 1;
      return {
        acquired: true,
        release: once(() => {
          if (kind === "session") state.sessions -= 1;
          else state.probes -= 1;
          if (endsVerifying) state.verifyingUntil = undefined;
          tidy(key, state);
        }),
      };
    },

    acquireExclusive: (home) => {
      const { key, state } = takeState(home);
      if (state.exclusive) return { acquired: false, message: SIGN_IN_RUNNING };
      if (state.sessions > 0 || state.probes > 0) {
        const message = describeRunning(state);
        tidy(key, state);
        return { acquired: false, message };
      }
      // A new sign-in replaces the verifying state of the one before it.
      state.verifyingUntil = undefined;
      state.exclusive = true;
      let ended = false;
      const end = (verify: boolean): void => {
        if (ended) return;
        ended = true;
        state.exclusive = false;
        if (verify) state.verifyingUntil = now() + VERIFYING_BOUND_MS;
        tidy(key, state);
      };
      return { acquired: true, release: () => end(false), verify: () => end(true) };
    },
  };
};
