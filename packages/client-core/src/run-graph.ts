/**
 * A run's plan as a run's page draws it: the workflow graph with each step's
 * state, the steps as lines, and the lines placed on a time axis.
 *
 * A run's step records hold what happened; the plan holds what could have
 * happened. These functions join the two, so the graph, the step list and the
 * timeline agree on every step's state.
 */
import type { Run, RunStatus, StepError, StepRecord } from "@hercule/contract";
import { readTimestamps, type Timestamps, type WorkState } from "./run-display";
import {
  buildWorkflowGraph,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
} from "./workflow-graph";

/** Where a run is at one step of its plan: the step's state and its times. */
export interface StepProgress extends Timestamps {
  readonly state: WorkState;
}

/** A trigger or a step of a run's plan. A step carries its progress; a trigger has none. */
export interface RunGraphNode extends WorkflowGraphNode {
  readonly progress: StepProgress | undefined;
}

/**
 * How far a run has come along an edge:
 * - `untravelled`: the run has not gone along it;
 * - `travelled`: the run went along it, and the step it leads to is queued or has ended;
 * - `active`: the run went along it, and the step it leads to is running now.
 */
export type EdgeTravel = "untravelled" | "travelled" | "active";

export interface RunGraphEdge extends WorkflowGraphEdge {
  readonly travel: EdgeTravel;
}

/** A run's plan as a graph, with the run's progress on every step and edge. */
export interface RunGraph {
  readonly nodes: ReadonlyArray<RunGraphNode>;
  readonly edges: ReadonlyArray<RunGraphEdge>;
  /** The run's status, which decides how a step the run has not reached reads. */
  readonly status: RunStatus;
}

/**
 * Returns the latest step record of each step, by step id. A step that runs
 * again gets a new record, and the latest one holds where the step is now.
 */
const findLatestRecords = (steps: ReadonlyArray<StepRecord>): ReadonlyMap<string, StepRecord> =>
  new Map(steps.map((record) => [record.stepId, record]));

/** Returns a step's progress from its step record, or `unreached` for a step with none. */
const readStepProgress = (record: StepRecord | undefined): StepProgress =>
  record === undefined
    ? { state: "unreached" }
    : { state: record.status, ...readTimestamps(record) };

/**
 * Builds the graph of a run's plan, as `buildWorkflowGraph` does, with the
 * run's progress on it:
 * - each step carries its state and times, from its latest step record;
 * - each edge between two steps is travelled once the run went from the one
 *   step to the other, and active while the step it leads to runs.
 *
 * An edge from a trigger is never travelled: a trigger does not fire for a
 * run started by hand or through the API.
 */
export const buildRunGraph = (run: Pick<Run, "plan" | "steps" | "status">): RunGraph => {
  const graph = buildWorkflowGraph(run.plan);
  const latest = findLatestRecords(run.steps);
  const stepIds = new Set(run.plan.steps.map((step) => step.id));
  /**
   * Decides how far the run has come along the edge from `from` to `to`, from
   * the latest step record at each end. This handles a linear graph, where
   * each step runs at most once; loops and joins come with
   * [#80](https://github.com/theagenticage/hercule/issues/80).
   */
  const decideTravel = (from: string, to: string): EdgeTravel => {
    const target = latest.get(to);
    if (latest.get(from)?.status !== "completed" || target === undefined) return "untravelled";
    return target.status === "running" ? "active" : "travelled";
  };
  return {
    nodes: graph.nodes.map((node) => {
      if (!stepIds.has(node.id)) return { ...node, progress: undefined };
      return { ...node, progress: readStepProgress(latest.get(node.id)) };
    }),
    edges: graph.edges.map((edge) => ({ ...edge, travel: decideTravel(edge.from, edge.to) })),
    status: run.status,
  };
};

/** What a completed step's action returned. */
type StepOutput = Extract<StepRecord, { readonly status: "completed" }>["output"];

/**
 * One line of a run's step list and timeline: a step record, or a step that
 * has none, with its state and times.
 */
export interface StepLine extends StepProgress {
  /** Unique within the run. */
  readonly key: string;
  readonly stepId: string;
  /** The action an action step calls, as the plan names it. */
  readonly action: string | undefined;
  /** What the action returned, for a completed step; `null` for an action that returns nothing. */
  readonly output: StepOutput | undefined;
  /** Why the step failed, for a failed step. */
  readonly error: StepError | undefined;
}

/**
 * Returns a run's step lines: one per step record, in the order the records
 * were created, then one for each step of the plan that has no record, in the
 * plan's order.
 */
export const buildStepLines = (run: Pick<Run, "plan" | "steps">): ReadonlyArray<StepLine> => {
  const actions = new Map(
    run.plan.steps.map((step) => [step.id, step.kind === "action" ? step.action : undefined]),
  );
  const recorded = new Set(run.steps.map((record) => record.stepId));
  return [
    ...run.steps.map((record): StepLine => ({
      key: `${record.stepId}#${String(record.iteration)}`,
      stepId: record.stepId,
      action: actions.get(record.stepId),
      ...readStepProgress(record),
      output: record.status === "completed" ? record.output : undefined,
      error: record.status === "failed" ? record.error : undefined,
    })),
    ...run.plan.steps
      .filter((step) => !recorded.has(step.id))
      .map((step): StepLine => ({
        key: step.id,
        stepId: step.id,
        action: actions.get(step.id),
        ...readStepProgress(undefined),
        output: undefined,
        error: undefined,
      })),
  ];
};

