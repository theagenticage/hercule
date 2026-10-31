/**
 * What the Providers page says about an account on each machine: whether it
 * is signed in there and as whom, and which action the machine offers. The
 * card's pips and the account sheet's Machines section both read these, so
 * they cannot disagree.
 */
import type { Harness, Provider, ProviderAccount, Runner } from "@hercule/contract";
import { buildProviderRows } from "./provider-rows";

/** One machine, as an account sees it. */
export interface AccountMachine {
  readonly runnerId: string;
  readonly runnerName: string;
  /** Whether the machine is connected to the controller now. */
  readonly online: boolean;
  /** Whether the machine's last probe of the account, in its default harness, found it signed in. */
  readonly signedIn: boolean;
  /** Who the account is signed in as there, or `null` when it is not signed in or the harness named nobody. */
  readonly identity: string | null;
  /** Whether the machine can start a sign-in now: online, with the harness installed. */
  readonly canSignIn: boolean;
  /**
   * The Install action: `offered` when the machine can install the harness,
   * `blocked` when its runner build has no adapter for it, `none` when the
   * harness is there or the machine is offline.
   */
  readonly install: "offered" | "blocked" | "none";
}

/**
 * Returns one entry for each runner that is not retired, in the order of
 * `runners`. A retired runner is gone for good, so it holds no sign-in the
 * user could act on.
 */
export const listAccountMachines = (
  account: ProviderAccount,
  runners: ReadonlyArray<Runner>,
  providers: ReadonlyArray<Provider>,
  harnesses: ReadonlyArray<Harness>,
): ReadonlyArray<AccountMachine> =>
  runners
    .filter((runner) => runner.lifecycle !== "retired")
    .map((runner) => {
      const row = buildProviderRows(runner, [account], providers, harnesses)[0];
      const auth = account.snapshots.find(
        (snapshot) =>
          snapshot.runnerId === runner.id && snapshot.harnessId === account.defaultHarnessId,
      )?.auth;
      const signedIn = auth?.status === "ok";
      return {
        runnerId: runner.id,
        runnerName: runner.name,
        online: runner.connectivity === "online",
        signedIn,
        identity: signedIn ? (auth.identity ?? null) : null,
        // An account whose default harness no plugin registers has no row:
        // nothing can be done for it on any machine.
        canSignIn: row?.signIn ?? false,
        install: row?.install ?? "none",
      };
    });
