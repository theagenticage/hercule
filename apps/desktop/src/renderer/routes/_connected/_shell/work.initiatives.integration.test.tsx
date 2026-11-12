/**
 * Tests the Initiatives of the Work board through the rendered screen: a row
 * On top with its facts and beads, opening it into cards, In lanes, Group by
 * Initiative, the board with no Initiative, and the Blocked filter. How rows,
 * beads and progress are worked out is tested in client-core.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildBoard, buildCard } from "@hercule/client-core/work/testing";
import type { Initiative, Task, WorkCard } from "@hercule/contract";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubApi,
  stubIntersectionObserver,
} from "../../../app/testing";

beforeEach(() => {
  stubIntersectionObserver();
});

afterEach(() => {
  setVisibility("visible");
  localStorage.clear();
});

const WEBSHOP = SIDEBAR_FIXTURE.projects[0]!;
const buildTaskId = (n: number): string => `01a06d02-7e00-7000-8000-${String(n).padStart(12, "0")}`;

const CHECKOUT_REWORK: Initiative = {
  id: buildTaskId(500),
  name: "Checkout rework",
  intent: "One page, fewer taps.",
  hue: 245,
  projectId: WEBSHOP.id,
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-01T09:00:00.000Z",
};

const EXPRESS_PAY = buildCard(buildTaskId(1), {
  title: "Add express pay",
  projectId: WEBSHOP.id,
  stage: "building",
  initiativeId: CHECKOUT_REWORK.id,
});
const PAYMENT_FORM = buildCard(buildTaskId(2), {
  title: "Rebuild the payment form",
  projectId: WEBSHOP.id,
  stage: "landed",
  initiativeId: CHECKOUT_REWORK.id,
});
const RECEIPT_EMAIL = buildCard(buildTaskId(3), {
  title: "Send the receipt by email",
  projectId: WEBSHOP.id,
  stage: "planned",
  initiativeId: CHECKOUT_REWORK.id,
  blockedBy: [{ id: PAYMENT_FORM.id, title: PAYMENT_FORM.title, stage: "building" }],
  blockedByCount: 1,
});
const GIFT_WRAP = buildCard(buildTaskId(4), {
  title: "Offer gift wrap",
  projectId: WEBSHOP.id,
  stage: "exploring",
});
const DELIVERY_SLOTS = buildCard(buildTaskId(5), { title: "Cache delivery slot lookups" });

const CARDS: readonly WorkCard[] = [
  EXPRESS_PAY,
  PAYMENT_FORM,
  RECEIPT_EMAIL,
  GIFT_WRAP,
  DELIVERY_SLOTS,
];

/** Returns the Task the controller answers to a create. */
const buildCreatedTask = ({ title }: { readonly title: string }): Task => ({
  id: buildTaskId(60),
  title,
  description: "",
  leadSessionId: null,
  status: "open",
  stage: "exploring",
  priority: "normal",
  labels: [],
  provenance: [],
  createdAt: "2026-11-02T09:00:00.000Z",
  updatedAt: "2026-11-02T09:00:00.000Z",
  statusChangedAt: "2026-11-02T09:00:00.000Z",
  stageChangedAt: "2026-11-02T09:00:00.000Z",
});

/** Opens the app at Work on `cards`, with the open `initiatives` and one Done Task on the first. */
const openWork = async (
  initiatives: readonly Initiative[] = [CHECKOUT_REWORK],
  cards: readonly WorkCard[] = CARDS,
) => {
  const first = initiatives[0];
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "POST /api/v1/tasks": (call) => ({ body: buildCreatedTask(call.body as { title: string }) }),
    "GET /api/v1/tasks/board": {
      body: {
        ...buildBoard(...cards),
        initiativeDoneCounts: first === undefined ? {} : { [first.id]: 1 },
      },
    },
    "GET /api/v1/initiatives": { body: { items: initiatives } },
    "GET /api/v1/tasks": { body: { items: [] } },
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    {
      path: "/work",
    },
  );
  return { ...app, calls };
};

/** Returns the head button of the Initiative row named `name`. */
const getRowHead = (name: string): HTMLElement =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) });

