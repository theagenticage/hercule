/**
 * Tests the Inbox's pane through the rendered app: the asks of a thing as
 * sections, which one is current and how `[` and `]` step between them, an
 * answer that acts on the source being held for eight seconds with Undo,
 * Done, the one quiet line for blocks that cannot be read, and the pane of a
 * selection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildFakeInboxDetail } from "@hercule/client-core/inbox/testing";
import type { EntitySignalLine, InboxThing, Signal } from "@hercule/contract";
import {
  buildErrorBody,
  setVisibility,
  stubElementSize,
  stubIntersectionObserver,
  type Call,
} from "../../../app/testing";
import {
  OUTLINE,
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
  document.querySelector(".sig.is-current-ask .sig-say")?.textContent ?? "";

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
    expect(document.querySelectorAll(".sig.is-open")).toHaveLength(1);
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

    expect(readUndoLine()).toMatch(/Already sent to .*, so it can't be taken back here\./);
  });
});

describe("a reply", () => {
  it("opens its box again with its words when Undo comes after it was sent", async () => {
    const { calls } = await answerWithReturn(false);
    const reply = document.querySelector<HTMLElement>("[data-answer='reply']")!;
    fireEvent.click(reply);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Looks good to me" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(readUndoLine()).toMatch(/^Reply sent to Mei on .*\. Sends in 8s\.$/);
    await pass(HOLD_MS);
    await pass(0);
    expect(callsTo(calls, ACT_REVIEW)[0]!.body).toEqual({
      actionId: "reply",
      text: "Looks good to me",
    });
    expect(screen.queryByRole("textbox")).toBeNull();

    pressUndo();
    await pass(0);
    await pass(0);

    expect(readUndoLine()).toMatch(/Already sent to /);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("Looks good to me");
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
      expect(readUndoLine()).toContain("can't be undone here");
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
