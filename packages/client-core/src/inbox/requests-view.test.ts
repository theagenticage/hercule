/** Tests the words that sum up the Requests column's Show, Group and Sort choices. */
import { describe, expect, it } from "vitest";
import { describeRequestsView, SHOW_ALL, type RequestsView } from "./requests-view";

const DEFAULTS: RequestsView = { show: SHOW_ALL, grouping: "none", sort: "oldest" };

describe("describeRequestsView", () => {
  it.each<[string, Partial<RequestsView>, string | undefined]>([
    ["says nothing for the defaults", {}, undefined],
    ["names Mine", { show: { kind: "mine" } }, "Mine"],
    ["names the person", { show: { kind: "person", name: "Tessa Vane" } }, "Tessa Vane"],
    ["names the grouping", { grouping: "place" }, "By place"],
    ["names the sort", { sort: "newest" }, "Newest first"],
    [
      "joins every choice in the order Show, Group, Sort",
      { show: { kind: "mine" }, grouping: "place", sort: "newest" },
      "Mine · By place · Newest first",
    ],
    [
      "skips a choice that is the default",
      { grouping: "place", sort: "newest" },
      "By place · Newest first",
    ],
  ])("%s", (_name, overrides, words) => {
    expect(describeRequestsView({ ...DEFAULTS, ...overrides })).toBe(words);
  });

  it("does not shorten a long name", () => {
    const name = "A very long name that the control must cut by its own width";
    expect(describeRequestsView({ ...DEFAULTS, show: { kind: "person", name } })).toBe(name);
  });
});
