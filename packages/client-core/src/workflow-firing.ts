import type { Workflow } from "@hercule/contract";

/**
 * Checks whether the controller fires a workflow's triggers, which it does
 * only while the workflow is enabled and valid. Each trigger keeps its own
 * status either way, so a trigger can read as active on a workflow that
 * fires nothing.
 */
export const firesTriggers = (workflow: Pick<Workflow, "enabled" | "invalidSince">): boolean =>
  workflow.enabled && workflow.invalidSince === undefined;
