/** Tests what the user folded on the Work board: the answers, the changes, and Fold everything. */
import { describe, expect, it } from "vitest";
import {
  buildBoardFolds,
  EMPTY_FILTER_FOLDS,
  isBlockFolded,
  isFolded,
  planFoldEverything,
  toggleBlockFold,
  toggleFold,
} from "./board-folds";
import { buildLane } from "./lanes";

const core = buildLane("core", "Core", "core", []);
const edge = buildLane("edge", "Edge", "edge", []);
const row = buildLane("initiative-row:platform", "Platform", null, [], {
  initiative: { initiativeId: "platform", hue: 245, isRow: true, doneRingCount: 0 },
});
const initiativeLane = buildLane("initiative:platform", "Platform", null, [], {
  initiative: { initiativeId: "platform", hue: 245, isRow: false },
});

describe("isFolded", () => {
  it("opens a lane and folds a row by default, with no filter", () => {
    const folds = buildBoardFolds();

    expect(isFolded(folds, core)).toBe(false);
    expect(isFolded(folds, row)).toBe(true);
    expect(isFolded(folds, initiativeLane)).toBe(false);
  });

  it("folds a lane by foldedLaneIds and opens a row by openedInitiativeIds", () => {
    const folds = buildBoardFolds({
      saved: { foldedLaneIds: ["core"], openedInitiativeIds: ["platform"] },
    });

    expect(isFolded(folds, core)).toBe(true);
    expect(isFolded(folds, edge)).toBe(false);
    expect(isFolded(folds, row)).toBe(false);
  });

  it("does not fold a row because a lane with the same id is saved folded", () => {
    const folds = buildBoardFolds({
      saved: { foldedLaneIds: [row.id], openedInitiativeIds: ["platform"] },
    });

    expect(isFolded(folds, row)).toBe(false);
  });

  it("opens lanes and rows while a filter is on, whatever was saved", () => {
    const folds = buildBoardFolds({
      isFiltering: true,
      saved: { foldedLaneIds: ["core"], isInitiativeBlockFolded: true },
    });

    expect(isFolded(folds, core)).toBe(false);
    expect(isFolded(folds, row)).toBe(false);
    expect(isBlockFolded(folds)).toBe(false);
  });

  it("folds what the user folded since the filter came on", () => {
    const folds = buildBoardFolds({
      isFiltering: true,
      sinceFilter: { foldedLaneIds: ["core"], foldedInitiativeIds: ["platform"] },
    });

    expect(isFolded(folds, core)).toBe(true);
    expect(isFolded(folds, row)).toBe(true);
    expect(isFolded(folds, edge)).toBe(false);
  });
});

describe("toggleFold", () => {
  it("saves the fold of a lane and the opening of a row when no filter is on", () => {
    const folds = toggleFold(toggleFold(buildBoardFolds(), core), row);

    expect([...folds.saved.foldedLaneIds]).toEqual(["core"]);
    expect([...folds.saved.openedInitiativeIds]).toEqual(["platform"]);
    expect(folds.sinceFilter).toEqual(EMPTY_FILTER_FOLDS);
  });

  it("folds the other way on a second call", () => {
    const folds = toggleFold(toggleFold(buildBoardFolds(), core), core);

    expect(isFolded(folds, core)).toBe(false);
  });

  it("keeps a fold made while filtering apart from the saved ones", () => {
    const filtering = buildBoardFolds({ isFiltering: true, saved: { foldedLaneIds: ["edge"] } });
    const folds = toggleFold(toggleFold(filtering, core), row);

    expect([...folds.sinceFilter.foldedLaneIds]).toEqual(["core"]);
    expect([...folds.sinceFilter.foldedInitiativeIds]).toEqual(["platform"]);
    expect([...folds.saved.foldedLaneIds]).toEqual(["edge"]);
  });

  it("leaves the value it was given as it was", () => {
    const before = buildBoardFolds();
    toggleFold(before, core);
    toggleBlockFold(before);

    expect(before).toEqual(buildBoardFolds());
  });
});

