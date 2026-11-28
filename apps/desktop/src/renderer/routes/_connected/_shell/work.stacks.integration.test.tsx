/**
 * Tests the stacks of the Work board through the rendered screen: a lead card
 * with its sheet ("2 pull requests"), opening and closing the stack in place,
 * a stack that opens by itself for a question, a member that stands in another
 * cell and so is a card of its own there, and the keys that walk the members
 * of an open stack and skip those of a closed one. How the cards of a cell
 * are chosen is tested in client-core (`arrangeCell`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildBoard, buildCard } from "@hercule/client-core/work/testing";
import type { WorkBoard, WorkCard, WorkStackCandidate } from "@hercule/contract";
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

const OPS = SIDEBAR_FIXTURE.projects[1]!;
const buildTaskId = (n: number): string => `01a06d02-7e00-7000-8000-${String(n).padStart(12, "0")}`;

const TICKET = buildCard(buildTaskId(1), {
  title: "Make the checkout load faster",
  projectId: OPS.id,
  boardRank: "a",
});
const LAZY_LOAD = buildCard(buildTaskId(2), {
  title: "Lazy-load photos below the fold",
  projectId: OPS.id,
  boardRank: "b",
});
const PRELOAD = buildCard(buildTaskId(3), {
  title: "Preload the checkout font",
  projectId: OPS.id,
  boardRank: "c",
});
const NEXT = buildCard(buildTaskId(4), {
  title: "Renew the payment gateway certificate",
  projectId: OPS.id,
  boardRank: "d",
});

/** The ticket links the two pull requests, so its Task leads them. */
const STACK: readonly WorkStackCandidate[] = [
  { leadTaskId: TICKET.id, memberTaskId: LAZY_LOAD.id, noun: "pull request" },
  { leadTaskId: TICKET.id, memberTaskId: PRELOAD.id, noun: "pull request" },
];

/** A question that a Thread of a card is waiting on. */
const QUESTION: NonNullable<WorkCard["openQuestion"]> = {
  sessionId: buildTaskId(900),
  requestId: buildTaskId(901),
  text: "Which font should win?",
};

/** Opens the app at Work on a board of `cards` with `candidates`. */
const openWork = async (
  cards: readonly WorkCard[],
  candidates: readonly WorkStackCandidate[] = STACK,
) => {
  const board: WorkBoard = { ...buildBoard(...cards), stackCandidates: candidates };
  stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/tasks/board": { body: board },
    "GET /api/v1/tasks": { body: { items: [] } },
  });
  return renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }), {
    path: "/work",
  });
};

/** Returns the card named `title`: its button, which the screen reader names from its words. */
const getCard = (title: string): HTMLElement =>
  screen.getByRole("button", { name: new RegExp(`^${title}`) });

const queryCard = (title: string): HTMLElement | null =>
  screen.queryByRole("button", { name: new RegExp(`^${title}`) });

describe("a stack on the Work board", () => {
  it("draws the lead as a card with a sheet that names the members, and the members nowhere", async () => {
    await openWork([TICKET, LAZY_LOAD, PRELOAD, NEXT]);

    const sheet = await screen.findByRole("button", { name: "2 pull requests" });
    expect(sheet.getAttribute("aria-expanded")).toBe("false");
    expect(getCard(TICKET.title)).toBeTruthy();
    expect(getCard(NEXT.title)).toBeTruthy();
    expect(queryCard(LAZY_LOAD.title)).toBeNull();
    expect(queryCard(PRELOAD.title)).toBeNull();
    // The sheet stands right under its lead card, inside one stack.
    const stack = sheet.closest(".board-stack")!;
    expect(within(stack as HTMLElement).getByRole("button", { name: /^Make the checkout/ })).toBe(
      getCard(TICKET.title),
    );
  });

  it("opens the members as cards under the sheet, and closes them again", async () => {
    const user = userEvent.setup();
    await openWork([TICKET, LAZY_LOAD, PRELOAD, NEXT]);
    const sheet = await screen.findByRole("button", { name: "2 pull requests" });

    await user.click(sheet);

    expect(sheet.getAttribute("aria-expanded")).toBe("true");
    const members = sheet.closest(".board-stack")!.querySelector(".board-stack-members")!;
    expect(
      within(members as HTMLElement)
        .getAllByRole("button")
        .map((card) => card.textContent),
    ).toEqual([expect.stringContaining(LAZY_LOAD.title), expect.stringContaining(PRELOAD.title)]);

    await user.click(sheet);

    expect(sheet.getAttribute("aria-expanded")).toBe("false");
    expect(queryCard(LAZY_LOAD.title)).toBeNull();
  });

  it("opens by itself while a member has a question, and its sheet is not a button to press", async () => {
    await openWork([TICKET, { ...LAZY_LOAD, openQuestion: QUESTION }, PRELOAD, NEXT]);

    // The sheet is disabled: it has nothing to open or close.
    const sheet = await screen.findByRole<HTMLButtonElement>("button", {
      name: "2 pull requests",
    });
    expect(sheet.disabled).toBe(true);
    expect(getCard(LAZY_LOAD.title)).toBeTruthy();
    expect(getCard(PRELOAD.title)).toBeTruthy();
  });

  it("draws a Task that stands in another stage as a card of its own, with no stack", async () => {
    await openWork([TICKET, { ...LAZY_LOAD, stage: "building" }, NEXT], [STACK[0]!]);

    await screen.findByRole("button", { name: /^Make the checkout/ });
    expect(screen.queryByRole("button", { name: /pull request/ })).toBeNull();
    expect(getCard(LAZY_LOAD.title)).toBeTruthy();
  });
});

describe("the keys on a stack", () => {
  it("walks down through the members of an open stack, and skips them while it is closed", async () => {
    const user = userEvent.setup();
    await openWork([TICKET, LAZY_LOAD, PRELOAD, NEXT]);
    const sheet = await screen.findByRole("button", { name: "2 pull requests" });

    // Closed: the members are not on screen, so the walk goes from the lead to the next card.
    act(() => {
      getCard(TICKET.title).focus();
    });
    await user.keyboard("j");
    expect(document.activeElement).toBe(getCard(NEXT.title));

    await user.click(sheet);
    act(() => {
      getCard(TICKET.title).focus();
    });
    await user.keyboard("j");
    expect(document.activeElement).toBe(getCard(LAZY_LOAD.title));
    await user.keyboard("j");
    expect(document.activeElement).toBe(getCard(PRELOAD.title));
    await user.keyboard("j");
    expect(document.activeElement).toBe(getCard(NEXT.title));
    await user.keyboard("k");
    expect(document.activeElement).toBe(getCard(PRELOAD.title));
  });
});
