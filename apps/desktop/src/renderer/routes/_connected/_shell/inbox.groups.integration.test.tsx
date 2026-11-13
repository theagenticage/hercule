/**
 * Tests groups of linked things in the Inbox through the rendered app: a group
 * draws closed and opens with the right arrow, E dismisses a whole group in
 * one call with one Undo, T takes it on as one Task, L links a selection and
 * its Undo unlinks only the pairs that call wrote, and H refuses a group.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { answerFakeInboxQuery } from "@hercule/client-core/inbox/testing";
import type { InboxGroup, InboxQuery, InboxReply } from "@hercule/contract";
import {
  setVisibility,
  stubElementSize,
  stubIntersectionObserver,
  type Call,
} from "../../../app/testing";
import {
  BASKET,
  LOYALTY,
  QUERY_PATH,
  SLOTS,
  defaultInbox,
  openInbox,
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
const TAKE_ON_TOGETHER = `${BASE}/take-on`;
const UNDO_TAKE_ON_TOGETHER = `${BASE}/take-on/undo`;
const LINK = `${BASE}/links`;
const UNLINK = `${BASE}/links/remove`;
const TASK_ID = "01a1b576-c999-7000-8000-000000000902";

/** Slots and Loyalty are linked; Basket stands alone. */
const GROUP: InboxGroup = {
  labelRef: SLOTS.ref,
  label: SLOTS.title,
  members: [
    { id: SLOTS.id, ref: SLOTS.ref, matches: true },
    { id: LOYALTY.id, ref: LOYALTY.ref, matches: true },
  ],
  size: 2,
};

/** Answers a read as the controller would, with `GROUP` named in every reply that holds its members. */
const answerGrouped = (inbox: FakeInbox, call: Call): { body: InboxReply } => {
  const reply = answerFakeInboxQuery(inbox, call.body as InboxQuery);
  const groups = [GROUP];
  switch (reply.mode) {
    case "refresh":
      return {
        body: {
          ...reply,
          first: { ...reply.first, groups },
          held: { ...reply.held, groups },
        },
      };
    default:
      return { body: { ...reply, groups } };
  }
};

const callsTo = (calls: readonly Call[], path: string): readonly Call[] =>
  calls.filter((call) => `${call.method} ${call.path}` === path);

const readUndoLine = (): string =>
  document.querySelector(".ib .undo-line .undo-text")?.textContent ?? "";

const waitForUndoLine = (text: string): Promise<void> =>
  waitFor(() => {
    expect(readUndoLine()).toContain(text);
  });

const pressUndo = (user: ReturnType<typeof userEvent.setup>): Promise<void> =>
  user.click(
    within(document.querySelector<HTMLElement>(".ib .undo-line")!).getByRole("button", {
      name: /Undo/,
    }),
  );

/** Opens the Inbox with Slots and Loyalty linked, and waits for the group's row. */
const openGrouped = async (handlers: Parameters<typeof openInbox>[1] = {}) => {
  const inbox = defaultInbox();
  const opened = await openInbox(inbox, {
    [QUERY_PATH]: (call: Call) => answerGrouped(inbox, call),
    ...handlers,
  });
  await screen.findByRole("treeitem", { name: /Linked group, 2 things/ });
  return { ...opened, user: userEvent.setup() };
};

describe("a group of linked things", () => {
  it("draws closed as one row, and opens with the right arrow and closes with the left", async () => {
    const { user } = await openGrouped();

    expect(screen.getAllByRole("treeitem")).toHaveLength(2);
    expect(screen.queryByRole("treeitem", { name: new RegExp(LOYALTY.title) })).toBeNull();

    await user.keyboard("{ArrowRight}");
    expect(screen.getAllByRole("treeitem")).toHaveLength(4);
    expect(screen.getByRole("treeitem", { name: new RegExp(LOYALTY.title) })).toBeTruthy();

    await user.keyboard("{ArrowLeft}");
    expect(screen.getAllByRole("treeitem")).toHaveLength(2);
  });
});

