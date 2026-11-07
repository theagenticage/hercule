/** Tests what a cell shows: the row limit, loud cards, failures leading, Landed as a line, filters. */
import { describe, expect, it } from "vitest";
import type { WorkCard } from "@hercule/contract";
import { arrangeCell, type CellView } from "./arrange-cell";
import { buildCard, FAILURE, listIds, QUESTION } from "./cards.testing";

/** Returns `count` plain cards named c1, c2, ... */
const buildPlain = (count: number): readonly WorkCard[] =>
  Array.from({ length: count }, (_, index) => buildCard(`c${String(index + 1)}`));

const CLOSED: CellView = { stage: "building", opened: false, filtered: false };

describe("arrangeCell", () => {
  it.each([0, 3, 4, 5])("shows all of a cell of %i cards, with no line", (count) => {
    const arranged = arrangeCell(buildPlain(count), CLOSED);
    expect(arranged.cards).toHaveLength(count);
    expect(arranged.foot).toBe("none");
    expect(arranged.hiddenCards).toEqual([]);
  });

  it("shows four cards and a '2 more' line for six", () => {
    const arranged = arrangeCell(buildPlain(6), CLOSED);
    expect(listIds(arranged.cards)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(listIds(arranged.hiddenCards)).toEqual(["c5", "c6"]);
    expect(arranged.foot).toBe("more");
  });

  it("counts '13 more' for seventeen cards", () => {
    const arranged = arrangeCell(buildPlain(17), CLOSED);
    expect(arranged.cards).toHaveLength(4);
    expect(arranged.hiddenCards).toHaveLength(13);
    expect(arranged.foot).toBe("more");
  });

  it("opens every card in place and offers Show fewer", () => {
    const arranged = arrangeCell(buildPlain(17), { ...CLOSED, opened: true });
    expect(arranged.cards).toHaveLength(17);
    expect(arranged.hiddenCards).toEqual([]);
    expect(arranged.foot).toBe("fewer");
  });

  it("offers no Show fewer for an opened cell that hides nothing", () => {
    const arranged = arrangeCell(buildPlain(5), { ...CLOSED, opened: true });
    expect(arranged.foot).toBe("none");
  });

  it("shows a card with a question past the fourth row, after the fourth", () => {
    const cards = [...buildPlain(8)];
    cards[6] = buildCard("asks", { openQuestion: QUESTION });
    const arranged = arrangeCell(cards, CLOSED);
    expect(listIds(arranged.cards)).toEqual(["c1", "c2", "c3", "c4", "asks"]);
    expect(arranged.hiddenCards).toHaveLength(3);
    expect(arranged.foot).toBe("more");
  });

  it("offers no line when everything past the fourth row is loud", () => {
    const cards = [
      ...buildPlain(3),
      buildCard("asks-1", { openQuestion: QUESTION }),
      buildCard("broke", { failure: FAILURE }),
      buildCard("asks-2", { openQuestion: QUESTION }),
    ];
    const arranged = arrangeCell(cards, CLOSED);
    expect(listIds(arranged.cards)).toEqual(["broke", "c1", "c2", "c3", "asks-1", "asks-2"]);
    expect(arranged.foot).toBe("none");
  });

  it("leads the cell with a failed card and keeps the stored order of the failed ones", () => {
    const cards = [
      buildCard("a"),
      buildCard("fail-2", { failure: FAILURE }),
      buildCard("b"),
      buildCard("fail-1", { failure: FAILURE }),
    ];
    expect(listIds(arrangeCell(cards, CLOSED).cards)).toEqual(["fail-2", "fail-1", "a", "b"]);
  });

  it("shows every failed card even when there are more than four", () => {
    const cards = Array.from({ length: 6 }, (_, index) =>
      buildCard(`f${String(index)}`, { failure: FAILURE }),
    );
    const arranged = arrangeCell([...cards, ...buildPlain(3)], CLOSED);
    expect(arranged.cards).toHaveLength(6);
    expect(arranged.hiddenCards).toHaveLength(3);
  });

  it("does not change the cards it is given", () => {
    const cards = [buildCard("a"), buildCard("f", { failure: FAILURE })];
    arrangeCell(cards, CLOSED);
    expect(listIds(cards)).toEqual(["a", "f"]);
  });

  it("lifts the limit when a filter is on", () => {
    const arranged = arrangeCell(buildPlain(17), { ...CLOSED, filtered: true });
    expect(arranged.cards).toHaveLength(17);
    expect(arranged.foot).toBe("none");
  });

  describe("Landed", () => {
    const LANDED: CellView = { stage: "landed", opened: false, filtered: false };

    it("shows three cards as one '3 landed' line", () => {
      const arranged = arrangeCell(buildPlain(3), LANDED);
      expect(arranged.cards).toEqual([]);
      expect(arranged.hiddenCards).toHaveLength(3);
      expect(arranged.foot).toBe("landed");
    });

    it("shows a failed card as a card above the line, which counts the others", () => {
      const cards = [buildCard("a"), buildCard("broke", { failure: FAILURE }), buildCard("b")];
      const arranged = arrangeCell(cards, LANDED);
      expect(listIds(arranged.cards)).toEqual(["broke"]);
      expect(listIds(arranged.hiddenCards)).toEqual(["a", "b"]);
      expect(arranged.foot).toBe("landed");
    });

    it("shows a card with a question as a card above the line", () => {
      const arranged = arrangeCell(
        [buildCard("a"), buildCard("asks", { openQuestion: QUESTION })],
        LANDED,
      );
      expect(listIds(arranged.cards)).toEqual(["asks"]);
    });

    it("has no line when every card is loud", () => {
      const arranged = arrangeCell([buildCard("broke", { failure: FAILURE })], LANDED);
      expect(arranged.foot).toBe("none");
    });

    it("opens like any cell, failed card first", () => {
      const cards = [buildCard("a"), buildCard("broke", { failure: FAILURE })];
      const arranged = arrangeCell(cards, { ...LANDED, opened: true });
      expect(listIds(arranged.cards)).toEqual(["broke", "a"]);
      expect(arranged.foot).toBe("fewer");
    });

    it("shows every card when a filter is on", () => {
      const arranged = arrangeCell(buildPlain(3), { ...LANDED, filtered: true });
      expect(arranged.cards).toHaveLength(3);
      expect(arranged.foot).toBe("none");
    });

    it("has no line for an empty cell", () => {
      expect(arrangeCell([], LANDED).foot).toBe("none");
    });
  });
});
