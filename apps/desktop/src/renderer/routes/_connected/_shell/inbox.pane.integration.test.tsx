/**
 * Tests the Inbox's pane through the rendered app: the asks of a thing as
 * sections, which one is current and how `[` and `]` step between them, an
 * answer that acts on the source being held for eight seconds with Undo,
 * Done, the one quiet line for blocks that cannot be read, and the pane of a
 * selection.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildFakeInboxDetail } from "@hercule/client-core/inbox/testing";
import type { EntitySignalLine, InboxThing, Signal } from "@hercule/contract";
import {
  buildErrorBody,
  holdAnswer,
  setVisibility,
  stubElementSize,
  stubIntersectionObserver,
  type Call,
} from "../../../app/testing";
import {
  BASKET,
  LOYALTY,
  OUTLINE,
  QUERY_PATH,
  SLOTS,
  buildThingId,
  defaultInbox,
  openInbox,
  type FakeInbox,
} from "./-inbox.testing";

beforeEach(() => {
  stubIntersectionObserver();
  stubElementSize(400, 600);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  setVisibility("visible");
  localStorage.clear();
});

const REVIEW_KIND = "acme/review-requested";
const MENTION_KIND = "acme/mentioned";
const REVIEW_ASK = buildThingId(201);
const MENTION_ASK = buildThingId(202);
const ACT_REVIEW = `POST /api/v1/signals/${REVIEW_ASK}/act`;
const MARK_DONE = "POST /api/v1/signals/mark-done";
const HOLD_MS = 8_000;

/** Builds the line a thing's read holds for one of its signals. */
const buildLine = (id: string, kind: string, say: string, createdAt: string): EntitySignalLine => ({
  id,
  kind,
  title: say,
  priority: "normal",
  status: "open",
  createdAt,
  say: { say, tone: "plain" },
  snoozed: false,
  asks: true,
  asker: say.split(" ")[0]!,
});

const REVIEW_LINE = buildLine(
  REVIEW_ASK,
  REVIEW_KIND,
  "Mei asked for your review",
  "2026-11-07T09:00:00.000Z",
);
const MENTION_LINE = buildLine(
  MENTION_ASK,
  MENTION_KIND,
  "Omar mentioned you",
  "2026-11-07T10:00:00.000Z",
);

/** Builds the signal `signal.read` returns: Approve (suggested, acts on the source), Reply, and Done. */
const buildSignal = (id: string, kind: string, title: string): Signal => ({
  id,
  kind,
  origin: { type: "api", actor: "user", eventIds: [], reason: "Test" },
  title,
  priority: "normal",
  blocks: [],
  actions: [
    {
      id: "approve",
      label: "Approve",
      primary: true,
      operation: { op: "acme/pr.approve", input: {} },
      describeLine: [{ kind: "text", text: "Approves the pull request" }],
    },
    {
      id: "reply",
      label: "Reply…",
      operation: { op: "acme/pr.comment", input: { body: "" } },
      field: { name: "body", placeholder: "Write a reply" },
    },
    { id: "done", label: "Done", operation: null },
  ],
  match: {},
  status: "open",
  createdAt: "2026-11-07T09:00:00.000Z",
});

/** Returns the detail of `thing` with `lines` as its open signals. */
const withAsks = (thing: InboxThing, lines: readonly EntitySignalLine[]) => ({
  body: {
    ...buildFakeInboxDetail(thing),
    signals: [...lines],
    openCount: lines.length,
    signalCount: lines.length,
  },
});

/** The handlers of a pane whose first thing holds a review request and a mention. */
const askHandlers = (extra: Record<string, unknown> = {}) => ({
  [`GET /api/v1/external-entities/${SLOTS.id}`]: () => withAsks(SLOTS, [REVIEW_LINE, MENTION_LINE]),
  [`GET /api/v1/external-entities/${SLOTS.id}/blocks`]: { body: { blocks: [] } },
  [`GET /api/v1/signals/${REVIEW_ASK}`]: { body: buildSignal(REVIEW_ASK, REVIEW_KIND, "Review") },
  [`GET /api/v1/signals/${MENTION_ASK}`]: {
    body: buildSignal(MENTION_ASK, MENTION_KIND, "Mention"),
  },
  [ACT_REVIEW]: { body: { ...buildSignal(REVIEW_ASK, REVIEW_KIND, "Review"), status: "resolved" } },
  ...extra,
});

