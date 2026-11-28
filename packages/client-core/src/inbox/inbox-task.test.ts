import { describe, expect, it } from "vitest";
import { describeTaskActivity } from "./inbox-task";

const TASK = { id: "t1", title: "Install with Bun", workingThreadCount: 0 };
const review = { workflowId: "w1", name: "Review PR" };
const triage = { workflowId: "w2", name: "Triage" };
const deploy = { workflowId: "w3", name: "Deploy" };

describe("describeTaskActivity", () => {
  it("says nothing runs on a Task with no live workflow and no working Thread", () => {
    expect(describeTaskActivity({ task: TASK, liveWorkflows: [] })).toBeUndefined();
  });

  it("names up to two workflows and counts more", () => {
    expect(describeTaskActivity({ task: TASK, liveWorkflows: [review] })).toBe("Review PR running");
    expect(describeTaskActivity({ task: TASK, liveWorkflows: [review, triage] })).toBe(
      "Review PR and Triage running",
    );
    expect(describeTaskActivity({ task: TASK, liveWorkflows: [review, triage, deploy] })).toBe(
      "3 workflows running",
    );
  });

  it("counts working Threads, beside the workflows", () => {
    expect(
      describeTaskActivity({ task: { ...TASK, workingThreadCount: 1 }, liveWorkflows: [] }),
    ).toBe("1 thread working");
    expect(
      describeTaskActivity({ task: { ...TASK, workingThreadCount: 2 }, liveWorkflows: [review] }),
    ).toBe("Review PR running · 2 threads working");
  });

  it("names a workflow just handed the thing before its Task is known", () => {
    expect(describeTaskActivity({ liveWorkflows: [review] })).toBe("Review PR running");
  });
});
