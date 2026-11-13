/**
 * Tests the Inbox's keys and moves through the rendered app: walking and
 * selecting, Dismiss with its one Undo, Take on that keeps the row until the
 * list is read again, the hand-off with one workflow and with several, the
 * refusals the undo line says, the keys that do nothing outside the list, the
 * saved-query digits, and the offline refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildWorkflowOffer } from "@hercule/client-core/inbox/testing";
import type { HandOffUndo } from "@hercule/contract";
import {
  buildErrorBody,
  neverAnswer,
  setVisibility,
  stubElementSize,
  stubIntersectionObserver,
  type Call,
} from "../../../app/testing";
import {
  BASKET,
  LOYALTY,
  SLOTS,
  defaultInbox,
  openInbox,
  readQueries,
  request,
  type FakeInbox,
} from "./-inbox.testing";

beforeEach(() => {
  stubIntersectionObserver();
  stubElementSize(400, 600);
});

afterEach(() => {
  cleanup();
  setVisibility("visible");
  localStorage.clear();
});

const BASE = "POST /api/v1/external-entities";
const DISMISS = `${BASE}/dismiss`;
const RESTORE = `${BASE}/restore`;
const takeOnPath = (id: string): string => `${BASE}/${id}/take-on`;
const TAKE_ON_TOGETHER = `${BASE}/take-on`;
const UNDO_TAKE_ON_TOGETHER = `${BASE}/take-on/undo`;
const undoTakeOnPath = (id: string): string => `${BASE}/${id}/take-on/undo`;
const handOffPath = (id: string): string => `${BASE}/${id}/hand-off`;
const RUN_ID = "01a1b576-c999-7000-8000-000000000901";
const TASK_ID = "01a1b576-c999-7000-8000-000000000902";
const UNDO_HAND_OFF = `${BASE}/handoffs/${RUN_ID}/undo`;

const REVIEW = {
  ...buildWorkflowOffer("Review PR", ["acme/review-requested"]),
  workflowId: "01a1b576-c999-7000-8000-000000000801",
};
const REPAIR = {
  ...buildWorkflowOffer("Repair the build", ["acme/checks-failed"]),
  workflowId: "01a1b576-c999-7000-8000-000000000802",
};

/** Returns the calls to `path`, in order. */
const callsTo = (calls: readonly Call[], path: string): readonly Call[] =>
  calls.filter((call) => `${call.method} ${call.path}` === path);

const getRow = (title: string): HTMLElement =>
  screen.getByRole("treeitem", { name: new RegExp(title) });

/** Returns what the undo line says now, with the title it ends on. */
const readUndoLine = (): string =>
  document.querySelector(".ib .undo-line .undo-text")?.textContent ?? "";

const waitForUndoLine = (text: string): Promise<void> =>
  waitFor(() => {
    expect(readUndoLine()).toContain(text);
  });

/** Opens the Inbox with the three review requests, and waits for them to be drawn. */
const open = async (
  change: (inbox: FakeInbox) => void = () => undefined,
  handlers: Parameters<typeof openInbox>[1] = {},
) => {
  const inbox = defaultInbox();
  change(inbox);
  const opened = await openInbox(inbox, handlers);
  await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });
  return { ...opened, inbox, user: userEvent.setup() };
};

