/**
 * What a run's page says about the run's ephemeral workspace, which the
 * controller deletes once nothing holds it and its `keptUntil` has passed:
 *
 * - a completed run's workspace, and the workspace of a run cancelled without
 *   keeping it, is kept until the moment the run ended, so it is deleted soon
 *   after;
 * - a failed run's workspace, and the workspace of a run cancelled with its
 *   workspace kept, is kept for inspection until a later `keptUntil`, then
 *   deleted;
 * - a thread that works in the workspace holds it while the thread runs,
 *   and after it exits can keep it for longer than the run did;
 * - a user can delete a kept workspace before then.
 *
 * A primary workspace outlives every run that works in it, so a run says
 * nothing about it.
 */
import type { Run, Workspace } from "@hercule/contract";
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
  /** Whether the page offers Delete workspace: nothing holds the workspace, and it is kept for a while. */
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
 * - While a thread still works in the workspace, the note says so. The
 *   workspace then has no `keptUntil`, and deleting it is refused.
 * - While the workspace still exists and is kept past the moment the run
 *   ended, the note says until when, and the page offers to delete it. The
 *   note does not say why it is kept: the run's own retention or a thread
 *   that worked in it after the run can be what keeps it.
 * - Otherwise the note says the workspace will be deleted shortly. That
 *   includes a workspace whose `keptUntil` is still null because it was read
 *   before the run ended; the page reads it again once the run ends.
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

  if (run.status === "pending" || run.status === "running") {
    return { ...NOTHING, asksOnCancel: true };
  }
  if (workspace.sessionIds.length > 0) {
    return { ...NOTHING, note: "Workspace in use by a thread" };
  }
  // The controller deletes the workspace at its next sweep, which can be
  // minutes away. No live topic tells an open page when that happens, so the
  // page can show this note for a while after the deletion, and the words
  // must not become wrong then.
  if (
    workspace.keptUntil === null ||
    Date.parse(workspace.keptUntil) <= Date.parse(run.finishedAt)
  ) {
    return { ...NOTHING, note: "Workspace will be deleted shortly" };
  }
  const keptUntil = formatDay(new Date(workspace.keptUntil), timezone);
  return {
    asksOnCancel: false,
    note: keptUntil === undefined ? "Workspace kept" : `Workspace kept until ${keptUntil}`,
    offersDelete: true,
  };
};
