/** Tests which card the pane reads a Task from. */
import { describe, expect, it } from "vitest";
import { buildCard } from "./cards.testing";
import { chooseTaskCard } from "./task-card";

describe("the card the pane reads a Task from", () => {
  const onBoard = buildCard("a", { title: "On the board" });
  const inDetail = buildCard("a", { title: "In the details" });

  it("prefers the board's card, which is the newer", () => {
    expect(chooseTaskCard([onBoard], "a", { card: inDetail })).toBe(onBoard);
  });

  it("falls back to the card of the details when the board has none", () => {
    expect(chooseTaskCard([buildCard("b")], "a", { card: inDetail })).toBe(inDetail);
  });

  it("has none when neither does", () => {
    expect(chooseTaskCard([], "a", undefined)).toBeUndefined();
  });
});