describe("walking and selecting", () => {
  it("walks with J and K, moving the focus with the current row", async () => {
    const { user } = await open();

    await user.keyboard("j");
    expect(document.activeElement).toBe(getRow(LOYALTY.title));
    expect(getRow(LOYALTY.title).tabIndex).toBe(0);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(getRow(BASKET.title));
    await user.keyboard("k");
    expect(document.activeElement).toBe(getRow(LOYALTY.title));
  });

  it("extends a range with Shift J, shrinks it back with Shift K, and selects with X", async () => {
    const { user } = await open();

    await user.keyboard("{Shift>}j{/Shift}");
    expect(screen.getByText("selected").parentElement!.textContent).toContain("2");
    await user.keyboard("{Shift>}k{/Shift}");
    expect(screen.getByText("selected").parentElement!.textContent).toContain("1");
    await user.keyboard("x");
    await user.keyboard("{Escape}");
    expect(getRow(SLOTS.title).getAttribute("aria-selected")).toBe("false");
  });

  it("selects everything that is loaded with the select-all key, and clears it with Esc", async () => {
    const { user } = await open();

    await user.keyboard("{Control>}a{/Control}");
    expect(getRow(BASKET.title).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Escape}");
    expect(getRow(BASKET.title).getAttribute("aria-selected")).toBe("false");
  });

  it("does nothing for single keys while the focus is in the rail", async () => {
    const { user, calls } = await open();
    within(screen.getByRole("navigation", { name: "Inbox lists" }))
      .getAllByRole("button")[0]!
      .focus();

    await user.keyboard("ejx");

    expect(callsTo(calls, DISMISS)).toHaveLength(0);
    expect(getRow(SLOTS.title).tabIndex).toBe(0);
    expect(getRow(SLOTS.title).getAttribute("aria-selected")).toBe("false");
  });

  it("picks a saved query with a digit, from the list and from the rail", async () => {
    const { user } = await open();

    await user.keyboard("2");
    await screen.findByRole("heading", { name: "Mine" });
    within(screen.getByRole("navigation", { name: "Inbox lists" }))
      .getAllByRole("button")[0]!
      .focus();
    await user.keyboard("3");
    await screen.findByRole("heading", { name: "Updates" });
    // No eighth place: Triage is not built.
    await user.keyboard("8");
    expect(screen.getByRole("heading", { name: "Updates" })).toBeTruthy();
  });

  it("takes in the arrivals with the dot key", async () => {
    const { user, live, inbox } = await open();
    await waitFor(() => {
      expect(live.readTopics()).toContain("externalEntity");
    });
    const arrival = request(4, "Bump the checkout SDK", "Noa");
    inbox.lists.waits = [SLOTS, LOYALTY, BASKET, arrival];
    act(() => {
      live.pushInvalidation("externalEntity", [arrival.id]);
    });
    await screen.findByRole("button", { name: /1 new/ });

    await user.keyboard(".");

    expect(await screen.findByRole("treeitem", { name: /Bump the checkout SDK/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /1 new/ })).toBeNull();
  });
});

