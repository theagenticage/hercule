/**
 * Builds the composer's runner selector for the account the model selector
 * has already picked. Each row shows whether that runner can host the
 * account in the thread's harness; the sign-in state of other accounts does
 * not matter here.
 */
import type { ProviderAccount, ProviderAccountReadinessState, Runner } from "@hercule/contract";
import { findProviderAccountReadiness } from "../provider-accounts";

export interface RunnerMenuRow {
  readonly runnerId: string;
  readonly name: string;
  readonly state: "online" | "draining" | "unreachable" | "offline";
  readonly isLocal: boolean;
  readonly reserved: boolean;
  readonly identity: string | null;
  readonly planLabel: string | null;
  readonly dimmed: string | null;
}

export interface RunnerMenu {
  readonly rows: readonly RunnerMenuRow[];
  readonly defaultRunnerId: string | null;
}

const readRunnerState = (runner: Runner): RunnerMenuRow["state"] =>
  runner.lifecycle === "draining" ? "draining" : runner.connectivity;

// A retired runner can never host a thread again, and runners are never
// deleted, so the menu would otherwise fill up with machines that are gone.
const isRetired = (runner: Runner): boolean => runner.lifecycle === "retired";

/**
 * Returns why `runner` cannot host a thread of an account that is `readiness`
 * on it right now, or `null` when it can: "retired", its connectivity when it
 * is not online, "draining", "not signed in", "no key or token" when the
 * controller holds no credential for the account, "token expired", "not
 * installed" when the harness is not on the runner, or "harness too old" when
 * it is older than this build supports.
 */
export const findDimmedReason = (
  runner: Runner,
  readiness: ProviderAccountReadinessState,
): string | null =>
  isRetired(runner)
    ? "retired"
    : runner.connectivity !== "online"
      ? runner.connectivity
      : runner.lifecycle === "draining"
        ? "draining"
        : readiness === "not-signed-in"
          ? "not signed in"
          : readiness === "credential-missing"
            ? "no key or token"
            : readiness === "token-expired"
              ? "token expired"
              : readiness === "harness-too-old"
                ? "harness too old"
                : readiness === "harness-missing"
                  ? "not installed"
                  : null;

/**
 * Returns one row per runner that is not retired, and the default runner: the
 * runner on this Mac when it is usable, else the first usable runner, else `null`.
 * A row is dimmed, with the reason, when its runner is not online, is
 * draining, or the account cannot run in `harnessId` on it
 * (`findProviderAccountReadiness`).
 */
export const buildRunnerMenu = (
  runners: readonly Runner[],
  localId: string | null,
  account: ProviderAccount,
  harnessId: string,
): RunnerMenu => {
  const rows = runners
    .filter((runner) => !isRetired(runner))
    .map((runner) => {
      const readiness = findProviderAccountReadiness(account, harnessId, runner.id);
      const dimmed = findDimmedReason(runner, readiness);
      return {
        runnerId: runner.id,
        name: runner.name,
        state: readRunnerState(runner),
        isLocal: runner.id === localId,
        reserved: runner.reserved,
        // Who the account is signed in as is known only where it can run.
        identity: readiness === "ready" ? account.identity : null,
        planLabel: readiness === "ready" ? account.planLabel : null,
        dimmed,
      };
    });

  const localRow = rows.find((row) => row.runnerId === localId);
  const defaultRunnerId =
    localRow !== undefined && localRow.dimmed === null
      ? localRow.runnerId
      : (rows.find((row) => row.dimmed === null)?.runnerId ?? null);

  return { rows, defaultRunnerId };
};

/**
 * Returns the runner the composer refers to when it needs one even though
 * none may be selectable, for example to name it in the reason a draft cannot
 * start. Returns, in order of preference:
 *
 * - the selected runner, even a retired one, because a started thread keeps
 *   the runner it ran on;
 * - otherwise the runner on this Mac, unless it is retired;
 * - otherwise the first runner in the list that is not retired;
 * - otherwise `undefined`, when every runner is retired or there are none.
 */
export const findReferenceRunner = (
  runners: readonly Runner[],
  selectedRunnerId: string | null,
  thisMacRunnerId: string | null,
): Runner | undefined =>
  runners.find((runner) => runner.id === selectedRunnerId) ??
  runners.find((runner) => runner.id === thisMacRunnerId && !isRetired(runner)) ??
  runners.find((runner) => !isRetired(runner));
