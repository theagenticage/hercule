/**
 * PROTOTYPE - throwaway (P021 run graph, branch prototype/P021-run-graph).
 *
 * Hard-coded fake data: one frozen plan and three scripted runs of it. Each
 * run is a list of frames; a frame is the run as `run.read` would return it at
 * one moment. The plan stays inside what #79 runs accept (SPEC AC-3): action
 * steps only, unconditional edges, a fan-out, and no step with two incoming
 * edges, so no join.
 *
 * The engine runs one built-in step at a time (SPEC "How one run flows"), so
 * after the fan-out `label_task` and `query_tasks` are both queued and then
 * run one after the other.
 */
import type { WorkflowGraph } from "@hercule/client-core";

export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * What the graph shows for a step. `unreached` is a step with no step record:
 * the run has not got there yet, or never will.
 */
export type StepState = StepStatus | "unreached";

export interface StepRecord {
  readonly stepId: string;
  readonly status: StepStatus;
  /** Seconds since the run was created. */
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface Frame {
  /** Seconds since the run was created. */
  readonly at: number;
  readonly status: RunStatus;
  readonly records: ReadonlyArray<StepRecord>;
  /** A short caption for the scrubber. */
  readonly caption: string;
}

export type Scenario = "success" | "failed" | "cancelled";
export const SCENARIOS: ReadonlyArray<Scenario> = ["success", "failed", "cancelled"];

export const WORKFLOW_NAME = "Triage a new issue";
export const RUN_ID = "01j8zq6m4k7r2x9c3v5b8n1d4f";
/** The wall-clock time the run was created, for the header. */
export const CREATED_AT = new Date("2026-09-24T14:02:10+02:00");

export const INPUTS: ReadonlyArray<readonly [string, string]> = [
  ["title", '"Webhook tests flake on CI"'],
  ["priority", '"high"'],
];

export const PLAN_GRAPH: WorkflowGraph = {
  nodes: [
    { id: "manual", kind: "start" },
    { id: "create_task", kind: "action" },
    { id: "label_task", kind: "action" },
    { id: "query_tasks", kind: "action" },
    { id: "update_task", kind: "action" },
  ],
  edges: [
    { from: "manual", to: "create_task" },
    { from: "create_task", to: "label_task" },
    { from: "create_task", to: "query_tasks" },
    { from: "query_tasks", to: "update_task" },
  ],
};

/** The action each step calls, for the step list. */
export const STEP_ACTIONS: Readonly<Record<string, string>> = {
  create_task: "task.create",
  label_task: "task.update",
  query_tasks: "task.query",
  update_task: "task.update",
};

/** The steps in plan order, for the step list. */
export const STEP_IDS = ["create_task", "label_task", "query_tasks", "update_task"] as const;

export const STEP_OUTPUTS: Readonly<Record<string, string>> = {
  create_task: `{
  "id": "tsk_01j8zq6n0a",
  "title": "Webhook tests flake on CI",
  "status": "backlog",
  "priority": "high"
}`,
  label_task: `{
  "id": "tsk_01j8zq6n0a",
  "labels": ["ci", "flaky-test"]
}`,
  query_tasks: `{
  "items": [
    { "id": "tsk_01j8m2c4t1", "title": "Webhook test times out on CI" }
  ]
}`,
  update_task: `{
  "id": "tsk_01j8zq6n0a",
  "relatedTo": ["tsk_01j8m2c4t1"]
}`,
};

const done = (stepId: string, startedAt: number, finishedAt: number): StepRecord => ({
  stepId,
  status: "completed",
  startedAt,
  finishedAt,
});
const running = (stepId: string, startedAt: number): StepRecord => ({
  stepId,
  status: "running",
  startedAt,
});
const queued = (stepId: string): StepRecord => ({ stepId, status: "pending" });

const common: ReadonlyArray<Frame> = [
  { at: 0, status: "pending", records: [queued("create_task")], caption: "run created" },
  {
    at: 0.6,
    status: "running",
    records: [running("create_task", 0.6)],
    caption: "create_task running",
  },
  {
    at: 2.2,
    status: "running",
    records: [done("create_task", 0.6, 2.2), queued("label_task"), queued("query_tasks")],
    caption: "create_task done, fan-out queued",
  },
  {
    at: 2.6,
    status: "running",
    records: [done("create_task", 0.6, 2.2), running("label_task", 2.6), queued("query_tasks")],
    caption: "label_task running",
  },
];

const labelDone = [done("create_task", 0.6, 2.2), done("label_task", 2.6, 5.4)];

export const RUNS: Readonly<Record<Scenario, ReadonlyArray<Frame>>> = {
  success: [
    ...common,
    {
      at: 5.4,
      status: "running",
      records: [...labelDone, running("query_tasks", 5.4)],
      caption: "query_tasks running",
    },
    {
      at: 6.8,
      status: "running",
      records: [...labelDone, done("query_tasks", 5.4, 6.8), queued("update_task")],
      caption: "update_task queued",
    },
    {
      at: 7.2,
      status: "running",
      records: [...labelDone, done("query_tasks", 5.4, 6.8), running("update_task", 7.2)],
      caption: "update_task running",
    },
    {
      at: 8.6,
      status: "completed",
      records: [...labelDone, done("query_tasks", 5.4, 6.8), done("update_task", 7.2, 8.6)],
      caption: "run completed",
    },
  ],
  failed: [
    ...common,
    {
      at: 5.4,
      status: "running",
      records: [...labelDone, running("query_tasks", 5.4)],
      caption: "query_tasks running",
    },
    {
      at: 6.4,
      status: "failed",
      records: [
        ...labelDone,
        {
          stepId: "query_tasks",
          status: "failed",
          startedAt: 5.4,
          finishedAt: 6.4,
          error: {
            code: "validation",
            message:
              'filter.status: expected one of "backlog", "todo", "in-progress", "done", got "open"',
          },
        },
      ],
      caption: "query_tasks failed, run failed",
    },
  ],
  cancelled: [
    ...common,
    {
      at: 4.1,
      status: "cancelled",
      records: [
        done("create_task", 0.6, 2.2),
        { stepId: "label_task", status: "cancelled", startedAt: 2.6, finishedAt: 4.1 },
        { stepId: "query_tasks", status: "cancelled", finishedAt: 4.1 },
      ],
      caption: "cancelled by you",
    },
  ],
};

/** A step as the page draws it at one moment. */
export interface StepView {
  readonly state: StepState;
  readonly record?: StepRecord;
  /** The step's place in the order the engine started steps, from 1; absent before it starts. */
  readonly order?: number;
}

/** Returns the view of every node in the plan at one frame, keyed by node id. */
export const buildStepViews = (frame: Frame): ReadonlyMap<string, StepView> => {
  const started = frame.records
    .filter((record) => record.startedAt !== undefined)
    .sort((a, b) => a.startedAt! - b.startedAt!);
  return new Map(
    PLAN_GRAPH.nodes.map((node): [string, StepView] => {
      if (node.kind === "start") return [node.id, { state: "completed" as const }];
      const record = frame.records.find((each) => each.stepId === node.id);
      if (record === undefined) return [node.id, { state: "unreached" as const }];
      const index = started.indexOf(record);
      return [
        node.id,
        { state: record.status, record, ...(index === -1 ? {} : { order: index + 1 }) },
      ];
    }),
  );
};

/**
 * How far the run has come along an edge:
 * - `travelled`: the run went along it; the step it leads to is queued or has finished;
 * - `active`: the run went along it and the step it leads to is running now;
 * - `untravelled`: the run has not gone along it.
 */
export type EdgeTravel = "travelled" | "active" | "untravelled";

export const decideEdgeTravel = (to: string, views: ReadonlyMap<string, StepView>): EdgeTravel => {
  const state = views.get(to)?.state ?? "unreached";
  if (state === "unreached") return "untravelled";
  return state === "running" ? "active" : "travelled";
};

/** Formats seconds as the step list and cards show them: `1.6s`. */
export const formatSeconds = (seconds: number): string => `${seconds.toFixed(1)}s`;

/** Formats the time of day `seconds` after the run was created: `14:02:12`. */
export const formatClockTime = (seconds: number): string =>
  new Date(CREATED_AT.getTime() + seconds * 1000).toLocaleTimeString("en-GB", {
    timeZone: "Europe/Amsterdam",
    hour12: false,
  });
