/**
 * Tests the Initiative row of the Work board: the beads of its folded line,
 * what pressing a bead, the head and the edit button do, the cards of an open
 * row, and the flags a folded Project lane keeps for the Initiatives it holds.
 */
import type { JSX } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  arrangeLanes,
  buildLane,
  buildLanes,
  type ArrangedLane,
  type InitiativeRowLane,
} from "@hercule/client-core/work";
import { buildCard, FAILURE, QUESTION } from "@hercule/client-core/work/testing";
import type { WorkCard } from "@hercule/contract";
import { BoardLane } from "./board-lane";
import { InitiativeBlock, InitiativeRow, NotInInitiativeHeading } from "./initiative-row";

const INITIATIVE: InitiativeRowLane = {
  initiativeId: "platform",
  hue: 245,
  isRow: true,
  doneRingCount: 0,
};

/** Returns the row of `cards`, folded or open, as the board arranges it. */
const arrangeRow = (
  cards: readonly WorkCard[],
  { isFolded = true, doneRingCount = 0 } = {},
): ArrangedLane => {
  const lane = buildLane("initiative-row:platform", "Retire the scheduler", null, cards, {
    initiative: { ...INITIATIVE, doneRingCount },
  });
  const [arranged] = arrangeLanes([lane], {
    foldedLaneIds: new Set(),
    openedCellIds: new Set(),
    openedInitiativeIds: new Set(isFolded ? [] : ["platform"]),
    openedStackIds: new Set(),
    stackCandidates: [],
    isFiltering: false,
  });
  if (arranged === undefined) throw new Error("No lane");
  return arranged;
};

const BLOCKED = {
  blockedBy: [{ id: "b", title: "B", stage: "building" as const }],
  blockedByCount: 1,
};

/** Renders the row and returns what its callbacks were called with. */
const renderRow = (
  arrangedLane: ArrangedLane,
  facts: string | null = "Platform · 1 of 4 landed",
): {
  readonly onToggleRow: ReturnType<typeof vi.fn>;
  readonly onEditInitiative: ReturnType<typeof vi.fn>;
  readonly onPressBead: ReturnType<typeof vi.fn>;
  readonly onPressCard: ReturnType<typeof vi.fn>;
} => {
  const handlers = {
    onToggleRow: vi.fn(),
    onEditInitiative: vi.fn(),
    onPressBead: vi.fn(),
    onPressCard: vi.fn(),
  };
  render(
    <InitiativeRow
      arrangedLane={arrangedLane}
      facts={facts}
      plugins={[]}
      tabStop={null}
      isStill
      canWriteSummaries={false}
      selectedIds={new Set()}
      onToggleCell={() => {}}
      onToggleStack={() => {}}
      onFocusCard={() => {}}
      {...handlers}
    />,
  );
  return handlers;
};

const readBeads = (): readonly string[] =>
  [...document.querySelectorAll<HTMLElement>(".initiative-bead")].map(
    (bead) => `${bead.dataset["kind"] ?? ""}:${bead.dataset["beadTaskId"] ?? "ring"}`,
  );

