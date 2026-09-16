/**
 * Workspaces: the provisioned working areas on a machine, the checkouts inside
 * them, and the git credentials the work in them needs.
 *
 * `WorkspaceService` is the whole of the boundary. The rows, how a workspace is
 * laid out and what is written when one is opened are this domain's alone; the
 * only things other domains read directly are the two SQL predicates below,
 * which the workspace sweep is written in and the sessions listing reads back.
 * Nothing here imports another domain's service, so the domain graph has no
 * cycle - `pnpm dep-lint` fails if one appears.
 */
export { gitCredentials, gitIdentityOf, type GitCredential } from "./credentials";
export { readyWhere, resumableWhere } from "./repository";
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
