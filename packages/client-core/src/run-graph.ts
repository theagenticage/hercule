/**
 * A run's plan as a run's page draws it: the workflow graph with each step's
 * state, the steps as lines, and the lines placed on a time axis.
 *
 * A run's step records hold what happened; the plan holds what could have
 * happened. These functions join the two, so the graph, the step list and the
 * timeline agree on every step's state.
 */
import {
  collectReachableSteps,
  type Run,
  type RunStatus,
  type StepError,
  type StepRecord,
} from "@hercule/contract";
import {
  describeUnstartedStep,
  isRunLive,
  readTimestamps,
  type Timestamps,
  type WorkState,
} from "./run-display";
import {
  buildIndexedWorkflowGraph,
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
  /** How many step records the step has: how often the run came to it. 0 for a trigger. */
  readonly iterationCount: number;
  /**
   * The text after the step's id on its card, such as `×3` for a step the run
   * came to three times. `undefined` for a step the run came to at most once.
   */
  readonly iterationLabel: string | undefined;
}

/**
 * How far a run has come along an edge:
 * - `fired`: the run followed it at least once;
 * - `active`: the run followed it, and the step it leads to is running now;
 * - `notTaken`: the run has not followed it and never will, because the run
 *   has ended, or because its source step finished and can no longer run
 *   again. The edge's condition may have been false, or the edge was never
 *   evaluated at all: a terminal step's edges, and the edges after the one a
 *   run failed at;
 * - `notYet`: the run is live, has not followed it, and may still. Its source
 *   step has not finished yet, or can still run again: the step has a pending
 *   or running record, or a step with one has a path of edges to it, as in a
 *   loop that is still going round. An edge from a trigger is `notYet` while
 *   the run is live: a trigger does not fire for a run started by hand or
 *   through the API.
 */
export type EdgeTravel = "fired" | "active" | "notTaken" | "notYet";

export interface RunGraphEdge extends WorkflowGraphEdge {
  readonly travel: EdgeTravel;
  /**
   * How often the run followed an edge with `maxTraversals`, out of that
   * limit, such as `2/3`. `undefined` for an edge with no limit.
   */
  readonly traversalBadge: string | undefined;
  /** Whether the run failed at this edge, on its limit or on its condition. */
  readonly isFailedEdge: boolean;
  /** Whether the run failed because it would have followed this edge more often than its limit allows. */
  readonly isOverLimit: boolean;
}

/** A run's plan as a graph, with the run's progress on every step and edge. */
export interface RunGraph {
  readonly nodes: ReadonlyArray<RunGraphNode>;
  readonly edges: ReadonlyArray<RunGraphEdge>;
  /** The run's status, which decides how a step the run has not reached reads. */
  readonly status: RunStatus;
}

/**
 * Returns the record that holds where a step is now, from its records in
 * the order they were created: the running one, else a pending one, else the
 * latest. A step can have a record waiting behind the running one, and the
 * step is still running.
 */
const findCurrentRecord = (records: ReadonlyArray<StepRecord>): StepRecord | undefined =>
  records.find((record) => record.status === "running") ??
  records.find((record) => record.status === "pending") ??
  records.at(-1);

/** Returns a step's progress from its step record, or `unreached` for a step with none. */
const readStepProgress = (record: StepRecord | undefined): StepProgress =>
  record === undefined
    ? { state: "unreached" }
    : { state: record.status, ...readTimestamps(record) };

/** Returns a run's step records grouped by step id, each group in the order the records were created. */
const groupRecordsByStep = (
  steps: ReadonlyArray<StepRecord>,
): ReadonlyMap<string, ReadonlyArray<StepRecord>> => {
  const groups = new Map<string, Array<StepRecord>>();
  for (const record of steps) {
    const group = groups.get(record.stepId);
    if (group === undefined) groups.set(record.stepId, [record]);
    else group.push(record);
  }
  return groups;
};

/**
 * Builds the graph of a run's plan, as `buildWorkflowGraph` does, with the
 * run's progress on it:
 * - each step carries the state and times of its current record (see
 *   `findCurrentRecord`) and how many records it has;
 * - each edge carries how far the run came along it (see `EdgeTravel`), from
 *   the run's count of how often it followed each edge;
 * - an edge with `maxTraversals` carries that count out of its limit;
 * - the edge the run failed at, if it failed at one, is marked.
 */
