/** Tests Find: narrowing by title and the list of top matches. */
import { describe, expect, it } from "vitest";
import { buildCard, listIds } from "./cards.testing";
import { findCardsByTitle } from "./find";

const CARDS = [
  buildCard("a", { title: "Add a refund button" }),
  buildCard("b", { title: "Refund emails show the wrong currency", stage: "landed" }),
  buildCard("c", { title: "Basket sync drops items" }),
  buildCard("d", { title: "REFUND window for depots", stage: "building" }),
];

describe("findCardsByTitle", () => {
  it("narrows by title ignoring case, in the order given", () => {
    expect(listIds(findCardsByTitle(CARDS, "refund").matches)).toEqual(["a", "b", "d"]);
  });

  it("ignores spaces at either end of the text", () => {
    expect(listIds(findCardsByTitle(CARDS, "  basket ").matches)).toEqual(["c"]);
  });

  it("lists the top matches with Landed last", () => {
    expect(listIds(findCardsByTitle(CARDS, "refund").topMatches)).toEqual(["a", "d", "b"]);
  });

  it("lists at most eight top matches but narrows to all", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      buildCard(`m${String(index)}`, { title: `Refund ${String(index)}` }),
    );
    const found = findCardsByTitle(many, "refund");
    expect(found.matches).toHaveLength(12);
    expect(found.topMatches).toHaveLength(8);
  });

  it("finds nothing for a text no title holds", () => {
    expect(findCardsByTitle(CARDS, "zzz")).toEqual({ matches: [], topMatches: [] });
  });

  it("leaves all cards and lists no matches for an empty text", () => {
    expect(findCardsByTitle(CARDS, "  ")).toEqual({ matches: CARDS, topMatches: [] });
  });
});
