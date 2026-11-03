/**
 * Tests `readThreadsForDialog`: each call gets exactly the Threads of the
 * workspaces it asked for, whatever other reads of the same machine are
 * running, and the page's cache entry receives what it read.
 */
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createClient } from "@hercule/client-core";
import { createApiStub, type Answer } from "@hercule/client-core/testing";
import { buildSession } from "@hercule/client-core/threads/testing";
import { cleanupThreadsQuery, readThreadsForDialog } from "./machine-storage-queries";
import { CONTROLLER_URL } from "./testing";

const RUNNER_ID = "01a06d02-5000-7000-8000-000000000001";
const WORKSPACE_A = "01a06d02-5000-7000-8000-0000000000a1";
const WORKSPACE_B = "01a06d02-5000-7000-8000-0000000000b1";
const WORKSPACE_C = "01a06d02-5000-7000-8000-0000000000c2";

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
    // The Storage section started this read when only workspace A was idle.
    void queryClient.fetchQuery(cleanupThreadsQuery(client, RUNNER_ID, [WORKSPACE_A]));
    await vi.waitFor(() => expect(reads).toHaveLength(1));

    const first = readThreadsForDialog(queryClient, client, RUNNER_ID, [WORKSPACE_A, WORKSPACE_B]);
    const second = readThreadsForDialog(queryClient, client, RUNNER_ID, [WORKSPACE_B, WORKSPACE_C]);
    release();

    expect(titles(await first)).toEqual(["Thread in A", "Thread in B"]);
    expect(titles(await second)).toEqual(["Thread in B", "Thread in C"]);
    expect(reads).toEqual([[WORKSPACE_A], [WORKSPACE_A, WORKSPACE_B], [WORKSPACE_B, WORKSPACE_C]]);
  });

  it("writes what it read to the page's entry, with the ids it covers", async () => {
    const queryClient = new QueryClient();
    const { client } = openController();

    await readThreadsForDialog(queryClient, client, RUNNER_ID, [WORKSPACE_B, WORKSPACE_C]);

    const cached = queryClient.getQueryData<{
      workspaceIds: string[];
      threads: { title: string | null }[];
    }>(cleanupThreadsQuery(client, RUNNER_ID, []).queryKey);
    expect(cached?.workspaceIds).toEqual([WORKSPACE_B, WORKSPACE_C]);
    expect(titles(cached?.threads ?? [])).toEqual(["Thread in B", "Thread in C"]);
  });
});