/** Opens the Inbox on `inbox` with the pane's asks, and waits for the current ask's answers. */
const open = async (change: (inbox: FakeInbox) => void = () => undefined, extra = {}) => {
  const inbox = defaultInbox();
  change(inbox);
  const opened = await openInbox(inbox, askHandlers(extra) as Parameters<typeof openInbox>[1]);
  await screen.findByRole("button", { name: /^Approve/ });
  return {
    ...opened,
    inbox,
    user: userEvent.setup(),
  };
};

const callsTo = (calls: readonly Call[], path: string): readonly Call[] =>
  calls.filter((call) => `${call.method} ${call.path}` === path);

/** Returns what the undo line says now. */
const readUndoLine = (): string =>
  document.querySelector(".ib .undo-line .undo-text")?.textContent ?? "";

/** Returns the words of the ask that is current, which is the one that is unfolded. */
const readCurrentAsk = (): string =>
  document.querySelector('#inbox-pane [aria-current="true"] .sig-say')?.textContent ?? "";

/** Returns the heads of the asks that are unfolded. */
const listOpenAsks = (): HTMLElement[] =>
  within(document.getElementById("inbox-pane")!).queryAllByRole("button", { expanded: true });

/** Presses the undo key, directly, because user-event cannot run while the clock is faked. */
const pressUndo = (): void => {
  fireEvent.keyDown(document.body, { key: "z", metaKey: true });
};

/** Lets time pass in the app: the pane's timers and the requests they start. */
const pass = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Opens the review ask as the current one and fakes the app's timers from then on. With `pressReturn`, answers it with Return. */
const answerWithReturn = async (pressReturn = true) => {
  const opened = await open((inbox) => {
    inbox.outline = {
      ...OUTLINE,
      savedQueries: OUTLINE.savedQueries.map((query) =>
        query.id === "waits" ? { ...query, signalKinds: [REVIEW_KIND] } : query,
      ),
    };
  });
  await screen.findByText("Approves the pull request");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // user-event waits on a real timer, which the faked clock never fires: press the key directly.
  if (pressReturn) fireEvent.keyDown(document.body, { key: "Enter" });
  return opened;
};

describe("the asks of a thing", () => {
  it("unfolds the newest ask and fills only its suggested answer", async () => {
    await open();

    expect(readCurrentAsk()).toBe("Omar mentioned you");
    expect(listOpenAsks()).toHaveLength(1);
  });

  it("unfolds the ask of the saved query's kind first", async () => {
    await open((inbox) => {
      inbox.outline = {
        ...OUTLINE,
        savedQueries: OUTLINE.savedQueries.map((query) =>
          query.id === "waits" ? { ...query, signalKinds: [REVIEW_KIND] } : query,
        ),
      };
    });

    expect(readCurrentAsk()).toBe("Mei asked for your review");
  });

  it("steps between the asks with [ and ], and stops at the ends", async () => {
    const { user } = await open();
    expect(readCurrentAsk()).toBe("Omar mentioned you");

    await user.keyboard("]");
    await waitFor(() => {
      expect(readCurrentAsk()).toBe("Mei asked for your review");
    });
    await user.keyboard("]");
    expect(readCurrentAsk()).toBe("Mei asked for your review");
    await user.keyboard("[[");
    await waitFor(() => {
      expect(readCurrentAsk()).toBe("Omar mentioned you");
    });
  });
});