describe("InitiativeRow, folded", () => {
  const cards = [
    buildCard("open", { title: "Open one" }),
    buildCard("failed", { title: "Broken one", stage: "building", failure: FAILURE }),
    buildCard("asks", { title: "Asking one", stage: "building", openQuestion: QUESTION }),
    buildCard("waits", { title: "Waiting one", stage: "planned", ...BLOCKED }),
    buildCard("done", { title: "Landed one", stage: "landed" }),
  ];

  it("draws a bead of the right kind for each Task, and a ring for each Done Task", () => {
    renderRow(arrangeRow(cards, { doneRingCount: 2 }));

    expect(readBeads()).toEqual([
      "open:open",
      "blocked:waits",
      "failed:failed",
      "question:asks",
      "landed:done",
      "landed:ring",
      "landed:ring",
    ]);
  });

  it("opens a Task when its bead is pressed, and does not make a button of a Done ring", async () => {
    const user = userEvent.setup();
    const { onPressBead } = renderRow(arrangeRow(cards, { doneRingCount: 1 }));

    await user.click(screen.getByRole("button", { name: "Broken one, Building, failed" }));

    expect(onPressBead).toHaveBeenCalledExactlyOnceWith("failed");
    const line = screen.getByRole("group", { name: "6 Tasks, folded" });
    expect(within(line).getAllByRole("button")).toHaveLength(5);
  });

  it("is one tab stop, and the arrows walk the beads", async () => {
    const user = userEvent.setup();
    renderRow(arrangeRow(cards));
    const buttons = within(screen.getByRole("group", { name: "5 Tasks, folded" })).getAllByRole(
      "button",
    );

    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    buttons[0]?.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(buttons[4]);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(buttons[4]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("draws at most the tally cap as marks in a crowded cell, and counts every Task", () => {
    const crowd = Array.from({ length: 30 }, (_, index) => buildCard(`t${String(index)}`));
    renderRow(arrangeRow(crowd));

    expect(document.querySelectorAll(".initiative-bead")).toHaveLength(20);
    expect(document.querySelector(".initiative-line-cell.is-tally")).not.toBeNull();
    expect(screen.getByRole("group", { name: "30 Tasks, folded" })).toBeTruthy();
  });

  it("draws the bright line across the stages before the last bead's stage", () => {
    renderRow(arrangeRow([buildCard("a", { stage: "building" })]));
    expect(document.querySelector<HTMLElement>(".initiative-reach")?.style.gridColumn).toBe(
      "1 / span 2",
    );
  });

  it("draws no bright line before the first stage", () => {
    renderRow(arrangeRow([buildCard("a")]));
    expect(document.querySelector(".initiative-reach")).toBeNull();
    expect(document.querySelector(".initiative-beads.is-reach-end")).not.toBeNull();
  });
});

describe("InitiativeRow, the head", () => {
  it("shows its name and facts, says how many failed, and folds or opens the row", async () => {
    const user = userEvent.setup();
    const { onToggleRow } = renderRow(
      arrangeRow([buildCard("a", { failure: FAILURE }), buildCard("b")]),
    );

    const head = screen.getByRole("button", { name: /^Retire the scheduler/ });
    expect(head.textContent).toContain("Platform · 1 of 4 landed");
    expect(head.textContent).toContain("1 failed");
    expect(head.getAttribute("aria-expanded")).toBe("false");

    await user.click(head);
    expect(onToggleRow).toHaveBeenCalledExactlyOnceWith("initiative-row:platform");
  });

  it("leaves out the facts and the failed count when there are none", () => {
    renderRow(arrangeRow([buildCard("a")]), null);

    const head = screen.getByRole("button", { name: "Retire the scheduler" });
    expect(head.querySelector("small")).toBeNull();
    expect(head.textContent).not.toContain("failed");
  });

  it("calls onEditInitiative with the Initiative's id from the edit button", async () => {
    const user = userEvent.setup();
    const { onEditInitiative, onToggleRow } = renderRow(arrangeRow([buildCard("a")]));

    await user.click(screen.getByRole("button", { name: "Edit Retire the scheduler" }));

    expect(onEditInitiative).toHaveBeenCalledExactlyOnceWith("platform");
    expect(onToggleRow).not.toHaveBeenCalled();
  });
});

describe("InitiativeRow, open", () => {
  it("draws the cards in cells, and no line", async () => {
    const user = userEvent.setup();
    const { onPressCard } = renderRow(
      arrangeRow([buildCard("a", { title: "Retry policy" })], { isFolded: false }),
    );

    expect(
      screen.getByRole("button", { name: /^Retire the scheduler/ }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(document.querySelector(".initiative-line")).toBeNull();
    expect(document.querySelectorAll(".board-cell")).toHaveLength(5);
    await user.click(screen.getByText("Retry policy"));
    expect(onPressCard).toHaveBeenCalledOnce();
  });
});

describe("InitiativeBlock", () => {
  const drawBlock = (isFolded: boolean, onToggle = vi.fn()): JSX.Element => (
    <InitiativeBlock count={6} isFolded={isFolded} onToggle={onToggle}>
      <p>the rows</p>
    </InitiativeBlock>
  );

  it("shows its count and its rows, and folds to the heading alone", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(drawBlock(false, onToggle));

    const heading = screen.getByRole("button", { name: "Initiatives 6" });
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("the rows")).toBeTruthy();
    await user.click(heading);
    expect(onToggle).toHaveBeenCalledOnce();

    rerender(drawBlock(true, onToggle));
    expect(screen.queryByText("the rows")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Initiatives 6" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("names the lanes that follow it", () => {
    render(<NotInInitiativeHeading />);
    expect(screen.getByRole("heading", { name: "Not in an initiative" })).toBeTruthy();
  });
});

describe("BoardLane and Initiatives", () => {
  const [project] = buildLanes({ cards: [buildCard("a", { projectId: "storefront" })] }, [
    { id: "storefront", name: "Storefront" },
  ]);
  const drawLane = (
    isFolded: boolean,
    held: readonly { id: string; hue: number; name: string }[],
  ): void => {
    if (project === undefined) throw new Error("No lane");
    const [arranged] = arrangeLanes([project], {
      foldedLaneIds: new Set(isFolded ? ["storefront"] : []),
      openedCellIds: new Set(),
      openedInitiativeIds: new Set(),
      openedStackIds: new Set(),
      stackCandidates: [],
      isFiltering: false,
    });
    if (arranged === undefined) throw new Error("No lane");
    render(
      <BoardLane
        arrangedLane={arranged}
        plugins={[]}
        tabStop={null}
        isStill
        canWriteSummaries={false}
        selectedIds={new Set()}
        heldInitiatives={held}
        onToggleLane={() => {}}
        onToggleCell={() => {}}
        onToggleStack={() => {}}
        onAddTask={() => {}}
        onPressCard={() => {}}
        onFocusCard={() => {}}
      />,
    );
  };
  const HELD = [
    { id: "a", hue: 245, name: "Platform" },
    { id: "b", hue: 150, name: "Checkout" },
  ];

  it("keeps a flag for each Initiative a folded lane holds", () => {
    drawLane(true, HELD);

    expect(screen.getByRole("img", { name: "Initiative Platform" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Initiative Checkout" })).toBeTruthy();
  });

  it("draws no flag while the lane is open, because the rows are under it", () => {
    drawLane(false, HELD);

    expect(screen.queryByRole("img", { name: /Initiative/ })).toBeNull();
  });

  it("puts the Initiative's flag in place of the folder in the lane of Group by Initiative", () => {
    const lane = buildLane("initiative:platform", "Platform", null, [], {
      initiative: { initiativeId: INITIATIVE.initiativeId, hue: INITIATIVE.hue, isRow: false },
    });
    const [arranged] = arrangeLanes([lane], {
      foldedLaneIds: new Set(),
      openedCellIds: new Set(),
      openedInitiativeIds: new Set(),
      openedStackIds: new Set(),
      stackCandidates: [],
      isFiltering: false,
    });
    if (arranged === undefined) throw new Error("No lane");
    render(
      <BoardLane
        arrangedLane={arranged}
        plugins={[]}
        tabStop={null}
        isStill
        canWriteSummaries={false}
        selectedIds={new Set()}
        onToggleLane={() => {}}
        onToggleCell={() => {}}
        onToggleStack={() => {}}
        onAddTask={() => {}}
        onPressCard={() => {}}
        onFocusCard={() => {}}
      />,
    );

    expect(document.querySelector(".board-lane-folder.is-flag .hue-flag")).not.toBeNull();
    expect(document.querySelector(".board-lane-folder svg path[d^='M2.2']")).toBeNull();
  });
});
