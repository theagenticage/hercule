/** Tests which cards moved, arrived or left between two reads of the board. */
import { describe, expect, it } from "vitest";
import { buildBoard, buildCard } from "./cards.testing";
import { listCardMoves } from "./list-card-moves";

const MERGED = { factId: 4, ref: "github:pull-request:6221", text: "Pull request #6221 merged" };

describe("listCardMoves", () => {
  it("lists nothing when no card changed stage", () => {
    const previous = buildBoard(buildCard("a"), buildCard("b", { stage: "building" }));
    const next = buildBoard(buildCard("b", { stage: "building" }), buildCard("a"));

    expect(listCardMoves(previous, next)).toEqual([]);
  });

  it.each([
    [
      "a fact moved it, with its words",
      buildCard("a", { stage: "landed", stageCause: MERGED }),
      { kind: "moved", cardId: "a", cause: MERGED },
    ],
    [
      "a drag from another client moved it, with no words",
      buildCard("a", { stage: "landed" }),
      { kind: "moved", cardId: "a" },
    ],
  ])("lists a card that changed stage when %s", (_, card, expected) => {
    const previous = buildBoard(buildCard("a", { stage: "in-review", projectId: "depots" }));
    const next = buildBoard({ ...card, projectId: "depots" });

    expect(listCardMoves(previous, next)).toEqual([
      {
        ...expected,
        from: { stage: "in-review", projectId: "depots" },
        to: { stage: "landed", projectId: "depots" },
      },
    ]);
  });

  it("names a card with no Project as null in its cells", () => {
    const previous = buildBoard(buildCard("a"));
    const next = buildBoard(buildCard("a", { stage: "planned" }));

    expect(listCardMoves(previous, next)).toEqual([
      {
        kind: "moved",
        cardId: "a",
        from: { stage: "exploring", projectId: null },
        to: { stage: "planned", projectId: null },
      },
    ]);
  });

  it("does not list a card that only changed Project or place", () => {
    const previous = buildBoard(buildCard("a", { projectId: "depots" }), buildCard("b"));
    const next = buildBoard(buildCard("b"), buildCard("a", { projectId: "pricing" }));

    expect(listCardMoves(previous, next)).toEqual([]);
  });

  it("lists a card that arrived, and a card that left", () => {
    const previous = buildBoard(buildCard("gone", { stage: "building", projectId: "depots" }));
    const next = buildBoard(buildCard("new", { stage: "planned" }));

    expect(listCardMoves(previous, next)).toEqual([
      { kind: "arrived", cardId: "new", to: { stage: "planned", projectId: null } },
      { kind: "left", cardId: "gone", from: { stage: "building", projectId: "depots" } },
    ]);
  });

  it("lists arrivals and moves in the order of the new board, then the cards that left", () => {
    const previous = buildBoard(
      buildCard("x", { stage: "building" }),
      buildCard("y"),
      buildCard("z"),
    );
    const next = buildBoard(
      buildCard("new"),
      buildCard("z", { stage: "planned" }),
      buildCard("y", { stage: "building" }),
    );

    expect(
      listCardMoves(previous, next).map((change) => `${change.kind}:${change.cardId}`),
    ).toEqual(["arrived:new", "moved:z", "moved:y", "left:x"]);
  });
});
