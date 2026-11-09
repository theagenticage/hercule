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
import {
  advanceInboxVisit,
  decideDrawnRiding,
  HOME_GROUPING,
  SHOW_ALL,
} from "@hercule/client-core/inbox";
import {
  buildInbox,
  buildInboxCard,
  buildInboxLink,
  buildRequestCard,
  buildWorkflowOffer,
} from "@hercule/client-core/inbox/testing";
import type { HandOffUndo, Inbox, InboxCard } from "@hercule/contract";
import { useVisitHistory } from "../../../screens/inbox/use-inbox-visit";
import { inboxQuery } from "../../../app/queries";
import {
  installFakeAnimations,
  removeFakeAnimations,
} from "../../../app/motion/testing-animations";
import { openTestAccountScope } from "../../../app/testing-account-scope";
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

const setUp = (
  readInbox: () => Promise<Inbox> = () => Promise.resolve(INBOX),
  cachedInbox: Inbox = INBOX,
  page: HTMLElement | null = null,
) => {
  let token: string | null = "bearer";
  const takes = holdCalls<{ taskId: string; created: boolean }>();
  const dismissals = holdCalls<unknown>();
  const links = holdCalls<unknown>();
  const unlinks = holdCalls<{ removed: boolean; remaining?: "source" | "person" | "text" }>();
  const handOffs = holdCalls<{ runId: string; taskId: string }>();
  // The requests in the order they reach the controller.
  const sent: string[] = [];
  const restore = vi.fn(() => {
    sent.push("restore");
    return Promise.resolve({});
  });
  const undoTakeOn = vi.fn(() => {
    sent.push("undoTakeOn");
    return Promise.resolve({ undone: true });
  });
  const queryInbox = vi.fn(readInbox);
  const undoHandOff = vi.fn((): Promise<HandOffUndo> => {
    sent.push("undoHandOff");
    return Promise.resolve({
      outcome: "undone",
      stopRequested: true,
      taskRemoved: true,
      stageRestored: false,
      failureRestored: false,
    });
  });
  const client = {
    getToken: () => token,
    externalEntity: {
      queryInbox,
      takeOn: () => {
        sent.push("takeOn");
        return takes.call();
      },
      dismiss: () => {
        sent.push("dismiss");
        return dismissals.call();
      },
      link: () => {
        sent.push("link");
        return links.call();
      },
      unlink: () => {
        sent.push("unlink");
        return unlinks.call();
      },
      handOff: () => {
        sent.push("handOff");
        return handOffs.call();
      },
      undoHandOff,
      restore,
      undoTakeOn,
    },
  } as unknown as HerculeClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.inbox(), cachedInbox);
  const { scope, scopes } = openTestAccountScope(client, queryClient);
  const { undoStack } = scope;
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    () => {
      const { data } = useQuery(inboxQuery(client));
      const visit = useVisitHistory();
      const moves = useInboxMoves({
        client,
        scope,
        serverInbox: data,
        visit,
        scrollRef: { current: page },
        isCarrying: () => false,
        openTask: () => undefined,
      });
      // The visit draws the page as the screen does, so the test can ask where each card rides.
      const drawn = advanceInboxVisit(visit.history, {
        received: moves.inbox,
        view: {
          grouping: HOME_GROUPING,
          filter: {},
          requestsGrouping: "none",
          requestsShow: SHOW_ALL,
          requestsSort: "oldest",
        },
        released: new Set(),
        isFresh: true,
        hasUserMove: moves.hasPendingEdits,
        isMotionReduced: () => false,
      });
      if (drawn.history !== visit.history) visit.setHistory(drawn.history);
      const riding =
        moves.inbox === undefined
          ? new Map<string, string>()
          : decideDrawnRiding(moves.inbox.cards, drawn.history.placement);
      return { ...moves, riding };
    },
    { wrapper },
  );
  return {
    ...view,
    takes,
    dismissals,
    links,
    unlinks,
    handOffs,
    undoHandOff,
    restore,
    undoTakeOn,
    // Sign-out: the token goes and the scope closes.
    signOut: () => {
      token = null;
      scopes.close();
    },
    sent,
    queryInbox,
    queryClient,
    undoStack,
  };
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
      result.current.dismiss(B, []);
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
      result.current.dismiss(B, []);
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

describe("the order of requests around Undo", () => {
  it("sends the reversal of a slow Take before a Take made after Undo", async () => {
    const { result, takes, sent } = setUp();
    act(() => {
      result.current.take(A);
    });
    await waitFor(() => {
      expect(takes.calls).toHaveLength(1);
    });
    // Undo is pressed before the first Take has answered, and the card still offers Take.
    act(() => {
      result.current.undoLastMove();
      result.current.take(A);
    });
    await act(async () => {
      takes.calls[0]!.answer({ taskId: "task-a", created: true });
      await settle();
    });
    await waitFor(() => {
      expect(takes.calls).toHaveLength(2);
    });

    expect(sent).toEqual(["takeOn", "undoTakeOn", "takeOn"]);
  });

  it("sends the reversal of a slow dismissal before a dismissal made after Undo", async () => {
    const { result, dismissals, sent } = setUp();
    act(() => {
      result.current.dismiss(A, []);
    });
    await waitFor(() => {
      expect(dismissals.calls).toHaveLength(1);
    });
    act(() => {
      result.current.undoLastMove();
      result.current.dismiss(A, []);
    });
    await act(async () => {
      dismissals.calls[0]!.answer({});
      await settle();
    });
    await waitFor(() => {
      expect(dismissals.calls).toHaveLength(2);
    });

    expect(sent).toEqual(["dismiss", "restore", "dismiss"]);
  });
});

