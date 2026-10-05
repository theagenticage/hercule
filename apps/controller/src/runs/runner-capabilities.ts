/**
 * Which runners can run a plan's workspace steps. A runner lists at hello
 * the workspace actions its build implements, and whether it runs agent
 * steps; the negotiated list is stored on its row. A run is pinned only to a
 * runner whose list holds every capability the plan needs, so a runner on an
 * older build is never handed a step it cannot run.
 *
 * `run.start` refuses a plan that no runner can run. Pinning fails a run
 * whose only capable runners were retired or reserved after it started, and
 * a run a start trigger started with no capable runner at all. A reserved
 * runner never counts, because a run names no runner and is never pinned to
 * a reserved one. Both use the message `describeMissingCapableRunner`
 * returns, so the user reads the same advice in both places.
 */
import type { WorkflowDefinition } from "@hercule/contract";
import { AGENT_STEPS_CAPABILITY, buildWorkspaceActionCapability } from "@hercule/protocol";
import { runsInWorkspace } from "../plugins";
import type { PlacementCandidate } from "../runners";

/** A capability a plan needs from its runner, and the words that name it for the user. */
interface RequiredCapability {
  readonly capability: string;
  readonly label: string;
}

/**
 * Returns the capabilities a runner needs to run a plan's workspace steps,
 * each once, in step order: one per workspace action the plan's steps use,
 * and `agentSteps` when the plan has an agent step.
 */
export const listRequiredCapabilities = (
  plan: WorkflowDefinition,
): ReadonlyArray<RequiredCapability> => {
  const required = new Map<string, string>();
  for (const step of plan.steps) {
    if (step.kind === "action" && runsInWorkspace(step.action)) {
      required.set(buildWorkspaceActionCapability(step.action), step.action);
    } else if (step.kind === "agent") {
      required.set(AGENT_STEPS_CAPABILITY, "agent steps");
    }
  }
  return [...required].map(([capability, label]) => ({ capability, label }));
};

/** Checks whether a runner negotiated every one of these capabilities at its last hello. */
const offersEveryCapability = (
  candidate: PlacementCandidate,
  required: ReadonlyArray<RequiredCapability>,
): boolean => required.every(({ capability }) => candidate.capabilities.includes(capability));

/**
 * Returns the runners among `candidates` that offer every capability a plan
 * needs, `required` (see `listRequiredCapabilities`). A plan that needs none
 * can run on any of them.
 */
export const listCapableRunners = (
  required: ReadonlyArray<RequiredCapability>,
  candidates: ReadonlyArray<PlacementCandidate>,
): ReadonlyArray<PlacementCandidate> =>
  candidates.filter((candidate) => offersEveryCapability(candidate, required));

/**
 * Returns why no runner among `candidates` offers every capability a plan
 * needs, `required` (see `listRequiredCapabilities`), as a message for the
 * user, or `undefined` when one does. A plan that needs no capability needs
 * no runner, so it always gets `undefined`.
 *
 * The message names the capabilities that no runner offers. When each one
 * is offered by some runner, but no runner offers them all, it names every
 * capability the plan needs, because the combination is what is missing.
 */
export const describeMissingCapableRunner = (
  required: ReadonlyArray<RequiredCapability>,
  candidates: ReadonlyArray<PlacementCandidate>,
): string | undefined => {
  if (required.length === 0) return undefined;
  if (candidates.some((candidate) => offersEveryCapability(candidate, required))) return undefined;
  const offeredByNone = required.filter(
    (needed) => !candidates.some((candidate) => offersEveryCapability(candidate, [needed])),
  );
  const named = offeredByNone.length > 0 ? offeredByNone : required;
  return `No runner can run ${named.map(({ label }) => label).join(" and ")}; update a runner to this version.`;
};
