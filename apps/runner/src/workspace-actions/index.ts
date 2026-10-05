/**
 * Workspace actions: the Workflow Actions whose code runs on this runner, in
 * a run's workspace, such as `git.commit`. Built into the runner the way
 * provider adapters are; plugins cannot contribute them.
 */
export type { WorkspaceAction, WorkspaceActionContext } from "./action";
export { WorkspaceActionFailed } from "./action";
export { STOP_GRACE, switchCheckoutBranch } from "./git";
export { WORKSPACE_ACTION_IDS, findWorkspaceAction } from "./registry";
