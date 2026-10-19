/** Tests the text cutting and the listing budget that the skills listing shares. */
import { describe, expect, it } from "vitest";
import { MAX_LISTING_ENTRIES, buildListingBudget, fitText, shortenText, spendEntry } from "./files";

describe("fitText", () => {
  it("keeps text that fits and cuts longer text to the limit, ending in an ellipsis", () => {
    expect(fitText("abc", 5)).toBe("abc");
    expect(fitText("abcdef", 5)).toBe("ab...");
  });

  it("never splits a surrogate pair, and never exceeds the limit", () => {
    // Each emoji is two UTF-16 code units, so the cut at 3 code units falls inside the second one.
    const cut = fitText("😀😀😀😀", 6);
    expect(cut).toBe("😀...");
    expect(cut.length).toBeLessThanOrEqual(6);
  });
});

describe("shortenText", () => {
  it("keeps the first characters and adds an ellipsis only when it cut", () => {
    expect(shortenText("abc", 3)).toBe("abc");
    expect(shortenText("abcd", 3)).toBe("abc...");
    expect(shortenText("😀😀", 3)).toBe("😀...");
  });
});

describe("spendEntry", () => {
  it("spends entries until none is left, then reports the budget spent", () => {
    const budget = buildListingBudget(new AbortController().signal);
    budget.entriesLeft = 2;
    expect([spendEntry(budget), spendEntry(budget), spendEntry(budget)]).toEqual([
      true,
      true,
      false,
    ]);
    expect(budget.isSpent).toBe(true);
  });

  it("starts with the listing's limit", () => {
    expect(buildListingBudget(new AbortController().signal).entriesLeft).toBe(MAX_LISTING_ENTRIES);
  });

  it("throws the abort reason once the time is over", () => {
    const controller = new AbortController();
    const budget = buildListingBudget(controller.signal);
    controller.abort(new Error("out of time"));
    expect(() => spendEntry(budget)).toThrow("out of time");
  });
});
