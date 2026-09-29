/**
 * Reads the projects, workspaces and resources again when a change in the
 * thread list shows that the cache no longer holds them all.
 *
 * Those three lists have no live topic, so the thread list, which does, is
 * the only sign that one of them changed. `decideRelatedReads` in client-core
 * holds the rules; this module compares each thread list with the one before.
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { decideRelatedReads, queryKeys } from "@hercule/client-core";
import type { Project, Session, Workspace } from "@hercule/contract";
import { invalidateWithoutCancelling } from "./live-invalidation";

/**
 * Compares `threads` with the thread list of the calling component's previous
 * render, and reads again the lists `decideRelatedReads` names:
 *
 * - the projects;
 * - the workspaces, together with the resources, because a main workspace's
 *   label is its repo's name.
 *
 * Call it once, in the component that reads the thread list for the sidebar,
 * with the three lists it reads. The first render compares with no previous
 * list, so an id the loader's reads did not find is read once.
 */
export const useRelatedReads = (
  threads: readonly Session[],
  projects: readonly Project[],
  workspaces: readonly Workspace[],
): void => {
  const queryClient = useQueryClient();
  const previousThreads = useRef<readonly Session[] | undefined>(undefined);

  useEffect(() => {
    const reads = decideRelatedReads(previousThreads.current, threads, projects, workspaces);
    previousThreads.current = threads;
    if (reads.projects) invalidateWithoutCancelling(queryClient, queryKeys.projects());
    if (reads.workspaces) {
      invalidateWithoutCancelling(queryClient, queryKeys.workspaces());
      invalidateWithoutCancelling(queryClient, queryKeys.resources());
    }
  }, [threads, projects, workspaces, queryClient]);
};
