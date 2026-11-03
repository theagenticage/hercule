/**
 * Tests `readThreadsCovering`: the Threads for the workspaces asked for are
 * read again when a read already running under the same key was started for
 * other workspaces, and a read that covers them all is not repeated.
 */
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createClient } from "@hercule/client-core";
import { createApiStub, type Answer } from "@hercule/client-core/testing";
import { buildSession } from "@hercule/client-core/threads/testing";
import { cleanupThreadsQuery, readThreadsCovering } from "./machine-storage-queries";
import { CONTROLLER_URL } from "./testing";

const RUNNER_ID = "01a06d02-5000-7000-8000-000000000001";
const WORKSPACE_A = "01a06d02-5000-7000-8000-0000000000a1";
const WORKSPACE_B = "01a06d02-5000-7000-8000-0000000000b1";

const THREAD_IN_B = buildSession({
  id: "01a06d02-5000-7000-8000-0000000000c1",
  permissionProfileId: "01a06d02-5000-7000-8000-000000000900",
  providerAccountId: "01a06d02-5000-7000-8000-000000000901",
  runnerId: RUNNER_ID,
  workspaceId: WORKSPACE_B,
  title: "Thread in B",
});

/**
 * Returns a client over a controller that holds one Thread, in workspace B,
 * and the ids each read of Threads asked for. A read that asks for A alone is
 * held until `release` is called.
 */
const openController = () => {
  const reads: string[][] = [];
  let release: (answer: Answer) => void = () => {};
  const { fetch } = createApiStub({
    "GET /api/v1/sessions": (call) => {
      const ids = new URLSearchParams(call.search).getAll("workspaceId");
      reads.push(ids);
      const items = ids.includes(WORKSPACE_B) ? [THREAD_IN_B] : [];
      if (ids.length === 1 && ids[0] === WORKSPACE_A) {
        return new Promise<Answer>((resolve) => {
          release = resolve;
        });
      }
      return { body: { items } };
    },
  });
  return {
    client: createClient({ baseUrl: CONTROLLER_URL, fetch }),
    reads,
    release: () => {
      release({ body: { items: [] } });
    },
  };
};

describe("readThreadsCovering", () => {
  it("reads again for its own workspaces when it joins a read that was started for fewer", async () => {
    const queryClient = new QueryClient();
    const { client, reads, release } = openController();
    // The Storage section started this read when only workspace A was idle.
    void queryClient.fetchQuery(cleanupThreadsQuery(client, RUNNER_ID, [WORKSPACE_A]));
    await vi.waitFor(() => expect(reads).toHaveLength(1));

    const covering = readThreadsCovering(queryClient, client, RUNNER_ID, [
      WORKSPACE_A,
      WORKSPACE_B,
    ]);
    release();

    expect((await covering).map((thread) => thread.title)).toEqual(["Thread in B"]);
    expect(reads).toEqual([[WORKSPACE_A], [WORKSPACE_A, WORKSPACE_B]]);
  });

  it("reads once when the read it gets already covers its workspaces", async () => {
    const queryClient = new QueryClient();
    const { client, reads } = openController();

    const threads = await readThreadsCovering(queryClient, client, RUNNER_ID, [
      WORKSPACE_A,
      WORKSPACE_B,
    ]);

    expect(threads.map((thread) => thread.title)).toEqual(["Thread in B"]);
    expect(reads).toEqual([[WORKSPACE_A, WORKSPACE_B]]);
  });
});
