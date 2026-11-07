/** Tests which cards stay selected, and the words for what the user can do with them. */
import { describe, expect, it } from "vitest";
import {
  describeCardsEnd,
  describeCardsLeftAsTheyAre,
  describeSelectedCount,
  keepShownSelectedIds,
  listSelectedIds,
  toggleSelectedId,
} from "./selection";

describe("toggleSelectedId", () => {
  it("adds an id that is not selected and takes out one that is, without changing the set given", () => {
    const none = new Set<string>();
    const one = toggleSelectedId(none, "a");

    expect([...one]).toEqual(["a"]);
    expect([...none]).toEqual([]);
    expect([...toggleSelectedId(one, "a")]).toEqual([]);
  });
});

describe("keepShownSelectedIds", () => {
  it("returns the same set when every id is shown, so nothing draws again", () => {
    const selected = new Set(["a", "b"]);

    expect(keepShownSelectedIds(selected, ["b", "a", "c"])).toBe(selected);
  });

  it("drops the ids the board no longer shows", () => {
    expect([...keepShownSelectedIds(new Set(["a", "b", "c"]), ["a", "c"])]).toEqual(["a", "c"]);
  });
});

describe("listSelectedIds", () => {
  it("lists the selected ids in the order the board draws them, not the order they were selected", () => {
    expect(listSelectedIds(new Set(["c", "a"]), ["a", "b", "c", "d"])).toEqual(["a", "c"]);
  });
});

describe("the words for a selection", () => {
  it.each([
    [1, "1 selected"],
    [3, "3 selected"],
  ])("counts %i cards", (count, words) => {
    expect(describeSelectedCount(count)).toBe(words);
  });

  it.each([
    [3, "done" as const, "Marked 3 Tasks Done"],
    [12, "dropped" as const, "Dropped 12 Tasks"],
  ])("says what ending %i cards as %s did", (count, stage, words) => {
    expect(describeCardsEnd(count, stage)).toBe(words);
  });

  it.each([
    [1, "1 Task could not be put back, so it stayed as it is."],
    [2, "2 Tasks could not be put back, so they stayed as they are."],
  ])("says how many of a group Undo left alone (%i)", (count, words) => {
    expect(describeCardsLeftAsTheyAre(count)).toBe(words);
  });
});