describe("an answer that acts on the source", () => {
  it("is held with Undo on Return, and sent once after eight seconds", async () => {
    const { calls } = await answerWithReturn();

    expect(readUndoLine()).toMatch(/^Approve .* on .*\. Sends in 8s\.$/);
    await pass(HOLD_MS - 1);
    expect(callsTo(calls, ACT_REVIEW)).toHaveLength(0);
    await pass(1);
    expect(callsTo(calls, ACT_REVIEW)).toHaveLength(1);
    expect(callsTo(calls, ACT_REVIEW)[0]!.body).toEqual({ actionId: "approve" });
  });

  it("is cancelled by Undo within the hold, and the thing is current again", async () => {
    const { calls } = await answerWithReturn();
    // The answer is a move: the current row has moved on, and the row stays in the list.
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);

    pressUndo();
    await pass(HOLD_MS);

    expect(callsTo(calls, ACT_REVIEW)).toHaveLength(0);
    expect(readUndoLine()).toContain("Not sent");
    expect(screen.getByRole("treeitem", { name: new RegExp(SLOTS.title) }).tabIndex).toBe(0);
  });

  it("waits while the undo line is held, and sends when it is let go", async () => {
    const { calls } = await answerWithReturn();
    const line = document.querySelector<HTMLElement>(".ib .undo-line")!;

    fireEvent.focusIn(line);
    await pass(HOLD_MS + 4_000);
    expect(callsTo(calls, ACT_REVIEW)).toHaveLength(0);

    fireEvent.focusOut(line);
    await pass(0);
    expect(callsTo(calls, ACT_REVIEW)).toHaveLength(1);
  });

  it("says Undo is too late once the answer was sent", async () => {
    await answerWithReturn();
    await pass(HOLD_MS);
    await pass(0);

    pressUndo();
    await pass(0);

    expect(readUndoLine()).toMatch(
      /^Already sent to (.*), so it can’t be taken back here\. Answer again on \1 if it needs changing\.$/,
    );
  });

  it("does nothing more when Undo is pressed again after the answer was sent", async () => {
    const { calls } = await answerWithReturn();
    await pass(HOLD_MS);
    await pass(0);

    pressUndo();
    await pass(0);

    expect(callsTo(calls, ACT_REVIEW)).toHaveLength(1);
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
  });
});

/** Types `words` into the reply box of the current ask and sends them with the box's own key. */
const sendReply = (words: string): void => {
  fireEvent.click(document.querySelector<HTMLElement>("[data-answer='reply']")!);
  const box = screen.getByRole("textbox");
  fireEvent.change(box, { target: { value: words } });
  fireEvent.keyDown(box, { key: "Enter", metaKey: true });
};

