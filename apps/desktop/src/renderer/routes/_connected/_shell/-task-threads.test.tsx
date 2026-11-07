/**
 * Tests `useTaskThreads` on its own: a start that waits for a read while the
 * user signs out must not start the Thread as the next account. The
 * whole-screen behaviour is in `work.integration.test.tsx`.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import { buildCard } from "@hercule/client-core/work/testing";
import { openTestAccountScope } from "../../../app/testing-account-scope";
import { useTaskThreads } from "./-task-threads";

const CARD = buildCard("task-1", { title: "Label the pallets" });

const setUp = () => {
  let token: string | null = "token-1";
  let answerSessionRead: (page: unknown) => void = () => undefined;
  const sessionQuery = vi.fn(
    () =>
      new Promise((resolve) => {
        answerSessionRead = resolve;
      }),
  );
  let answerSpawn: () => void = () => undefined;
  const spawn = vi.fn(
    () =>
      new Promise((resolve) => {
        answerSpawn = () => {
          resolve({});
        };
      }),
  );
  let answerMove: () => void = () => undefined;
  const moveToTask = vi.fn(
    () =>
      new Promise((resolve) => {
        answerMove = () => {
          resolve({});
        };
      }),
  );
  const client = {
    getToken: () => token,
    session: { query: sessionQuery, spawn, moveToTask },
    workspace: { read: vi.fn() },
  } as unknown as HerculeClient;
  const say = vi.fn();
  const queryClient = new QueryClient();
  // Reads in the cache, so that a request that reads again has something to invalidate.
  queryClient.setQueryData(queryKeys.workBoard(), {});
  queryClient.setQueryData(queryKeys.taskDetail(CARD.id), {});
  const { scope, scopes } = openTestAccountScope(client, queryClient);
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () =>
      useTaskThreads({
        client,
        scope,
        cards: [CARD],
        readCard: () => CARD,
        openTaskId: CARD.id,
        scrollRef: { current: null },
        say,
        openPane: () => undefined,
        closePane: () => undefined,
      }),
    { wrapper },
  );
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  return {
    result,
    spawn,
    moveToTask,
    invalidate,
    say,
    answerSpawn: () => {
      answerSpawn();
    },
    answerMove: () => {
      answerMove();
    },
    sessionQuery,
    answerSessionRead: (page: unknown) => {
      answerSessionRead(page);
    },
    signOut: () => {
      token = null;
    },
    /** Closes the scope as the router does at sign-out, while the token is still held. */
    closeScope: () => {
      scopes.close();
    },
  };
};

describe("useTaskThreads", () => {
  it("starts nothing, and says nothing, when the user signed out while the workspace was being read", async () => {
    const { result, spawn, say, sessionQuery, answerSessionRead, signOut } = setUp();
    act(() => {
      result.current.changes.onSendThreadPrompt("Check the labels");
    });
    await waitFor(() => {
      expect(sessionQuery).toHaveBeenCalledTimes(1);
    });

    signOut();
    await act(() => {
      answerSessionRead({ items: [] });
      return new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it("says nothing and reads nothing when the user signed out while the Thread was starting", async () => {
    const {
      result,
      spawn,
      say,
      invalidate,
      sessionQuery,
      answerSessionRead,
      answerSpawn,
      closeScope,
    } = setUp();
    act(() => {
      result.current.changes.onSendThreadPrompt("Check the labels");
    });
    await waitFor(() => {
      expect(sessionQuery).toHaveBeenCalledTimes(1);
    });
    act(() => {
      answerSessionRead({ items: [] });
    });
    await waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    closeScope();
    await act(() => {
      answerSpawn();
      return new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(say).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("says nothing and reads nothing when the user signed out while a Thread was moving to a new Task", async () => {
    const { result, moveToTask, say, invalidate, answerMove, closeScope } = setUp();
    act(() => {
      result.current.changes.onMoveThreadToNewTask("session-1");
    });
    await waitFor(() => {
      expect(moveToTask).toHaveBeenCalledTimes(1);
    });

    closeScope();
    await act(() => {
      answerMove();
      return new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(say).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("says that the Thread moved, and reads again, while the user is still signed in", async () => {
    const { result, moveToTask, say, invalidate, answerMove } = setUp();
    act(() => {
      result.current.changes.onMoveThreadToNewTask("session-1");
    });
    await waitFor(() => {
      expect(moveToTask).toHaveBeenCalledTimes(1);
    });
    await act(() => {
      answerMove();
      return new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(say).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalled();
  });
});
