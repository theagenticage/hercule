/**
 * Tests the Work toolbar as the user meets it: the numbers and rows of its
 * menus, what a choice reports to the board, and the chips of what is on.
 * jsdom has no popover API, so a menu's rows are always in the page and the
 * tests find them with `hidden: true`.
 */
import { useState, type JSX } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EMPTY_FILTER, type Filter } from "@hercule/client-core/desk";
import { buildLanes, buildWorkFacets } from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import { WorkToolbar, type WorkDisplay } from "./work-toolbar";

/** Returns a card in the invented Northwind Market world, at Exploring, with no facts. */
const buildCard = (id: string, title: string, overrides: Partial<WorkCard> = {}): WorkCard => ({
  id,
  title,
  stage: "exploring",
  priority: "normal",
  boardRank: id,
  threadCount: 1,
  createdAt: "2026-11-01T09:00:00.000Z",
  stageChangedAt: "2026-11-01T09:00:00.000Z",
  lastActivityAt: "2026-11-01T09:00:00.000Z",
  ...overrides,
});

const STOREFRONT = { id: "storefront", name: "Storefront" };
const DEPOT_OPS = { id: "depot-ops", name: "Depot ops" };

const CARDS: readonly WorkCard[] = [
  buildCard("refund-emails", "Refund emails show the wrong currency", {
    projectId: STOREFRONT.id,
    openQuestion: { sessionId: "s1", requestId: "r1", text: "Which currency should win?" },
  }),
  buildCard("delivery-slots", "Cache delivery slot lookups", {
    projectId: STOREFRONT.id,
    stage: "in-review",
    failure: { runId: "run-1", workflowName: "Review PR", cause: "the branch changed" },
  }),
  buildCard("gateway-certificate", "Renew the payment gateway certificate", {
    projectId: DEPOT_OPS.id,
    workingSessionId: "s2",
  }),
  buildCard("order-history", "Order history hides cancelled items", { projectId: STOREFRONT.id }),
];

const DISPLAY: WorkDisplay = { laneLabels: "side-labels", isStill: false, hasSingleKeys: true };

interface Spies {
  readonly onFoldEverything: () => void;
  readonly onShowKeys: () => void;
  readonly onDisplayChange: (display: WorkDisplay) => void;
}

/**
 * Draws the toolbar over `cards` with a filter and a display it keeps itself,
 * as the board does, so a choice shows in the next render.
 */
function Harness({
  cards = CARDS,
  projects = [STOREFRONT, DEPOT_OPS],
  initialFilter = EMPTY_FILTER,
  spies,
  findValue = "",
  findMatches = [],
}: {
  readonly cards?: readonly WorkCard[];
  readonly projects?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly initialFilter?: Filter;
  readonly spies?: Partial<Spies>;
  readonly findValue?: string;
  readonly findMatches?: readonly WorkCard[];
}): JSX.Element {
  const [filter, setFilter] = useState(initialFilter);
  const [display, setDisplay] = useState(DISPLAY);
  const facets = buildWorkFacets(buildLanes({ cards }, projects));
  return (
    <WorkToolbar
      pill={<span>Overview</span>}
      facets={facets}
      filter={filter}
      onFilterChange={setFilter}
      cards={cards}
      find={{
        value: findValue,
        onChange: vi.fn(),
        inputRef: null,
        onKeyDown: vi.fn(),
        matches: findMatches,
        totalCount: findMatches.length,
        activeId: null,
        onOpen: vi.fn(),
      }}
      display={display}
      onDisplayChange={(next) => {
        setDisplay(next);
        spies?.onDisplayChange?.(next);
      }}
      onFoldEverything={spies?.onFoldEverything ?? vi.fn()}
      onShowKeys={spies?.onShowKeys ?? vi.fn()}
      onAdd={vi.fn()}
      line={null}
    />
  );
}

/**
 * Returns the one row of a menu named `name`: a row that opens or acts, or a
 * checkbox. A row of a group of choices is a radio, which tests ask for by role.
 */
const getRow = (name: RegExp | string): HTMLElement => {
  const rows = (["menuitem", "menuitemcheckbox"] as const).flatMap((role) =>
    screen.queryAllByRole(role, { name, hidden: true }),
  );
  const [row] = rows;
  if (row === undefined || rows.length > 1) {
    throw new Error(`Expected one menu row named ${String(name)}, found ${rows.length}.`);
  }
  return row;
};

/** Returns the name of a row that ends in the number of cards it would leave. */
const withCount = (name: string, count: number): RegExp => new RegExp(`^${name}\\s*${count}$`);