describe("a reply", () => {
  it("opens its box again with its words when Undo takes it back during the hold", async () => {
    const { calls } = await answerWithReturn(false);
    sendReply("Looks good to me");
    expect(readUndoLine()).toMatch(/^Reply to Mei on .*\. Sends in 8s\.$/);
    expect(screen.queryByRole("textbox")).toBeNull();

    pressUndo();
    await pass(0);
    await pass(HOLD_MS);

    expect(callsTo(calls, ACT_REVIEW)).toHaveLength(0);
    expect(readUndoLine()).toBe("Not sent. The ask is open again.");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("Looks good to me");
  });

  it("leaves the box shut when Undo comes after it was sent, and says so", async () => {
    const { calls } = await answerWithReturn(false);
    sendReply("Looks good to me");
    await pass(HOLD_MS);
    await pass(0);
    expect(callsTo(calls, ACT_REVIEW)[0]!.body).toEqual({
      actionId: "reply",
      text: "Looks good to me",
    });

    pressUndo();
    await pass(0);

    expect(readUndoLine()).toMatch(/^Already sent to /);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("Done", () => {
  it("ends the ask at once with signal.markDone and says it cannot be undone here", async () => {
    const { calls, user } = await open(undefined, {
      [MARK_DONE]: { body: { done: [MENTION_ASK], skipped: [] } },
    });

    await user.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => {
      expect(callsTo(calls, MARK_DONE)).toHaveLength(1);
    });
    expect(callsTo(calls, MARK_DONE)[0]!.body).toEqual({ signalIds: [MENTION_ASK] });
    await waitFor(() => {
      expect(readUndoLine()).toContain("can’t be undone here");
    });
  });
});

describe("the blocks of the source", () => {
  it("says so in one quiet line when the source cannot be read, and the asks still answer", async () => {
    await open(undefined, {
      [`GET /api/v1/external-entities/${SLOTS.id}/blocks`]: {
        status: 409,
        body: buildErrorBody("invalid_state", "The source could not be read."),
      },
    });

    expect(await screen.findByText(/couldn't be read just now\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Approve/ })).toBeTruthy();
  });
});

describe("the read of the current ask", () => {
  it("waits until the row has rested, so walking down the list with J reads none of the rows it passes", async () => {
    const passedAsk = buildThingId(203);
    const restedAsk = buildThingId(204);
    const readsOf = (calls: readonly Call[], id: string) =>
      callsTo(calls, `GET /api/v1/signals/${id}`);
    const { calls } = await open(undefined, {
      [`GET /api/v1/external-entities/${LOYALTY.id}`]: () =>
        withAsks(LOYALTY, [
          buildLine(passedAsk, MENTION_KIND, "Omar mentioned you", "2026-11-07T10:00:00.000Z"),
        ]),
      [`GET /api/v1/external-entities/${BASKET.id}`]: () =>
        withAsks(BASKET, [
          buildLine(restedAsk, MENTION_KIND, "Tessa mentioned you", "2026-11-07T10:00:00.000Z"),
        ]),
      [`GET /api/v1/signals/${passedAsk}`]: {
        body: buildSignal(passedAsk, MENTION_KIND, "Mention"),
      },
      [`GET /api/v1/signals/${restedAsk}`]: {
        body: buildSignal(restedAsk, MENTION_KIND, "Mention"),
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    fireEvent.keyDown(document.body, { key: "j" });
    await pass(100);
    fireEvent.keyDown(document.body, { key: "j" });
    await pass(100);

    expect(readsOf(calls, passedAsk)).toHaveLength(0);
    expect(readsOf(calls, restedAsk)).toHaveLength(0);

    await pass(300);

    expect(readsOf(calls, passedAsk)).toHaveLength(0);
    expect(readsOf(calls, restedAsk)).toHaveLength(1);
  });
});

describe("a selection", () => {
  it("shows the pane of the selection for two things, and E dismisses both", async () => {
    const { user, calls } = await open(undefined, {
      "POST /api/v1/external-entities/dismiss": { body: {} },
    });

    await user.keyboard("{Shift>}j{/Shift}");

    const pane = document.getElementById("inbox-pane")!;
    expect(await within(pane).findByText("2 things selected")).toBeTruthy();
    await user.keyboard("e");
    await waitFor(() => {
      expect(callsTo(calls, "POST /api/v1/external-entities/dismiss")).toHaveLength(1);
    });
    expect(
      (callsTo(calls, "POST /api/v1/external-entities/dismiss")[0]!.body as { ids: string[] }).ids,
    ).toHaveLength(2);
  });
});

describe("the asks and blocks of the thing before", () => {
  it("get no answer from Return, and its blocks wait for the new thing's own read", async () => {
    const detail = holdAnswer();
    const { calls, user } = await open(undefined, {
      [`GET /api/v1/external-entities/${LOYALTY.id}`]: detail.handler,
      [`GET /api/v1/external-entities/${LOYALTY.id}/blocks`]: {
        body: { blocks: [{ type: "text", markdown: "Loyalty blocks" }] },
      },
    });

    await user.keyboard("j");
    // The blocks of the new thing arrive while its record is still on its way.
    await waitFor(() => {
      expect(callsTo(calls, `GET /api/v1/external-entities/${LOYALTY.id}/blocks`)).toHaveLength(1);
    });
    await user.keyboard("{Enter}");

    expect(document.querySelector(".ib-pane-content")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("Loyalty blocks")).toBeNull();
    expect(readUndoLine()).not.toMatch(/Approve/);
    expect(callsTo(calls, ACT_REVIEW)).toHaveLength(0);

    detail.answer({ body: buildFakeInboxDetail(LOYALTY) });
    expect(await screen.findByText("Loyalty blocks")).toBeTruthy();
  });
});

describe("Send again", () => {
  it("keeps the saved answer when the answer is refused because the app is offline", async () => {
    // After the drop the controller stays unreachable, so the app cannot reconnect (its first retry
    // comes after one second) between the drop and the click, however slow the machine is.
    let isUnreachable = false;
    const { calls, live, user } = await open(undefined, {
      [ACT_REVIEW]: { status: 409, body: buildErrorBody("invalid_state", "The source said no.") },
      "POST /api/v1/auth/ws-ticket": () =>
        isUnreachable
          ? { status: 503, body: buildErrorBody("unavailable", "The controller is down.") }
          : { body: { ticket: "ws-ticket" } },
    });
    await user.keyboard("]");
    await waitFor(() => {
      expect(readCurrentAsk()).toBe("Mei asked for your review");
    });
    // Approve is the ask's suggested answer: Return holds it, and a failed send leaves it saved.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.keyDown(document.body, { key: "Enter" });
    await pass(HOLD_MS);
    await pass(0);
    vi.useRealTimers();
    await waitFor(() => {
      expect(callsTo(calls, ACT_REVIEW)).toHaveLength(1);
    });
    const failed = await screen.findByRole("alert");
    expect(failed.textContent).toMatch(/was not sent to/);

    isUnreachable = true;
    act(() => {
      live.drop();
    });
    await screen.findByText(/Offline/);
    await user.click(screen.getByRole("button", { name: "Send again" }));

    expect(readUndoLine()).toMatch(/^You are offline, so that was not done\./);
    expect(screen.getByRole("alert").textContent).toMatch(/was not sent to/);
    expect(screen.getByRole("button", { name: "Send again" })).toBeTruthy();
  });
});

describe("an answer that fails after the user dismissed its thing", () => {
  it("leaves the dismissal alone", async () => {
    const markDone = holdAnswer();
    const { calls, user } = await open(undefined, {
      [MARK_DONE]: markDone.handler,
      "POST /api/v1/external-entities/dismiss": { body: {} },
    });
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(callsTo(calls, MARK_DONE)).toHaveLength(1);
    });
    // The answer moved on to the next thing: go back to this one and dismiss it.
    await user.keyboard("k");
    await user.keyboard("e");
    await waitFor(() => {
      expect(screen.getAllByRole("treeitem")).toHaveLength(2);
    });

    markDone.answer({
      status: 409,
      body: buildErrorBody("invalid_state", "The source said no."),
    });

    await waitFor(() => {
      expect(readUndoLine()).toMatch(/was not sent to/);
    });
    expect(screen.queryByRole("treeitem", { name: new RegExp(SLOTS.title) })).toBeNull();
    expect(screen.getAllByRole("treeitem")).toHaveLength(2);
  });
});

describe("O on a selection", () => {
  it("opens nothing and says why", async () => {
    const open$ = vi.spyOn(window, "open").mockReturnValue(null);
    const { user } = await open();
    await user.keyboard("{Shift>}j{/Shift}");
    await within(document.getElementById("inbox-pane")!).findByText("2 things selected");

    await user.keyboard("o");

    expect(open$).not.toHaveBeenCalled();
    expect(readUndoLine()).toMatch(/^O opens one thing\./);
    open$.mockRestore();
  });
});

describe("a folded current ask", () => {
  const THIRD_ASK = buildThingId(203);
  const THIRD_LINE = buildLine(
    THIRD_ASK,
    MENTION_KIND,
    "Tessa mentioned you",
    "2026-11-07T08:00:00.000Z",
  );
  const openWithThree = () =>
    open(undefined, {
      [`GET /api/v1/external-entities/${SLOTS.id}`]: () =>
        withAsks(SLOTS, [REVIEW_LINE, MENTION_LINE, THIRD_LINE]),
      [`GET /api/v1/signals/${THIRD_ASK}`]: { body: buildSignal(THIRD_ASK, MENTION_KIND, "Third") },
    });
  const foldCurrentAsk = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.keyboard("]");
    await waitFor(() => {
      expect(readCurrentAsk()).toBe("Mei asked for your review");
    });
    await user.click(
      document.querySelector<HTMLElement>('#inbox-pane [aria-current="true"] .sig-head')!,
    );
    expect(listOpenAsks()).toHaveLength(0);
  };

  it("is still where ] steps on from", async () => {
    const { user } = await openWithThree();
    await foldCurrentAsk(user);

    await user.keyboard("]");

    await waitFor(() => {
      expect(readCurrentAsk()).toBe("Tessa mentioned you");
    });
    expect(listOpenAsks()).toHaveLength(1);
  });

  it("is unfolded by Return, which answers nothing yet", async () => {
    const { calls, user } = await openWithThree();
    await foldCurrentAsk(user);

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(listOpenAsks()).toHaveLength(1);
    });
    expect(readCurrentAsk()).toBe("Mei asked for your review");
    expect(readUndoLine()).not.toMatch(/Approve/);
    expect(callsTo(calls, ACT_REVIEW)).toHaveLength(0);
  });
});

/** Makes the Inbox's frame report `width`, so a width under 760 stacks the pane over the list. Returns the way back. */
const stubFrameWidth = (width: number): void => {
  const before = globalThis.ResizeObserver;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(): void {
        this.callback([{ contentRect: { width } } as ResizeObserverEntry], this);
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  onTestFinished(() => {
    vi.stubGlobal("ResizeObserver", before);
  });
};

/** The outline whose waits list is about review requests, so the review ask is the current one. */
const reviewOutline = (inbox: FakeInbox): void => {
  inbox.outline = {
    ...OUTLINE,
    savedQueries: OUTLINE.savedQueries.map((query) =>
      query.id === "waits" ? { ...query, signalKinds: [REVIEW_KIND] } : query,
    ),
  };
};

describe("an ask that was folded", () => {
  it("does not keep another ask folded when it becomes the current one", async () => {
    const state = { lines: [REVIEW_LINE, MENTION_LINE] };
    const { live, user } = await open(undefined, {
      [`GET /api/v1/external-entities/${SLOTS.id}`]: () => withAsks(SLOTS, state.lines),
    });
    await user.click(
      document.querySelector<HTMLElement>('#inbox-pane [aria-current="true"] .sig-head')!,
    );
    expect(listOpenAsks()).toHaveLength(0);

    // The folded ask is answered elsewhere and leaves: the ask that takes its place is drawn open.
    state.lines = [REVIEW_LINE];
    act(() => {
      live.pushInvalidation("externalEntity", [SLOTS.id]);
    });

    await waitFor(() => {
      expect(readCurrentAsk()).toBe("Mei asked for your review");
    });
    expect(listOpenAsks()).toHaveLength(1);
  });
});

describe("a stacked pane that is closed", () => {
  it("reads no ask while it is hidden, whatever the keys step to", async () => {
    stubFrameWidth(500);
    const inbox = defaultInbox();
    const { calls } = await openInbox(inbox, askHandlers() as Parameters<typeof openInbox>[1]);
    const user = userEvent.setup();
    await user.keyboard("{Enter}");
    await screen.findByRole("button", { name: /^Approve/ });
    await user.keyboard("{Escape}");

    await user.keyboard("]");

    expect(callsTo(calls, `GET /api/v1/signals/${REVIEW_ASK}`)).toHaveLength(0);
  });
});

describe("an answer that was sent", () => {
  it("shows its ask without answers at once, and reads no list itself", async () => {
    const { calls } = await answerWithReturn();
    const countReads = () =>
      calls.filter(
        (call) =>
          `${call.method} ${call.path}` === QUERY_PATH ||
          call.path === `/api/v1/external-entities/${SLOTS.id}`,
      ).length;
    const before = countReads();

    await pass(HOLD_MS);
    await pass(0);

    expect(callsTo(calls, ACT_REVIEW)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(countReads()).toBe(before);
  });
});

describe("a reply that Undo takes back", () => {
  it("shows the box with its words and the cursor in it when a selection was made during the hold", async () => {
    await answerWithReturn(false);
    sendReply("Looks good to me");
    fireEvent.keyDown(document.body, { key: "j", shiftKey: true });
    await pass(0);
    expect(
      within(document.getElementById("inbox-pane")!).getByText("2 things selected"),
    ).toBeTruthy();

    pressUndo();
    await pass(0);

    const box = screen.getByRole<HTMLTextAreaElement>("textbox");
    expect(box.value).toBe("Looks good to me");
    expect(document.activeElement).toBe(box);
    expect(screen.queryByText("2 things selected")).toBeNull();
  });

  it("opens the pane that lies closed over the list", async () => {
    stubFrameWidth(500);
    const inbox = defaultInbox();
    reviewOutline(inbox);
    await openInbox(inbox, askHandlers() as Parameters<typeof openInbox>[1]);
    const user = userEvent.setup();
    await user.keyboard("{Enter}");
    await screen.findByText("Approves the pull request");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    sendReply("Looks good to me");
    fireEvent.keyDown(document.body, { key: "Escape" });
    const pane = document.getElementById("inbox-pane")!;
    expect(pane.hasAttribute("inert")).toBe(true);

    pressUndo();
    await pass(0);

    const box = screen.getByRole<HTMLTextAreaElement>("textbox");
    expect(pane.hasAttribute("inert")).toBe(false);
    expect(box.value).toBe("Looks good to me");
    expect(document.activeElement).toBe(box);
  });

  it("keeps the words typed in the box when it is closed and opened again", async () => {
    const { user } = await open();
    await user.click(document.querySelector<HTMLElement>("[data-answer='reply']")!);
    await user.type(screen.getByRole("textbox"), "Half a thought");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();

    await user.click(document.querySelector<HTMLElement>("[data-answer='reply']")!);

    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("Half a thought");
  });
});

describe("a selection in the pane", () => {
  it("opens a member alone when its row is pressed", async () => {
    const { user } = await open();
    await user.keyboard("{Shift>}j{/Shift}");
    const pane = document.getElementById("inbox-pane")!;
    await within(pane).findByText("2 things selected");

    await user.click(within(pane).getByRole("button", { name: new RegExp(SLOTS.title) }));

    expect(
      await within(pane).findByRole("heading", { name: new RegExp(SLOTS.title) }),
    ).toBeTruthy();
    expect(within(pane).queryByText("2 things selected")).toBeNull();
  });
});

describe("answers that were not sent", () => {
  const refused = {
    [ACT_REVIEW]: { status: 409, body: buildErrorBody("invalid_state", "The source said no.") },
  };

  it("shows each one whichever ask is current, and offers Send again while its ask is open", async () => {
    const opened = await open((inbox) => reviewOutline(inbox), refused);
    await screen.findByText("Approves the pull request");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.keyDown(document.body, { key: "Enter" });
    await pass(HOLD_MS);
    await pass(0);
    vi.useRealTimers();
    await screen.findByRole("alert");

    await opened.user.keyboard("[[");
    await waitFor(() => {
      expect(readCurrentAsk()).toBe("Omar mentioned you");
    });

    expect(screen.getByRole("alert").textContent).toMatch(/was not sent to/);
    expect(screen.getByRole("button", { name: "Send again" })).toBeTruthy();
  });

  it("offers only Discard, and the words, once its ask is no longer open", async () => {
    const state = { lines: [REVIEW_LINE, MENTION_LINE] };
    const { live, user } = await open(reviewOutline, {
      ...refused,
      [`GET /api/v1/external-entities/${SLOTS.id}`]: () => withAsks(SLOTS, state.lines),
    });
    await screen.findByText("Approves the pull request");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    sendReply("Looks good to me");
    await pass(HOLD_MS);
    await pass(0);
    vi.useRealTimers();
    await screen.findByRole("alert");

    state.lines = [MENTION_LINE];
    act(() => {
      live.pushInvalidation("externalEntity", [SLOTS.id]);
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Send again" })).toBeNull();
    });
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Looks good to me")).toBeTruthy();
    await user.click(within(alert).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
