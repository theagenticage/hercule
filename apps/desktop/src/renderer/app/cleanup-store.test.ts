/**
 * Tests `createCleanupStore`: that rows settle only from a read of the
 * workspaces that began after the controller's answer, also when that read
 * is paused (the Mac is offline) or fails, with no timer; that a read which
 * changes nothing draws nothing; that a write with `setQueryData` is not a
 * read and settles nothing; that a refused archive shows a toast when no
 * dialog watches; and that a disposed store drops every answer still on its
 * way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onlineManager, QueryClient } from "@tanstack/react-query";
import { createClient } from "@hercule/client-core";
import {
  buildErrorBody,
  createApiStub,
  type Answer,
  type Call,
} from "@hercule/client-core/testing";
import { buildWorkspace } from "@hercule/client-core/threads/testing";
import type { CleanupPlan, CleanupRow } from "@hercule/client-core/cleanup";
import type { Workspace } from "@hercule/contract";
import { createCleanupStore } from "./cleanup-store";
import { workspacesQuery } from "./queries";
import { CONTROLLER_URL } from "./testing";

const GB = 1e9;
const RUNNER_ID = "01a06d02-a000-7000-8000-000000000004";
const WORKSPACE_ID = "01a06d02-7400-7000-8000-000000000010";
const LAST_USED_AT = "2026-10-10T09:00:00.000Z";
const REMOVED_TOAST = "Removed 1 workspace. 1 GB freed.";

/** Returns the idle workspace of the test in the state `status`, with the reason `message` when it stayed. */
const buildStored = (status: Workspace["status"], message: string | null = null): Workspace =>
  buildWorkspace({
    id: WORKSPACE_ID,
    runnerId: RUNNER_ID,
    kind: "ephemeral",
    status,
    message,
    lastUsedAt: LAST_USED_AT,
  });

const ROW: CleanupRow = {
  workspaceId: WORKSPACE_ID,
  name: "Thread 1",
  sizeBytes: 2 * GB,
  freesBytes: GB,
  sizeText: "2 GB",
  freesText: "1 GB",
  lastUsedText: "3 weeks ago",
  measuringNote: null,
  group: "done",
  expectedLastUsedAt: LAST_USED_AT,
  unarchivedThreadIds: [],
};

const PLAN: CleanupPlan = {
  threadIds: [],
  items: [{ workspaceId: WORKSPACE_ID, expectedLastUsedAt: LAST_USED_AT, freesBytes: GB }],
};

interface World {
  /** What the controller lists as the workspace. A test changes it. */
  workspace: Workspace;
  /** Makes the read of the workspaces answer 500 while true. */
  failReads: boolean;
  /** While true, the removal request waits for `releaseDispose`. */
  holdDispose: boolean;
  releaseDispose: (() => void) | null;
}

/**
 * Builds a store on a stub controller. The shell reads the workspace as it was
 * before the cleanup: it stayed, for an old reason. After that read the
 * controller lists it as being removed.
 */
const buildStore = async () => {
  const world: World = {
    workspace: buildStored("ready", "A process had a file open."),
    failReads: false,
    holdDispose: false,
    releaseDispose: null,
  };
  const api = createApiStub({
    "GET /api/v1/workspaces": (): Answer =>
      world.failReads
        ? { status: 500, body: buildErrorBody("internal", "The controller failed.") }
        : { body: { items: [world.workspace] } },
    "POST /api/v1/workspaces/dispose": async (): Promise<Answer> => {
      if (world.holdDispose) {
        await new Promise<void>((resolve) => {
          world.releaseDispose = resolve;
        });
      }
      return { body: { results: [{ workspaceId: WORKSPACE_ID, outcome: "requested" }] } };
    },
    "POST /api/v1/sessions/archive": () => ({
      status: 409,
      body: buildErrorBody("invalid_state", "Thread 1 started working again."),
    }),
  });
  const client = createClient({ baseUrl: CONTROLLER_URL, fetch: api.fetch });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Mounted, the client resumes paused reads when the Mac comes back online, as the app's does.
  queryClient.mount();
  mounted.push(queryClient);
  await queryClient.fetchQuery(workspacesQuery(client));
  world.workspace = buildStored("disposing");
  const showNotice = vi.fn<(text: string) => void>();
  const store = createCleanupStore({ client, queryClient, showNotice });
  return {
    world,
    calls: api.calls,
    readsBefore: countReads(api.calls),
    queryClient,
    client,
    showNotice,
    store,
  };
};

const mounted: QueryClient[] = [];

/** Counts the reads of the workspaces the controller received. */
const countReads = (calls: readonly Call[]): number =>
  calls.filter((call) => call.method === "GET" && call.path === "/api/v1/workspaces").length;

beforeEach(() => {
  onlineManager.setOnline(true);
});

