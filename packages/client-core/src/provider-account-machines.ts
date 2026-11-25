/**
 * What the Providers page says about a Provider Account on each machine:
 * whether it is signed in there and as whom, and which action the machine
 * offers, with the reason when it offers none. The card's pips and the
 * account sheet's Machines section both read these, so they cannot disagree.
 */
import type {
  CapabilitySnapshot,
  Harness,
  Provider,
  ProviderAccount,
  ProviderAccountReadinessState,
  Runner,
} from "@hercule/contract";
import {
  findDefaultHarnessSnapshot,
  findProviderAccountKind,
  findProviderAccountReadiness,
  hasAdapter,
  signsInPerMachine,
} from "./provider-accounts";
import { buildProviderRows, type ProviderRow } from "./provider-rows";

/**
 * The one action a machine offers for an account that is not ready there:
 *
 * - `sign-in`: start a sign-in on the machine;
 * - `install`: install the harness on the machine, which has an adapter for it;
 * - `update`: install the version of the harness this Hercule build runs, over
 *   an installed one that is older than the build supports;
 * - `offline`: the machine is not connected, so it can do nothing now;
 * - `unavailable`: the machine's Hercule build has no adapter for the harness,
 *   so no action could ever work there until the machine is updated.
 *
 * `reason` is the text for the two actions that cannot be pressed, such as
 * "moss is offline."; it is `null` for the other two.
 */
export type ProviderAccountMachineAction =
  | { readonly kind: "sign-in"; readonly reason: null }
  | { readonly kind: "install"; readonly reason: null }
  | { readonly kind: "update"; readonly reason: null }
  | { readonly kind: "offline"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/** One machine, as a Provider Account sees it. */
export interface ProviderAccountMachine {
  readonly runnerId: string;
  readonly runnerName: string;
  /**
   * Whether the account can run in its default harness on the machine: the
   * controller's readiness row for that pair says `ready`.
   */
  readonly ready: boolean;
  /** Who the account is signed in as there, or `null` when it is not ready or the harness named nobody. */
  readonly identity: string | null;
  /**
   * What stands in the way on the machine, in a few words, such as "Codex
   * 0.169.0 is too old" or "Not signed in"; `null` when the account is ready.
   */
  readonly problem: string | null;
  /** What the machine offers, or `null` when the account is ready there already. */
  readonly action: ProviderAccountMachineAction | null;
}

/**
 * Decides the action of a machine on which the account is not signed in.
 * `offer` says whether the machine is connected and can sign in or install
 * (a `ProviderRow` says so); without one, the machine's build has no adapter
 * for the harness.
 */
export const decideMachineAction = (
  runner: Runner,
  offer: Pick<ProviderRow, "signIn" | "install"> | undefined,
  harnessName: string,
): ProviderAccountMachineAction => {
  if (runner.connectivity !== "online") {
    return { kind: "offline", reason: `${runner.name} is offline.` };
  }
  if (offer?.signIn === true) return { kind: "sign-in", reason: null };
  if (offer?.install === "offered") return { kind: "install", reason: null };
  return {
    kind: "unavailable",
    reason: `${runner.name} runs a Hercule build that cannot run ${harnessName}.`,
  };
};

/**
 * Describes what stops an account on a machine whose readiness is `state`,
 * in a few words for the machine's row, such as "Codex 0.169.0 is too old".
 * Returns `null` for `ready`. `snapshot` is the last probe of the account's
 * default harness there, which holds the harness version the machine reported.
 */
const describeMachineProblem = (
  state: ProviderAccountReadinessState,
  harnessName: string,
  snapshot: CapabilitySnapshot | undefined,
  runnerHasAdapter: boolean,
): string | null => {
  switch (state) {
    case "ready":
      return null;
    case "harness-too-old": {
      const version = snapshot?.harnessVersion;
      return `${harnessName}${version == null ? "" : ` ${version}`} is too old`;
    }
    case "harness-missing":
      // The machine's action says which harness the build cannot run, so this
      // row only says what is wrong.
      return runnerHasAdapter ? `${harnessName} is not installed` : "Not supported there";
    case "token-expired":
      return "Token expired";
    case "not-signed-in":
    case "credential-missing":
      return "Not signed in";
  }
};

/**
 * Where a Provider Account works:
 *
 * - `shared`: its credential is a key or token the controller keeps, so every
 *   machine uses it;
 * - `per-machine`: its login lives on each machine, so it works only where it
 *   is signed in. `machines` has one entry for each runner that is not retired,
 *   in the order of the runners;
 * - `unknown`: nothing says where its login lives, because its default harness
 *   is not registered or its provider no longer declares its kind.
 */
export type ProviderAccountReach =
  | { readonly kind: "shared" }
  | { readonly kind: "per-machine"; readonly machines: ReadonlyArray<ProviderAccountMachine> }
  | { readonly kind: "unknown" };

/**
 * Decides where the account works: see `ProviderAccountReach`. A retired runner
 * is gone for good, so it holds no sign-in the user could act on and is left
 * out of `machines`.
 */
export const decideProviderAccountReach = (
  account: ProviderAccount,
  runners: ReadonlyArray<Runner>,
  providers: ReadonlyArray<Provider>,
  harnesses: ReadonlyArray<Harness>,
): ProviderAccountReach => {
  const harness = harnesses.find(({ id }) => id === account.defaultHarnessId);
  if (harness === undefined || findProviderAccountKind(providers, account) === undefined) {
    return { kind: "unknown" };
  }
  if (!signsInPerMachine(providers, account)) return { kind: "shared" };
  const harnessName = harness.displayName;
  const machines = runners
    .filter((runner) => runner.lifecycle !== "retired")
    .map((runner) => {
      const row = buildProviderRows(runner, [account], providers, harnesses)[0];
      const state = findProviderAccountReadiness(account, account.defaultHarnessId, runner.id);
      const ready = state === "ready";
      const snapshot = findDefaultHarnessSnapshot(account, runner.id);
      const auth = snapshot?.auth;
      // A sign-in cannot help where the harness is too old, however the
      // login stands, so the machine offers the update instead.
      const action: ProviderAccountMachineAction | null = ready
        ? null
        : state === "harness-too-old" && runner.connectivity === "online"
          ? { kind: "update", reason: null }
          : decideMachineAction(runner, row, harnessName);
      return {
        runnerId: runner.id,
        runnerName: runner.name,
        ready,
        identity: ready && auth?.status === "ok" ? (auth.identity ?? null) : null,
        problem: describeMachineProblem(
          state,
          harnessName,
          snapshot,
          hasAdapter(runner, account.defaultHarnessId),
        ),
        action,
      };
    });
  return { kind: "per-machine", machines };
};

/**
 * Returns one entry for each runner that is not retired, in the order of
 * `runners`, for an account that signs in on each machine
 * (`signsInPerMachine`). Returns `null` for any other account, whose
 * credential every machine uses, and for one whose default harness is not
 * registered (see `decideProviderAccountReach`, which tells these apart).
 */
export const listProviderAccountMachines = (
  account: ProviderAccount,
  runners: ReadonlyArray<Runner>,
  providers: ReadonlyArray<Provider>,
  harnesses: ReadonlyArray<Harness>,
): ReadonlyArray<ProviderAccountMachine> | null => {
  const reach = decideProviderAccountReach(account, runners, providers, harnesses);
  return reach.kind === "per-machine" ? reach.machines : null;
};
