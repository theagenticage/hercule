import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, queryKeys, type HerculeClient, type ThreadCopy } from "@hercule/client-core";
import { buildId, buildThreadCopyFixture } from "./testing-thread-copies";
import { createThreadCopies, type ThreadCopies } from "./thread-copies";
import { buildThreadCopy, useKeepThreadCopy } from "./keep-thread-copy";

const SESSION_ID = buildId(1);

/** Puts the copy's reads into the query cache, as the thread's page leaves them. */
const seedCache = (queryClient: QueryClient, copy: ThreadCopy): void => {
  const id = copy.session.id;
  queryClient.setQueryData(queryKeys.session(id), copy.session);
  queryClient.setQueryData(queryKeys.subagents(id), copy.subagents);
  queryClient.setQueryData(queryKeys.inputs(id), copy.queuedInputs);
  queryClient.setQueryData(queryKeys.transcript(id), copy.transcript);
  for (const [subagentId, rows] of Object.entries(copy.subagentTranscripts)) {
    queryClient.setQueryData(queryKeys.transcript(id, subagentId), rows);
  }
};

describe("buildThreadCopy", () => {
  it("collects the four reads and the transcript of each subagent opened", () => {
    const queryClient = new QueryClient();
    const base = buildThreadCopyFixture(SESSION_ID);
    const copy: ThreadCopy = {
      ...base,
      subagentTranscripts: { a1: base.transcript.slice(0, 1) },
    };
    seedCache(queryClient, copy);
    // Another thread's subagent transcript is not this thread's.
    queryClient.setQueryData(queryKeys.transcript(buildId(2), "a9"), base.transcript);

    expect(buildThreadCopy(queryClient, SESSION_ID)).toEqual(copy);
  });

  it.each([
    ["session", queryKeys.session(SESSION_ID)],
    ["subagents", queryKeys.subagents(SESSION_ID)],
    ["queued inputs", queryKeys.inputs(SESSION_ID)],
    ["transcript", queryKeys.transcript(SESSION_ID)],
  ])("returns undefined when the cache lacks the %s", (_name, key) => {
    const queryClient = new QueryClient();
    seedCache(queryClient, buildThreadCopyFixture(SESSION_ID));
    queryClient.removeQueries({ queryKey: key, exact: true });

    expect(buildThreadCopy(queryClient, SESSION_ID)).toBeUndefined();
  });
});

describe("useKeepThreadCopy", () => {
  /**
   * Renders the hook for `sessionId` over a cache that holds the thread's
   * reads. The controller's session read answers `readSession`, and its token
   * is `token`. The store is real, so a test reads back what was saved, and
   * its `save` and `delete` are spied on.
   */
  const renderSaving = ({
    sessionId = SESSION_ID,
    token = "bearer",
    readSession = () => Promise.reject(new Error("The session was not expected to be read.")),
  }: {
    readonly sessionId?: string;
    readonly token?: string | null;
    readonly readSession?: () => Promise<never>;
  } = {}) => {
    const queryClient = new QueryClient();
    const copy = buildThreadCopyFixture(sessionId);
    seedCache(queryClient, copy);
    const threadCopies: ThreadCopies = createThreadCopies("http://controller.test");
    const save = vi.spyOn(threadCopies, "save");
    const remove = vi.spyOn(threadCopies, "delete");
    const client = {
      getToken: () => token,
      session: { read: readSession },
    } as unknown as HerculeClient;
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook(
      ({ id }) => {
        useKeepThreadCopy({ client, threadCopies }, queryClient, id);
      },
      { wrapper, initialProps: { id: sessionId } },
    );
    return { queryClient, copy, threadCopies, save, remove, ...rendered };
  };

  /** Waits for the saves the hook started to be written. */
  const flushSaves = async (save: {
    readonly mock: { readonly results: ReadonlyArray<{ value: unknown }> };
  }) => {
    await Promise.all(save.mock.results.map((result) => result.value));
  };

  it("saves the copy when the thread's page closes", async () => {
    const { copy, threadCopies, save, unmount } = renderSaving();
    expect(save).not.toHaveBeenCalled();

    unmount();
    await flushSaves(save);

    expect(await threadCopies.read(SESSION_ID)).toEqual(copy);
  });

  it("saves the copy of the thread that was open when the session id changes", async () => {
    const { copy, threadCopies, save, rerender } = renderSaving();

    rerender({ id: buildId(2) });
    await flushSaves(save);

    expect(await threadCopies.read(SESSION_ID)).toEqual(copy);
    expect(await threadCopies.read(buildId(2))).toBeUndefined();
  });

  it("saves nothing while the thread streams, and once when the turn ends", async () => {
    const { queryClient, copy, threadCopies, save } = renderSaving();
    const setStatus = async (status: "busy" | "idle"): Promise<void> => {
      await act(async () => {
        queryClient.setQueryData(queryKeys.session(SESSION_ID), { ...copy.session, status });
        // The query notifies its observers on a timer.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const rows = [...copy.transcript];
    for (let position = 2; position <= 11; position++) {
      rows.push({ ...copy.transcript[0]!, position });
    }

    await setStatus("busy");
    for (let count = 2; count <= rows.length; count++) {
      queryClient.setQueryData(queryKeys.transcript(SESSION_ID), rows.slice(0, count));
    }
    expect(save).not.toHaveBeenCalled();

    await setStatus("idle");
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    await flushSaves(save);
    expect((await threadCopies.read(SESSION_ID))?.transcript).toHaveLength(11);
  });

  it("deletes the copy instead of saving it when the controller says the thread does not exist", async () => {
    const { queryClient, threadCopies, save, remove, unmount } = renderSaving({
      readSession: () => Promise.reject(new ApiError("not_found", "No such session.")),
    });
    await threadCopies.save(buildThreadCopyFixture(SESSION_ID));
    save.mockClear();

    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.session(SESSION_ID) }));
    unmount();

    expect(remove).toHaveBeenCalledWith(SESSION_ID);
    expect(save).not.toHaveBeenCalled();
    expect(await threadCopies.read(SESSION_ID)).toBeUndefined();
  });

  it("saves nothing when the user is signed out", () => {
    const { save, unmount } = renderSaving({ token: null });

    unmount();

    expect(save).not.toHaveBeenCalled();
  });
});
