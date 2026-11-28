import { describe, expect, it } from "vitest";
import { decideMachineTransitionTypes } from "./machine-transition";

const move = (from: string | undefined, to: string, isMotionReduced = false) =>
  decideMachineTransitionTypes(
    {
      ...(from === undefined ? {} : { fromLocation: { pathname: from } }),
      toLocation: { pathname: to },
    },
    isMotionReduced,
  );

describe("decideMachineTransitionTypes", () => {
  it.each([
    ["opening a machine's page", "/fleet", "/fleet/runner-1"],
    ["going back to Fleet", "/fleet/runner-1", "/fleet"],
    ["a path with a trailing slash", "/fleet/", "/fleet/runner-1/"],
  ])("runs the machine transition for %s", (_, from, to) => {
    // "fleet-machine" is the type machine-transition.css selects on, spelled out there too.
    expect(move(from, to)).toEqual(["fleet-machine"]);
  });

  it.each([
    ["from the first navigation", undefined, "/fleet"],
    ["into Fleet from another screen", "/workflows", "/fleet"],
    ["out of a machine's page to another screen", "/fleet/runner-1", "/workflows"],
    ["between two machines' pages", "/fleet/runner-1", "/fleet/runner-2"],
    ["from a machine's page to its activity", "/fleet/runner-1", "/fleet/runner-1/activity"],
    ["within a screen that only looks alike", "/fleetwood", "/fleet/runner-1"],
  ])("runs no transition for %s", (_, from, to) => {
    expect(move(from, to)).toBe(false);
  });

  it("runs no transition under Reduce motion", () => {
    expect(move("/fleet", "/fleet/runner-1", true)).toBe(false);
    expect(move("/fleet/runner-1", "/fleet", true)).toBe(false);
  });
});
