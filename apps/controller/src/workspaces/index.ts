/**
 * Workspaces: the provisioned working areas on a machine, the checkouts inside
 * them, and the git credentials the work in them needs.
 *
 * `WorkspaceService` is the whole of the boundary. The rows, how a workspace is
 * laid out and what is written when one is opened are this domain's alone; the
 * only things other domains read directly are the two SQL predicates below,
 * which the sessions listing reads back.
 *
 * Nothing here talks to a machine or reaches another domain's service: a frame
 * is built as a value and the controller daemon above sends it, which is what
 * keeps the domain graph a DAG - `pnpm dep-lint` fails if an edge back appears.
 */
export { gitCredentials, gitIdentityOf, type GitCredential } from "./credentials";
export { readyWhere, resumableWhere } from "./repository";
export {
  WorkspaceService,
  WorkspaceServiceLayer,
  type Identified,
  type QueryInput,
} from "./service";
