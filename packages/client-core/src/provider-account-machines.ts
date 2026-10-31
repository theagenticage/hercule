/**
 * What the Providers page says about a Provider Account on each machine:
 * whether it is signed in there and as whom, and which action the machine
 * offers, with the reason when it offers none. The card's pips and the
 * account sheet's Machines section both read these, so they cannot disagree.
 */
import type { Harness, Provider, ProviderAccount, Runner } from "@hercule/contract";
import { findDefaultHarnessSnapshot, signsInPerMachine } from "./provider-accounts";
import { buildProviderRows, type ProviderRow } from "./provider-rows";

/**
 * The one action a machine offers for an account that is not signed in there:
 *
 * - `sign-in`: start a sign-in on the machine;
 * - `install`: install the harness on the machine, which has an adapter for it;
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
  | { readonly kind: "offline"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/** One machine, as a Provider Account sees it. */
export interface ProviderAccountMachine {
  readonly runnerId: string;
  readonly runnerName: string;
  /** Whether the machine's last probe of the account, in its default harness, found it signed in. */
  readonly signedIn: boolean;
  /** Who the account is signed in as there, or `null` when it is not signed in or the harness named nobody. */
  readonly identity: string | null;
  /** What the machine offers, or `null` when the account is signed in there already. */
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
 * Returns one entry for each runner that is not retired, in the order of
 * `runners`, for an account that signs in on each machine
 * (`signsInPerMachine`). Returns `null` for any other account, whose
 * credential every machine uses, and for one whose default harness is not
 * registered. A retired runner is gone for good, so it holds no sign-in the
 * user could act on.
 */
export const listProviderAccountMachines = (
  account: ProviderAccount,
  runners: ReadonlyArray<Runner>,
  providers: ReadonlyArray<Provider>,
  harnesses: ReadonlyArray<Harness>,
): ReadonlyArray<ProviderAccountMachine> | null => {
  const harness = harnesses.find(({ id }) => id === account.defaultHarnessId);
  if (harness === undefined || !signsInPerMachine(providers, account)) return null;
  const harnessName = harness.displayName;
  return runners
    .filter((runner) => runner.lifecycle !== "retired")
    .map((runner) => {
      const row = buildProviderRows(runner, [account], providers, harnesses)[0];
      const auth = findDefaultHarnessSnapshot(account, runner.id)?.auth;
      const signedIn = auth?.status === "ok";
      return {
        runnerId: runner.id,
        runnerName: runner.name,
        signedIn,
        identity: signedIn ? (auth.identity ?? null) : null,
        action: signedIn ? null : decideMachineAction(runner, row, harnessName),
      };
    });
};
