import { describe, expect, it } from "vitest";
import { decodeWorkflowDefinition } from "@hercule/contract";
import { buildRunGraph, buildWorkflowGraph } from "@hercule/client-core";
import { buildWorkflowRows } from "../screens/workflows/workflow-rows";
import { SPECIMEN_NOW } from "./sidebar-fixture";
import { buildShipReleaseFrames, SHIP_RELEASE_ID, WORKFLOWS_RECORDS } from "./workflows-fixture";

describe("the Workflows specimen's fixture", () => {
  it("holds definitions the controller would accept", () => {
    for (const { definition } of WORKFLOWS_RECORDS.definitions) {
      const decoded = decodeWorkflowDefinition(definition);
      expect(decoded, definition.name).toMatchObject({ _tag: "Success" });
    }
  });

  it("draws Ship release's newest run as the specimen describes it", () => {
    const run = WORKFLOWS_RECORDS.runs.find(
      (candidate) => candidate.workflowId === SHIP_RELEASE_ID,
    )!;
    const graph = buildRunGraph(run);
    const states = Object.fromEntries(graph.nodes.map((node) => [node.id, node.progress?.state]));
    expect(states).toMatchObject({
      changelog: "completed",
      security: "running",
      test: "completed",
      review: "completed",
      fix: "completed",
      open_pr: "pending",
      announce: "unreached",
      notify: "unreached",
    });
    expect(graph.edges.find((edge) => edge.from === "fix")?.traversalBadge).toBe("1/3");
    expect(buildWorkflowGraph(run.plan).nodes).toHaveLength(11);
  });

  it.each(["completed", "failed"] as const)(
    "plays Ship release's newest run until it is %s",
    (ending) => {
      const frames = buildShipReleaseFrames(ending);
      const newest = WORKFLOWS_RECORDS.runs.find(
        (candidate) => candidate.workflowId === SHIP_RELEASE_ID,
      )!;
      expect(new Set(frames.map(({ run }) => run.id))).toEqual(new Set([newest.id]));
      // The fourth moment is the newest run of the records: security waits on the user.
      expect(frames.map(({ recentRun }) => recentRun.waitingOnUser)).toEqual(
        frames.map((_, index) => index === 3),
      );
      expect(frames.at(-1)!.run.status).toBe(ending);
      const finalStates = buildRunGraph(frames.at(-1)!.run).nodes.map(
        (node) => node.progress?.state,
      );
      expect(finalStates).not.toContain("running");
      expect(finalStates).not.toContain("pending");
    },
  );

  it("fills every group of the workflow list, and every kind of row", () => {
    const { workflows, triggers, runSessions } = WORKFLOWS_RECORDS;
    const rows = buildWorkflowRows(workflows, triggers, runSessions, "UTC", new Date(SPECIMEN_NOW));
    const findRow = (name: string) => rows.find((row) => row.name === name)!;
    expect(rows.slice(0, 10).map((row) => [row.group, row.name])).toEqual([
      ["needsYou", "Rotate prod keys"],
      ["needsYou", "Ship release"],
      ["failing", "Label new issues"],
      ["failing", "Nightly backup check"],
      ["failing", "Reload staging"],
      ["failing", "Watch flaky tests"],
      ["running", "Fix bug"],
      ["running", "Investigate"],
      ["running", "Review dependabot"],
      ["running", "Translate docs"],
    ]);
    expect(findRow("Ship release")).toMatchObject({
      status: { text: "security asks: Run npm audit fix --force?" },
      nextText: "Fri 14:00",
      successText: "83%",
    });
    expect(findRow("Ship release").strip).toHaveLength(20);
    expect(findRow("Label new issues").status.text).toBe("issue_opened: No such key: labels");
    expect(findRow("Fix bug").status.text).toBe("2 runs · at fix");
    expect(findRow("Summarize standup")).toMatchObject({
      startsOn: { text: "Weekdays at 09:00 (Europe/London)" },
      timeText: "08:00",
      nextText: "Wed 08:00",
    });
    expect(rows.filter((row) => row.isOff).map((row) => [row.name, row.nextText])).toEqual([
      ["Prune branches", "Off"],
      ["Refresh demo data", "Off"],
      ["Rotate secrets", "Off"],
      ["Weekly metrics", "Paused"],
    ]);
  });
});
