/**
 * Tests the thread's Request drafts: they outlive the dock that shows them,
 * a change to one Request's draft renders only that Request's readers, and
 * they are dropped when their Request closes or the thread is left.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_REQUEST_DRAFT } from "@hercule/client-core";
import type { SessionRequest } from "@hercule/contract";
import { useRequestDraft, useShownRequestId, useThreadRequestDrafts } from "./thread-drafts";

// The session id of the thread route the hooks are drawn in; undefined
// stands for a page drawn outside it, as in the Office's thread drawer.
let routeSessionId: string | undefined = "ses_1";

vi.mock("@tanstack/react-router", () => ({
  useMatch: ({ select }: { select: (match: { params: { sessionId: string } }) => string }) =>
    routeSessionId === undefined ? undefined : select({ params: { sessionId: routeSessionId } }),
}));

afterEach(() => {
  routeSessionId = "ses_1";
});

const buildRequest = (requestId: string): SessionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "ls" },
});

const OPEN_REQUESTS = [buildRequest("r-1"), buildRequest("r-2")];

describe("useRequestDraft", () => {
  it("keeps a draft after its dock unmounts, while the thread keeps its drafts", () => {
    const thread = renderHook(() => {
      useThreadRequestDrafts("ses_1", OPEN_REQUESTS);
    });
    const dock = renderHook(() => useRequestDraft("r-1"));
    act(() => {
      dock.result.current[1]((draft) => ({ ...draft, answered: true }));
    });
    dock.unmount();

    expect(renderHook(() => useRequestDraft("r-1")).result.current[0].answered).toBe(true);
    thread.unmount();
  });

  it("renders a reader of another Request no more when one Request's draft changes", () => {
    const thread = renderHook(() => {
      useThreadRequestDrafts("ses_1", OPEN_REQUESTS);
    });
    const first = renderHook(() => useRequestDraft("r-1"));
    let otherRenders = 0;
    renderHook(() => {
      otherRenders += 1;
      return useRequestDraft("r-2");
    });
    const rendersBefore = otherRenders;
    act(() => {
      first.result.current[1]((draft) => ({ ...draft, shownQuestionIndex: 1 }));
    });

    expect(first.result.current[0].shownQuestionIndex).toBe(1);
    expect(otherRenders).toBe(rendersBefore);
    thread.unmount();
  });

  it("drops the draft of a Request once it is no longer open", () => {
    const thread = renderHook(
      ({ openRequests }) => {
        useThreadRequestDrafts("ses_1", openRequests);
      },
      { initialProps: { openRequests: OPEN_REQUESTS } },
    );
    const first = renderHook(() => useRequestDraft("r-1"));
    const second = renderHook(() => useRequestDraft("r-2"));
    act(() => {
      first.result.current[1]((draft) => ({ ...draft, answered: true }));
      second.result.current[1]((draft) => ({ ...draft, answered: true }));
    });
    thread.rerender({ openRequests: [buildRequest("r-2")] });

    expect(first.result.current[0]).toBe(EMPTY_REQUEST_DRAFT);
    expect(second.result.current[0].answered).toBe(true);
    thread.unmount();
  });

  it("drops every draft of the thread when the thread is left", () => {
    const thread = renderHook(() => {
      useThreadRequestDrafts("ses_1", OPEN_REQUESTS);
    });
    const dock = renderHook(() => useRequestDraft("r-1"));
    const shown = renderHook(() => useShownRequestId());
    act(() => {
      dock.result.current[1]((draft) => ({ ...draft, answered: true }));
      shown.result.current[1]("r-2");
    });
    thread.unmount();

    expect(dock.result.current[0]).toBe(EMPTY_REQUEST_DRAFT);
    expect(shown.result.current[0]).toBeUndefined();
  });

  it("keeps the draft in the caller's own state where no layout keeps the thread's drafts", () => {
    const dock = renderHook(() => useRequestDraft("r-1"));
    act(() => {
      dock.result.current[1]((draft) => ({ ...draft, answered: true }));
    });

    expect(dock.result.current[0].answered).toBe(true);
    expect(renderHook(() => useRequestDraft("r-1")).result.current[0]).toBe(EMPTY_REQUEST_DRAFT);
  });

  it("drops a change made after the thread is left", () => {
    const thread = renderHook(() => {
      useThreadRequestDrafts("ses_1", OPEN_REQUESTS);
    });
    const dock = renderHook(() => useRequestDraft("r-1"));
    const changeDraft = dock.result.current[1];
    dock.unmount();
    thread.unmount();
    act(() => {
      changeDraft((draft) => ({ ...draft, answered: true }));
    });
    renderHook(() => {
      useThreadRequestDrafts("ses_1", OPEN_REQUESTS);
    });

    expect(renderHook(() => useRequestDraft("r-1")).result.current[0]).toBe(EMPTY_REQUEST_DRAFT);
  });

  it("keeps the draft in the caller's own state outside a thread's route", () => {
    routeSessionId = undefined;
    const dock = renderHook(() => useRequestDraft("r-1"));
    act(() => {
      dock.result.current[1]((draft) => ({ ...draft, answered: true }));
    });

    expect(dock.result.current[0].answered).toBe(true);
    expect(renderHook(() => useRequestDraft("r-1")).result.current[0]).toBe(EMPTY_REQUEST_DRAFT);
  });
});

describe("useShownRequestId", () => {
  it("shares the paged Request between the readers of one thread", () => {
    const thread = renderHook(() => {
      useThreadRequestDrafts("ses_1", OPEN_REQUESTS);
    });
    const first = renderHook(() => useShownRequestId());
    const second = renderHook(() => useShownRequestId());
    act(() => {
      first.result.current[1]("r-2");
    });

    expect(second.result.current[0]).toBe("r-2");
    thread.unmount();
  });
});
