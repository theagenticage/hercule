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

/**
 * Which end of a tick's label stands at the tick. A label is centred on its
 * tick unless centring it would reach past an end of the axis:
 * - `start`: the label starts at its tick. The tick at 0 is aligned so.
 * - `end`: the label ends at its tick. A tick at or near the end of the axis is
 *   aligned so.
 * - `center`: the label is centred on its tick.
 */
export type TickAlign = "start" | "center" | "end";

/** A mark on the time axis. */
export interface TimelineTick {
  /** Where the tick is, as a fraction of the axis. */
  readonly position: number;
  readonly label: string;
  readonly align: TickAlign;
}

/** A step record's bar: where it starts and ends, as fractions of the axis. */
export interface TimelineBar {
  readonly start: number;
  readonly end: number;
}

/**
 * A run's step lines on a time axis. The axis starts when the run started and
 * ends at now, or where the run ended.
 */
export interface Timeline {
  readonly ticks: ReadonlyArray<TimelineTick>;
  /** How long the run has run up to now, or ran, in milliseconds. It is the length of the axis. */
  readonly elapsedMs: number;
  readonly lines: ReadonlyArray<{ readonly line: StepLine; readonly bar: TimelineBar | undefined }>;
}

/**
 * The most ticks an axis has, not counting the one at 0. A wide axis could
 * hold more labels, but more would crowd it.
 */
const MAX_TICKS = 6;

/** The least space between two tick labels, in characters of the labels' font. */
const LABEL_GAP_CHARACTERS = 2;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

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
 * Returns the distances between ticks that an axis `spanMs` long can use,
 * shortest first: `TICK_STEPS`, then whole numbers of days. The last step is
 * at least `spanMs`.
 */
const listTickSteps = (spanMs: number): ReadonlyArray<number> => [
  ...TICK_STEPS,
  ...Array.from({ length: Math.ceil(spanMs / DAY_MS) - 1 }, (_, index) => (index + 2) * DAY_MS),
];

/**
 * Decides how to align a label `length` characters long whose tick is at
 * `position` on an axis `axisWidth` characters wide: centred, unless that
 * would reach past the start or the end of the axis.
 */
const decideTickAlign = (position: number, length: number, axisWidth: number): TickAlign => {
  const centre = position * axisWidth;
  if (centre - length / 2 < 0) return "start";
  if (centre + length / 2 > axisWidth) return "end";
  return "center";
};

/**
 * Builds a tick every `step` milliseconds on an axis `spanMs` long and
 * `axisWidth` characters wide, from 0 up to the last one inside the axis.
 */
const buildTicks = (step: number, spanMs: number, axisWidth: number): ReadonlyArray<TimelineTick> =>
  Array.from({ length: Math.floor(spanMs / step) + 1 }, (_, index) => {
    const position = (index * step) / spanMs;
    const label = formatTickLabel(index * step);
    return { position, label, align: decideTickAlign(position, [...label].length, axisWidth) };
  });

/**
 * Checks that ticks `spacing` characters apart keep their labels at least
 * `LABEL_GAP_CHARACTERS` apart, when the longest label is `longestLabel`
 * characters long.
 *
 * The closest two labels can come is a centred label followed by one aligned
 * to end at its tick at the end of the axis: half of one label and all of the
 * other stand between the two ticks. The check assumes both are the longest
 * label. That asks for a little more space than the labels need, but the
 * answer does not depend on where the last tick falls. So while a run is
 * live, its step only ever grows, and the ticks never flip back to a shorter
 * step as the run grows.
 */
const areLabelsApart = (spacing: number, longestLabel: number): boolean =>
  spacing >= 1.5 * longestLabel + LABEL_GAP_CHARACTERS;

/**
 * Builds the ticks of an axis `spanMs` long and `axisWidth` characters wide.
 *
 * The ticks are a round step apart: the shortest step that puts at most
 * `MAX_TICKS` ticks inside the axis and keeps every two labels apart. When no
 * step keeps the labels apart, because the axis is too narrow, the axis has
 * only the tick at 0.
 */
const buildTimeAxis = (spanMs: number, axisWidth: number): ReadonlyArray<TimelineTick> => {
  for (const step of listTickSteps(spanMs)) {
    if (Math.floor(spanMs / step) > MAX_TICKS) continue;
    const ticks = buildTicks(step, spanMs, axisWidth);
    const longestLabel = Math.max(...ticks.map((tick) => [...tick.label].length));
    if (areLabelsApart((step / spanMs) * axisWidth, longestLabel)) return ticks;
  }
  return [{ position: 0, label: formatTickLabel(0), align: "start" }];
};

/**
 * Places a run's step lines on a time axis that starts when the run started
 * and ends at now, or where the run ended.
 *
 * The ticks stay at round steps, and only those inside the axis are drawn:
 * a run of 23 seconds can have ticks at 0, 10s and 20s. They are as close
 * together as their labels allow on an axis `axisWidthInCharacters` wide, and
 * never closer: the labels are in a monospace font, so the caller passes the
 * axis's width in pixels divided by the width of one character of the labels.
 */
export const buildTimeline = (run: Run, now: number, axisWidthInCharacters: number): Timeline => {
  const { startedAt, finishedAt } = readTimestamps(run);
  const origin = Date.parse(startedAt ?? run.createdAt);
  const end = finishedAt === undefined ? now : Date.parse(finishedAt);
  const elapsedMs = Math.max(0, end - origin);
  // An axis needs a length, even for a run that took no measurable time.
  const spanMs = Math.max(1, elapsedMs);
  const measureFraction = (instant: number): number =>
    Math.min(1, Math.max(0, (instant - origin) / spanMs));
  return {
    ticks: buildTimeAxis(spanMs, axisWidthInCharacters),
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
