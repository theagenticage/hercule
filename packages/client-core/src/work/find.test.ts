/** Tests Find: narrowing by title and summary, and the list of top matches. */
import { describe, expect, it } from "vitest";
import { buildCard, buildSummary, listIds } from "./cards.testing";
import { findCards } from "./find";

const CARDS = [
  buildCard("a", { title: "Add a refund button" }),
  buildCard("b", { title: "Refund emails show the wrong currency", stage: "landed" }),
  buildCard("c", { title: "Basket sync drops items" }),
  buildCard("d", { title: "REFUND window for depots", stage: "building" }),
];

describe("findCards", () => {
  it.each([
    ["the title", "refund button", ["a"]],
    ["the card line of a summary", "depots worried", ["e"]],
    ["where a summary says it stands, ignoring case", "STUCK ON THE CARRIER", ["e"]],
    ["what a summary says is left", "carrier contract", ["f"]],
    ["a stale summary", "stale words", ["g"]],
  ])("finds a card by %s", (_, text, ids) => {
    const cards = [
      buildCard("a", { title: "Add a refund button" }),
      buildCard("e", {
        title: "Plan the depot move",
        summary: buildSummary("Three designs, depots worried.", {
          standing: "Stuck on the carrier quote.",
        }),
      }),
      buildCard("f", {
        title: "Tidy labels",
        summary: buildSummary("Labels done.", { left: "Sign the carrier contract." }),
      }),
      buildCard("g", {
        title: "Basket sync",
        summary: buildSummary("Some stale words.", { stale: true }),
      }),
    ];
    expect(listIds(findCards(cards, text).matches)).toEqual(ids);
  });

  it("narrows by title ignoring case, in the order given", () => {
    expect(listIds(findCards(CARDS, "refund").matches)).toEqual(["a", "b", "d"]);
  });

  it("ignores spaces at either end of the text", () => {
    expect(listIds(findCards(CARDS, "  basket ").matches)).toEqual(["c"]);
  });

  it("lists the top matches with Landed last", () => {
    expect(listIds(findCards(CARDS, "refund").topMatches)).toEqual(["a", "d", "b"]);
  });

  it("lists at most eight top matches but narrows to all", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      buildCard(`m${String(index)}`, { title: `Refund ${String(index)}` }),
    );
    const found = findCards(many, "refund");
    expect(found.matches).toHaveLength(12);
    expect(found.topMatches).toHaveLength(8);
  });

  it("finds nothing for a text no title holds", () => {
    expect(findCards(CARDS, "zzz")).toEqual({ matches: [], topMatches: [] });
  });

  it("leaves all cards and lists no matches for an empty text", () => {
    expect(findCards(CARDS, "  ")).toEqual({ matches: CARDS, topMatches: [] });
  });
});
