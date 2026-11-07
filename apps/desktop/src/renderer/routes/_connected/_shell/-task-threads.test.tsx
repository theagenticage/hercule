/**
 * Tests `useTaskThreads` on its own: a start that waits for a read while the
 * user signs out must not start the Thread as the next account. The
 * whole-screen behaviour is in `work.integration.test.tsx`.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { buildCard } from "@hercule/client-core/work/testing";
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
  const spawn = vi.fn(() => Promise.resolve({}));
  const client = {
    getToken: () => token,
    session: { query: sessionQuery, spawn },
    workspace: { read: vi.fn() },
  } as unknown as HerculeClient;
  const say = vi.fn();
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () =>
      useTaskThreads({
        client,
        cards: [CARD],
        openTaskId: CARD.id,
        scrollRef: { current: null },
        say,
        openPane: () => undefined,
        closePane: () => undefined,
      }),
    { wrapper },
  );
  return {
    result,
    spawn,
    say,
    sessionQuery,
    answerSessionRead: (page: unknown) => {
      answerSessionRead(page);
    },
    signOut: () => {
      token = null;
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
});
