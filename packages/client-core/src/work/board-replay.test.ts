/** Tests how a snapshot of the last board and the first read of a new session become a replay. */
import { describe, expect, it } from "vitest";
import {
  buildBoardSnapshot,
  MOST_REPLAYED_CHANGES,
  planMorningReplay,
  summarizeCardMoves,
} from "./board-replay";
import { buildBoard, buildCard, listIds } from "./cards.testing";
import { holdBackBoardChanges } from "./hold-back-board";
import { listCardMoves } from "./list-card-moves";

const NOTHING = new Set<string>();
const MERGED = {
  kind: "fact" as const,
  factId: 4,
  ref: "github:pull-request:6221",
  text: "Pull request #6221 merged",
};

/** Returns a card that landed at the given time of 2 November 2026. */
const buildLanded = (id: string, hour: number) =>
  buildCard(id, {
    stage: "landed",
    stageChangedAt: `2026-11-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    stageCause: MERGED,
  });

describe("buildBoardSnapshot", () => {
  it("keeps only where each card stands and why, in the board's order", () => {
    const board = buildBoard(
      buildCard("a", { title: "Secret", projectId: "depots" }),
      buildLanded("b", 3),
    );

    expect(buildBoardSnapshot(board)).toEqual({
      cards: [
        { id: "a", stage: "exploring", projectId: "depots" },
        { id: "b", stage: "landed", stageCause: MERGED },
      ],
      isTruncated: false,
    });
  });
});

describe("summarizeCardMoves", () => {
  it("counts what landed, what moved elsewhere and what is new, in that order", () => {
    const previous = buildBoard(
      buildCard("a", { stage: "in-review" }),
      buildCard("b", { stage: "in-review" }),
      buildCard("c"),
      buildCard("gone"),
    );
    const next = buildBoard(
      buildCard("a", { stage: "landed" }),
      buildCard("b", { stage: "landed" }),
      buildCard("c", { stage: "building" }),
      buildCard("new"),
    );

    expect(summarizeCardMoves(listCardMoves(previous, next))).toBe(
      "Since you last looked: two landed, one moved, one new",
    );
  });

  it("spells counts from one to nine, and writes larger ones in digits", () => {
    const ids = Array.from({ length: 10 }, (_, index) => `card-${String(index)}`);
    const previous = buildBoard(...ids.map((id) => buildCard(id, { stage: "in-review" })));
    const next = buildBoard(...ids.map((id) => buildCard(id, { stage: "landed" })));

    expect(summarizeCardMoves(listCardMoves(previous, next))).toBe(
      "Since you last looked: 10 landed",
    );
    expect(summarizeCardMoves(listCardMoves(previous, buildBoard(...next.cards.slice(0, 9))))).toBe(
      "Since you last looked: nine landed",
    );
  });

  it("says nothing when nothing landed, moved or arrived, even if a card left", () => {
    const previous = buildBoard(buildCard("a"), buildCard("gone"));
    const next = buildBoard(buildCard("a"));

    expect(summarizeCardMoves(listCardMoves(previous, next))).toBeNull();
  });
});

describe("planMorningReplay", () => {
  it("plans nothing when the board is as the snapshot remembers it", () => {
    const board = buildBoard(buildCard("a"), buildCard("b", { stage: "building" }));

    expect(planMorningReplay(buildBoardSnapshot(board), board)).toBeUndefined();
  });

  it("plans nothing when only a card left, or when either board was cut short", () => {
    const before = buildBoard(buildCard("a"), buildCard("b"));
    const snapshot = buildBoardSnapshot(before);

    expect(planMorningReplay(snapshot, buildBoard(buildCard("a")))).toBeUndefined();
    const arrived = buildBoard(buildCard("a"), buildCard("b"), buildCard("c"));
    expect(planMorningReplay({ ...snapshot, isTruncated: true }, arrived)).toBeUndefined();
    expect(planMorningReplay(snapshot, { ...arrived, truncated: true })).toBeUndefined();
  });

  it("starts from the snapshot's stages, holds what it plays, and ends on the read", () => {
    const before = buildBoard(
      buildCard("a", { stage: "in-review" }),
      buildCard("b", { stage: "in-review" }),
      buildCard("c", { stage: "in-review" }),
    );
    const read = buildBoard(
      buildCard("a", { stage: "in-review" }),
      buildLanded("b", 3),
      buildCard("c", { stage: "in-review" }),
      buildCard("new", { createdAt: "2026-11-02T05:00:00.000Z" }),
    );

    const plan = planMorningReplay(buildBoardSnapshot(before), read)!;

    expect(plan.summary).toBe("Since you last looked: one landed, one new");
    expect(plan.playedKeys).toEqual(["move:b:fact-4", "arrival:new"]);

    const start = holdBackBoardChanges(plan.shown, read, {
      released: NOTHING,
      hiddenBefore: NOTHING,
      playedKeys: new Set(plan.playedKeys),
    });
    expect(start.board.cards.map((card) => [card.id, card.stage])).toEqual([
      ["a", "in-review"],
      ["b", "in-review"],
      ["c", "in-review"],
    ]);
    expect(start.held.map((change) => change.key)).toEqual(plan.playedKeys);

    const end = holdBackBoardChanges(plan.shown, read, {
      released: new Set(plan.playedKeys),
      hiddenBefore: NOTHING,
      playedKeys: new Set(plan.playedKeys),
    });
    expect(end.board.cards.map((card) => [card.id, card.stage])).toEqual([
      ["a", "in-review"],
      ["b", "landed"],
      ["c", "in-review"],
      ["new", "exploring"],
    ]);
    expect(end.held).toEqual([]);
  });

  it("puts a card that will move back in its old cell after the card that stood before it", () => {
    const before = buildBoard(
      buildCard("x", { stage: "in-review" }),
      buildCard("y", { stage: "in-review" }),
      buildCard("z", { stage: "in-review" }),
    );
    // The controller put the moved card last in its new cell, and "y" stays.
    const read = buildBoard(
      buildCard("x", { stage: "in-review" }),
      buildCard("z", { stage: "in-review" }),
      buildLanded("y", 4),
    );

    const plan = planMorningReplay(buildBoardSnapshot(before), read)!;
    const start = holdBackBoardChanges(plan.shown, read, {
      released: NOTHING,
      hiddenBefore: NOTHING,
      playedKeys: new Set(plan.playedKeys),
    });

    expect(listIds(start.board.cards.filter((card) => card.stage === "in-review"))).toEqual([
      "x",
      "y",
      "z",
    ]);
  });

  it("plays a move that came with no cause, and holds it like any other", () => {
    const before = buildBoard(buildCard("a", { stage: "building" }));
    const read = buildBoard(
      buildCard("a", { stage: "planned", stageChangedAt: "2026-11-02T03:00:00.000Z" }),
    );

    const plan = planMorningReplay(buildBoardSnapshot(before), read)!;

    expect(plan.summary).toBe("Since you last looked: one moved");
    expect(plan.playedKeys).toEqual(["move:a:2026-11-02T03:00:00.000Z"]);
  });

  it("plays the newest changes in the order they happened and draws the older ones at once", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const before = buildBoard(...ids.map((id) => buildCard(id, { stage: "in-review" })));
    // "f" landed first and "a" last, so the order of the board is not the order of the night.
    const read = buildBoard(...ids.map((id, index) => buildLanded(id, 10 - index)));

    const plan = planMorningReplay(buildBoardSnapshot(before), read)!;

    expect(plan.summary).toBe("Since you last looked: six landed");
    expect(plan.playedKeys).toHaveLength(MOST_REPLAYED_CHANGES);
    expect(plan.playedKeys).toEqual([
      "move:d:fact-4",
      "move:c:fact-4",
      "move:b:fact-4",
      "move:a:fact-4",
    ]);
    const start = holdBackBoardChanges(plan.shown, read, {
      released: NOTHING,
      hiddenBefore: NOTHING,
      playedKeys: new Set(plan.playedKeys),
    });
    const inStage = (stage: string): readonly string[] =>
      listIds(start.board.cards.filter((card) => card.stage === stage));
    expect(inStage("in-review")).toEqual(["a", "b", "c", "d"]);
    expect(inStage("landed")).toEqual(["e", "f"]);
  });
});
