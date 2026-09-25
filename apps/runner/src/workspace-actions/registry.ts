/**
 * The workspace actions built into this runner. This list is the one record
 * of which workspace actions this runner build implements.
 */
import type { WorkspaceAction } from "./action";
import { gitCommit } from "./git-commit";

const WORKSPACE_ACTIONS: ReadonlyMap<string, WorkspaceAction> = new Map(
  [gitCommit].map((action) => [action.id, action]),
);

/** The ids of every workspace action this runner build implements. */
export const WORKSPACE_ACTION_IDS: ReadonlyArray<string> = [...WORKSPACE_ACTIONS.keys()];

/** Returns the workspace action with this id, or undefined when this runner build does not implement it. */
export const findWorkspaceAction = (actionId: string): WorkspaceAction | undefined =>
  WORKSPACE_ACTIONS.get(actionId);
