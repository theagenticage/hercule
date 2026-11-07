/**
 * Tests the Work toolbar as the user meets it: Group by, the Filter menu with
 * the Work board's facets, the Display menu and what a choice reports to the
 * board, and the Find matches. The Filter menu's own rules are tested with
 * the desk's `FilterControl`.
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
import type { WorkDisplay } from "./use-work-view";
import { WorkToolbar } from "./work-toolbar";

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

  it("filters by a Project from the Filter menu, and shows it as a chip with its caption", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(getRow("Project"));
    await user.click(getRow(withCount("Storefront", 3)));

    expect(screen.getByRole("button", { name: "Remove filter Project Storefront" })).toBeTruthy();
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
