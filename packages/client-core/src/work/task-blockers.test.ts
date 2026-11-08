/** Tests the rows of Blocked by and Blocks, the Tasks that "Add a blocker" offers, and the words of each change. */
import { describe, expect, it } from "vitest";
import type { TaskStage } from "@hercule/contract";
import { buildCard } from "./cards.testing";
import {
  buildTaskBlockerSections,
  describeBlockerDone,
  describeBlockerFailure,
  describeBlockerGesture,
  describeBlockerLoopRefused,
  describeBlockerNothing,
  listBlockerCandidates,
  reverseBlockerDirection,
  type TaskBlockers,
} from "./task-blockers";

const task = (id: string, title: string, stage: TaskStage) => ({ id, title, stage });

const NO_BLOCKERS: TaskBlockers = { blockers: [], blockerCount: 0, blocks: [], blockCount: 0 };

describe("the rows of Blocked by", () => {
  it.each<{
    readonly stage: TaskStage;
    readonly stageName: string;
    readonly canOpen: boolean;
    readonly isQuiet: boolean;
  }>([
    { stage: "exploring", stageName: "Exploring", canOpen: true, isQuiet: false },
    { stage: "planned", stageName: "Planned", canOpen: true, isQuiet: false },
    { stage: "building", stageName: "Building", canOpen: true, isQuiet: false },
    { stage: "in-review", stageName: "In review", canOpen: true, isQuiet: false },
    // Landed is a board stage, so its row opens, but it no longer holds anything back.
    { stage: "landed", stageName: "Landed", canOpen: true, isQuiet: true },
    // Done and Dropped Tasks have no card: their rows are history.
    { stage: "done", stageName: "Done", canOpen: false, isQuiet: true },
    { stage: "dropped", stageName: "Dropped", canOpen: false, isQuiet: true },
  ])("reads a blocker at $stage as $stageName", ({ stage, ...row }) => {
    const { blockedBy } = buildTaskBlockerSections({
      ...NO_BLOCKERS,
      blockers: [task("t1", "Pack the crates", stage)],
      blockerCount: 1,
    });

    expect(blockedBy.rows).toEqual([{ id: "t1", title: "Pack the crates", ...row }]);
  });

  it("keeps the order the controller lists them in", () => {
    const { blockedBy } = buildTaskBlockerSections({
      ...NO_BLOCKERS,
      blockers: [task("t2", "Second", "planned"), task("t1", "First", "done")],
      blockerCount: 2,
    });

    expect(blockedBy.rows.map((row) => row.id)).toEqual(["t2", "t1"]);
  });
});

describe("the rows of Blocks", () => {
  it("opens a Task at a board stage and leaves a finished one plain, and none is quiet", () => {
    const { blocks } = buildTaskBlockerSections({
      ...NO_BLOCKERS,
      blocks: [task("t1", "Print labels", "building"), task("t2", "Ship the pallets", "done")],
      blockCount: 2,
    });

    expect(blocks.rows).toEqual([
      { id: "t1", title: "Print labels", stageName: "Building", canOpen: true, isQuiet: false },
      { id: "t2", title: "Ship the pallets", stageName: "Done", canOpen: false, isQuiet: false },
    ]);
  });
});

describe("the words for the Tasks past the list", () => {
  it.each([
    { listed: 0, total: 0, words: null },
    { listed: 2, total: 2, words: null },
    { listed: 2, total: 3, words: "and 1 more" },
    { listed: 50, total: 62, words: "and 12 more" },
  ])("says $words for $listed listed of $total", ({ listed, total, words }) => {
    const tasks = Array.from({ length: listed }, (_, index) =>
      task(`t${String(index)}`, `Task ${String(index)}`, "planned"),
    );
    const sections = buildTaskBlockerSections({
      blockers: tasks,
      blockerCount: total,
      blocks: tasks,
      blockCount: total,
    });

    expect(sections.blockedBy.moreWords).toBe(words);
    expect(sections.blocks.moreWords).toBe(words);
  });
});

describe("the Tasks Add a blocker offers", () => {
  const CARDS = [
    buildCard("t1", { title: "Restore a basket after sign-in" }),
    buildCard("t2", { title: "Restore the wishlist", stage: "landed" }),
    buildCard("t3", { title: "Restore stock counts" }),
    buildCard("t4", { title: "Print depot pick lists" }),
  ];
  const SCOPE = { taskId: "t1", blockedByIds: ["t3"] };

  it("offers nothing before the user types", () => {
    expect(listBlockerCandidates(CARDS, "  ", SCOPE)).toEqual([]);
  });

  it("leaves out the Task itself and the Tasks it waits on already, and puts Landed last", () => {
    expect(listBlockerCandidates(CARDS, "restore", SCOPE).map((card) => card.id)).toEqual(["t2"]);
    expect(
      listBlockerCandidates(CARDS, "restore", { taskId: "t4", blockedByIds: [] }).map(
        (card) => card.id,
      ),
    ).toEqual(["t1", "t3", "t2"]);
  });

  it("offers a card that waits on this Task, because the controller explains that refusal", () => {
    const waiting = buildCard("t5", {
      title: "Restock the shelves",
      blockedBy: [{ id: "t1", title: "Restore a basket after sign-in", stage: "planned" }],
      blockedByCount: 1,
    });

    expect(listBlockerCandidates([...CARDS, waiting], "restock", SCOPE)).toEqual([waiting]);
  });
});

describe("the words of a blocker change", () => {
  const TASK = "Restore a basket after sign-in";
  const BLOCKER = "Round loyalty points";

  it("names both Tasks in the gesture, the done line and the nothing line, for each direction", () => {
    expect(describeBlockerGesture("add", TASK, BLOCKER)).toBe(`Made ${TASK} wait on ${BLOCKER}`);
    expect(describeBlockerGesture("remove", TASK, BLOCKER)).toBe(
      `Took ${BLOCKER} off what ${TASK} waits on`,
    );
    expect(describeBlockerDone("add", TASK, BLOCKER)).toBe(`${TASK} now waits on ${BLOCKER}.`);
    expect(describeBlockerDone("remove", TASK, BLOCKER)).toBe(
      `${TASK} no longer waits on ${BLOCKER}.`,
    );
    expect(describeBlockerNothing("add", TASK, BLOCKER)).toBe(
      `${TASK} waited on ${BLOCKER} already, so nothing changed.`,
    );
    expect(describeBlockerNothing("remove", TASK, BLOCKER)).toBe(
      `${TASK} did not wait on ${BLOCKER}, so nothing was removed.`,
    );
  });

  it("gives the reason of a refusal and says what to do", () => {
    expect(describeBlockerFailure("add", TASK, BLOCKER, "That Task does not exist")).toBe(
      `${TASK} was not made to wait on ${BLOCKER}: That Task does not exist. Try again.`,
    );
    expect(describeBlockerFailure("remove", TASK, BLOCKER, "Offline")).toBe(
      `${BLOCKER} was not taken off what ${TASK} waits on: Offline. Try again.`,
    );
  });

  it("leaves the reason of a loop to the section, and does not say to try again", () => {
    expect(describeBlockerLoopRefused(TASK, BLOCKER)).toBe(
      `${TASK} was not made to wait on ${BLOCKER}.`,
    );
  });

  it("cuts a long title so the undo line stays short", () => {
    expect(describeBlockerDone("add", "A".repeat(80), BLOCKER)).toMatch(/^A{1,40}… now waits/);
  });

  it("reverses each direction", () => {
    expect(reverseBlockerDirection("add")).toBe("remove");
    expect(reverseBlockerDirection("remove")).toBe("add");
  });
});
