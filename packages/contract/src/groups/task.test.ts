import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { MAX_FILTER_VALUES, MAX_PROVENANCE_APPEND, MAX_TASK_LABELS } from "../index";
import {
  HandoffLeg,
  MAX_LEG_LIVE_RUNS,
  MAX_LEG_QUERY_RUNS,
  TASK_STAGES,
  TaskCreateInput,
  TaskFilter,
  TaskMoveInput,
  TaskUpdateCall,
  TaskUpdateInput,
  BOARD_STAGES,
  task,
} from "./task";

const decodeOutcome = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  input: unknown,
) => Effect.runSyncExit(Schema.decodeUnknownEffect(schema)(input))._tag;

const buildLabels = (count: number) =>
  Array.from({ length: count }, (_, index) => `label-${String(index)}`);

describe("the bounds on a task's lists", () => {
  it("accepts a list at the cap, and rejects a list one longer", () => {
    expect(
      decodeOutcome(TaskCreateInput, {
        title: "t",
        description: "",
        labels: buildLabels(MAX_TASK_LABELS),
      }),
    ).toBe("Success");
    expect(
      decodeOutcome(TaskCreateInput, {
        title: "t",
        description: "",
        labels: buildLabels(MAX_TASK_LABELS + 1),
      }),
    ).toBe("Failure");
  });

  it("bounds both sides of a label edit", () => {
    expect(decodeOutcome(TaskUpdateInput, { addLabels: buildLabels(MAX_TASK_LABELS + 1) })).toBe(
      "Failure",
    );
    expect(decodeOutcome(TaskUpdateInput, { removeLabels: buildLabels(MAX_TASK_LABELS + 1) })).toBe(
      "Failure",
    );
  });

  it("bounds one call's provenance append", () => {
    const buildEntries = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ref: `github:issue:owner/repo#${String(index)}`,
      }));
    expect(
      decodeOutcome(TaskUpdateInput, { provenance: buildEntries(MAX_PROVENANCE_APPEND) }),
    ).toBe("Success");
    expect(
      decodeOutcome(TaskUpdateInput, { provenance: buildEntries(MAX_PROVENANCE_APPEND + 1) }),
    ).toBe("Failure");
  });

  it("bounds every list of values a filter takes", () => {
    expect(decodeOutcome(TaskFilter, { labels: buildLabels(MAX_FILTER_VALUES + 1) })).toBe(
      "Failure",
    );
    expect(
      decodeOutcome(TaskFilter, {
        status: Array.from({ length: MAX_FILTER_VALUES + 1 }, () => "open"),
      }),
    ).toBe("Failure");
    expect(
      decodeOutcome(TaskFilter, {
        refs: Array.from({ length: MAX_FILTER_VALUES + 1 }, () => "github:issue:owner/repo#1"),
      }),
    ).toBe("Failure");
  });
});

describe("the fields of a provenance entry that the core writes", () => {
  it("are refused in an entry a request writes: at and actor", () => {
    for (const stamp of [
      { at: "2026-09-04T10:00:00.000Z" },
      { actor: "session:0199e0e7-0002-7000-8000-00000000" },
    ]) {
      const provenance = [{ ref: "github:issue:owner/repo#42", ...stamp }];
      expect(decodeOutcome(TaskCreateInput, { title: "t", description: "", provenance })).toBe(
        "Failure",
      );
      expect(decodeOutcome(TaskUpdateInput, { provenance })).toBe("Failure");
    }
  });
});

describe("the signal a provenance entry records", () => {
  const SIGNAL_ID = "0199e0e7-0005-7000-8000-000000000000";
  const RUN_ID = "0199e0e7-0006-7000-8000-000000000000";

  it("is refused in an entry a request writes, on create and on update", () => {
    const provenance = [{ runId: RUN_ID, signalId: SIGNAL_ID }];

    expect(decodeOutcome(TaskCreateInput, { title: "t", description: "", provenance })).toBe(
      "Failure",
    );
    expect(decodeOutcome(TaskUpdateInput, { provenance })).toBe("Failure");
  });
});

