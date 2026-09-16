/**
 * Workspaces: the provisioned working areas on a machine, the checkouts inside
 * them, and the git credentials the work in them needs.
 *
 * `WorkspaceService` is the whole of the boundary. The rows, how a workspace is
 * laid out and what is written when one is opened are this domain's alone; the
 * one thing other domains read directly is the SQL predicate below, because
 * "the workspace stands" is a question the sessions table asks of this one.
 */
export { gitCredentials, gitIdentityOf, type GitCredential } from "./credentials";
export { readyWhere } from "./repository";
export {
  WorkspaceService,
  WorkspaceServiceLayer,
  WorkspaceSweepInterval,
  type Identified,
  type Opened,
  type QueryInput,
  type Settled,
  type WorkspacePage,
} from "./service";
