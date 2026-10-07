/** Describes a run's workspace retention and removal without predicting successful cleanup. */
import type { Run, Workspace } from "@hercule/contract";
import { buildWorkspaceDetails } from "./workspace-details";

/** The note and actions shown about the run's workspace. */
export interface RunWorkspaceReading {
  /** Whether cancelling this run offers a retention choice for an automatic workspace. */
  readonly asksOnCancel: boolean;
  readonly note: string | undefined;
  /** Whether no active holder prevents an explicit managed-workspace removal. */
  readonly offersDelete: boolean;
}

const NOTHING: RunWorkspaceReading = { asksOnCancel: false, note: undefined, offersDelete: false };

/**
 * Returns the run page's retention note and actions, with dates in `timezone`.
 * Manual retention survives the run. A refused cleanup remains visible until
 * an explicit removal, and a pending removal never offers another request.
 */
export const describeRunWorkspace = (
  run: Run,
  workspace: Workspace | undefined,
  timezone: string,
): RunWorkspaceReading => {
  if (workspace?.kind !== "ephemeral" || workspace.status === "lost") return NOTHING;
  const details = buildWorkspaceDetails(workspace, { runners: [], timezone });
  if (workspace.status === "deleted" || workspace.status === "disposing")
    return { ...NOTHING, note: details.retention };
  if (run.status === "pending" || run.status === "running")
    return { ...NOTHING, asksOnCancel: workspace.retentionPolicy === "automatic" };
  if (workspace.sessionIds.length > 0) return { ...NOTHING, note: "Workspace in use by a thread" };
  const due =
    workspace.retentionPolicy === "automatic" &&
    workspace.message === null &&
    (workspace.keptUntil === null || Date.parse(workspace.keptUntil) <= Date.parse(run.finishedAt));
  return {
    asksOnCancel: false,
    note:
      workspace.message !== null
        ? `${details.retention}: ${workspace.message}`
        : due
          ? "Automatic cleanup is due; workspace remains until removal succeeds"
          : details.retention,
    offersDelete: details.canDiscard,
  };
};