export const buildRunGraph = (run: Run): RunGraph => {
  const graph = buildIndexedWorkflowGraph(run.plan);
  const records = groupRecordsByStep(run.steps);
  const current = new Map([...records].map(([stepId, own]) => [stepId, findCurrentRecord(own)]));
  const stepIds = new Set(run.plan.steps.map((step) => step.id));
  const failedEdgeIndex =
    "failedEdge" in run && run.failedEdge !== undefined ? run.failedEdge.index : undefined;
  const isOverLimitRun = run.status === "failed" && run.failureReason === "iteration-limit";
  const isLive = isRunLive(run.status);
  // The steps that can still run: those with a pending or running record,
  // and every step they have a path to.
  const canStillRun = collectReachableSteps(
    run.plan.edges ?? [],
    run.steps
      .filter((record) => record.status === "pending" || record.status === "running")
      .map((record) => record.stepId),
  );
  /**
   * Checks whether a step has finished at least once: completed, or skipped
   * by its condition. A trigger has no records, so it never has.
   */
  const hasFinished = (stepId: string): boolean =>
    (records.get(stepId) ?? []).some(
      (record) => record.status === "completed" || record.status === "skipped",
    );
  /** Decides how far the run has come along an edge, from how often it followed the edge. */
  const decideTravel = (edge: WorkflowGraphEdge, traversals: number): EdgeTravel => {
    if (traversals > 0) return current.get(edge.to)?.status === "running" ? "active" : "fired";
    const mayStillFollow = !hasFinished(edge.from) || canStillRun.has(edge.from);
    return isLive && mayStillFollow ? "notYet" : "notTaken";
  };
  return {
    nodes: graph.nodes.map((node) => {
      if (!stepIds.has(node.id)) {
        return { ...node, progress: undefined, iterationCount: 0, iterationLabel: undefined };
      }
      const iterationCount = records.get(node.id)?.length ?? 0;
      return {
        ...node,
        progress: readStepProgress(current.get(node.id)),
        iterationCount,
        iterationLabel: iterationCount > 1 ? `×${String(iterationCount)}` : undefined,
      };
    }),
    edges: graph.edges.map(({ edge, planEdgeIndex }) => {
      const traversals = planEdgeIndex === undefined ? 0 : (run.edgeTraversals[planEdgeIndex] ?? 0);
      const isFailedEdge = planEdgeIndex !== undefined && planEdgeIndex === failedEdgeIndex;
      return {
        ...edge,
        travel: decideTravel(edge, traversals),
        traversalBadge:
          edge.maxTraversals === undefined
            ? undefined
            : `${String(traversals)}/${String(edge.maxTraversals)}`,
        isFailedEdge,
        isOverLimit: isFailedEdge && isOverLimitRun,
      };
    }),
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
  /**
   * The record's iteration, such as `#2`, on every line of a step that has
   * more than one record. `undefined` on the line of a step that ran once, so
   * a run with no loops reads as before.
   */
  readonly iterationLabel: string | undefined;
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
  const records = groupRecordsByStep(run.steps);
  return [
    ...run.steps.map((record): StepLine => ({
      key: `${record.stepId}#${String(record.iteration)}`,
      stepId: record.stepId,
      iterationLabel:
        (records.get(record.stepId)?.length ?? 0) > 1 ? `#${String(record.iteration)}` : undefined,
      action: actions.get(record.stepId),
      ...readStepProgress(record),
      output: record.status === "completed" ? record.output : undefined,
      error: record.status === "failed" ? record.error : undefined,
    })),
    ...run.plan.steps
      .filter((step) => !records.has(step.id))
      .map((step): StepLine => ({
        key: step.id,
        stepId: step.id,
        iterationLabel: undefined,
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
  /** The label, centred on the tick. */
  readonly label: string;
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
  readonly lines: ReadonlyArray<TimelineLine>;
}

/** A step line on a time axis. */
export interface TimelineLine {
  readonly line: StepLine;
  /** The bar of a record that started, or `undefined` for one that has not. */
  readonly bar: TimelineBar | undefined;
  /** The text a line with no bar shows on its track, or `undefined` for none. A line has a bar or a note, never both. */
  readonly note: TimelineNote | undefined;
}

/**
 * The text a line with no bar shows, such as "skipped", and where it stands:
 * where a skipped record was skipped, and at the end of the axis for any
 * other line. The note ends at its position, but only by the same fraction of
 * its width as its position is of the axis, so it stays inside the axis.
 */
export interface TimelineNote {
  readonly text: string;
  /** A fraction of the axis. */
  readonly position: number;
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
 * Builds a tick every `step` milliseconds on an axis `spanMs` long, from 0 up
 * to the last one inside the axis.
 */
const buildTicks = (step: number, spanMs: number): ReadonlyArray<TimelineTick> =>
  Array.from({ length: Math.floor(spanMs / step) + 1 }, (_, index) => {
    const position = (index * step) / spanMs;
    return { position, label: formatTickLabel(index * step) };
  });

/**
 * Checks that ticks `spacing` characters apart keep their centred labels at
 * least `LABEL_GAP_CHARACTERS` apart, when the longest label is
 * `longestLabel` characters long. The check assumes both labels are the
 * longest, so while a run is live and its axis grows, the ticks never flip
 * back to a shorter step.
 */
const areLabelsApart = (spacing: number, longestLabel: number): boolean =>
  spacing >= longestLabel + LABEL_GAP_CHARACTERS;

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
    const ticks = buildTicks(step, spanMs);
    const longestLabel = Math.max(...ticks.map((tick) => [...tick.label].length));
    if (areLabelsApart((step / spanMs) * axisWidth, longestLabel)) return ticks;
  }
  return [{ position: 0, label: formatTickLabel(0) }];
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
    lines: buildStepLines(run).map((line) => {
      // A cancelled record that started has a bar, and so no note.
      const text =
        line.startedAt === undefined ? describeUnstartedStep(line.state, run.status) : undefined;
      const note =
        text === undefined
          ? undefined
          : {
              text,
              position:
                line.state === "skipped" && line.finishedAt !== undefined
                  ? measureFraction(Date.parse(line.finishedAt))
                  : 1,
            };
      return {
        line,
        note,
        bar:
          line.startedAt === undefined
            ? undefined
            : {
                start: measureFraction(Date.parse(line.startedAt)),
                end: measureFraction(
                  line.finishedAt === undefined ? end : Date.parse(line.finishedAt),
                ),
              },
      };
    }),
  };
};
