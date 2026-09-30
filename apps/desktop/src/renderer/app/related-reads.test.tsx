/**
 * Tests `useRelatedReads`: which of the projects, workspaces and resources it
 * reads again as the thread list changes. The rules themselves are tested in
 * client-core (`decideRelatedReads`); these tests check that the hook compares
 * each list with the one before and reads each list once, not on every
 * render.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { queryKeys } from "@hercule/client-core";
import { buildSession, buildWorkspace } from "@hercule/client-core/threads/testing";
import type { Project, Session, Workspace } from "@hercule/contract";
import { useRelatedReads } from "./related-reads";

const KNOWN = buildWorkspace({ id: "ws-known" });
const NEW = buildWorkspace({ id: "ws-new" });

const inKnownWorkspace = buildSession({ id: "s-1", workspaceId: KNOWN.id });
const inNewWorkspace = buildSession({ id: "s-2", workspaceId: NEW.id });

/** The query observers the current test made, removed after it. */
const observers: Array<() => void> = [];

afterEach(() => {
  for (const unsubscribe of observers.splice(0)) unsubscribe();
});

/**
 * Returns a query cache that holds the three related lists, each with a
 * screen reading it, so an invalidation reads it again. Also returns how many
 * times each list was read.
 */
const buildRelatedCache = () => {
  const queryClient = new QueryClient();
  const reads = { projects: 0, workspaces: 0, resources: 0 };
  for (const list of ["projects", "workspaces", "resources"] as const) {
    const queryKey = queryKeys[list]();
    queryClient.setQueryData(queryKey, []);
    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn: () => {
        reads[list] += 1;
        return Promise.resolve([]);
      },
      staleTime: Infinity,
    });
    observers.push(observer.subscribe(() => {}));
  }
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { reads, wrapper };
};

interface Lists {
  readonly threads: readonly Session[];
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
}

const NO_LISTS: Lists = { threads: [], projects: [], workspaces: [] };

describe("useRelatedReads", () => {
  it("reads the workspaces and resources once when a thread appears in a workspace the cache does not hold", async () => {
    const { reads, wrapper } = buildRelatedCache();
    const { rerender } = renderHook(
      ({ threads, projects, workspaces }: Lists) => {
        useRelatedReads(threads, projects, workspaces);
      },
      { wrapper, initialProps: { threads: [inKnownWorkspace], projects: [], workspaces: [KNOWN] } },
    );
    expect(reads).toEqual({ projects: 0, workspaces: 0, resources: 0 });

    rerender({ threads: [inNewWorkspace, inKnownWorkspace], projects: [], workspaces: [KNOWN] });
    await waitFor(() => {
      expect(reads).toEqual({ projects: 0, workspaces: 1, resources: 1 });
    });

    // The thread list changes again before the workspace list holds the new
    // workspace. The previous list already named it, so it is not read again.
    const busy: Session = { ...inNewWorkspace, status: "busy" };
    rerender({ threads: [busy, inKnownWorkspace], projects: [], workspaces: [KNOWN] });
    // The new workspace list arrives: nothing new to read.
    rerender({ threads: [busy, inKnownWorkspace], projects: [], workspaces: [KNOWN, NEW] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toEqual({ projects: 0, workspaces: 1, resources: 1 });
  });

  it("reads the projects when a thread names a project the cache does not hold", async () => {
    const { reads, wrapper } = buildRelatedCache();
    const { rerender } = renderHook(
      ({ threads, projects, workspaces }: Lists) => {
        useRelatedReads(threads, projects, workspaces);
      },
      { wrapper, initialProps: NO_LISTS },
    );

    rerender({
      threads: [buildSession({ id: "s-3", projectId: "p-new" })],
      projects: [],
      workspaces: [],
    });
    await waitFor(() => {
      expect(reads).toEqual({ projects: 1, workspaces: 0, resources: 0 });
    });
  });
});
