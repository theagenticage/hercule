/**
 * The open workflow's page: the chips under its name, and the rows of its
 * Runs, Triggers and Inputs tabs (spec 17 §Workflows, "The open workflow").
 *
 * Like the list's rows in `workflow-rows.ts`, a row holds only strings,
 * numbers, booleans and null, and times are kept as instants. The screen
 * formats them against the age clock: a moment with `formatListTime`, and a
 * run's duration with `formatRunDuration`. A row therefore stays equal as
 * time passes, and only the time text draws again.
 *
 * This module is the subpath `@hercule/client-core/workflow-detail-rows`,
 * not part of the index, so that it stays off the desktop app's first screen.
 */
import {
  isSchedule,
  type RunSummary,
  type Trigger,
  type TriggerFiresOn,
  type Workflow,
  type WorkflowDefinition,
} from "@hercule/contract";
import {
  describeFailureReason,
  describeRunOrigin,
  isRunLive,
  measureElapsed,
  readTimestamps,
} from "./run-display";
import { describeSchedule } from "./schedule-text";
import { formatDuration } from "./threads/duration";
import {
  decideRunMarkState,
  describeLiveRuns,
  describeWaitingRunSession,
  type RunMarkState,
} from "./run-marks";
import { decideFiresOn, describeTriggerOn } from "./trigger-display";
import type { WaitingRunSession } from "./waiting";
import { firesTriggers } from "./workflow-firing";
import type { WorkflowStatusTone } from "./workflow-rows";

/** Returns `text` with its first letter in upper case. */
const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Returns `triggers` in the order `definition` declares them, so the page
 * lists them as the user wrote them, whatever order the read returned.
 */
const sortByDeclaration = (
  definition: WorkflowDefinition,
  triggers: ReadonlyArray<Trigger>,
): ReadonlyArray<Trigger> => {
  const order = (definition.triggers ?? []).map((trigger) => trigger.id);
  return triggers.toSorted((a, b) => order.indexOf(a.triggerId) - order.indexOf(b.triggerId));
};

/** One chip under a workflow's name. */
export interface WorkflowChip {
  /** A key that is unique among the chips. */
  readonly key: string;
  /** The clock or the bolt drawn before the text, or null for none. */
  readonly firesOn: TriggerFiresOn | null;
  /**
   * The chip's text: a start trigger's schedule in words or event kind, with
   * " · paused" or " · error" when it is either, "On demand", or what the
   * steps run, "5 agents · 2 actions · 1 signal".
   */
  readonly text: string;
  /**
   * When the start trigger fires next, an ISO instant, which the screen
   * appends as " · next Fri 14:00". Null while the workflow is disabled or
   * invalid, the trigger is paused or in error, or its next fire is not known.
   */
  readonly nextFireAt: string | null;
  /** `fail` for a start trigger in error. */
  readonly tone: "fail" | null;
}