describe("Dismiss", () => {
  it("dismisses the current thing at once, says it with its title last, and Undo puts it back current and focused", async () => {
    const { user, calls } = await open(undefined, {
      [DISMISS]: { body: {} },
      [RESTORE]: { body: {} },
    });

    await user.keyboard("e");

    expect(screen.queryByRole("treeitem", { name: /Cache delivery slot lookups/ })).toBeNull();
    // The next row took the current place and the focus.
    expect(document.activeElement).toBe(getRow(LOYALTY.title));
    await waitForUndoLine("Dismissed");
    expect(readUndoLine()).toBe(`Dismissed: “${SLOTS.title}”`);
    expect(callsTo(calls, DISMISS)[0]?.body).toEqual({ ids: [SLOTS.id] });

    await user.click(
      within(document.querySelector<HTMLElement>(".ib .undo-line")!).getByRole("button", {
        name: /Undo/,
      }),
    );

    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });
    expect(document.activeElement).toBe(getRow(SLOTS.title));
    expect(callsTo(calls, RESTORE)[0]?.body).toEqual({ ids: [SLOTS.id] });
    await waitForUndoLine("Back in your Inbox.");
  });

  it("dismisses a whole selection in one call, with one Undo that restores the same things", async () => {
    const { user, calls } = await open(undefined, {
      [DISMISS]: { body: {} },
      [RESTORE]: { body: {} },
    });

    await user.keyboard("x");
    await user.keyboard("j");
    await user.keyboard("x");
    await user.keyboard("e");

    await waitForUndoLine("Dismissed 2 things");
    expect(callsTo(calls, DISMISS)).toHaveLength(1);
    expect(callsTo(calls, DISMISS)[0]?.body).toEqual({ ids: [SLOTS.id, LOYALTY.id] });
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);

    await user.click(
      within(document.querySelector<HTMLElement>(".ib .undo-line")!).getByRole("button", {
        name: /Undo/,
      }),
    );

    await waitFor(() => {
      expect(screen.getAllByRole("treeitem")).toHaveLength(3);
    });
    expect(callsTo(calls, RESTORE)).toHaveLength(1);
    expect(callsTo(calls, RESTORE)[0]?.body).toEqual({ ids: [SLOTS.id, LOYALTY.id] });
  });

  it("puts the rows back and says why when the controller refuses", async () => {
    const { user } = await open(undefined, {
      [DISMISS]: { status: 500, body: buildErrorBody("internal", "The database is locked.") },
    });

    await user.keyboard("e");

    await waitForUndoLine("was not dismissed, so it is back: The database is locked");
    expect(
      await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ }),
    ).toBeTruthy();
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
  });

  it("moves the focus to the empty state's heading when the last thing leaves", async () => {
    const { user } = await open(
      (inbox) => {
        inbox.lists.waits = [SLOTS];
      },
      { [DISMISS]: { body: {} } },
    );

    await user.keyboard("e");

    const heading = await screen.findByRole("heading", { name: /Nobody waits on you|All clear/ });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
  });

  it("acts on the row whose own button was pressed, and keeps the selection elsewhere", async () => {
    const { user, calls } = await open(undefined, { [DISMISS]: { body: {} } });
    await user.keyboard("x");
    const row = getRow(BASKET.title);

    await user.hover(row);
    await user.click(within(row).getByRole("button", { name: "Dismiss", hidden: true }));

    expect(callsTo(calls, DISMISS)[0]?.body).toEqual({ ids: [BASKET.id] });
    expect(getRow(SLOTS.title).getAttribute("aria-selected")).toBe("true");
  });

  it("acts on the whole selection when the row whose own button was pressed is part of it", async () => {
    const { user, calls } = await open(undefined, { [DISMISS]: { body: {} } });
    await user.keyboard("x");
    await user.keyboard("j");
    await user.keyboard("x");
    const row = getRow(LOYALTY.title);

    await user.hover(row);
    await user.click(within(row).getByRole("button", { name: "Dismiss", hidden: true }));

    expect(callsTo(calls, DISMISS)[0]?.body).toEqual({ ids: [SLOTS.id, LOYALTY.id] });
  });

  it("dismisses a thing again after a new ask brought it back, and sends the second dismissal", async () => {
    const { user, calls, live, inbox } = await open(undefined, { [DISMISS]: { body: {} } });
    await waitFor(() => {
      expect(live.readTopics()).toContain("externalEntity");
    });
    await user.keyboard("e");
    await waitFor(() => {
      expect(callsTo(calls, DISMISS)).toHaveLength(1);
    });
    inbox.lists.waits = [LOYALTY, BASKET];
    const readsBeforePush = readQueries(calls).length;
    act(() => {
      live.pushInvalidation("externalEntity", [SLOTS.id]);
    });
    // The first page that lacks the thing tells the list the controller has taken it out.
    await waitFor(() => {
      expect(readQueries(calls).length).toBeGreaterThan(readsBeforePush);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // The controller takes it back to the list: a newer ask put it there again.
    inbox.lists.waits = [{ ...SLOTS, askCount: 2 }, LOYALTY, BASKET];
    act(() => {
      live.pushInvalidation("externalEntity", [SLOTS.id]);
    });
    await user.click(await screen.findByRole("button", { name: /1 new/ }));
    const row = await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });

    await user.hover(row);
    await user.click(within(row).getByRole("button", { name: "Dismiss", hidden: true }));

    await waitFor(() => {
      expect(callsTo(calls, DISMISS)).toHaveLength(2);
    });
    expect(callsTo(calls, DISMISS)[1]?.body).toEqual({ ids: [SLOTS.id] });
  });
});

describe("the last thing leaving", () => {
  it("plays the sunrise for the user's own move", async () => {
    const { user } = await open(
      (inbox) => {
        inbox.lists.waits = [SLOTS];
      },
      { [DISMISS]: { body: {} } },
    );
    expect(document.querySelector(".ib-em")).toBeNull();

    await user.keyboard("e");

    await screen.findByRole("heading", { name: /Nobody waits on you|All clear/ });
    expect(document.querySelector(".ib-em--rises")).not.toBeNull();
  });

  // Its own test, not a second app opened after the first one: the first app's live connection
  // stays alive until the test ends, and would still be reading from the second app's fake.
  it("draws the sunrise still when the Inbox opens empty", async () => {
    const empty = defaultInbox();
    empty.lists.waits = [];
    await openInbox(empty);
    await screen.findByRole("heading", { name: /Nobody waits on you/ });
    expect(document.querySelector(".ib-em")).not.toBeNull();
    expect(document.querySelector(".ib-em--rises")).toBeNull();
  });

  it("says what waits behind the new pill, instead of drawing nothing, and the focus goes to it", async () => {
    const { user, live, inbox } = await open(
      (fake) => {
        fake.lists.waits = [SLOTS];
      },
      { [DISMISS]: { body: {} } },
    );
    await waitFor(() => {
      expect(live.readTopics()).toContain("externalEntity");
    });
    inbox.lists.waits = [request(4, "Bump the checkout SDK", "Noa"), SLOTS];
    act(() => {
      live.pushInvalidation("externalEntity", [SLOTS.id]);
    });
    await screen.findByRole("button", { name: /1 new/ });

    await user.keyboard("e");

    const heading = await screen.findByRole("heading", { name: "Nothing left here" });
    expect(screen.getByRole("button", { name: /1 new/ })).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    inbox.lists.waits = [request(4, "Bump the checkout SDK", "Noa")];
    await user.click(screen.getByRole("button", { name: /Show what is new/ }));
    await screen.findByRole("treeitem", { name: /Bump the checkout SDK/ });
  });
});

