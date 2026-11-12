import { describe, expect, it } from "vitest";
import { findHolder } from "./inbox-holder";

const WORKFLOW = { workflowId: "w1", name: "Review PR" };

describe("findHolder", () => {
  it("prefers a live workflow over the user", () => {
    expect(findHolder({ liveWorkflows: [WORKFLOW], takenOn: true })).toEqual({
      kind: "colleague",
      workflowId: "w1",
      name: "Review PR",
    });
  });

  it("names the user when they took the thing on and nothing is live on it", () => {
    expect(findHolder({ liveWorkflows: [], takenOn: true })).toEqual({ kind: "you" });
  });

  it("names nobody for a Task the user did not take on", () => {
    expect(findHolder({ liveWorkflows: [], takenOn: false })).toBeUndefined();
  });
});
