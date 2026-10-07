/**
 * Tests the thread's Request drafts: they outlive the dock that shows them
 * while a keeper keeps the thread, a change to one Request's draft renders
 * only that Request's readers, and they are dropped when the last keeper
 * lets go.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EMPTY_REQUEST_DRAFT } from "@hercule/client-core";
import { useKeepRequestDrafts, useRequestDraft, useShownRequestId } from "./request-drafts";

/** Mounts a keeper of the thread `sessionId`'s drafts. */
const keepThread = (sessionId = "ses_1") =>
  renderHook(() => {
    useKeepRequestDrafts(sessionId);
  });

describe("useRequestDraft", () => {
  it("keeps a draft after its dock unmounts, while the thread is kept", () => {
    const thread = keepThread();
    const dock = renderHook(() => useRequestDraft("ses_1", "r-1"));
    act(() => {
      dock.result.current[1]((draft) => ({ ...draft, answered: true }));
    });
    dock.unmount();

    expect(renderHook(() => useRequestDraft("ses_1", "r-1")).result.current[0].answered).toBe(true);
    thread.unmount();
  });

  it("renders a reader of another Request no more when one Request's draft changes", () => {
    const thread = keepThread();
    const first = renderHook(() => useRequestDraft("ses_1", "r-1"));
    let otherRenders = 0;
    renderHook(() => {
      otherRenders += 1;
      return useRequestDraft("ses_1", "r-2");
    });
    const rendersBefore = otherRenders;
    act(() => {
      first.result.current[1]((draft) => ({ ...draft, shownQuestionIndex: 1 }));
    });

    expect(first.result.current[0].shownQuestionIndex).toBe(1);
    expect(otherRenders).toBe(rendersBefore);
    thread.unmount();
  });

  it("keeps the drafts of different threads apart", () => {
    const first = keepThread("ses_1");
    const second = keepThread("ses_2");
    const dock = renderHook(() => useRequestDraft("ses_1", "r-1"));
    act(() => {
      dock.result.current[1]((draft) => ({ ...draft, answered: true }));
    });

    expect(renderHook(() => useRequestDraft("ses_2", "r-1")).result.current[0]).toBe(
      EMPTY_REQUEST_DRAFT,
    );
    first.unmount();
    second.unmount();
  });

  it("drops every draft of the thread when the thread is left", () => {
    const thread = keepThread();
    const dock = renderHook(() => useRequestDraft("ses_1", "r-1"));
    const shown = renderHook(() => useShownRequestId("ses_1"));
    act(() => {
      dock.result.current[1]((draft) => ({ ...draft, answered: true }));
      shown.result.current[1]("r-2");
    });
    thread.unmount();

    expect(dock.result.current[0]).toBe(EMPTY_REQUEST_DRAFT);
    expect(shown.result.current[0]).toBeUndefined();
  });

  it("keeps the drafts until the last of several keepers lets go", () => {
    const card = keepThread();
    const drawer = keepThread();
    const dock = renderHook(() => useRequestDraft("ses_1", "r-1"));
    act(() => {
      dock.result.current[1]((draft) => ({ ...draft, answered: true }));
    });
    card.unmount();

    expect(dock.result.current[0].answered).toBe(true);
    drawer.unmount();
    expect(dock.result.current[0]).toBe(EMPTY_REQUEST_DRAFT);
  });

  it("drops a change to a thread nobody keeps", () => {
    const dock = renderHook(() => useRequestDraft("ses_1", "r-1"));
    act(() => {
      dock.result.current[1]((draft) => ({ ...draft, answered: true }));
    });

    expect(dock.result.current[0]).toBe(EMPTY_REQUEST_DRAFT);
  });

  it("drops a change made after the thread is left", () => {
    const thread = keepThread();
    const dock = renderHook(() => useRequestDraft("ses_1", "r-1"));
    const changeDraft = dock.result.current[1];
    dock.unmount();
    thread.unmount();
    act(() => {
      changeDraft((draft) => ({ ...draft, answered: true }));
    });
    const again = keepThread();

    expect(renderHook(() => useRequestDraft("ses_1", "r-1")).result.current[0]).toBe(
      EMPTY_REQUEST_DRAFT,
    );
    again.unmount();
  });
});

describe("useShownRequestId", () => {
  it("shares the paged Request between the readers of one thread", () => {
    const thread = keepThread();
    const first = renderHook(() => useShownRequestId("ses_1"));
    const second = renderHook(() => useShownRequestId("ses_1"));
    act(() => {
      first.result.current[1]("r-2");
    });

    expect(second.result.current[0]).toBe("r-2");
    thread.unmount();
  });
});
