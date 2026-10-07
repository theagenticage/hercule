/**
 * Decides which of the lists the sidebar's labels come from to read again
 * when the thread list changes. Projects, workspaces and resources have no
 * live topic, so a change in the thread list is the only sign that one of
 * them is out of date: a thread in a new project, in a new workspace, or in a
 * workspace that is still being set up.
 */
import type { Project, Session, Workspace } from "@hercule/contract";

/** Which lists to read again. */
export interface RelatedReads {
  readonly projects: boolean;
  /**
   * Whether to read the workspace list again, and the resource list with it,
   * because a main workspace's label uses its repo's name.
   */
  readonly workspaces: boolean;
}

/**
 * Checks whether a thread names an id that is not in `listed` and that the
 * previous thread list did not name. An id the previous list named already had
 * its chance to be read: a deleted project is never listed again, although its
 * threads keep its id, so reading the list on every change would not bring it
 * back.
 */
const namesNewUnlistedId = (
  threads: readonly Session[],
  previous: readonly Session[] | undefined,
  readId: (thread: Session) => string | null,
  listed: ReadonlySet<string>,
): boolean => {
  const namedBefore = new Set(previous?.map(readId));
  return threads.some((thread) => {
    const id = readId(thread);
    return id !== null && !listed.has(id) && !namedBefore.has(id);
  });
};

/**
 * Returns which lists to read again after the thread list changed from
 * `previous` to `threads`. `previous` is `undefined` for the first list.
 *
 * - The projects, when a thread names a project the projects list does not
 *   hold, and the previous thread list did not name it.
 * - The workspaces and resources, when a thread names a workspace the
 *   workspaces list does not hold (with the same exception). Known workspaces
 *   update through their own live topic.
 */
export const decideRelatedReads = (
  previous: readonly Session[] | undefined,
  threads: readonly Session[],
  projects: readonly Project[],
  workspaces: readonly Workspace[],
): RelatedReads => ({
  projects: namesNewUnlistedId(
    threads,
    previous,
    (thread) => thread.projectId,
    new Set(projects.map((each) => each.id)),
  ),
  workspaces: namesNewUnlistedId(
    threads,
    previous,
    (thread) => thread.workspaceId,
    new Set(workspaces.map((each) => each.id)),
  ),
});
