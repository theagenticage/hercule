/**
 * Tests linking and groups in the Inbox through the rendered app: Return on
 * an open group in a narrow window, dropping a row on another (the order of
 * the link, a drop on the row's own group, offline), Unlink from a group's
 * pane and its Undo, taking a group on into a Task that exists, a group too
 * large to move as a whole, a link that fails part way, and what a click on a
 * group's head and its buttons do.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EntityPeer, InboxGroupDetail, InboxThing } from "@hercule/contract";
import {
  buildErrorBody,
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
  SLOTS_AND_LOYALTY,
  answerGroupedWith,
  callsTo,
  defaultInbox,
  openInbox,
  pressUndo,
  readUndoLine,
  waitForUndoLine,
} from "./-inbox.testing";

beforeEach(() => {
  stubIntersectionObserver();
  stubElementSize(400, 600);
  // jsdom has no pointer capture. A held pointer is what a browser would hold.
  const held = new Set<number>();
  Element.prototype.setPointerCapture = (id: number) => void held.add(id);
  Element.prototype.releasePointerCapture = (id: number) => void held.delete(id);
  Element.prototype.hasPointerCapture = (id: number) => held.has(id);
});

afterEach(() => {
  cleanup();
  setVisibility("visible");
  localStorage.clear();
  document.documentElement.removeAttribute("data-ib-carrying");
});

const BASE = "POST /api/v1/external-entities";
const DISMISS = `${BASE}/dismiss`;
const LINK = `${BASE}/links`;
const UNLINK = `${BASE}/links/remove`;
const GROUP_PATH = `${BASE}/inbox/group`;
const TAKE_ON_TOGETHER = `${BASE}/take-on`;
const UNDO_TAKE_ON_TOGETHER = `${BASE}/take-on/undo`;
const TASK_ID = "01a1b576-c999-7000-8000-000000000902";
const RECORD_ID = "01a1b576-c999-7000-8000-000000000903";

/** Makes the Inbox's frame report `width`, so a width under 760 stacks the pane over the list. */
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

const buildPeer = (thing: InboxThing): EntityPeer => ({
  id: thing.id,
  ref: thing.ref,
  kind: thing.kind,
  noun: thing.noun,
  identifier: thing.identifier,
  title: thing.title,
  url: thing.url,
  yours: false,
  restricted: false,
});

/** What the pane of the group Slots and Loyalty reads: the two linked by the user. */
const GROUP_DETAIL: InboxGroupDetail = {
  labelRef: SLOTS.ref,
  label: SLOTS.title,
  members: [buildPeer(SLOTS), buildPeer(LOYALTY)],
  links: [
    {
      fromRef: SLOTS.ref,
      toRef: LOYALTY.ref,
      claim: { type: "person", actor: "user" },
      hasPersonClaim: true,
    },
  ],
  complete: true,
};

/** Opens the Inbox with Slots and Loyalty linked, and waits for the group's head. */
const openGrouped = async (
  handlers: Parameters<typeof openInbox>[1] = {},
  group = SLOTS_AND_LOYALTY,
) => {
  const inbox = defaultInbox();
  const answer = answerGroupedWith([group]);
  const opened = await openInbox(inbox, {
    [QUERY_PATH]: (call: Call) => answer(inbox, call),
    [GROUP_PATH]: { body: GROUP_DETAIL },
    ...handlers,
  });
  await screen.findByRole("treeitem", { name: /Linked group, \d+ things/ });
  return { ...opened, user: userEvent.setup() };
};

const findLine = (key: string): HTMLElement =>
  document.querySelector<HTMLElement>(`.ib-rows [data-ref="${key}"]`)!;
const findHead = (): HTMLElement => document.querySelector<HTMLElement>(".ib-row--group")!;

/**
 * Carries the row `carriedKey` onto the line `targetKey` and lets go, as a
 * hand does. jsdom has no layout, so the line under the pointer is the one
 * the test says.
 */
