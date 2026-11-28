/**
 * Tests the reads of a machine's Storage section: `readThreadsForDialog` gives
 * each call exactly the Threads of the workspaces it asked for, whatever other
 * reads of the same machine are running, and `useIdleWorkspaceThreads` reads
 * the Threads of the idle workspaces once and again only for a workspace the
 * data does not cover.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createClient } from "@hercule/client-core";
import { createApiStub, type Answer } from "@hercule/client-core/testing";
import { buildSession, buildWorkspace } from "@hercule/client-core/threads/testing";
import { DISK_USAGE_CAPABILITY, type Workspace } from "@hercule/contract";
import {
  loadMachineStorage,
  readThreadsForDialog,
  useIdleWorkspaceThreads,
} from "./machine-storage-queries";
import { workspacesQuery } from "./queries";
import { CONTROLLER_URL } from "./testing";

const RUNNER_ID = "01a06d02-5000-7000-8000-000000000001";
const WORKSPACE_A = "01a06d02-5000-7000-8000-0000000000a1";
const WORKSPACE_B = "01a06d02-5000-7000-8000-0000000000b1";
const WORKSPACE_C = "01a06d02-5000-7000-8000-0000000000c2";
const NOW = new Date("2026-11-03T09:00:00.000Z");

/** Returns an ephemeral workspace of the runner that nobody has used for a month. */
const buildIdle = (id: string): Workspace =>
  buildWorkspace({
    id,
    runnerId: RUNNER_ID,
    kind: "ephemeral",
    createdAt: "2026-10-01T09:00:00.000Z",
    lastUsedAt: "2026-10-01T09:00:00.000Z",
  });

/** Returns a Thread in `workspaceId` titled "Thread in <title>". */
const buildThreadIn = (workspaceId: string, title: string, number: number) =>
  buildSession({
    id: `01a06d02-5000-7000-8000-0000000000d${String(number)}`,
    permissionProfileId: "01a06d02-5000-7000-8000-000000000900",
    providerAccountId: "01a06d02-5000-7000-8000-000000000901",
    runnerId: RUNNER_ID,
    workspaceId,
    title: `Thread in ${title}`,
  });

const THREADS = [
  buildThreadIn(WORKSPACE_A, "A", 1),
  buildThreadIn(WORKSPACE_B, "B", 2),
  buildThreadIn(WORKSPACE_C, "C", 3),
];

/**
 * Returns a client over a controller that holds one Thread in each workspace
 * and the ids each read of Threads asked for. A read that asks for A alone is
 * held until `release` is called.
 */
const openController = () => {
  const reads: string[][] = [];
  let release: () => void = () => {};
  const { fetch } = createApiStub({
    "GET /api/v1/sessions": (call) => {
      const ids = new URLSearchParams(call.search).getAll("workspaceId");
      reads.push(ids);
      const items = THREADS.filter((thread) => ids.includes(thread.workspaceId ?? ""));
      if (ids.length === 1 && ids[0] === WORKSPACE_A) {
        return new Promise<Answer>((resolve) => {
          release = () => {
            resolve({ body: { items } });
          };
        });
      }
      return { body: { items } };
    },
  });
  return {
    client: createClient({ baseUrl: CONTROLLER_URL, fetch }),
    reads,
    release: () => {
      release();
    },
  };
};

const titles = (threads: readonly { readonly title: string | null }[]) =>
  threads.map((thread) => thread.title).toSorted();

describe("readThreadsForDialog", () => {
  it("gives each of two overlapping callers exactly its workspaces while a page read is running", async () => {
    const queryClient = new QueryClient();
    const { client, reads, release } = openController();
    queryClient.setQueryData(workspacesQuery(client).queryKey, [buildIdle(WORKSPACE_A)]);
    queryClient.setQueryData(
      ["runner", RUNNER_ID, "negotiated-capabilities"],
      [DISK_USAGE_CAPABILITY],
    );
    // The page's loader started this read when only workspace A was idle.
    void loadMachineStorage(
      queryClient,
      client,
      RUNNER_ID,
      "UTC",
      Promise.resolve({ readAt: NOW.getTime() }),
    );
    await vi.waitFor(() => expect(reads).toHaveLength(1));

    const first = readThreadsForDialog(queryClient, client, RUNNER_ID, [WORKSPACE_A, WORKSPACE_B]);
    const second = readThreadsForDialog(queryClient, client, RUNNER_ID, [WORKSPACE_B, WORKSPACE_C]);
    release();

    expect(titles(await first)).toEqual(["Thread in A", "Thread in B"]);
    expect(titles(await second)).toEqual(["Thread in B", "Thread in C"]);
    expect(reads).toEqual([[WORKSPACE_A], [WORKSPACE_A, WORKSPACE_B], [WORKSPACE_B, WORKSPACE_C]]);
  });
});

describe("useIdleWorkspaceThreads", () => {
  /** Renders the hook over `queryClient`, whose workspaces are `workspaces`. */
  const renderIdleThreads = (
    queryClient: QueryClient,
    client: ReturnType<typeof openController>["client"],
  ) =>
    renderHook(() => useIdleWorkspaceThreads(client, RUNNER_ID, NOW, true), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

  it("uses the Threads a dialog read wrote, without reading again", async () => {
    const queryClient = new QueryClient();
    const { client, reads } = openController();
    queryClient.setQueryData(workspacesQuery(client).queryKey, [
      buildIdle(WORKSPACE_B),
      buildIdle(WORKSPACE_C),
    ]);
    await readThreadsForDialog(queryClient, client, RUNNER_ID, [WORKSPACE_B, WORKSPACE_C]);

    const { result } = renderIdleThreads(queryClient, client);

    expect(result.current.isKnown).toBe(true);
    expect(titles(result.current.threads)).toEqual(["Thread in B", "Thread in C"]);
    expect(reads).toHaveLength(1);
  });

  it("reads nothing when the set shrinks, and once when a workspace the data lacks appears", async () => {
    const queryClient = new QueryClient();
    const { client, reads } = openController();
    queryClient.setQueryData(workspacesQuery(client).queryKey, [
      buildIdle(WORKSPACE_B),
      buildIdle(WORKSPACE_C),
    ]);
    await readThreadsForDialog(queryClient, client, RUNNER_ID, [WORKSPACE_B, WORKSPACE_C]);
    const { result } = renderIdleThreads(queryClient, client);

    queryClient.setQueryData(workspacesQuery(client).queryKey, [buildIdle(WORKSPACE_C)]);
    await waitFor(() => expect(titles(result.current.threads)).toEqual(["Thread in C"]));
    expect(result.current.isKnown).toBe(true);
    expect(reads).toHaveLength(1);

    queryClient.setQueryData(workspacesQuery(client).queryKey, [
      buildIdle(WORKSPACE_B),
      buildIdle(WORKSPACE_C),
      buildIdle(WORKSPACE_A),
    ]);
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[1]).toEqual([WORKSPACE_A, WORKSPACE_B, WORKSPACE_C]);
  });
});
