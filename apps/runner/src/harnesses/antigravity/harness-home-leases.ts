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
 * The leases only stop a sign-in from overwriting a login that a running
 * process uses. They do not check that a new login belongs to the right
 * person, and a session start that waited through a sign-in can still use the
 * new login before the controller has judged it. Every harness that reads its
 * login when it starts has that race; #1306 owns it.
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
}

export type LeaseResult = LeaseHeld | LeaseRefused;

/** Who holds a read lease, so a refusal can say what is running. */
export type ReadLeaseKind = "session" | "probe";

export interface HarnessHomeLeases {
  /** Takes a read lease on `home`. Refused while a sign-in holds the exclusive lease. */
  readonly acquireRead: (home: string, kind: ReadLeaseKind) => LeaseResult;
  /** Takes the exclusive lease on `home`. Refused while any lease on it exists. */
  readonly acquireExclusive: (home: string) => LeaseResult;
}

interface HomeState {
  exclusive: boolean;
  sessions: number;
  probes: number;
}

const SIGN_IN_RUNNING =
  "A sign-in of this account is in progress on this runner. Finish or cancel it, then try again.";

const formatCount = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/** Builds the refusal of a sign-in: what runs on the home, and what the user can do about it. */
const buildSignInRefusal = (state: HomeState): string => {
  const sessions = state.sessions > 0 ? formatCount(state.sessions, "session") : undefined;
  const check = state.probes > 0 ? "a check" : undefined;
  const running =
    sessions !== undefined && check !== undefined
      ? `${sessions} and ${check} of this account run`
      : sessions !== undefined
        ? `${sessions} of this account ${state.sessions === 1 ? "runs" : "run"}`
        : "a check of this account runs";
  const actions = [
    ...(sessions === undefined
      ? []
      : [state.sessions === 1 ? "stop the session" : "stop the sessions"]),
    ...(check === undefined ? [] : ["wait for the check to end"]),
  ];
  const advice =
    actions.length === 1
      ? `${actions[0]!} and try again.`
      : `${actions.join(", ")}, and try again.`;
  const sentence = `${advice.charAt(0).toUpperCase()}${advice.slice(1)}`;
  return `Cannot sign in now: ${running} on this runner. ${sentence}`;
};

/** Makes an empty registry. */
export const makeHarnessHomeLeases = (): HarnessHomeLeases => {
  const homes = new Map<string, HomeState>();

  const readOrCreateHomeState = (home: string): { key: string; state: HomeState } => {
    const key = resolve(home);
    let state = homes.get(key);
    if (state === undefined) {
      state = { exclusive: false, sessions: 0, probes: 0 };
      homes.set(key, state);
    }
    return { key, state };
  };

  /** Forgets a home no lease holds any more, so the map does not grow with every account. */
  const forgetIdleHome = (key: string, state: HomeState): void => {
    if (!state.exclusive && state.sessions === 0 && state.probes === 0) {
      homes.delete(key);
    }
  };

  /** Returns a release that does its work once. */
  const makeRunOnce = (release: () => void): (() => void) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release();
    };
  };

  return {
    acquireRead: (home, kind) => {
      const { key, state } = readOrCreateHomeState(home);
      if (state.exclusive) {
        forgetIdleHome(key, state);
        return { acquired: false, message: SIGN_IN_RUNNING };
      }
      if (kind === "session") state.sessions += 1;
      else state.probes += 1;
      return {
        acquired: true,
        release: makeRunOnce(() => {
          if (kind === "session") state.sessions -= 1;
          else state.probes -= 1;
          forgetIdleHome(key, state);
        }),
      };
    },

    acquireExclusive: (home) => {
      const { key, state } = readOrCreateHomeState(home);
      if (state.exclusive) return { acquired: false, message: SIGN_IN_RUNNING };
      if (state.sessions > 0 || state.probes > 0) {
        const message = buildSignInRefusal(state);
        forgetIdleHome(key, state);
        return { acquired: false, message };
      }
      state.exclusive = true;
      return {
        acquired: true,
        release: makeRunOnce(() => {
          state.exclusive = false;
          forgetIdleHome(key, state);
        }),
      };
    },
  };
};