describe("Take on", () => {
  it("keeps the row, moves the current one on at once, and Undo asks the controller to take the Task away", async () => {
    const { user, calls } = await open(undefined, {
      [takeOnPath(SLOTS.id)]: { body: { taskId: TASK_ID, created: true } },
      [undoTakeOnPath(SLOTS.id)]: { body: { undone: true } },
    });

    await user.keyboard("t");

    expect(getRow(SLOTS.title)).toBeTruthy();
    expect(document.activeElement).toBe(getRow(LOYALTY.title));
    await waitForUndoLine("Took on, a Task on Work");
    expect(readUndoLine()).toContain(SLOTS.title);
    expect(callsTo(calls, takeOnPath(SLOTS.id))).toHaveLength(1);

    await user.click(
      within(document.querySelector<HTMLElement>(".ib .undo-line")!).getByRole("button", {
        name: /Undo/,
      }),
    );

    await waitForUndoLine("The Task is gone, and nothing had started.");
    expect(callsTo(calls, undoTakeOnPath(SLOTS.id))[0]?.body).toEqual({ taskId: TASK_ID });
  });

  it("says why an undo is refused, when the Task was touched since", async () => {
    const { user } = await open(undefined, {
      [takeOnPath(SLOTS.id)]: { body: { taskId: TASK_ID, created: true } },
      [undoTakeOnPath(SLOTS.id)]: {
        body: { undone: false, reason: "A thread was started on the Task." },
      },
    });
    await user.keyboard("t");
    await waitForUndoLine("Took on");

    await user.click(
      within(document.querySelector<HTMLElement>(".ib .undo-line")!).getByRole("button", {
        name: /Undo/,
      }),
    );

    await waitForUndoLine("A thread was started on the Task.");
  });

  it("takes a selection of several things on as one Task, and Undo takes back what the call wrote", async () => {
    const result = {
      taskId: TASK_ID,
      created: true,
      added: [SLOTS.id, LOYALTY.id],
      taken: [SLOTS.id, LOYALTY.id],
      takenAt: "2026-11-13T10:00:00.000Z",
    };
    const { user, calls } = await open(undefined, {
      [TAKE_ON_TOGETHER]: { body: result },
      [UNDO_TAKE_ON_TOGETHER]: { body: { undone: true } },
    });
    await user.keyboard("x");
    await user.keyboard("j");
    await user.keyboard("x");

    await user.keyboard("t");

    await waitForUndoLine("Took on, a Task on Work");
    expect(callsTo(calls, TAKE_ON_TOGETHER)[0]?.body).toEqual({
      ids: [SLOTS.id, LOYALTY.id],
      title: SLOTS.title,
    });
    expect(callsTo(calls, takeOnPath(SLOTS.id))).toHaveLength(0);

    await user.click(
      within(document.querySelector<HTMLElement>(".ib .undo-line")!).getByRole("button", {
        name: /Undo/,
      }),
    );

    await waitForUndoLine("The Task is gone, and nothing had started.");
    expect(callsTo(calls, UNDO_TAKE_ON_TOGETHER)[0]?.body).toEqual(result);
  });
});

