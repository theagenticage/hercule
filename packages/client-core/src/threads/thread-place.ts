/**
 * Describes where a thread works, in words a screen reader reads: its
 * project, its workspace, its machine and its branch, each named once.
 */
import type { Workspace } from "@hercule/contract";

/**
 * Returns where a thread works, as one sentence fragment, such as "in
 * webshop, webshop main workspace, on moss, branch main". The parts are, in
 * order:
 *
 * - the project, or "in no project" when `projectName` is `null`;
 * - the workspace: "<repo> main workspace" for a primary workspace,
 *   "workspace <name>" for an ephemeral one, or "no workspace";
 * - the machine, when it is known;
 * - the branch, when it is known and is not the workspace's name. An
 *   ephemeral workspace is named after its branch, so its branch would
 *   otherwise be read twice.
 *
 * `workspace.name` is the name the sidebar shows: the repo's name for a
 * primary workspace, the branch for an ephemeral one.
 */
export const describeThreadPlace = ({
  projectName,
  workspace,
  machine,
  branch,
}: {
  readonly projectName: string | null;
  readonly workspace: { readonly kind: Workspace["kind"]; readonly name: string } | null;
  readonly machine: string | null;
  readonly branch: string | null;
}): string =>
  [
    `in ${projectName ?? "no project"}`,
    workspace === null
      ? "no workspace"
      : workspace.kind === "primary"
        ? `${workspace.name} main workspace`
        : `workspace ${workspace.name}`,
    machine === null ? null : `on ${machine}`,
    branch === null || branch === workspace?.name ? null : `branch ${branch}`,
  ]
    .filter((part) => part !== null)
    .join(", ");
