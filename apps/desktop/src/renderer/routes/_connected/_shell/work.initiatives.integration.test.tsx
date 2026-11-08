/**
 * Tests the Initiatives of the Work board through the rendered screen: a row
 * On top with its facts and beads, opening it into cards, In lanes, Group by
 * Initiative, the board with no Initiative, and the Blocked filter. How rows,
 * beads and progress are worked out is tested in client-core.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildBoard, buildCard } from "@hercule/client-core/work/testing";
import type { Initiative, WorkCard } from "@hercule/contract";
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

/** Opens the app at Work on `cards`, with the open `initiatives` and one Done Task on the first. */
const openWork = async (
  initiatives: readonly Initiative[] = [CHECKOUT_REWORK],
  cards: readonly WorkCard[] = CARDS,
) => {
  const first = initiatives[0];
  stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/tasks/board": {
      body: {
        ...buildBoard(...cards),
        initiativeDoneCounts: first === undefined ? {} : { [first.id]: 1 },
      },
    },
    "GET /api/v1/initiatives": { body: { items: initiatives } },
    "GET /api/v1/tasks": { body: { items: [] } },
  });
  return renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }), {
    path: "/work",
  });
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
});