describe("the block of rows On top", () => {
  it("is open by default and saves its fold when no filter is on", () => {
    const folds = toggleBlockFold(buildBoardFolds());

    expect(isBlockFolded(buildBoardFolds())).toBe(false);
    expect(isBlockFolded(folds)).toBe(true);
    expect(folds.saved.isInitiativeBlockFolded).toBe(true);
  });

  it("holds a fold made while filtering only for the filter, and the saved fold returns after it", () => {
    const saved = { isInitiativeBlockFolded: true };
    const filtering = toggleBlockFold(buildBoardFolds({ isFiltering: true, saved }));

    expect(isBlockFolded(filtering)).toBe(true);
    expect(filtering.saved.isInitiativeBlockFolded).toBe(true);
    expect(isBlockFolded({ ...filtering, isFiltering: false })).toBe(true);
    expect(isBlockFolded(buildBoardFolds({ isFiltering: true, saved }))).toBe(false);
  });
});

describe("planFoldEverything", () => {
  const targets = [core, edge, row];

  it("folds every lane and closes every open row, with no filter", () => {
    const folds = buildBoardFolds({ saved: { openedInitiativeIds: ["platform"] } });
    const plan = planFoldEverything(folds, targets);

    expect(plan.isOpening).toBe(false);
    expect([...plan.folds.saved.foldedLaneIds].toSorted()).toEqual(["core", "edge"]);
    expect([...plan.folds.saved.openedInitiativeIds]).toEqual([]);
    expect(plan.changing.map((target) => target.id)).toEqual(["core", "edge", row.id]);
  });

  it("opens the lanes when all are folded and no row is open", () => {
    const folds = buildBoardFolds({ saved: { foldedLaneIds: ["core", "edge"] } });
    const plan = planFoldEverything(folds, targets);

    expect(plan.isOpening).toBe(true);
    expect([...plan.folds.saved.foldedLaneIds]).toEqual([]);
    expect(plan.changing.map((target) => target.id)).toEqual(["core", "edge"]);
  });

  it("folds rather than opens when all lanes are folded but a row is open, and changes only the row", () => {
    const folds = buildBoardFolds({
      saved: { foldedLaneIds: ["core", "edge"], openedInitiativeIds: ["platform"] },
    });
    const plan = planFoldEverything(folds, targets);

    expect(plan.isOpening).toBe(false);
    expect(plan.changing.map((target) => target.id)).toEqual([row.id]);
  });

  it("counts an opened row of an Initiative that has no row on the board as an open row", () => {
    const folds = buildBoardFolds({
      saved: { foldedLaneIds: ["core", "edge"], openedInitiativeIds: ["elsewhere"] },
    });

    expect(planFoldEverything(folds, [core, edge]).isOpening).toBe(false);
  });

  it("treats rows as lanes while a filter is on", () => {
    const filtering = buildBoardFolds({ isFiltering: true });
    const folding = planFoldEverything(filtering, targets);

    expect(folding.isOpening).toBe(false);
    expect([...folding.folds.sinceFilter.foldedLaneIds].toSorted()).toEqual(["core", "edge"]);
    expect([...folding.folds.sinceFilter.foldedInitiativeIds]).toEqual(["platform"]);
    expect(folding.folds.saved).toEqual(filtering.saved);

    const opening = planFoldEverything(folding.folds, targets);
    expect(opening.isOpening).toBe(true);
    expect(opening.folds.sinceFilter).toEqual(EMPTY_FILTER_FOLDS);
    expect(opening.changing).toHaveLength(3);
  });

  it("changes nothing when there is nothing to fold", () => {
    const plan = planFoldEverything(buildBoardFolds(), []);

    expect(plan.changing).toEqual([]);
  });
});