const dropOn = (carried: HTMLElement, target: HTMLElement): void => {
  const pointer = { pointerId: 1, isPrimary: true };
  document.elementFromPoint = () => target;
  fireEvent.pointerDown(carried, { ...pointer, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(window, { ...pointer, clientX: 100, clientY: 110 });
  fireEvent.pointerMove(window, { ...pointer, clientX: 100, clientY: 150 });
  fireEvent.pointerUp(window, { ...pointer, clientX: 100, clientY: 150 });
};

describe("Return on an open group in a window too narrow for the pane beside the list", () => {
  it("unfolds a closed group, and then slides the pane in", async () => {
    stubFrameWidth(500);
    const { user } = await openGrouped();
    const pane = document.getElementById("inbox-pane")!;
    expect(pane.hasAttribute("inert")).toBe(true);

    await user.keyboard("{Enter}");
    expect(screen.getAllByRole("treeitem")).toHaveLength(4);
    expect(pane.hasAttribute("inert")).toBe(true);

    await user.keyboard("{Enter}");
    expect(pane.hasAttribute("inert")).toBe(false);
    expect(await within(pane).findByRole("heading", { level: 2 })).toBeTruthy();
    expect(screen.getAllByRole("treeitem")).toHaveLength(4);
  });
});

describe("dropping a row on another", () => {
  it("links the line dropped on with the thing carried, in that order", async () => {
    const { calls } = await openGrouped({ [LINK]: { body: { created: [BASKET.ref] } } });

    dropOn(findLine(BASKET.ref), findHead());

    await waitForUndoLine("Linked");
    expect(callsTo(calls, LINK)).toHaveLength(1);
    expect(callsTo(calls, LINK)[0]?.body).toEqual({ fromRef: SLOTS.ref, toRefs: [BASKET.ref] });
  });

  it("refuses a drop on the head of the carried member's own group, and says why", async () => {
    const { user, calls } = await openGrouped({ [LINK]: { body: { created: [BASKET.ref] } } });
    await user.keyboard("{ArrowRight}");

    dropOn(findLine(LOYALTY.ref), findHead());

    await waitForUndoLine("These are in one group already.");
    expect(callsTo(calls, LINK)).toHaveLength(0);
  });

  it("refuses a drop on another member of the carried member's own group", async () => {
    const { user, calls } = await openGrouped({ [LINK]: { body: { created: [BASKET.ref] } } });
    await user.keyboard("{ArrowRight}");

    dropOn(findLine(LOYALTY.ref), findLine(SLOTS.ref));

    await waitForUndoLine("These are in one group already.");
    expect(callsTo(calls, LINK)).toHaveLength(0);
  });

  it("refuses offline and sends nothing", async () => {
    const { live, calls } = await openGrouped({ [LINK]: { body: { created: [BASKET.ref] } } });
    act(() => {
      live.drop();
    });
    await screen.findByText(/Offline/);

    dropOn(findLine(BASKET.ref), findHead());

    await waitForUndoLine("You are offline, so that was not done.");
    expect(callsTo(calls, LINK)).toHaveLength(0);
  });
});

describe("Unlink in the pane of a group", () => {
  it("removes the pair the user linked, and Undo links it again", async () => {
    const { user, calls } = await openGrouped({
      [UNLINK]: { body: { results: [{ toRef: LOYALTY.ref, removed: true }] } },
      [LINK]: { body: { created: [LOYALTY.ref] } },
    });
    const pane = document.getElementById("inbox-pane")!;

    await user.click(await within(pane).findByRole("button", { name: /^Unlink / }));

    await waitForUndoLine("Unlinked");
    expect(callsTo(calls, UNLINK)[0]?.body).toEqual({ fromRef: SLOTS.ref, toRefs: [LOYALTY.ref] });
    // The line names the two ends, which the pair knows without another read.
    expect(document.querySelector(".ib .undo-line")?.textContent ?? "").toMatch(/ and /);

    await pressUndo(user);

    await waitForUndoLine("Linked again.");
    expect(callsTo(calls, LINK)[0]?.body).toEqual({ fromRef: SLOTS.ref, toRefs: [LOYALTY.ref] });
  });
});

describe("T on a group whose Task exists", () => {
  it("adds the members to it, and Undo takes back only what the call added", async () => {
    const result = {
      taskId: TASK_ID,
      created: false,
      recordId: RECORD_ID,
      added: 1,
      taken: 2,
    };
    const { user, calls } = await openGrouped({
      [TAKE_ON_TOGETHER]: { body: result },
      [UNDO_TAKE_ON_TOGETHER]: { body: { undone: true } },
    });

    await user.keyboard("t");

    await waitForUndoLine("Added to its Task on Work");
    await pressUndo(user);
    await waitFor(() => {
      expect(callsTo(calls, UNDO_TAKE_ON_TOGETHER)).toHaveLength(1);
    });
    expect(callsTo(calls, UNDO_TAKE_ON_TOGETHER)[0]?.body).toEqual({ recordId: RECORD_ID });
  });
});

describe("a group of more than 1,000 things", () => {
  const LARGE = { ...SLOTS_AND_LOYALTY, size: 1001 };

  it("is refused by E, with the way out, and nothing is dismissed", async () => {
    const { user, calls } = await openGrouped({ [DISMISS]: { body: {} } }, LARGE);

    await user.keyboard("e");

    await waitForUndoLine("This group has 1,001 things");
    expect(readUndoLine()).toContain("Dismiss takes up to 1,000 at once");
    expect(callsTo(calls, DISMISS)).toHaveLength(0);
  });

  it("is refused by T, with the way out, and nothing is taken on", async () => {
    const { user, calls } = await openGrouped({ [TAKE_ON_TOGETHER]: { body: {} } }, LARGE);

    await user.keyboard("t");

    await waitForUndoLine("Take on takes up to 1,000 at once");
    expect(callsTo(calls, TAKE_ON_TOGETHER)).toHaveLength(0);
  });
});

describe("L on a selection when the link fails", () => {
  it("says the link did not save, offers no Undo, and unlinks nothing", async () => {
    const inbox = defaultInbox();
    const { user, calls } = await (async () => {
      const opened = await openInbox(inbox, {
        [LINK]: { status: 500, body: buildErrorBody("internal", "The database is locked.") },
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

    await waitForUndoLine("The link did not save: The database is locked");
    expect(callsTo(calls, LINK)).toHaveLength(1);
    expect(
      within(document.querySelector<HTMLElement>(".ib .undo-line")!).queryByRole("button", {
        name: /Undo/,
      }),
    ).toBeNull();
    expect(callsTo(calls, UNLINK)).toHaveLength(0);
  });
});

describe("a click on a group's head", () => {
  it("selects the group with Command, and the range to it with Shift, as on a thing's row", async () => {
    const { user } = await openGrouped();
    const head = findHead();

    await user.keyboard("{Meta>}");
    await user.click(within(head).getByText(SLOTS.title));
    await user.keyboard("{/Meta}");

    expect(head.getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{Shift>}");
    await user.click(findLine(BASKET.ref));
    await user.keyboard("{/Shift}");

    expect(findLine(BASKET.ref).getAttribute("aria-selected")).toBe("true");
    expect(head.getAttribute("aria-selected")).toBe("true");
  });

  it("dismisses the group with its own button, in one call", async () => {
    const { user, calls } = await openGrouped({ [DISMISS]: { body: {} } });

    await user.click(within(findHead()).getByRole("button", { name: /^Dismiss all/ }));

    await waitForUndoLine("Dismissed the group");
    expect(callsTo(calls, DISMISS)[0]?.body).toEqual({ ids: [SLOTS.id, LOYALTY.id] });
  });

  it("takes the group on with its own button", async () => {
    const { user, calls } = await openGrouped({
      [TAKE_ON_TOGETHER]: {
        body: {
          taskId: TASK_ID,
          created: true,
          recordId: RECORD_ID,
          added: 2,
          taken: 2,
        },
      },
    });

    await user.click(within(findHead()).getByRole("button", { name: "Take on" }));

    await waitForUndoLine("Took on, a Task on Work");
    expect(callsTo(calls, TAKE_ON_TOGETHER)[0]?.body).toEqual({
      ids: [SLOTS.id, LOYALTY.id],
      title: SLOTS.title,
    });
  });
});

describe("the members of an open group", () => {
  it("count their place within the group, not within the whole list", async () => {
    const { user } = await openGrouped();

    await user.keyboard("{ArrowRight}");

    const members = [findLine(SLOTS.ref), findLine(LOYALTY.ref)];
    expect(members.map((member) => member.getAttribute("aria-posinset"))).toEqual(["1", "2"]);
    expect(members.map((member) => member.getAttribute("aria-setsize"))).toEqual(["2", "2"]);
  });
});

describe("L on the only selected member of a folded group", () => {
  it("opens Link to... under the group's head", async () => {
    const inbox = defaultInbox();
    const answer = answerGroupedWith([SLOTS_AND_LOYALTY]);
    await openInbox(inbox, { [QUERY_PATH]: (call) => answer(inbox, call) });
    await screen.findByRole("treeitem", { name: /Linked group/ });
    const user = userEvent.setup();

    // Open the group, select its first member, fold the group again, press L.
    await user.keyboard("{ArrowRight}jx{ArrowLeft}{ArrowLeft}l");

    expect(await screen.findByLabelText(/Search for a thing to link/)).toBeTruthy();
  });
});
