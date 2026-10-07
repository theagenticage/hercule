/** Interprets workspace observations, retention and actions for the clients. */
import type { Runner, Workspace } from "@hercule/contract";
import { describeStartingRevision } from "./starting-revision";
import { formatDay, formatPreciseStamp } from "./time-context";

/** The recorded Git facts for one checkout, with its source described for display. */
export interface WorkspaceCheckoutDetails {
  readonly resourceId: string;
  readonly branch: string | null;
  readonly startingRevision: string | null;
  readonly baseCommit: string | null;
  readonly headCommit: string | null;
}

/** The facts and available actions shown by workspace details and run pages. */
export interface WorkspaceDetails {
  readonly runner: string;
  readonly source: string;
  readonly ownership: string;
  readonly status: string;
  readonly retention: string;
  readonly observation: string | null;
  readonly checkouts: readonly WorkspaceCheckoutDetails[];
  readonly warnings: readonly string[];
  readonly message: string | null;
  readonly activeSessionCount: number;
  readonly actionReason: string | null;
  readonly canRefresh: boolean;
  readonly canDiscard: boolean;
  readonly canDetach: boolean;
}

/** Returns the workspace's retention or removal state without promising that cleanup will succeed. */
const describeWorkspaceRetention = (workspace: Workspace, timezone: string): string => {
  if (workspace.status === "disposing") return "Workspace removal in progress";
  if (workspace.status === "deleted") {
    const day =
      workspace.disposedAt === null
        ? undefined
        : formatDay(new Date(workspace.disposedAt), timezone);
    return day === undefined ? "Workspace deleted" : `Workspace deleted ${day}`;
  }
  if (workspace.message !== null && workspace.status === "ready")
    return workspace.retentionPolicy === "automatic"
      ? "Automatic cleanup stopped; workspace retained"
      : "Manual retention: workspace retained after removal was refused";
  if (workspace.retentionPolicy === "manual") return "Manual retention: workspace kept";
  if (workspace.sessionIds.length > 0) return "Workspace in use by a thread";
  const day =
    workspace.keptUntil === null ? undefined : formatDay(new Date(workspace.keptUntil), timezone);
  return day === undefined ? "Workspace awaits automatic cleanup" : `Workspace kept until ${day}`;
};

/**
 * Returns recorded workspace facts and action eligibility. An observation is
 * always described as the last observation; an offline runner cannot refresh it.
 * Omitting runner records leaves runner availability unknown, as on a run page.
 * The controller checks current holders and permissions when an action is sent.
 */
export const buildWorkspaceDetails = (
  workspace: Workspace,
  { runners, timezone }: { readonly runners: readonly Runner[]; readonly timezone: string },
): WorkspaceDetails => {
  const runner = runners.find((each) => each.id === workspace.runnerId);
  const available =
    runner === undefined || (runner.connectivity === "online" && runner.lifecycle === "active");
  const held = workspace.sessionIds.length > 0;
  const legacySource =
    workspace.ownership === "managed" &&
    workspace.kind === "primary" &&
    workspace.checkouts.some((checkout) => checkout.form === "clone");
  const removable =
    available && !held && (workspace.status === "ready" || workspace.status === "failed");
  return {
    runner: runner?.name ?? workspace.runnerId,
    source: workspace.path ?? "Managed working files",
    ownership: workspace.ownership === "adopted" ? "Adopted checkout" : "Managed workspace",
    status: workspace.status,
    retention: describeWorkspaceRetention(workspace, timezone),
    observation:
      workspace.observedAt === null
        ? null
        : (formatPreciseStamp(new Date(workspace.observedAt), timezone) ?? workspace.observedAt),
    checkouts: workspace.checkouts.map((checkout) => ({
      resourceId: checkout.resourceId,
      branch: checkout.branch,
      startingRevision:
        checkout.startingRevision === null
          ? checkout.baseBranch === null
            ? null
            : `remote branch ${checkout.baseBranch}`
          : describeStartingRevision(checkout.startingRevision),
      baseCommit: checkout.baseCommit,
      headCommit: checkout.headCommit,
    })),
    warnings: workspace.warnings,
    message: workspace.message,
    activeSessionCount: workspace.sessionIds.length,
    actionReason: legacySource
      ? "This legacy checkout contains the source Git repository. Keep it; create a new workspace for separate work."
      : held
        ? "Stop the active threads before removing this workspace"
        : !available
          ? "Reconnect the selected runner before refreshing or removing this workspace"
          : workspace.status === "disposing"
            ? "Wait for the current removal to finish"
            : null,
    canRefresh:
      available &&
      workspace.status !== "deleted" &&
      workspace.status !== "lost" &&
      workspace.status !== "disposing",
    canDiscard: removable && workspace.ownership === "managed" && !legacySource,
    canDetach: removable && workspace.ownership === "adopted",
  };
};