describe("the hand-off", () => {
  const handable = (inbox: FakeInbox): void => {
    inbox.offerSets = { one: [REVIEW], several: [REVIEW, REPAIR] };
    inbox.lists.waits = [
      { ...SLOTS, offerSetId: "one" },
      { ...LOYALTY, offerSetId: "several" },
      BASKET,
    ];
  };

  it("hands the thing to its one workflow at once, and the current row moves on", async () => {
    const { user, calls } = await open(handable, {
      [handOffPath(SLOTS.id)]: { body: { runId: RUN_ID, taskId: TASK_ID } },
    });

    await user.keyboard("h");

    expect(document.activeElement).toBe(getRow(LOYALTY.title));
    await waitForUndoLine("Handed to Review PR");
    expect(readUndoLine()).toContain(SLOTS.title);
    expect(callsTo(calls, handOffPath(SLOTS.id))[0]?.body).toEqual({
      workflowId: REVIEW.workflowId,
    });
  });

  it("opens the menu of workflows when several fit, and hands on a number key", async () => {
    const { user, calls } = await open(handable, {
      [handOffPath(LOYALTY.id)]: { body: { runId: RUN_ID, taskId: TASK_ID } },
    });
    await user.keyboard("j");

    await user.keyboard("h");

    expect(
      await screen.findByRole("menuitem", { name: /Repair the build/, hidden: true }),
    ).toBeTruthy();
    expect(callsTo(calls, handOffPath(LOYALTY.id))).toHaveLength(0);
    await user.keyboard("2");

    await waitForUndoLine("Handed to Repair the build");
    expect(callsTo(calls, handOffPath(LOYALTY.id))[0]?.body).toEqual({
      workflowId: REPAIR.workflowId,
    });
    expect(document.querySelector(".hand-menu")).toBeNull();
  });

  it("gives the focus back to the current row when the menu is closed with Esc", async () => {
    const { user } = await open(handable);
    await user.keyboard("j");
    await user.keyboard("h");
    await screen.findByRole("menuitem", { name: /Review PR/, hidden: true });

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(document.querySelector(".hand-menu")).toBeNull();
    });
    expect(document.activeElement).toBe(getRow(LOYALTY.title));
  });

  it("refuses a hand-off picked from an open menu when the connection was lost meanwhile", async () => {
    const { user, live, calls } = await open(handable, {
      [handOffPath(LOYALTY.id)]: { body: { runId: RUN_ID, taskId: TASK_ID } },
    });
    await live.waitForFirstPushes();
    await user.keyboard("j");
    await user.keyboard("h");
    await screen.findByRole("menuitem", { name: /Repair the build/, hidden: true });
    act(() => {
      live.drop();
    });
    await screen.findByText(/Offline/);

    await user.keyboard("2");

    await waitForUndoLine("You are offline, so that was not done.");
    expect(callsTo(calls, handOffPath(LOYALTY.id))).toHaveLength(0);
  });

  it("refuses a selection, and a thing no workflow takes, with the reason", async () => {
    const { user, calls } = await open(handable);
    await user.keyboard("j");
    await user.keyboard("j");
    await user.keyboard("h");
    await waitForUndoLine("No workflow can take this ticket yet.");
    await user.keyboard("x");
    await user.keyboard("k");
    await user.keyboard("x");

    await user.keyboard("h");

    await waitForUndoLine("Hand-off takes one thing at a time.");
    expect(callsTo(calls, handOffPath(SLOTS.id))).toHaveLength(0);
  });

  it("offers no hand-off in the pane of a selection of several things, only Take on, Link and Dismiss", async () => {
    const { user, calls } = await open(handable);
    await user.keyboard("x");
    await user.keyboard("j");
    await user.keyboard("x");

    const pane = document.getElementById("inbox-pane")!;
    expect(await within(pane).findByRole("button", { name: "Dismiss all 2" })).toBeTruthy();
    expect(within(pane).getByRole("button", { name: "Take on" })).toBeTruthy();
    expect(within(pane).getByRole("button", { name: "Link all 2" })).toBeTruthy();
    expect(within(pane).queryByRole("button", { name: /Hand to/ })).toBeNull();
    expect(callsTo(calls, handOffPath(SLOTS.id))).toHaveLength(0);
  });

  it.each([
    ["undone", "Took back Review PR. Nothing had started."],
    ["stopped", "Asked Review PR to stop. Anything it already did stays."],
    ["too-late", "Review PR already finished."],
  ] as const)("says what Undo did when the outcome is %s", async (outcome, words) => {
    const undo: HandOffUndo = {
      outcome,
      stopRequested: outcome !== "too-late",
      taskRemoved: outcome === "undone",
      stageRestored: false,
      failureRestored: false,
    };
    const { user } = await open(handable, {
      [handOffPath(SLOTS.id)]: { body: { runId: RUN_ID, taskId: TASK_ID } },
      [UNDO_HAND_OFF]: { body: undo },
    });
    await user.keyboard("h");
    await waitForUndoLine("Handed to Review PR");

    await user.click(
      within(document.querySelector<HTMLElement>(".ib .undo-line")!).getByRole("button", {
        name: /Undo/,
      }),
    );

    await waitForUndoLine(words);
  });

  it("shows the workflow having the thing at once, and puts the row back when the hand-off is refused", async () => {
    const { user } = await open(handable, {
      [handOffPath(SLOTS.id)]: {
        status: 409,
        body: buildErrorBody("invalid_state", "Review PR already works on its Task."),
      },
    });
    expect(getRow(SLOTS.title).getAttribute("aria-label")).not.toContain("Review PR has it");

    await user.keyboard("h");

    await waitForUndoLine("was not handed to Review PR");
    expect(getRow(SLOTS.title).getAttribute("aria-label")).not.toContain("Review PR has it");
  });

  it("draws the row as handed while the controller has not answered", async () => {
    const { user } = await open(handable, {
      [handOffPath(SLOTS.id)]: neverAnswer,
    });

    await user.keyboard("h");

    await waitFor(() => {
      expect(getRow(SLOTS.title).getAttribute("aria-label")).toContain("Review PR has it");
    });
  });

  it("says why the controller refused a hand-off", async () => {
    const { user } = await open(handable, {
      [handOffPath(SLOTS.id)]: {
        status: 409,
        body: buildErrorBody("invalid_state", "Review PR already works on its Task."),
      },
    });

    await user.keyboard("h");

    await waitForUndoLine("was not handed to Review PR: Review PR already works on its Task");
  });
});

