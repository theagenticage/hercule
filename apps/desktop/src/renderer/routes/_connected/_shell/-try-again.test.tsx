/**
 * Tests `useTryAgain` on its own: what a Try again does when the user signs
 * out while it is on its way, and which request an Undo lets go of. The
 * whole-screen behaviour is in `work.integration.test.tsx`.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { Gesture } from "../../../app/undo-stack";
import type { CardMover } from "../../../app/card-mover";
import { openTestAccountScope } from "../../../app/testing-account-scope";
import { isTryAgainStarting, useTryAgain, type FailedCard } from "./-try-again";

const failedCard = (runId: string): FailedCard => ({
  id: "task-1",
  title: "Refund emails",
  failure: { runId, workflowName: "Review PR", cause: "the branch changed" },
});

/** A request the test answers when it chooses. */
interface HeldRerun {
  readonly runId: string;
  readonly accept: (newRunId: string) => void;
  readonly refuse: () => void;
}

const setUp = () => {
  let token: string | null = "token-1";
  const reruns: HeldRerun[] = [];
  const client = {
    getToken: () => token,
    run: {
      rerun: ({ params }: { params: { id: string } }) =>
        new Promise((resolve, reject) => {
          reruns.push({
            runId: params.id,
            accept: (runId) => {
              resolve({ runId });
            },
            refuse: () => {
              reject(new Error("The runner is away."));
            },
          });
        }),
    },
    task: { undoTryAgain: () => Promise.resolve({ outcome: "restored", stopRequested: false }) },
  } as unknown as HerculeClient;
  const queryClient = new QueryClient();
  const { scope, scopes } = openTestAccountScope(client, queryClient);
  const gestures: Gesture<CardMover>[] = [];
  const sayWithoutUndo = vi.fn();
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () =>
      useTryAgain(client, scope, {
        sayWithUndo: (_text, gesture) => {
          gestures.push(gesture);
          return () => undefined;
        },
        sayWithoutUndo,
        onStarted: () => undefined,
        onUndone: () => undefined,
      }),
    { wrapper },
  );
  return {
    tryAgain: result.current,
    reruns,
    queryClient,
    gestures,
    sayWithoutUndo,
    signOut: () => {
      token = null;
    },
    closeScope: () => {
      scopes.close();
    },
  };
};

describe("useTryAgain", () => {
  it("offers no Undo for a run that started after the user signed out", async () => {
    const { tryAgain, reruns, gestures, signOut, queryClient } = setUp();
    act(() => {
      tryAgain(failedCard("run-1"));
    });
    await waitFor(() => {
      expect(reruns).toHaveLength(1);
    });

    signOut();
    await act(() => {
      reruns[0]!.accept("run-2");
      return Promise.resolve();
    });
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });

    expect(gestures).toHaveLength(0);
  });

  it("says nothing of a refusal that came after the user signed out", async () => {
    const { tryAgain, reruns, signOut, sayWithoutUndo, queryClient } = setUp();
    act(() => {
      tryAgain(failedCard("run-1"));
    });
    await waitFor(() => {
      expect(reruns).toHaveLength(1);
    });

    signOut();
    await act(() => {
      reruns[0]!.refuse();
      return Promise.resolve();
    });
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });

    expect(sayWithoutUndo).not.toHaveBeenCalled();
  });

  it("keeps the lock of a newer press when the Undo of an older one finishes", async () => {
    const { tryAgain, reruns, gestures, queryClient } = setUp();
    act(() => {
      tryAgain(failedCard("run-1"));
    });
    await waitFor(() => {
      expect(reruns).toHaveLength(1);
    });
    await act(() => {
      reruns[0]!.accept("run-2");
      return Promise.resolve();
    });
    await waitFor(() => {
      expect(gestures).toHaveLength(1);
    });
    // The new run failed too, and the user tries that one again.
    act(() => {
      tryAgain(failedCard("run-2"));
    });
    await waitFor(() => {
      expect(reruns).toHaveLength(2);
    });

    await act(() => gestures[0]!.undo({} as CardMover));

    expect(isTryAgainStarting(queryClient, "task-1", "run-2")).toBe(true);
  });
});