/** Returns `count` with the noun after it, "1 agent" or "5 agents", or `undefined` for none. */
const formatCount = (count: number, noun: string): string | undefined =>
  count === 0 ? undefined : `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Builds the chips under a workflow's name: one per start trigger among
 * `triggers`, the workflow's own, or "On demand" when it has none, then what
 * its steps run. `workflow` is the workflow, as its switch shows it. The
 * workflow is off while it is disabled or invalid; its triggers then do not
 * fire, so their chips have no next fire.
 */
export const buildWorkflowChips = (
  definition: WorkflowDefinition,
  workflow: Pick<Workflow, "enabled" | "invalidSince">,
  triggers: ReadonlyArray<Trigger>,
): ReadonlyArray<WorkflowChip> => {
  const isOn = firesTriggers(workflow);
  const startChips = sortByDeclaration(definition, triggers)
    .filter((trigger) => trigger.kind === "start")
    .map((trigger): WorkflowChip => {
      const words = isSchedule(trigger.on) ? describeSchedule(trigger.on) : trigger.on.kind;
      const isBroken = trigger.health?.state === "error";
      const isPaused = trigger.status === "paused";
      return {
        key: `trigger:${trigger.triggerId}`,
        firesOn: decideFiresOn(trigger.on),
        text: isBroken ? `${words} · error` : isPaused ? `${words} · paused` : words,
        nextFireAt: isOn && !isBroken && !isPaused ? (trigger.nextFireAt ?? null) : null,
        tone: isBroken ? "fail" : null,
      };
    });
  const { steps } = definition;
  const counts = [
    formatCount(steps.filter((step) => step.kind === "agent").length, "agent"),
    formatCount(steps.filter((step) => step.kind === "action").length, "action"),
    formatCount(steps.filter((step) => step.kind === "text-generation").length, "text generation"),
    formatCount(
      (definition.triggers ?? []).filter((trigger) => trigger.kind === "signal").length,
      "signal",
    ),
  ].filter((count) => count !== undefined);
  return [
    ...(startChips.length > 0
      ? startChips
      : [{ key: "on-demand", firesOn: null, text: "On demand", nextFireAt: null, tone: null }]),
    { key: "steps", firesOn: null, text: counts.join(" · "), nextFireAt: null, tone: null },
  ];
};

/** One run, as its row in the Runs tab's list shows it. */
export interface RunRow {
  readonly id: string;
  /** The run's mark. `cancelled` and `starting` have none: the row shows its words in the mark's place. */
  readonly state: RunMarkState;
  /**
   * What the run is doing or how it ended: what its step asks while it waits
   * on the user ("review asks: Ship v2.4?"), "At review", "Waiting for
   * approved", "Starting", "Completed", "Cancelled", or why it failed and
   * where ("Session failed at test").
   */
  readonly statusText: string;
  readonly statusTone: WorkflowStatusTone;
  /** Who or what started the run: the id of the start trigger, or the actor, "You". */
  readonly startedByText: string;
  /**
   * The clock or the bolt drawn before a trigger's id, or null for an actor,
   * and for a trigger the workflow no longer declares.
   */
  readonly startedByFiresOn: TriggerFiresOn | null;
  /** When the run was created, an ISO instant: the Started column. */
  readonly createdAt: string;
  /** When the run's first step started, an ISO instant, or null while it has not. */
  readonly startedAt: string | null;
  /** When the run ended, an ISO instant, or null while it is live. */
  readonly finishedAt: string | null;
  /** Whether the run has not ended, so its duration still counts. */
  readonly isLive: boolean;
}

/**
 * Returns the status text of a run that has not ended and does not wait on
 * the user, or one that has ended.
 */
const describeRunStatus = (run: RunSummary): string => {
  switch (run.status) {
    case "pending":
    case "running":
      return describeLiveRuns([run]);
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "failed": {
      const reason = capitalize(describeFailureReason(run.failureReason));
      const stepId = "failedStepId" in run ? run.failedStepId : undefined;
      return stepId === undefined ? reason : `${reason} at ${stepId}`;
    }
  }
};

/**
 * Builds the row of each of `runs`, runs of the workflow `definition`
 * describes, in the order given. `waitingRunSessions` are the sessions of
 * runs that wait on the user, most recently active first, as
 * `listWaitingRunSessions` lists them. A live run with one of them is drawn
 * as waiting, with the question of the one that has waited longest.
 */
export const buildRunRows = (
  runs: ReadonlyArray<RunSummary>,
  definition: WorkflowDefinition,
  waitingRunSessions: ReadonlyArray<WaitingRunSession>,
): ReadonlyArray<RunRow> =>
  runs.map((run): RunRow => {
    const isLive = isRunLive(run.status);
    const waiting = isLive
      ? waitingRunSessions.filter((session) => session.runId === run.id).at(-1)
      : undefined;
    const { origin } = run;
    const on =
      origin.kind === "trigger"
        ? definition.triggers?.find((trigger) => trigger.id === origin.triggerId)?.on
        : undefined;
    const { startedAt, finishedAt } = readTimestamps(run);
    return {
      id: run.id,
      state: decideRunMarkState(run, waiting !== undefined),
      statusText:
        waiting === undefined ? describeRunStatus(run) : describeWaitingRunSession(waiting),
      statusTone: waiting !== undefined ? "you" : run.status === "failed" ? "fail" : "muted",
      startedByText:
        origin.kind === "trigger" ? origin.triggerId : capitalize(describeRunOrigin(run).label),
      startedByFiresOn: on === undefined ? null : decideFiresOn(on),
      createdAt: run.createdAt,
      startedAt: startedAt ?? null,
      finishedAt: finishedAt ?? null,
      isLive,
    };
  });

/**
 * Formats how long the run of `row` took, or has taken up to `now` while it
 * is live, for the Took column: "31s", "6m 12s", "1h 4m". Returns "" for a
 * run that never started a step.
 *
 * It formats with `formatDuration`, so a live run's duration changes exactly
 * at the moments `findNextDurationChange` finds, and the screen counts it on
 * the age clock with `useDurationText(row.startedAt, row.isLive, ...)`.
 */
export const formatRunDuration = (row: RunRow, now: number): string => {
  const elapsed = measureElapsed(row.startedAt ?? undefined, row.finishedAt ?? undefined, now);
  return elapsed === undefined ? "" : formatDuration(elapsed);
};

/**
 * Describes the run of `row` in words, for assistive technology and a
 * tooltip: "Completed, started by nightly, 09:30, took 6m 12s", or "running
 * for 6m 12s" while the run is live. `startedText` is when it was created as
 * the list shows it, and `tookText` its duration (`formatRunDuration`); the
 * screen formats both against the age clock. A run that never started a
 * step has no duration, so it says none.
 */
export const describeRunRow = (row: RunRow, startedText: string, tookText: string): string =>
  [
    row.statusText,
    `started by ${row.startedByText}`,
    startedText,
    tookText === "" ? "" : `${row.isLive ? "running for" : "took"} ${tookText}`,
  ]
    .filter((part) => part !== "")
    .join(", ");

/** One trigger, as its row in the Triggers tab shows it. */
export interface TriggerRow {
  readonly id: string;
  /** The clock or the bolt drawn before the id. */
  readonly firesOn: TriggerFiresOn;
  /** What the trigger does: "Starts a run", or "Resumes a run" for a signal trigger. */
  readonly doesText: string;
  /** What it fires on: a schedule in words, or an event kind with its Connection. */
  readonly firesOnText: string;
  /**
   * Its state in words: its error, "Paused", "Off" while the workflow is
   * disabled or invalid, or "On event". Empty for a signal trigger, which fires only into a run
   * that waits for it, and when `nextFireAt` is set, or a schedule's next
   * fire is not known yet.
   */
  readonly stateText: string;
  /** `fail` for a trigger in error. */
  readonly stateTone: "fail" | "muted";
  /** When the trigger fires next, an ISO instant, which the screen shows as "Next Fri 14:00". */
  readonly nextFireAt: string | null;
  /**
   * A start trigger's pause switch, or null for a signal trigger, which has
   * none:
   *
   * - `isActive`: whether the trigger starts runs, so the switch is on. It
   *   is false while the trigger is paused.
   * - `label`: the switch's accessible name, "on_friday starts runs".
   */
  readonly switch: { readonly isActive: boolean; readonly label: string } | null;
}

/**
 * Builds a row for each of `triggers`, the workflow's own, in the order
 * `definition` declares them. `workflow` is the workflow, as its switch shows
 * it.
 *
 * The state is the first of these that holds: the trigger's error, empty for
 * a signal trigger, "Paused", "Off" while the workflow is disabled or
 * invalid, its next fire, and "On event" for a trigger that fires on events.
 */
export const buildTriggerRows = (
  definition: WorkflowDefinition,
  workflow: Pick<Workflow, "enabled" | "invalidSince">,
  triggers: ReadonlyArray<Trigger>,
): ReadonlyArray<TriggerRow> => {
  const isOn = firesTriggers(workflow);
  return sortByDeclaration(definition, triggers).map((trigger): TriggerRow => {
    const { health, status, nextFireAt, on } = trigger;
    const isStart = trigger.kind === "start";
    const isQuiet = health?.state === "error" || !isStart || status === "paused" || !isOn;
    return {
      id: trigger.triggerId,
      firesOn: decideFiresOn(on),
      doesText: isStart ? "Starts a run" : "Resumes a run",
      firesOnText: isSchedule(on) ? describeSchedule(on) : describeTriggerOn(on),
      stateText:
        health?.state === "error"
          ? health.message
          : !isStart
            ? ""
            : status === "paused"
              ? "Paused"
              : !isOn
                ? "Off"
                : isSchedule(on)
                  ? ""
                  : "On event",
      stateTone: health?.state === "error" ? "fail" : "muted",
      nextFireAt: isQuiet ? null : (nextFireAt ?? null),
      switch: isStart
        ? { isActive: status !== "paused", label: `${trigger.triggerId} starts runs` }
        : null,
    };
  });
};

/** One input, as its row in the Inputs tab shows it. */
export interface InputRow {
  readonly name: string;
  /**
   * Its type: the schema's type, "JSON" for a schema with no single type,
   * the Connection type its value is the id of ("github/github
   * connection"), or the kinds of Signal its value is the id of
   * ("github/review-requested signal").
   */
  readonly typeText: string;
  readonly requiredText: "Required" | "Optional";
  /** Its default as JSON, or "" when it has none. */
  readonly defaultText: string;
}

/** Builds a row for each input `definition` declares, in its order. */
export const buildInputRows = (definition: WorkflowDefinition): ReadonlyArray<InputRow> =>
  (definition.inputs ?? []).map((input): InputRow => {
    const schemaType = input.schema?.type;
    return {
      name: input.name,
      typeText:
        input.connection !== undefined
          ? `${input.connection.type} connection`
          : input.signal !== undefined
            ? `${input.signal.kinds.join(", ")} signal`
            : typeof schemaType === "string"
              ? schemaType
              : "JSON",
      requiredText: input.required ? "Required" : "Optional",
      defaultText: input.default === undefined ? "" : JSON.stringify(input.default),
    };
  });
