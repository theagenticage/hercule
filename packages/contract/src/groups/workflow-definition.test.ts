/**
 * Tests the walk along a workflow's edges that the controller and the run
 * graph both use to find the steps a set of steps can lead to.
 */
import { describe, expect, it } from "vitest";
import { collectReachableSteps } from "./workflow-definition";

describe("collecting the steps reachable from some steps", () => {
  it("includes the starting steps and every step a path of edges leads to", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "x", to: "y" },
    ];
    expect([...collectReachableSteps(edges, ["a"])].sort()).toEqual(["a", "b", "c"]);
  });

  it("returns only the starting steps when no edge leaves them", () => {
    expect([...collectReachableSteps([{ from: "a", to: "b" }], ["b", "z"])].sort()).toEqual([
      "b",
      "z",
    ]);
  });

  it("stops at a loop instead of walking it forever", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
      { from: "b", to: "c" },
    ];
    expect([...collectReachableSteps(edges, ["b"])].sort()).toEqual(["a", "b", "c"]);
  });

  it("follows every edge, whatever its condition or limit", () => {
    const edges = [
      { from: "a", to: "b", condition: "${{ false }}", maxTraversals: 1 },
      { from: "b", to: "c", maxTraversals: 0 },
    ];
    expect([...collectReachableSteps(edges, ["a"])].sort()).toEqual(["a", "b", "c"]);
  });

  it("returns an empty set when it starts from no step", () => {
    expect(collectReachableSteps([{ from: "a", to: "b" }], []).size).toBe(0);
  });
});
