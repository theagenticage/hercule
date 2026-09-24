/**
 * Builds the composer's runner selector for the instance the model selector
 * has already picked. Each row shows whether that runner can host the
 * instance; the login state of other instances does not matter here.
 */
import type { ProviderInstance, Runner } from "@hercule/contract";

export interface RunnerMenuRow {
  readonly runnerId: string;
  readonly name: string;
  readonly state: "online" | "draining" | "retired" | "unreachable" | "offline";
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
  runner.lifecycle !== "active" ? runner.lifecycle : runner.connectivity;

/**
 * Returns one row per runner, and the default runner: the local runner when it
 * is usable, else the first usable runner, else `null`. A row is dimmed, with
 * the reason, when its runner is not online, is draining, or is not logged in
 * to the instance.
 */
export const buildRunnerMenu = (
  runners: readonly Runner[],
  localId: string | null,
  instance: ProviderInstance,
): RunnerMenu => {
  const rows = runners.map((runner) => {
    const snapshot = instance.snapshots.find((each) => each.runnerId === runner.id);
    const dimmed =
      runner.connectivity !== "online"
        ? runner.connectivity
        : runner.lifecycle === "draining"
          ? "draining"
          : snapshot?.auth.status !== "ok"
            ? "not logged in"
            : null;

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
 * - the selected runner;
 * - otherwise the local runner;
 * - otherwise the first runner in the list;
 * - otherwise `undefined`, when there are no runners.
 */
export const findReferenceRunner = (
  runners: readonly Runner[],
  selectedRunnerId: string | null,
  localRunnerId: string | null,
): Runner | undefined =>
  runners.find((runner) => runner.id === selectedRunnerId) ??
  runners.find((runner) => runner.id === localRunnerId) ??
  runners[0];