describe("WorkToolbar", () => {
  it("groups by Project, the one grouping for now", () => {
    render(<Harness />);

    const groupBy = screen.getByRole("button", { name: /^Group by\s*Project$/ });
    expect(groupBy).toBeTruthy();
    expect(
      screen
        .getByRole("menuitemradio", { name: "Project", hidden: true })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("counts, for each state, the cards it would leave", () => {
    render(<Harness />);

    expect(getRow(withCount("Has a question", 1))).toBeTruthy();
    expect(getRow(withCount("Failed", 1))).toBeTruthy();
    expect(getRow(withCount("With an agent", 1))).toBeTruthy();
  });

  it("shows what is on as chips beside Filter, and counts the values of other facets within it", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(getRow(withCount("Failed", 1)));

    expect(screen.getByRole("button", { name: "Remove filter Failed" })).toBeTruthy();
    expect(getRow(withCount("Failed", 1)).getAttribute("aria-checked")).toBe("true");
    await user.click(getRow("Project"));
    // Only the failed card is left: it is in Storefront, so Depot ops adds nothing.
    expect(getRow(withCount("Storefront", 1))).toBeTruthy();
    expect(getRow(withCount("Depot ops", 0))).toBeTruthy();
  });

  it("opens the Project values in the same menu, and Back returns to the row that opened them", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(getRow("Project"));
    await user.click(getRow(withCount("Storefront", 3)));

    // A chosen Project counts on the Project row and shows as a chip with its caption.
    expect(screen.getByRole("button", { name: "Remove filter Project Storefront" })).toBeTruthy();
    expect(
      screen.queryByRole("menuitemcheckbox", { name: /Has a question/, hidden: true }),
    ).toBeNull();
    await user.click(getRow("Project"));
    expect(getRow(/Has a question/)).toBeTruthy();
    expect(document.activeElement).toBe(getRow(withCount("Project", 1)));
  });

  it("puts a Find box over a facet that has more than seven values, and narrows the values by it", async () => {
    const user = userEvent.setup();
    const projects = Array.from({ length: 8 }, (_, index) => ({
      id: `project-${index}`,
      name: `Depot ${index + 1}`,
    }));
    const cards = projects.map((project) =>
      buildCard(`card-${project.id}`, `Check ${project.name}`, { projectId: project.id }),
    );
    render(<Harness cards={cards} projects={projects} />);

    await user.click(getRow("Project"));
    await user.type(
      screen.getByRole("textbox", { name: "Find in Project", hidden: true }),
      "depot 3",
    );

    expect(getRow(withCount("Depot 3", 1))).toBeTruthy();
    expect(screen.queryByRole("menuitemcheckbox", { name: /Depot 4/, hidden: true })).toBeNull();
  });

  it("has no Find box over two Projects", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(getRow("Project"));

    expect(screen.queryByRole("textbox", { name: "Find in Project", hidden: true })).toBeNull();
  });

  it("offers Clear from two chips, and Clear turns every filter off", async () => {
    const user = userEvent.setup();
    render(<Harness initialFilter={{ state: ["failed", "question"] }} />);

    expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove filter Failed" }));
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove filter Has a question" })).toBeTruthy();

    await user.click(getRow(withCount("Failed", 1)));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("button", { name: /Remove filter/ })).toBeNull();
  });

  it("reports the whole display when one choice changes", async () => {
    const user = userEvent.setup();
    const onDisplayChange = vi.fn();
    render(<Harness spies={{ onDisplayChange }} />);

    await user.click(getRow(/^Still colleagues/));
    expect(onDisplayChange).toHaveBeenLastCalledWith({ ...DISPLAY, isStill: true });

    await user.click(screen.getByRole("button", { name: "Bands", hidden: true }));
    expect(onDisplayChange).toHaveBeenLastCalledWith({
      ...DISPLAY,
      isStill: true,
      laneLabels: "bands",
    });
  });

  it("folds everything from the Display menu", async () => {
    const user = userEvent.setup();
    const onFoldEverything = vi.fn();
    render(<Harness spies={{ onFoldEverything }} />);

    await user.click(getRow(/Fold everything/));

    expect(onFoldEverything).toHaveBeenCalledOnce();
  });

  it("opens the keys from the Display menu", async () => {
    const user = userEvent.setup();
    const onShowKeys = vi.fn();
    render(<Harness spies={{ onShowKeys }} />);

    await user.click(getRow(/Keys/));

    expect(onShowKeys).toHaveBeenCalledOnce();
  });

  it("lists each Find match with its Project and its stage", () => {
    const [, deliverySlots] = CARDS;
    render(
      <Harness
        findValue="cache"
        findMatches={deliverySlots === undefined ? [] : [deliverySlots]}
      />,
    );

    const match = screen.getByRole("option", { name: /Cache delivery slot lookups/ });
    expect(within(match).getByText("Storefront, In review")).toBeTruthy();
  });
});
