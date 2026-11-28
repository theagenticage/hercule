import { describe, expect, it } from "vitest";
import {
  BOARD_RANK_ALPHABET,
  chooseRankBetween,
  MAX_BOARD_RANK_LENGTH,
  spreadBoardRanks,
} from "./board-rank";

/** Checks that a rank only uses the alphabet and does not end in `0`. */
const isWellFormed = (rank: string): boolean =>
  rank !== "" && [...rank].every((c) => BOARD_RANK_ALPHABET.includes(c)) && !rank.endsWith("0");

describe("chooseRankBetween", () => {
  const cases: ReadonlyArray<readonly [string, string | undefined, string | undefined]> = [
    ["an empty cell", undefined, undefined],
    ["the first place", undefined, "V"],
    ["the first place before a rank starting with 1", undefined, "1"],
    ["the first place before a rank starting with 0", undefined, "0V"],
    ["the first place before a rank starting with 2", undefined, "2x"],
    ["the last place", "V", undefined],
    ["the last place after a rank starting with z", "z", undefined],
    ["the last place after a long z run", "zzz", undefined],
    ["two far ranks", "2", "x"],
    ["two neighbouring digits", "1", "2"],
    ["a rank and its extension", "V", "VV"],
    ["neighbours with a long common prefix", "Vab", "Vac"],
    ["a gap next to zero", "0V", "1"],
  ];

  it.each(cases)("puts a rank strictly between the neighbours: %s", (_name, before, after) => {
    const rank = chooseRankBetween(before, after);
    expect(rank).toBeDefined();
    expect(isWellFormed(rank!)).toBe(true);
    if (before !== undefined) expect(rank! > before).toBe(true);
    if (after !== undefined) expect(rank! < after).toBe(true);
  });

  it("reports that no rank fits when the neighbours are equal or reversed", () => {
    expect(chooseRankBetween("V", "V")).toBeUndefined();
    expect(chooseRankBetween("W", "V")).toBeUndefined();
  });

  it("reports that no rank fits when the result would pass the limit", () => {
    const longest = "V".repeat(MAX_BOARD_RANK_LENGTH);
    expect(chooseRankBetween(longest, `${longest}V`)).toBeUndefined();
    expect(chooseRankBetween("z".repeat(MAX_BOARD_RANK_LENGTH), undefined)).toBeUndefined();
  });

  it("keeps 1,000 inserts into one gap in order, spreading the cell when the limit is reached", () => {
    let ranks: Array<string> = ["V"];
    let spreads = 0;
    for (let insert = 0; insert < 1000; insert++) {
      // Always insert right after the first card: the worst gap.
      let rank = chooseRankBetween(ranks[0], ranks[1]);
      if (rank === undefined) {
        spreads++;
        ranks = [...spreadBoardRanks(ranks.length)];
        rank = chooseRankBetween(ranks[0], ranks[1]);
      }
      expect(rank).toBeDefined();
      expect(rank!.length).toBeLessThanOrEqual(MAX_BOARD_RANK_LENGTH);
      ranks.splice(1, 0, rank!);
      expect(ranks).toEqual([...ranks].sort());
      expect(new Set(ranks).size).toBe(ranks.length);
    }
    expect(spreads).toBeGreaterThan(0);
  });

  it("grows a rank by one character per 31 inserts at the end or the start", () => {
    let last: string | undefined;
    let first: string | undefined;
    for (let insert = 0; insert < 1000; insert++) {
      const next = chooseRankBetween(last, undefined)!;
      expect(last === undefined || next > last).toBe(true);
      last = next;
      const previous = chooseRankBetween(undefined, first)!;
      expect(first === undefined || previous < first).toBe(true);
      expect(isWellFormed(previous)).toBe(true);
      first = previous;
    }
    expect(last!.length).toBeLessThanOrEqual(Math.ceil(1000 / 31) + 1);
    expect(first!.length).toBeLessThanOrEqual(Math.ceil(1000 / 31) + 1);
  });
});

describe("spreadBoardRanks", () => {
  it.each([0, 1, 2, 3, 61, 62, 63, 500, 5000])(
    "gives %i distinct, well formed ranks in ascending order",
    (count) => {
      const ranks = spreadBoardRanks(count);
      expect(ranks).toHaveLength(count);
      expect(ranks.every(isWellFormed)).toBe(true);
      expect(ranks).toEqual([...ranks].sort());
      expect(new Set(ranks).size).toBe(count);
    },
  );

  it("leaves room to insert between any two neighbours and at both ends", () => {
    const ranks = spreadBoardRanks(100);
    for (let index = 0; index <= ranks.length; index++) {
      const rank = chooseRankBetween(ranks[index - 1], ranks[index]);
      expect(rank).toBeDefined();
      expect(rank!.length).toBeLessThanOrEqual(ranks[0]!.length + 1);
    }
  });
});