describe("the leg of a handoff", () => {
  const ID = "0199e0e7-0006-7000-8000-000000000000";
  const run = {
    id: ID,
    workflowId: null,
    workflowName: "Triage",
    status: "completed",
    createdAt: "2026-09-04T10:00:00.000Z",
    awaitedSignalIds: [],
  };
  const leg = {
    runId: ID,
    signalId: ID,
    taskId: ID,
    taskStatus: "in-progress",
    workflowId: null,
    workflowName: "Triage",
    rerunCount: 0,
    latestRun: run,
    liveRunIds: [],
  };

  it("needs no next handoff, and refuses a negative re-run count", () => {
    expect(decodeOutcome(HandoffLeg, leg)).toBe("Success");
    expect(decodeOutcome(HandoffLeg, { ...leg, rerunCount: -1 })).toBe("Failure");
  });

  it("lists at most MAX_LEG_LIVE_RUNS live run ids", () => {
    const ids = (count: number) => Array.from({ length: count }, () => ID);
    expect(decodeOutcome(HandoffLeg, { ...leg, liveRunIds: ids(MAX_LEG_LIVE_RUNS) })).toBe(
      "Success",
    );
    expect(decodeOutcome(HandoffLeg, { ...leg, liveRunIds: ids(MAX_LEG_LIVE_RUNS + 1) })).toBe(
      "Failure",
    );
  });

  it("is asked for with one to MAX_LEG_QUERY_RUNS run ids", () => {
    const query = task.endpoints.queryLegs.query as Schema.Codec<unknown, unknown>;
    const ids = (count: number) => Array.from({ length: count }, () => ID);
    expect(decodeOutcome(query, { runIds: ids(0) })).toBe("Failure");
    expect(decodeOutcome(query, { runIds: ids(1) })).toBe("Success");
    expect(decodeOutcome(query, { runIds: ids(MAX_LEG_QUERY_RUNS) })).toBe("Success");
    expect(decodeOutcome(query, { runIds: ids(MAX_LEG_QUERY_RUNS + 1) })).toBe("Failure");
  });
});

describe("the stages of the board", () => {
  it("are the first five stages, and task.move takes each of them", () => {
    expect(TASK_STAGES.slice(0, BOARD_STAGES.length)).toEqual(BOARD_STAGES);
    for (const stage of BOARD_STAGES) {
      expect(decodeOutcome(TaskMoveInput, { stage })).toBe("Success");
    }
  });

  it("are refused as a place to move a Task to when they are done or dropped", () => {
    expect(decodeOutcome(TaskMoveInput, { stage: "done" })).toBe("Failure");
    expect(decodeOutcome(TaskMoveInput, { stage: "dropped" })).toBe("Failure");
  });

  it("let a move name a project and a card to follow, or null for none", () => {
    expect(decodeOutcome(TaskMoveInput, { projectId: null, afterTaskId: null })).toBe("Success");
  });
});

describe("a stage write that comes from a fact", () => {
  it("needs a stage, and the finished-work check needs a fact, in the request and in a workflow step", () => {
    const taskId = "0199f0b7-0000-7000-8000-00000000c001";
    for (const schema of [TaskUpdateInput, TaskUpdateCall]) {
      const base = schema === TaskUpdateCall ? { taskId } : {};
      expect(decodeOutcome(schema, { ...base, stage: "landed", stageFactId: 7 })).toBe("Success");
      expect(
        decodeOutcome(schema, {
          ...base,
          stage: "landed",
          stageFactId: 7,
          onlyWhenLinkedWorkFinished: true,
        }),
      ).toBe("Success");
      expect(decodeOutcome(schema, { ...base, stageFactId: 7, priority: "low" })).toBe("Failure");
      expect(
        decodeOutcome(schema, { ...base, stage: "landed", onlyWhenLinkedWorkFinished: true }),
      ).toBe("Failure");
    }
  });
});
