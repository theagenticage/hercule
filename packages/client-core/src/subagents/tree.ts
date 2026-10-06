/**
 * Arranges a session's subagents by who started whom. A subagent is started
 * by the session's own agent or by another subagent, so the subagents of one
 * session form a tree, and every screen that draws them follows that tree.
 */
import type { Subagent, SubagentId } from "@hercule/contract";

/** One subagent and the subagents it started, oldest first. */
export interface SubagentNode {
  readonly subagent: Subagent;
  readonly children: readonly SubagentNode[];
}

/** Sorts subagents by when they started, oldest first. */
const compareStartedAt = (a: Subagent, b: Subagent): number =>
  Date.parse(a.startedAt) - Date.parse(b.startedAt);

/**
 * Returns the subagents `parentId` started, oldest first. `parentId`
 * undefined returns the ones the session's own agent started.
 */
const listChildren = (
  subagents: readonly Subagent[],
  parentId: SubagentId | undefined,
): readonly Subagent[] =>
  subagents.filter((subagent) => subagent.parentSubagentId === parentId).sort(compareStartedAt);

/**
 * Builds the tree of `subagents`. Its roots are the subagents the session's
 * own agent started, and also any subagent whose parent is not in
 * `subagents`, so no subagent is ever left out. Siblings are sorted by when
 * they started, oldest first.
 */
export const buildSubagentTree = (subagents: readonly Subagent[]): readonly SubagentNode[] => {
  const ids = new Set(subagents.map((subagent) => subagent.id));
  const buildNode = (subagent: Subagent): SubagentNode => ({
    subagent,
    children: listChildren(subagents, subagent.id).map(buildNode),
  });
  return subagents
    .filter(
      (subagent) => subagent.parentSubagentId === undefined || !ids.has(subagent.parentSubagentId),
    )
    .sort(compareStartedAt)
    .map(buildNode);
};

/**
 * Returns the subagents above `subagent`, from the one the session's own
 * agent started down to its parent. `subagent` itself is not in the list.
 * Returns an empty list for a subagent the session's own agent started.
 */
export const listSubagentAncestors = (
  subagent: Subagent,
  subagents: readonly Subagent[],
): readonly Subagent[] => {
  const parent = subagents.find((each) => each.id === subagent.parentSubagentId);
  return parent === undefined ? [] : [...listSubagentAncestors(parent, subagents), parent];
};

/**
 * Returns every subagent below `subagent`, at any depth, in tree order: each
 * child, oldest first, followed by the subagents below that child.
 */
export const listSubagentDescendants = (
  subagent: Subagent,
  subagents: readonly Subagent[],
): readonly Subagent[] =>
  listChildren(subagents, subagent.id).flatMap((child) => [
    child,
    ...listSubagentDescendants(child, subagents),
  ]);
