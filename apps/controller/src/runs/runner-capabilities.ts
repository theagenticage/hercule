/**
 * Which runners can run a plan's workspace actions. A runner lists the
 * workspace actions its build implements at hello, and the negotiated list is
 * stored on its row. A run is pinned only to a runner whose list holds every
 * workspace action in the plan, so a runner on an older build is never handed
 * a step it cannot run.
 *
 * `run.start` refuses a plan that no runner can run. Pinning fails a run
 * whose only capable runners were retired or reserved after it started, and
 * a run a start trigger started with no capable runner at all. A reserved
 * runner never counts, because a run names no runner and is never pinned to
 * a reserved one. Both use the message `describeMissingCapableRunner`
 * returns, so the user reads the same advice in both places.
 */
import type { WorkflowDefinition } from "@hercule/contract";
import { buildWorkspaceActionCapability } from "@hercule/protocol";
import { runsInWorkspace } from "../plugins";
import type { PlacementCandidate } from "../runners";

/** Returns the ids of the workspace actions a plan's steps use, each once, in step order. */
export const listWorkspaceActionIds = (plan: WorkflowDefinition): ReadonlyArray<string> => [
  ...new Set(
    plan.steps.flatMap((step) =>
      step.kind === "action" && runsInWorkspace(step.action) ? [step.action] : [],
    ),
  ),
];

/** Checks whether a runner negotiated every one of these workspace actions at its last hello. */
const offersEveryAction = (
  candidate: PlacementCandidate,
  actionIds: ReadonlyArray<string>,
): boolean =>
  actionIds.every((actionId) =>
    candidate.capabilities.includes(buildWorkspaceActionCapability(actionId)),
  );

/**
 * Returns the runners among `candidates` that can run every one of a plan's
 * workspace actions, `actionIds` (see `listWorkspaceActionIds`). A plan with
 * no workspace action can run on any of them.
 */
export const listCapableRunners = (
  actionIds: ReadonlyArray<string>,
  candidates: ReadonlyArray<PlacementCandidate>,
): ReadonlyArray<PlacementCandidate> =>
  candidates.filter((candidate) => offersEveryAction(candidate, actionIds));

/**
 * Returns why no runner among `candidates` can run a plan's workspace
 * actions, `actionIds` (see `listWorkspaceActionIds`), as a message for the
 * user, or `undefined` when one can. A plan with no workspace action needs no
 * runner, so it always gets `undefined`.
 *
 * The message names the plan's workspace actions that no runner offers. When
 * each one is offered by some runner, but no runner offers them all, it names
 * every workspace action in the plan, because the combination is what is
 * missing.
 */
export const describeMissingCapableRunner = (
  actionIds: ReadonlyArray<string>,
  candidates: ReadonlyArray<PlacementCandidate>,
): string | undefined => {
  if (actionIds.length === 0) return undefined;
  if (candidates.some((candidate) => offersEveryAction(candidate, actionIds))) return undefined;
  const offeredByNone = actionIds.filter(
    (actionId) => !candidates.some((candidate) => offersEveryAction(candidate, [actionId])),
  );
  const named = offeredByNone.length > 0 ? offeredByNone : actionIds;
  return `No runner can run ${named.join(" and ")}; update a runner to this version.`;
};
