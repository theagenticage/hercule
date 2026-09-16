/**
 * Workspaces: the provisioned working areas on a machine, the checkouts inside
 * them, and the git credentials the work in them needs.
 */
export { gitCredentials, gitIdentityOf, type GitCredential } from "./credentials";
export { openPrimary, openWorkspace, provisionFrame, type CheckoutPlan } from "./provisioning";
export { workspaceRepository, type StoredWorkspace } from "./repository";
export {
  WorkspaceService,
  WorkspaceServiceLayer,
  WorkspaceSweepInterval,
  type Identified,
  type QueryInput,
  type WorkspacePage,
} from "./service";