/** A mark on the time axis. */
export interface TimelineTick {
  /** Where the tick is, as a fraction of the axis. */
  readonly position: number;
  readonly label: string;
}

/** A step record's bar: where it starts and ends, as fractions of the axis. */
export interface TimelineBar {
  readonly start: number;
  readonly end: number;
}

export interface Timeline {
  /** The length of the axis in milliseconds. It is a whole number of ticks. */
  readonly spanMs: number;
  readonly ticks: ReadonlyArray<TimelineTick>;
  /** Where now is, as a fraction of the axis. For an ended run, where it ended. */
  readonly now: number;
  /** How long the run has run up to now, or ran, in milliseconds. */
  readonly elapsedMs: number;
  readonly lines: ReadonlyArray<{ readonly line: StepLine; readonly bar: TimelineBar | undefined }>;
}

/** The most ticks an axis has, not counting the one at 0. More would crowd the labels. */
const MAX_TICKS = 6;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * The distances between ticks an axis can use, shortest first: round numbers
 * of milliseconds, then of seconds, minutes and hours. A reader adds them up
 * at a glance, where a tick every 20 seconds past a minute would need
 * arithmetic.
 */
const TICK_STEPS = [
  1,
  2,
  5,
  10,
  20,
  50,
  100,
  200,
  500,
  ...[1, 2, 5, 10, 15, 30].map((seconds) => seconds * SECOND_MS),
  ...[1, 2, 5, 10, 15, 30].map((minutes) => minutes * MINUTE_MS),
  ...[1, 2, 3, 6, 12, 24].map((hours) => hours * HOUR_MS),
];

/** Formats a tick's label: `0`, `20ms`, `2s`, `5m`, `1h 30m`. */
const formatTickLabel = (ms: number): string => {
  if (ms === 0) return "0";
  if (ms < SECOND_MS) return `${String(ms)}ms`;
  if (ms < MINUTE_MS) return `${String(ms / SECOND_MS)}s`;
  if (ms < HOUR_MS) return formatInUnits(ms, MINUTE_MS, "m", SECOND_MS, "s");
  return formatInUnits(ms, HOUR_MS, "h", MINUTE_MS, "m");
};

/** Formats `ms` as a whole number of `major` units, and the rest in `minor` units when there is a rest. */
const formatInUnits = (
  ms: number,
  major: number,
  majorLabel: string,
  minor: number,
  minorLabel: string,
): string => {
  const whole = `${String(Math.floor(ms / major))}${majorLabel}`;
  const rest = Math.round((ms % major) / minor);
  return rest === 0 ? whole : `${whole} ${String(rest)}${minorLabel}`;
};

/**
 * Returns the distance between ticks for an axis of `spanMs`: the shortest
 * step that needs at most `MAX_TICKS` ticks, or a whole number of days for a
 * run that has gone on for longer.
 */
const decideTickStep = (spanMs: number): number =>
  TICK_STEPS.find((step) => spanMs / step <= MAX_TICKS) ??
  Math.ceil(spanMs / MAX_TICKS / (24 * HOUR_MS)) * 24 * HOUR_MS;

/**
 * Places a run's step lines on a time axis that starts when the run started
 * and ends at now, or where the run ended. The axis is rounded up to a whole
 * number of round ticks, so it grows in steps while the run is live rather
 * than rescaling on every render.
 */
export const buildTimeline = (run: Run, now: number): Timeline => {
  const { startedAt, finishedAt } = readTimestamps(run);
  const origin = Date.parse(startedAt ?? run.createdAt);
  const end = finishedAt === undefined ? now : Date.parse(finishedAt);
  const elapsedMs = Math.max(0, end - origin);
  // An axis needs a length, even for a run that took no measurable time.
  const step = decideTickStep(Math.max(1, elapsedMs));
  const spanMs = Math.ceil(Math.max(1, elapsedMs) / step) * step;
  const measureFraction = (instant: number): number =>
    Math.min(1, Math.max(0, (instant - origin) / spanMs));
  return {
    spanMs,
    ticks: Array.from({ length: spanMs / step + 1 }, (_, index) => ({
      position: (index * step) / spanMs,
      label: formatTickLabel(index * step),
    })),
    now: measureFraction(end),
    elapsedMs,
    lines: buildStepLines(run).map((line) => ({
      line,
      bar:
        line.startedAt === undefined
          ? undefined
          : {
              start: measureFraction(Date.parse(line.startedAt)),
              end: measureFraction(
                line.finishedAt === undefined ? end : Date.parse(line.finishedAt),
              ),
            },
    })),
  };
};