describe("Narrow", () => {
  it("opens its menu from the F key, and a press outside closes it", async () => {
    const { user } = await open();

    await user.keyboard("f");

    expect(await screen.findByText("Narrow what the list holds")).toBeTruthy();
    await user.click(document.body);
    await waitFor(() => {
      expect(screen.queryByText("Narrow what the list holds")).toBeNull();
    });
  });
});

describe("Go to its Task, Open at its source and the keys sheet", () => {
  it("refuses Go to its Task for a thing no Task has, and goes to the Task of one that has", async () => {
    const { user, router } = await open((inbox) => {
      inbox.lists.waits = [SLOTS, { ...LOYALTY, taskId: TASK_ID }, BASKET];
    });

    await user.keyboard("g");
    await waitForUndoLine("This has no Task yet. T takes it on.");
    await user.keyboard("j");
    await user.keyboard("g");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/work");
    });
    expect(router.state.location.search).toMatchObject({ task: TASK_ID });
  });

  it("opens the current thing at its source with O, and says when it has no address", async () => {
    const open_ = vi.spyOn(window, "open").mockReturnValue(null);
    const { user } = await open((inbox) => {
      inbox.lists.waits = [SLOTS, { ...LOYALTY, url: "" }, BASKET];
    });

    await user.keyboard("o");
    expect(open_).toHaveBeenCalledWith(SLOTS.url, "_blank", "noreferrer");
    await user.keyboard("j");
    await user.keyboard("o");

    await waitForUndoLine("This has no address to open at its source.");
    expect(open_).toHaveBeenCalledTimes(1);
    open_.mockRestore();
  });

  it("opens the keys with the question mark, lists the Inbox's keys, and closes them with Esc", async () => {
    const { user } = await open();

    await user.keyboard("?");

    const sheet = await screen.findByRole("dialog", { name: "Keys" });
    expect(
      within(sheet).getByText("Dismiss, all of the selection or of the group at once"),
    ).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Keys" })).toBeNull();
    });
  });
});

describe("offline", () => {
  it("refuses every move with the reason and sends nothing", async () => {
    const { user, live, calls } = await open(undefined, { [DISMISS]: { body: {} } });
    await live.waitForFirstPushes();
    act(() => {
      live.drop();
    });
    await screen.findByText(/Offline/);

    await user.keyboard("e");

    await waitForUndoLine("You are offline, so that was not done.");
    expect(callsTo(calls, DISMISS)).toHaveLength(0);
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
  });
});