/** Returns the card of the Task `taskId` as the board draws it, or `null`. A bead is no card. */
const queryCard = (taskId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-card-id="${taskId}"]`);

/** Returns the names of the lanes and rows whose heads are on the board, in order. */
const listHeadNames = (): (string | null | undefined)[] =>
  [...document.querySelectorAll("[data-lane-head]")].map(
    (head) => head.querySelector(".board-lane-name, .initiative-name")?.textContent,
  );

describe("Initiatives on the Work board", () => {
  it("draws an Initiative On top as a folded row with its facts and one bead for each Task", async () => {
    await openWork();

    const head = await screen.findByRole("button", { name: /^Checkout rework/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    // Two of the four are landed: one is at Landed, and one is Done, which has a ring and no card.
    expect(head.textContent).toContain(`${WEBSHOP.name} · 2 of 4 landed`);
    const line = within(head.closest("section")!).getByRole("group", { name: "4 Tasks, folded" });
    expect(
      within(line)
        .getAllByRole("button")
        .map((bead) => bead.getAttribute("aria-label")),
    ).toEqual([
      "Send the receipt by email, Planned, blocked",
      "Add express pay, Building",
      "Rebuild the payment form, Landed",
    ]);
    // The Tasks of the row are on it, not in a lane.
    expect(queryCard(EXPRESS_PAY.id)).toBeNull();
    expect(screen.getByRole("heading", { name: /Initiatives/, level: 3 }).textContent).toContain(
      "1",
    );
    expect(screen.getByRole("heading", { name: "Not in an initiative" })).toBeTruthy();
    expect(queryCard(GIFT_WRAP.id)).toBeTruthy();
  });

  it("opens a row into its cards when its head is pressed, and folds it again", async () => {
    const user = userEvent.setup();
    await openWork();
    const head = await screen.findByRole("button", { name: /^Checkout rework/ });

    await user.click(head);

    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(queryCard(EXPRESS_PAY.id)).toBeTruthy();
    expect(queryCard(RECEIPT_EMAIL.id)).toBeTruthy();

    await user.click(head);

    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(queryCard(EXPRESS_PAY.id)).toBeNull();
  });

  it("moves a card of an open row to Landed when 5 is pressed on the card with focus", async () => {
    const user = userEvent.setup();
    const { calls } = await openWork();
    await user.click(await screen.findByRole("button", { name: /^Checkout rework/ }));
    const card = queryCard(EXPRESS_PAY.id)!;

    act(() => {
      card.focus();
    });
    await user.keyboard("5");

    await waitFor(() => {
      expect(
        calls.filter((call) => call.method === "POST" && call.path.endsWith("/move")),
      ).toMatchObject([
        { path: `/api/v1/tasks/${EXPRESS_PAY.id}/move`, body: { stage: "landed" } },
      ]);
    });
  });

  it("keeps a row open across a reload", async () => {
    const user = userEvent.setup();
    await openWork();
    await user.click(await screen.findByRole("button", { name: /^Checkout rework/ }));
    cleanup();

    await openWork();

    expect(
      (await screen.findByRole("button", { name: /^Checkout rework/ })).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
  });

  it("opens the Task of a bead, as a click on its card does", async () => {
    const user = userEvent.setup();
    const { router } = await openWork();
    const head = await screen.findByRole("button", { name: /^Checkout rework/ });

    await user.click(
      within(head.closest("section")!).getByRole("button", { name: /^Add express pay/ }),
    );

    await screen.findByRole("dialog", { name: EXPRESS_PAY.title });
    expect(router.state.location.search).toEqual({ task: EXPRESS_PAY.id });
  });

  it("puts the row under its Project's lane when Display says In lanes", async () => {
    const user = userEvent.setup();
    await openWork();
    await screen.findByRole("button", { name: /^Checkout rework/ });

    await user.click(screen.getByRole("button", { name: "In lanes", hidden: true }));

    const row = getRowHead("Checkout rework").closest("section")!;
    expect(row.getAttribute("data-place")).toBe("lane");
    const lane = row.previousElementSibling as HTMLElement;
    expect(lane.getAttribute("data-lane-id")).toBe(WEBSHOP.id);
    // The row says its facts without the Project's name: the lane above says it.
    expect(getRowHead("Checkout rework").textContent).toContain("2 of 4 landed");
    expect(getRowHead("Checkout rework").textContent).not.toContain(`${WEBSHOP.name} ·`);
    expect(screen.queryByRole("heading", { name: "Not in an initiative" })).toBeNull();
  });

  it("draws a lane for each Initiative under Group by Initiative, with a flag on no row", async () => {
    const user = userEvent.setup();
    await openWork();
    await screen.findByRole("button", { name: /^Checkout rework/ });

    await user.click(screen.getByRole("menuitemradio", { name: "Initiative", hidden: true }));

    await screen.findByRole("button", { name: /^Not in an initiative/ });
    const lanes = listHeadNames();
    expect(lanes[0]).toBe("Checkout rework");
    expect(lanes.at(-1)).toBe("Not in an initiative");
    expect(queryCard(EXPRESS_PAY.id)).toBeTruthy();
    expect(screen.queryByRole("group", { name: /folded/ })).toBeNull();
  });

  it("draws the board as before when no Initiative is open", async () => {
    await openWork([]);

    await screen.findByRole("button", { name: /^Offer gift wrap/ });
    expect(screen.queryByRole("heading", { name: /^Initiatives/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Not in an initiative" })).toBeNull();
    // A Task keeps its card in its lane when its Initiative is not listed.
    expect(queryCard(EXPRESS_PAY.id)).toBeTruthy();
    expect(screen.queryByRole("menuitemradio", { name: "Initiative", hidden: true })).toBeNull();
  });

  it("leaves only the blocked cards under the Blocked filter, and opens the row they are on", async () => {
    const user = userEvent.setup();
    await openWork();
    await screen.findByRole("button", { name: /^Checkout rework/ });

    await user.click(screen.getByRole("menuitemcheckbox", { name: /^Blocked/, hidden: true }));

    expect(await screen.findByRole("button", { name: /^Send the receipt by email/ })).toBeTruthy();
    expect(queryCard(EXPRESS_PAY.id)).toBeNull();
    expect(queryCard(GIFT_WRAP.id)).toBeNull();
    expect(queryCard(DELIVERY_SLOTS.id)).toBeNull();
    expect(getRowHead("Checkout rework").getAttribute("aria-expanded")).toBe("true");
  });

  it("counts every Task of the Project in the head of its lane when the rows stand under it", async () => {
    const user = userEvent.setup();
    await openWork();
    await screen.findByRole("button", { name: /^Checkout rework/ });

    await user.click(screen.getByRole("button", { name: "In lanes", hidden: true }));

    // Three Tasks are on the row and one is loose: the lane's head counts all four.
    const head = document.querySelector(`[data-lane-head="${WEBSHOP.id}"]`)!;
    expect(head.querySelector(".board-lane-total")?.textContent).toBe("4");
    await user.click(
      within(head as HTMLElement).getByRole("button", { name: new RegExp(`^${WEBSHOP.name}`) }),
    );
    const folded = document.querySelector(`[data-fold-row="${WEBSHOP.id}"]`)!;
    expect(folded.getAttribute("aria-label")).toBe("Exploring 1, Planned 1, Building 1, Landed 1");
  });

  it("draws an Initiative with no Task on a desk with no card at all, in place of All clear", async () => {
    await openWork([CHECKOUT_REWORK], []);

    expect(await screen.findByRole("button", { name: /^Checkout rework/ })).toBeTruthy();
    expect(screen.queryByText("All clear.")).toBeNull();
  });

  it("draws the lane of an Initiative with no Task under Group by Initiative on a desk with no card", async () => {
    const user = userEvent.setup();
    await openWork([CHECKOUT_REWORK], []);
    await screen.findByRole("button", { name: /^Checkout rework/ });

    await user.click(screen.getByRole("menuitemradio", { name: "Initiative", hidden: true }));

    expect(await screen.findByRole("button", { name: /^Not in an initiative/ })).toBeTruthy();
    expect(screen.queryByText("All clear.")).toBeNull();
  });

  it("opens a folded block of rows while a filter is on, and folds it again when the filter goes", async () => {
    const user = userEvent.setup();
    await openWork();
    const block = await screen.findByRole("button", { name: /^Initiatives/ });
    await user.click(block);
    expect(screen.queryByRole("button", { name: /^Checkout rework/ })).toBeNull();

    await user.click(screen.getByRole("menuitemcheckbox", { name: /^Blocked/, hidden: true }));

    expect(await screen.findByRole("button", { name: /^Send the receipt by email/ })).toBeTruthy();

    await user.click(screen.getByRole("menuitemcheckbox", { name: /^Blocked/, hidden: true }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^Checkout rework/ })).toBeNull();
    });
    expect(screen.getByRole("button", { name: /^Initiatives/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("acts the same from the keyboard and the toolbar when Fold everything runs with a filter on and the lane of a row folded", async () => {
    const user = userEvent.setup();
    await openWork();
    await screen.findByRole("button", { name: /^Checkout rework/ });
    await user.click(screen.getByRole("button", { name: "In lanes", hidden: true }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /^Blocked/, hidden: true }));
    await screen.findByRole("button", { name: /^Send the receipt by email/ });
    const laneHead = within(
      document.querySelector<HTMLElement>(`[data-lane-head="${WEBSHOP.id}"]`)!,
    ).getByRole("button", { name: new RegExp(`^${WEBSHOP.name}`) });
    await user.click(laneHead);
    expect(laneHead.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /^Checkout rework/ })).toBeNull();

    // The row is hidden under its folded lane but is still part of everything.
    // Every lane and row is not folded yet, so Fold everything folds them and
    // does not open the lane. The key and the toolbar button must agree.
    await user.keyboard("{Shift>}F{/Shift}");

    expect(laneHead.getAttribute("aria-expanded")).toBe("false");
  });

  it("creates a Task on the Initiative whose lane's plus was pressed, in its Project, and says so", async () => {
    const user = userEvent.setup();
    const { calls } = await openWork();
    await screen.findByRole("button", { name: /^Checkout rework/ });
    await user.click(screen.getByRole("menuitemradio", { name: "Initiative", hidden: true }));

    await user.click(await screen.findByRole("button", { name: "Add to Checkout rework" }));
    expect(screen.getByText("Starts in Exploring, in Checkout rework.")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "New Task" }), "Pay by link{Enter}");

    expect(await screen.findByText("Added to Exploring in Checkout rework.")).toBeTruthy();
    const created = calls.find((call) => call.method === "POST" && call.path === "/api/v1/tasks");
    expect(created?.body).toEqual({
      title: "Pay by link",
      description: "",
      stage: "exploring",
      projectId: WEBSHOP.id,
      initiativeId: CHECKOUT_REWORK.id,
    });
  });

  it("creates a Task from the toolbar's Add in the Project's lane, on no Initiative", async () => {
    const user = userEvent.setup();
    const { calls } = await openWork();
    await screen.findByRole("button", { name: /^Checkout rework/ });

    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.type(screen.getByRole("textbox", { name: "New Task" }), "Label the crates{Enter}");

    await screen.findByText(/^Added to Exploring/);
    const created = calls.find((call) => call.method === "POST" && call.path === "/api/v1/tasks");
    expect(created?.body).toEqual({
      title: "Label the crates",
      description: "",
      stage: "exploring",
      projectId: WEBSHOP.id,
    });
  });

  it("opens the Initiative sheet from New initiative in Add to Work, which gives way to it", async () => {
    const user = userEvent.setup();
    await openWork();
    await screen.findByRole("button", { name: /^Checkout rework/ });
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("heading", { name: "Add to Work" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "New initiative" }));

    expect(await screen.findByRole("heading", { name: "New initiative" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Add to Work" })).toBeNull();
    expect(document.querySelector(".work-desk")?.classList.contains("has-sheet")).toBe(true);
  });

  it("opens the Initiative sheet on an Initiative from the edit button of its row, and Add to Work closes it", async () => {
    const user = userEvent.setup();
    await openWork();
    await screen.findByRole("button", { name: /^Checkout rework/ });

    await user.click(screen.getByRole("button", { name: "Edit Checkout rework" }));

    expect(await screen.findByRole("heading", { name: "Checkout rework", level: 2 })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe(
      "Checkout rework",
    );

    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("heading", { name: "Add to Work" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  });

  it("closes the Initiative sheet when a card opens its details", async () => {
    const user = userEvent.setup();
    await openWork();
    await screen.findByRole("button", { name: /^Checkout rework/ });
    await user.click(screen.getByRole("button", { name: "Edit Checkout rework" }));
    await screen.findByRole("textbox", { name: "Name" });

    await user.click(screen.getByRole("button", { name: /^Offer gift wrap/ }));

    await screen.findByRole("dialog", { name: GIFT_WRAP.title });
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    });
  });
});
