/**
 * Builds the composer's runner selector for the instance the model selector
 * has already picked. Each row shows whether that runner can host the
 * instance; the login state of other instances does not matter here.
 */
import type { CapabilitySnapshot, ProviderInstance, Runner } from "@hercule/contract";

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
 * Returns why `runner` cannot host a thread of the instance whose snapshot on
 * it is `snapshot` right now, or `null` when it can: "retired", its
 * connectivity when it is not online, "draining", or "not logged in".
 */
export const findDimmedReason = (
  runner: Runner,
  snapshot: CapabilitySnapshot | undefined,
): string | null =>
  isRetired(runner)
    ? "retired"
    : runner.connectivity !== "online"
      ? runner.connectivity
      : runner.lifecycle === "draining"
        ? "draining"
        : snapshot?.auth.status !== "ok"
          ? "not logged in"
          : null;

/**
 * Returns one row per runner that is not retired, and the default runner: the
 * runner on this Mac when it is usable, else the first usable runner, else `null`.
 * A row is dimmed, with the reason, when its runner is not online, is
 * draining, or is not logged in to the instance.
 */
export const buildRunnerMenu = (
  runners: readonly Runner[],
  localId: string | null,
  instance: ProviderInstance,
): RunnerMenu => {
  const rows = runners
    .filter((runner) => !isRetired(runner))
    .map((runner) => {
      const snapshot = instance.snapshots.find((each) => each.runnerId === runner.id);
      const dimmed = findDimmedReason(runner, snapshot);
      return {
        runnerId: runner.id,
        name: runner.name,
        state: readRunnerState(runner),
        isLocal: runner.id === localId,
        reserved: runner.reserved,
        identity: snapshot?.auth.identity ?? null,
        planLabel: snapshot?.auth.planLabel ?? null,
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
 * none may be selectable, for example in a dimmed reason or to read the model
 * menu's catalog. Returns, in order of preference:
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