describe("a hand-off", () => {
  const REVIEW = buildWorkflowOffer("Agent review", ["acme/review-requested"]);
  const aim = (card: InboxCard) => ({ ...card, openKinds: card.signals.kinds });

  it("sends neither a queued Undo nor writes a late answer as the next account after the user signed out", async () => {
    const { result, handOffs, undoHandOff, signOut, queryClient, sent } = setUp();
    act(() => {
      result.current.handOff(aim(A), REVIEW, undefined);
    });
    await waitFor(() => {
      expect(handOffs.calls).toHaveLength(1);
    });
    // The user presses Undo while the hand-off is still on its way, then signs out.
    act(() => {
      result.current.undoLastMove();
    });
    signOut();

    await act(async () => {
      handOffs.calls[0]!.answer({ runId: "run-a", taskId: "task-a" });
      await settle();
    });

    expect(undoHandOff).not.toHaveBeenCalled();
    expect(sent).toEqual(["handOff"]);
    expect(
      queryClient.getQueryData<Inbox>(queryKeys.inbox())?.cards.find((card) => card.id === "a")
        ?.taskId,
    ).toBeUndefined();
  });

  it("stops the chain that is playing when the screen goes away, so no mark flies after the user left", () => {
    const played = installFakeAnimations();
    document.documentElement.style.setProperty("--dur-2", "200ms");
    try {
      const overview = document.body.appendChild(document.createElement("a"));
      overview.dataset["motionTarget"] = "overview";
      overview.getBoundingClientRect = () => new DOMRect(8, 96, 200, 30);
      const icon = overview.appendChild(
        document.createElementNS("http://www.w3.org/2000/svg", "svg"),
      );
      icon.getBoundingClientRect = () => new DOMRect(20, 100, 16, 16);
      const page = document.body.appendChild(document.createElement("div"));
      const card = page.appendChild(document.createElement("div"));
      card.dataset["cardId"] = A.id;
      const mark = card.appendChild(document.createElement("span"));
      mark.dataset["handOffMark"] = "";
      mark.getBoundingClientRect = () => new DOMRect(320, 210, 15, 15);
      const { result, unmount } = setUp(() => Promise.resolve(INBOX), INBOX, page);

      act(() => {
        result.current.handOff(aim(A), REVIEW, undefined);
      });
      const flight = played.find((animation) => animation.element.closest(".motion-flights"));
      expect(flight).toBeDefined();
      unmount();
      flight?.finish();

      expect(played.filter((animation) => !animation.isCancelled)).toEqual([]);
      expect(document.querySelector(".motion-flights")).toBeNull();
    } finally {
      removeFakeAnimations();
      document.documentElement.style.removeProperty("--dur-2");
      document.body.replaceChildren();
    }
  });

  it("keeps the Task of a card the hand-off continued when Undo takes back only the stage", async () => {
    const held = buildRequestCard("held", { taskId: "task-held" });
    const opened = buildInbox([held]);
    const { result, handOffs, undoHandOff } = setUp(() => Promise.resolve(opened), opened);
    undoHandOff.mockResolvedValueOnce({
      outcome: "undone",
      stopRequested: true,
      taskRemoved: false,
      stageRestored: true,
      failureRestored: false,
    });
    act(() => {
      result.current.handOff(aim(held), REVIEW, undefined);
    });
    await waitFor(() => {
      expect(handOffs.calls).toHaveLength(1);
    });
    await act(async () => {
      handOffs.calls[0]!.answer({ runId: "run-held", taskId: "task-held" });
      await settle();
    });

    act(() => {
      result.current.undoLastMove();
    });

    await waitFor(() => {
      expect(result.current.line.text).toContain("Took back Agent review");
    });
    expect(result.current.inbox?.cards.find((card) => card.id === "held")?.taskId).toBe(
      "task-held",
    );
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
      result.current.dismiss(A, []);
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

describe("what rides on what after a Link or Unlink", () => {
  const LEAD_A = buildInboxCard("lead-a");
  const LEAD_B = buildInboxCard("lead-b");
  const RIDER = buildRequestCard("rider");
  /**
   * The controller's reads still answer what the page opened with, as when a read raced the move: the
   * visit must keep the card where the user's Link or Unlink put it, whatever that read says.
   */
  const setUpWithStaleRead = (opened: Inbox) => setUp(() => Promise.resolve(opened), opened);
  const names = (to: { readonly ref: string; readonly identifier: string }) => ({
    fromRef: RIDER.ref,
    toRef: to.ref,
    fromName: RIDER.identifier,
    toName: to.identifier,
  });

  it("puts a card on the second lead when the first Link is refused and the second is accepted", async () => {
    const { result, links } = setUpWithStaleRead(buildInbox([LEAD_A, LEAD_B, RIDER]));
    act(() => {
      result.current.link(names(LEAD_A));
    });
    act(() => {
      result.current.link(names(LEAD_B));
    });
    expect(result.current.riding.get(RIDER.id)).toBe(LEAD_A.ref);
    await waitFor(() => {
      expect(links.calls).toHaveLength(1);
    });

    await act(async () => {
      links.calls[0]!.refuse("The ticket is gone");
      await settle();
    });
    await waitFor(() => {
      expect(links.calls).toHaveLength(2);
    });
    await act(async () => {
      links.calls[1]!.answer({});
      await settle();
    });

    expect(result.current.riding.get(RIDER.id)).toBe(LEAD_B.ref);
  });

  it("takes a card off the lead that was accepted when Undo removes that Link, though the Link was planned while another lead held the card", async () => {
    // The read after the Link is still on its way when Undo is pressed, so the page shows the Link
    // the answer wrote into the cache and the card without a lead.
    const { result, links, unlinks } = setUp(
      () => new Promise<Inbox>(() => undefined),
      buildInbox([LEAD_A, LEAD_B, RIDER]),
    );
    act(() => {
      result.current.link(names(LEAD_A));
    });
    act(() => {
      result.current.link(names(LEAD_B));
    });
    await waitFor(() => {
      expect(links.calls).toHaveLength(1);
    });
    await act(async () => {
      links.calls[0]!.refuse("The ticket is gone");
      await settle();
    });
    await waitFor(() => {
      expect(links.calls).toHaveLength(2);
    });
    await act(async () => {
      links.calls[1]!.answer({});
      await settle();
    });
    expect(result.current.riding.get(RIDER.id)).toBe(LEAD_B.ref);

    act(() => {
      result.current.undoLastMove();
    });
    await waitFor(() => {
      expect(unlinks.calls).toHaveLength(1);
    });
    await act(async () => {
      unlinks.calls[0]!.answer({ removed: true });
      await settle();
    });

    expect(result.current.riding.get(RIDER.id)).toBeUndefined();
  });

  it("keeps a card on its lead when Undo removes a Link and a source still reports the pair", async () => {
    const { result, links, unlinks } = setUpWithStaleRead(buildInbox([LEAD_A, RIDER]));
    act(() => {
      result.current.link(names(LEAD_A));
    });
    await waitFor(() => {
      expect(links.calls).toHaveLength(1);
    });
    await act(async () => {
      links.calls[0]!.answer({});
      await settle();
    });
    expect(result.current.riding.get(RIDER.id)).toBe(LEAD_A.ref);

    act(() => {
      result.current.undoLastMove();
    });
    await waitFor(() => {
      expect(unlinks.calls).toHaveLength(1);
    });
    await act(async () => {
      unlinks.calls[0]!.answer({ removed: true, remaining: "source" });
      await settle();
    });

    expect(result.current.riding.get(RIDER.id)).toBe(LEAD_A.ref);
  });

  it("keeps a card on its lead when an Unlink says a source still reports the link, and says so", async () => {
    const riding = { ...RIDER, ridesOn: LEAD_A.ref };
    const link = buildInboxLink(RIDER.ref, LEAD_A.ref, "person");
    const { result, unlinks } = setUpWithStaleRead(buildInbox([LEAD_A, riding], { links: [link] }));
    act(() => {
      result.current.unlink(names(LEAD_A));
    });
    expect(result.current.riding.get(RIDER.id)).toBeUndefined();
    await waitFor(() => {
      expect(unlinks.calls).toHaveLength(1);
    });

    await act(async () => {
      unlinks.calls[0]!.answer({ removed: true, remaining: "source" });
      await settle();
    });

    expect(result.current.riding.get(RIDER.id)).toBe(LEAD_A.ref);
    expect(result.current.line.text).toBe("Link removed. The source still reports the link.");
  });

  it("lets a card stand alone when an Unlink leaves nothing joining the two", async () => {
    const riding = { ...RIDER, ridesOn: LEAD_A.ref };
    const link = buildInboxLink(RIDER.ref, LEAD_A.ref, "person");
    const { result, unlinks } = setUpWithStaleRead(buildInbox([LEAD_A, riding], { links: [link] }));
    act(() => {
      result.current.unlink(names(LEAD_A));
    });
    await waitFor(() => {
      expect(unlinks.calls).toHaveLength(1);
    });

    await act(async () => {
      unlinks.calls[0]!.answer({ removed: true });
      await settle();
    });

    expect(result.current.riding.get(RIDER.id)).toBeUndefined();
    expect(result.current.line.text).toBe("Link removed.");
  });
});
