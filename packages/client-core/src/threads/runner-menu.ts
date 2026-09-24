/**
 * The composer's runner selector, scoped to the one instance the model
 * selector has already picked: what matters here is whether each machine can
 * host that instance, not the whole fleet's login state.
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
 * The runner the composer names when it has to speak about one but none is
 * selectable - a dimmed reason, the model menu's catalog: the selected runner
 * when there is one, else the local machine, else the first runner in the
 * list, else no runner exists at all to name.
 */
export const findReferenceRunner = (
  runners: readonly Runner[],
  selectedRunnerId: string | null,
  localRunnerId: string | null,
): Runner | undefined =>
  runners.find((runner) => runner.id === selectedRunnerId) ??
  runners.find((runner) => runner.id === localRunnerId) ??
  runners[0];