afterEach(() => {
  for (const queryClient of mounted.splice(0)) queryClient.unmount();
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

describe("createCleanupStore", () => {
  it("does not refuse a row from the old data while the fresh read is paused, and settles from the read that follows", async () => {
    // Query pauses a read while the Mac is offline and reports it as done at once,
    // with the old data. This store's client has Query's default network mode.
    const { world, showNotice, store } = await buildStore();
    onlineManager.setOnline(false);

    store.start(RUNNER_ID, [ROW], PLAN);
    await vi.waitFor(() => {
      expect(store.read(RUNNER_ID)?.kind).toBe("removing");
    });

    // The cache still says "ready" with the old reason. That must not show as a refusal.
    const progress = store.read(RUNNER_ID);
    expect(progress?.kind === "removing" && progress.outcomes.get(WORKSPACE_ID)).toEqual({
      kind: "removing",
    });
    expect(showNotice).not.toHaveBeenCalled();

    world.workspace = buildStored("deleted");
    onlineManager.setOnline(true);

    await vi.waitFor(() => {
      expect(showNotice).toHaveBeenCalledWith(REMOVED_TOAST);
    });
  });

  it("does not settle from a write to the cached workspaces while the fresh read is paused", async () => {
    const { world, queryClient, client, showNotice, store } = await buildStore();
    onlineManager.setOnline(false);
    store.start(RUNNER_ID, [ROW], PLAN);
    await vi.waitFor(() => {
      expect(store.read(RUNNER_ID)?.kind).toBe("removing");
    });

    // A screen that saves a workspace writes the list it holds, which is from before the answer.
    queryClient.setQueryData(workspacesQuery(client).queryKey, [
      buildStored("ready", "A process had a file open."),
    ]);

    const progress = store.read(RUNNER_ID);
    expect(progress?.kind === "removing" && progress.outcomes.get(WORKSPACE_ID)).toEqual({
      kind: "removing",
    });
    expect(showNotice).not.toHaveBeenCalled();

    world.workspace = buildStored("deleted");
    onlineManager.setOnline(true);
    await vi.waitFor(() => {
      expect(showNotice).toHaveBeenCalledWith(REMOVED_TOAST);
    });
  });

  it("keeps the rows removing when the fresh read fails, runs no timer, and settles from the next successful read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const { world, calls, readsBefore, queryClient, client, showNotice, store } =
      await buildStore();
    world.failReads = true;

    store.start(RUNNER_ID, [ROW], PLAN);
    await vi.waitFor(() => {
      expect(countReads(calls)).toBe(readsBefore + 1);
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(countReads(calls)).toBe(readsBefore + 1);
    const progress = store.read(RUNNER_ID);
    expect(progress?.kind === "removing" && progress.outcomes.get(WORKSPACE_ID)).toEqual({
      kind: "removing",
    });

    // What the live connection does on the next `workspace` push.
    world.failReads = false;
    world.workspace = buildStored("deleted");
    void queryClient.refetchQueries({ queryKey: workspacesQuery(client).queryKey });
    await vi.advanceTimersByTimeAsync(0);

    await vi.waitFor(() => {
      expect(showNotice).toHaveBeenCalledWith(REMOVED_TOAST);
    });
  });

  it("settles at once from the fresh read when the controller already lists the workspace as deleted", async () => {
    const { world, showNotice, store } = await buildStore();
    world.workspace = buildStored("deleted");
    store.start(RUNNER_ID, [ROW], PLAN);
    await vi.waitFor(() => {
      expect(showNotice).toHaveBeenCalledWith(REMOVED_TOAST);
    });
  });

  it("draws nothing when a read of the workspaces changes no row", async () => {
    const { calls, readsBefore, queryClient, client, store } = await buildStore();
    store.start(RUNNER_ID, [ROW], PLAN);
    await vi.waitFor(() => {
      expect(store.read(RUNNER_ID)?.kind).toBe("removing");
      expect(countReads(calls)).toBe(readsBefore + 1);
      expect(queryClient.isFetching()).toBe(0);
    });
    const listener = vi.fn();
    store.subscribe(listener);

    // A push about another machine reads the workspaces again, and this one is still being removed.
    await queryClient.refetchQueries({ queryKey: workspacesQuery(client).queryKey });

    expect(countReads(calls)).toBe(readsBefore + 2);
    expect(listener).not.toHaveBeenCalled();
  });

  it("shows the reason as a toast and keeps nothing when the archive is refused with no dialog open", async () => {
    const { showNotice, store } = await buildStore();

    store.start(RUNNER_ID, [ROW], { ...PLAN, threadIds: [WORKSPACE_ID] });

    await vi.waitFor(() => {
      expect(showNotice).toHaveBeenCalledWith("Thread 1 started working again.");
    });
    expect(store.read(RUNNER_ID)).toBeNull();
  });

  it("keeps the refused archive for the dialog that is open", async () => {
    const { showNotice, store } = await buildStore();
    store.watch(RUNNER_ID);

    store.start(RUNNER_ID, [ROW], { ...PLAN, threadIds: [WORKSPACE_ID] });

    await vi.waitFor(() => {
      expect(store.read(RUNNER_ID)?.kind).toBe("stopped");
    });
    expect(showNotice).not.toHaveBeenCalled();
  });

  it("drops the answer of a call that is still on its way when it is disposed", async () => {
    const { world, calls, readsBefore, showNotice, store } = await buildStore();
    world.holdDispose = true;
    store.start(RUNNER_ID, [ROW], PLAN);
    await vi.waitFor(() => {
      expect(world.releaseDispose).not.toBeNull();
    });

    store.dispose();
    world.releaseDispose?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(store.read(RUNNER_ID)).toBeNull();
    expect(showNotice).not.toHaveBeenCalled();
    expect(countReads(calls)).toBe(readsBefore);
  });
});
