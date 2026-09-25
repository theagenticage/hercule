/**
 * Workspaces: the provisioned working areas on a machine, the checkouts inside
 * them, and the git credentials the work in them needs.
 *
 * Other domains go through `WorkspaceService`. The rows, how a workspace is
 * laid out and what is written when one is opened belong to this domain alone.
 * Apart from the service, other domains import only the two SQL predicates
 * below, which the sessions repository uses in its queries.
 *
 * Nothing here sends anything to a machine or calls another domain's service.
 * A frame is built as a value and the controller daemon sends it. That keeps
 * the domain graph a DAG: `pnpm dep-lint` fails if an edge back appears.
 */
export { gitCredentials, buildGitIdentity, type GitCredential } from "./credentials";
export { buildReadyClause, buildResumableClause } from "./repository";
export {
  buildRunBranch,
  buildThreadBranch,
  WorkspaceService,
  WorkspaceServiceLayer,
  type QueryInput,
} from "./service";
