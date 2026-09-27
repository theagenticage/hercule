/**
 * What a run's page says about the run's ephemeral workspace, which the
 * controller deletes once the run no longer needs it:
 *
 * - a completed run's workspace, and the workspace of a run cancelled without
 *   keeping it, is deleted soon after the run ends;
 * - a failed run's workspace, and the workspace of a run cancelled with its
 *   workspace kept, is kept for inspection until `workspaceKeptUntil`, then
 *   deleted;
 * - a user can delete a kept workspace before then.
 *
 * A primary workspace outlives every run that works in it, so a run says
 * nothing about it.
 */
import type { Run, Workspace } from "@hercule/contract";
import { isRunLive } from "./run-display";
import { formatDay } from "./time-context";

/** What a run's page shows and offers about the run's workspace. */
export interface RunWorkspaceReading {
  /**
   * Whether cancelling the run can delete its workspace, so the cancel
   * question asks whether to: the run is live and its ephemeral workspace
   * still exists.
   */
  readonly asksOnCancel: boolean;
  /** The note about the workspace, such as "Workspace deleted 3 Oct", or undefined for none. */
  readonly note: string | undefined;
  /** Whether the page offers Delete workspace: the workspace is kept for inspection. */
  readonly offersDelete: boolean;
}

const NOTHING: RunWorkspaceReading = { asksOnCancel: false, note: undefined, offersDelete: false };

/**
 * Describes what a run's page shows about the run's workspace, with dates in
 * `timezone`. `workspace` is the run's workspace, or undefined while the run
 * has none or it has not been read yet.
 *
 * - While the run is live and its ephemeral workspace exists, the cancel
 *   question asks about the workspace.
 * - Once the workspace is deleted, the note says when, from the workspace's
 *   own `disposedAt`.
 * - While a failed or kept run's workspace still exists, the note says until
 *   when it is kept, and the page offers to delete it.
 * - While the workspace of a run that completed, or was cancelled without
 *   keeping it, still exists, the note says it will be deleted shortly.
 */
export const describeRunWorkspace = (
  run: Run,
  workspace: Workspace | undefined,
  timezone: string,
): RunWorkspaceReading => {
  if (workspace?.kind !== "ephemeral") return NOTHING;
  // A lost workspace was on a runner that was retired, so nothing about it
  // can change and the runner's page already says so.
  if (workspace.status === "lost") return NOTHING;

  if (workspace.status === "deleted") {
    const deletedOn =
      workspace.disposedAt === null
        ? undefined
        : formatDay(new Date(workspace.disposedAt), timezone);
    return {
      ...NOTHING,
      note: deletedOn === undefined ? "Workspace deleted" : `Workspace deleted ${deletedOn}`,
    };
  }

  if (isRunLive(run.status)) return { ...NOTHING, asksOnCancel: true };
  // The controller deletes the workspace at its next sweep, which can be
  // minutes away. No live topic tells an open page when that happens, so the
  // page can show this note for a while after the deletion, and the words
  // must not become wrong then.
  if (run.workspaceKeptUntil === undefined) {
    return { ...NOTHING, note: "Workspace will be deleted shortly" };
  }
  const keptUntil = formatDay(new Date(run.workspaceKeptUntil), timezone);
  return {
    asksOnCancel: false,
    note:
      keptUntil === undefined
        ? "Workspace kept for inspection"
        : `Workspace kept for inspection until ${keptUntil}`,
    offersDelete: true,
  };
};