describe("E on a group", () => {
  it("dismisses all its members in one call with one Undo", async () => {
    const { user, calls } = await openGrouped({ [DISMISS]: { body: {} }, [RESTORE]: { body: {} } });

    await user.keyboard("e");

    await waitForUndoLine("Dismissed the group");
    expect(readUndoLine()).toContain("2 things");
    expect(callsTo(calls, DISMISS)).toHaveLength(1);
    expect(callsTo(calls, DISMISS)[0]?.body).toEqual({ ids: [SLOTS.id, LOYALTY.id] });
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);

    await pressUndo(user);

    await waitFor(() => {
      expect(screen.getAllByRole("treeitem")).toHaveLength(2);
    });
    expect(callsTo(calls, RESTORE)).toHaveLength(1);
    expect(callsTo(calls, RESTORE)[0]?.body).toEqual({ ids: [SLOTS.id, LOYALTY.id] });
  });
});

describe("T on a group", () => {
  it("makes one Task for all its members, the label's thing first, and Undo takes back what it wrote", async () => {
    const result = {
      taskId: TASK_ID,
      created: true,
      added: [SLOTS.id, LOYALTY.id],
      taken: [SLOTS.id, LOYALTY.id],
      takenAt: "2026-11-13T10:00:00.000Z",
    };
    const { user, calls } = await openGrouped({
      [TAKE_ON_TOGETHER]: { body: result },
      [UNDO_TAKE_ON_TOGETHER]: { body: { undone: true } },
    });

    await user.keyboard("t");

    await waitForUndoLine("Took on, a Task on Work");
    expect(callsTo(calls, TAKE_ON_TOGETHER)[0]?.body).toEqual({
      ids: [SLOTS.id, LOYALTY.id],
      title: SLOTS.title,
    });

    await pressUndo(user);

    await waitForUndoLine("The Task is gone, and nothing had started.");
    expect(callsTo(calls, UNDO_TAKE_ON_TOGETHER)[0]?.body).toEqual(result);
  });
});

describe("L on a selection", () => {
  it("links the selected things from the first, and Undo unlinks only the pairs this call wrote", async () => {
    let answered = 0;
    const inbox = defaultInbox();
    const { user, calls } = await (async () => {
      const opened = await openInbox(inbox, {
        // The first pair is new; the user had already linked the second.
        [LINK]: () => ({ body: { created: (answered += 1) === 1 } }),
        [UNLINK]: { body: { removed: true } },
      });
      await screen.findByRole("treeitem", { name: new RegExp(SLOTS.title) });
      return { ...opened, user: userEvent.setup() };
    })();
    await user.keyboard("x");
    await user.keyboard("j");
    await user.keyboard("x");
    await user.keyboard("j");
    await user.keyboard("x");

    await user.keyboard("l");

    await waitForUndoLine("Linked 3 things");
    expect(callsTo(calls, LINK).map((call) => call.body)).toEqual([
      { fromRef: SLOTS.ref, toRef: LOYALTY.ref },
      { fromRef: SLOTS.ref, toRef: BASKET.ref },
    ]);

    await pressUndo(user);

    await waitForUndoLine("Unlinked. The sources were never told.");
    expect(callsTo(calls, UNLINK).map((call) => call.body)).toEqual([
      { fromRef: SLOTS.ref, toRef: LOYALTY.ref },
    ]);
  });
});

describe("H on a group", () => {
  it("refuses, says to open the group and pick one, and hands nothing off", async () => {
    const { user, calls } = await openGrouped();

    await user.keyboard("h");

    await waitForUndoLine("Hand-off takes one thing at a time.");
    expect(readUndoLine()).toContain("Open the group and pick one");
    expect(calls.filter((call) => call.path.endsWith("/hand-off"))).toHaveLength(0);
  });
});
