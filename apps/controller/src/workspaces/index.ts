/**
 * Workspaces: the provisioned working areas on a machine, the checkouts inside
 * them, the leases the sessions and runs that use them hold, and the git
 * credentials the work in them needs.
 *
 * Other domains go through `WorkspaceService`. The rows, how a workspace is
 * laid out, what is written when one is opened and how long a released lease
 * keeps it belong to this domain alone. Apart from the service, other domains
 * import only:
 *
 * - `buildReadyClause`, the SQL predicate the sessions repository uses in its
 *   queries;
 * - `WorkspaceStepActivity`, the port the runs domain implements so the
 *   credential rule can ask whether a workspace step is running;
 * - the repositories checked out in a session's workspace, and the rules that
 *   choose the repository a Wiki Page or a Discussion is about.
 *
 * Nothing here sends anything to a machine or calls another domain's service.
 * A frame is built as a value and the controller daemon sends it. That keeps
 * the domain graph a DAG: `pnpm dep-lint` fails if an edge back appears.
 */
export {
  gitCredentials,
  githubAccounts,
  WorkspaceStepActivity,
  type GithubAccount,
} from "./credentials";
export {
  listCheckedOutRepositories,
  namesRepository,
  resolveRepository,
  type RepositoryRef,
} from "./checked-out-repositories";
export { requireCheckedOut, validateCheckoutDirectories } from "./layout";
export { buildReadyClause, type Retention, type WorkspaceHolder } from "./repository";
export {
  buildRunBranch,
  buildThreadBranch,
  WorkspaceService,
  WorkspaceServiceLayer,
  type QueryInput,
} from "./service";
