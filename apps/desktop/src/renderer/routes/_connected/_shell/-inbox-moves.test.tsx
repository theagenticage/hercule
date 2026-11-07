/**
 * Tests the Inbox's moves through `useInboxMoves`: that Undo follows the order
 * of the user's gestures and not the order of the controller's answers, that a
 * move that failed or made no Task leaves the stack, and that an answered move
 * is written into the cached Inbox and then read again, so a read that raced
 * the answer cannot leave the cache without an authoritative read.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import { buildInbox, buildRequestCard } from "@hercule/client-core/inbox/testing";
import type { Inbox } from "@hercule/contract";
import type { CardMover } from "../../../app/card-mover";
import { inboxQuery } from "../../../app/queries";
import { createUndoStack } from "../../../app/undo-stack";
import { useInboxMoves } from "./-inbox-moves";

const A = buildRequestCard("a");
const B = buildRequestCard("b");
const INBOX = buildInbox([A, B]);

/** A request the test answers when it chooses. */
interface Held<Answer> {
  readonly answer: (value: Answer) => void;
  readonly refuse: (message: string) => void;
}

/** Returns a function that answers calls when the test says so, and the calls so far, oldest first. */
function holdCalls<Answer>() {
  const calls: Held<Answer>[] = [];
  const call = (): Promise<Answer> =>
    new Promise<Answer>((resolve, reject) => {
      calls.push({
        answer: resolve,
        refuse: (message) => {
          reject(new Error(message));
        },
      });
    });
  return { calls, call };
}

const setUp = (readInbox: () => Promise<Inbox> = () => Promise.resolve(INBOX)) => {
  const takes = holdCalls<{ taskId: string; created: boolean }>();
  const dismissals = holdCalls<unknown>();
  const restore = vi.fn(() => Promise.resolve({}));
  const undoTakeOn = vi.fn(() => Promise.resolve({ undone: true }));
  const queryInbox = vi.fn(readInbox);
  const client = {
    externalEntity: {
      queryInbox,
      takeOn: takes.call,
      dismiss: dismissals.call,
      restore,
      undoTakeOn,
    },
  } as unknown as HerculeClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.inbox(), INBOX);
  const undoStack = createUndoStack<CardMover>();
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    () => {
      const { data } = useQuery(inboxQuery(client));
      return useInboxMoves({
        client,
        undoStack,
        serverInbox: data,
        scrollRef: { current: null },
      });
    },
    { wrapper },
  );
  return { ...view, takes, dismissals, restore, undoTakeOn, queryInbox, queryClient, undoStack };
};

/** Lets the promises of the queued requests run. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 40; turn++) await Promise.resolve();
};

describe("the order of Undo", () => {
  it("undoes the newest gesture first, even when an older request is still pending", async () => {
    const { result, takes, dismissals, restore, undoTakeOn } = setUp();
    // Take A is sent first and has not answered when the user dismisses B.
    act(() => {
      result.current.take(A);
      result.current.dismiss(B);
    });
    await waitFor(() => {
      expect(takes.calls).toHaveLength(1);
    });

    act(() => {
      result.current.undoLastMove();
    });
    await act(async () => {
      takes.calls[0]!.answer({ taskId: "task-a", created: true });
      await settle();
    });
    await waitFor(() => {
      expect(dismissals.calls).toHaveLength(1);
    });
    await act(async () => {
      dismissals.calls[0]!.answer({});
      await settle();
    });

    await waitFor(() => {
      expect(result.current.line.text).toContain("Put back: Dismissed Review #b");
    });
    expect(restore).toHaveBeenCalledOnce();
    expect(undoTakeOn).not.toHaveBeenCalled();

    act(() => {
      result.current.undoLastMove();
    });
    await waitFor(() => {
      expect(result.current.line.text).toContain("Put back: Took on Review #a");
    });
    expect(undoTakeOn).toHaveBeenCalledOnce();
  });

  it("takes a dismissal that failed off the stack without moving the others", async () => {
    const { result, takes, dismissals, undoTakeOn } = setUp();
    act(() => {
      result.current.take(A);
      result.current.dismiss(B);
    });
    await waitFor(() => {
      expect(takes.calls).toHaveLength(1);
    });
    await act(async () => {
      takes.calls[0]!.answer({ taskId: "task-a", created: true });
      await settle();
    });
    await waitFor(() => {
      expect(dismissals.calls).toHaveLength(1);
    });
    await act(async () => {
      dismissals.calls[0]!.refuse("Not allowed.");
      await settle();
    });

    act(() => {
      result.current.undoLastMove();
    });

    await waitFor(() => {
      expect(result.current.line.text).toContain("Put back: Took on Review #a");
    });
    expect(undoTakeOn).toHaveBeenCalledOnce();
  });

  it("gives up the place of a Take that made no Task", async () => {
    const { result, takes } = setUp();
    act(() => {
      result.current.take(A);
    });
    await waitFor(() => {
      expect(takes.calls).toHaveLength(1);
    });
    await act(async () => {
      takes.calls[0]!.answer({ taskId: "task-a", created: false });
      await settle();
    });

    act(() => {
      result.current.undoLastMove();
    });

    await waitFor(() => {
      expect(result.current.line.text).toBe("Nothing to undo.");
    });
  });
});

describe("an answered move", () => {
  it("is written into the cache, and the Inbox is read again after it", async () => {
    // The read the controller's push started is still running when the answer arrives.
    let reads = 0;
    let finishFirstRead: (inbox: Inbox) => void = () => {};
    const { result, dismissals, queryInbox, queryClient } = setUp(() => {
      reads += 1;
      return reads === 1
        ? new Promise<Inbox>((resolve) => {
            finishFirstRead = resolve;
          })
        : Promise.resolve(buildInbox([B]));
    });
    act(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox() });
    });
    await waitFor(() => {
      expect(queryInbox).toHaveBeenCalledOnce();
    });
    act(() => {
      result.current.dismiss(A);
    });
    await waitFor(() => {
      expect(dismissals.calls).toHaveLength(1);
    });

    await act(async () => {
      dismissals.calls[0]!.answer({});
      await settle();
    });
    // A late answer of the cancelled read must not put the card back.
    finishFirstRead(INBOX);

    await waitFor(() => {
      expect(queryInbox).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(queryClient.getQueryState(queryKeys.inbox())?.isInvalidated).toBe(false);
      expect(queryClient.getQueryData<Inbox>(queryKeys.inbox())?.cards.map((c) => c.id)).toEqual([
        "b",
      ]);
    });
  });
});
