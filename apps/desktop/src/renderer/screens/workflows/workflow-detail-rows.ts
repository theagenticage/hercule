/**
 * PROTOTYPE. Decides what the page of an open workflow shows: the chips
 * under its name, and the rows of its Runs, Triggers and Inputs tabs. The
 * Workflows ticket moves it into `@hercule/client-core`, beside the list's
 * rows.
 */
import {
  describeFailureReason,
  describeRunOrigin,
  describeTrigger,
  describeTriggerOn,
  formatElapsed,
  isRunLive,
  measureElapsed,
  readTimestamps,
} from "@hercule/client-core";
import type { Run, RunSummary, Session, Trigger, WorkflowDefinition } from "@hercule/contract";
import type { MarkState } from "../../marks/mark-state";
import { describeSchedule } from "./schedule-text";
import {
  describeRunRequest,
  formatListTime,
  RUN_MARKS,
  type WorkflowStatus,
} from "./workflow-rows";

/** What a trigger fires on, which picks the clock or the bolt drawn before it. */
export type TriggerSource = "schedule" | "event";

/** One chip under a workflow's name. */
export interface WorkflowChip {
  /** A key that is unique among the chips. */
  readonly key: string;
  /** The clock or the bolt drawn before the text, or `undefined` for none. */
  readonly source: TriggerSource | undefined;
  readonly text: string;
  /** `fail` for a start trigger in error. */
  readonly tone: "fail" | undefined;
}

/** One run, as its row in the Runs tab shows it. */
export interface RunRow {
  readonly id: string;
  readonly mark: MarkState;
  readonly status: WorkflowStatus;
  /**
   * Who or what started the run: the id of the trigger that started it,
   * drawn after a clock or a bolt, or the actor, "You".
   */
  readonly startedBy: { readonly source: TriggerSource | undefined; readonly text: string };
  /** Whether the run has not ended. */
  readonly isLive: boolean;
  /** How long the run took, or has taken so far: "6m 12s". Empty while it is pending. */
  readonly durationText: string;
  /** When the run was created: "10:31" today, "Thu" this week, "3 Oct" before. */
  readonly timeText: string;
}

/** One trigger, as its row in the Triggers tab shows it. */
export interface TriggerRow {
  readonly id: string;
  readonly source: TriggerSource;
  /** What the trigger does: "Starts a run", or "Resumes a run" for a signal. */
  readonly roleText: string;
  /** What it fires on: a schedule in words, or an event kind with its Connection. */
  readonly firesOnText: string;
  /**
   * Its state: its error, when it next fires, "On event", "Paused", or "Off".
   * Empty for a signal with no error, which fires only into a run that waits
   * for it, so it has no schedule and nothing to pause.
   */
  readonly status: WorkflowStatus;
}

/** One input, as its row in the Inputs tab shows it. */
export interface InputRow {
  readonly name: string;
  /** Its type: the schema's type, or the Connection type its value is the id of. */
  readonly typeText: string;
  readonly requiredText: "Required" | "Optional";
  /** Its default as JSON, or empty when it has none. */
  readonly defaultText: string;
}

/** Returns `text` with its first letter in upper case. */
const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Returns what `on` fires on: a schedule or events. */
const readSource = (on: Trigger["on"]): TriggerSource => ("schedule" in on ? "schedule" : "event");

/** Returns `count` with the noun after it, "1 agent" or "5 agents", or `undefined` for none. */
const countNoun = (count: number, noun: string): string | undefined =>
  count === 0 ? undefined : `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Builds the chips under a workflow's name, in this order:
 *
 * - one per start trigger in `triggers`, the workflow's own: what it fires
 *   on, with "paused", "error", or when it next fires;
 * - "On demand" instead when it has no start trigger, so only the user, an
 *   agent or another run starts it;
 * - what its steps run, "5 agents · 2 actions · 1 signal";
 * - "Off" when the workflow is disabled.
 *
 * Times are formatted in `timezone`, relative to `now`.
 */
export const buildWorkflowChips = (
  definition: WorkflowDefinition,
  enabled: boolean,
  triggers: ReadonlyArray<Trigger>,
  timezone: string,
  now: Date,
): ReadonlyArray<WorkflowChip> => {
  const starts = triggers.filter((trigger) => trigger.kind === "start");
  const startChips = starts.map((trigger): WorkflowChip => {
    const words = "schedule" in trigger.on ? describeSchedule(trigger.on) : trigger.on.kind;
    const isBroken = trigger.health?.state === "error";
    const suffix = isBroken
      ? "error"
      : trigger.status === "paused"
        ? "paused"
        : enabled && trigger.nextFireAt !== undefined
          ? `next ${formatListTime(new Date(trigger.nextFireAt), timezone, now, "future")}`
          : undefined;
    return {
      key: `trigger:${trigger.triggerId}`,
      source: readSource(trigger.on),
      text: suffix === undefined ? words : `${words} · ${suffix}`,
      tone: isBroken ? "fail" : undefined,
    };
  });
  const steps = definition.steps;
  const counts = [
    countNoun(steps.filter((step) => step.kind === "agent").length, "agent"),
    countNoun(steps.filter((step) => step.kind === "action").length, "action"),
    countNoun((definition.triggers ?? []).filter((t) => t.kind === "signal").length, "signal"),
  ].filter((count) => count !== undefined);
  return [
    ...(startChips.length > 0
      ? startChips
      : [{ key: "on-demand", source: undefined, text: "On demand", tone: undefined }]),
    { key: "steps", source: undefined, text: counts.join(" · "), tone: undefined },
    ...(enabled ? [] : [{ key: "off", source: undefined, text: "Off", tone: undefined }]),
  ];
};

/**
 * Returns a run's status line: what its step asks the user while it waits on
 * them, how it failed and at which step, or its status in words.
 */
const describeRunState = (run: Run | RunSummary, request: string | undefined): WorkflowStatus => {
  if (request !== undefined) return { text: request, tone: "you" };
  switch (run.status) {
    case "pending":
      return { text: "Starting", tone: "muted" };
    case "running":
      return { text: "Running", tone: "muted" };
    case "completed":
      return { text: "Completed", tone: "muted" };
    case "cancelled":
      return { text: "Cancelled", tone: "muted" };
    case "failed": {
      const reason = capitalize(describeFailureReason(run.failureReason));
      const stepId = "failedStepId" in run ? run.failedStepId : undefined;
      return { text: stepId === undefined ? reason : `${reason} at ${stepId}`, tone: "fail" };
    }
  }
};

/**
 * Builds the row of `run`, a run of the workflow `definition` describes.
 * `waitingSessions` are the sessions of the runs that wait on the user: a
 * live run with one of them is drawn as waiting, with its step's question.
 * Times are formatted in `timezone`, relative to `now`.
 */
export const buildRunRow = (
  run: Run | RunSummary,
  definition: WorkflowDefinition,
  waitingSessions: ReadonlyArray<Session>,
  timezone: string,
  now: Date,
): RunRow => {
  const isLive = isRunLive(run.status);
  const request = isLive ? describeRunRequest(run.id, waitingSessions) : undefined;
  const { origin } = run;
  const on =
    origin.kind === "trigger"
      ? definition.triggers?.find((trigger) => trigger.id === origin.triggerId)?.on
      : undefined;
  const { startedAt, finishedAt } = readTimestamps(run);
  const elapsed = measureElapsed(startedAt, finishedAt, now.getTime());
  return {
    id: run.id,
    mark: request === undefined ? RUN_MARKS[run.status] : "waiting",
    status: describeRunState(run, request),
    startedBy:
      origin.kind === "trigger"
        ? { source: on === undefined ? undefined : readSource(on), text: origin.triggerId }
        : { source: undefined, text: capitalize(describeRunOrigin(run).label) },
    isLive,
    durationText: elapsed === undefined ? "" : formatElapsed(elapsed),
    timeText: formatListTime(new Date(run.createdAt), timezone, now, "past"),
  };
};

/**
 * Describes a run's row in words, for assistive technology and a tooltip:
 * "Completed, started by friday, 09:12, took 6m 12s", or "running for 6m
 * 12s" while the run has not ended. A run that has not started says neither.
 */
export const describeRunRow = (row: RunRow): string =>
  [
    row.status.text,
    `started by ${row.startedBy.text}`,
    row.timeText,
    row.durationText === "" ? "" : `${row.isLive ? "running for" : "took"} ${row.durationText}`,
  ]
    .filter(Boolean)
    .join(", ");

/**
 * Builds a row for each of `triggers`, the workflow's own, in the order its
 * `definition` declares them. `enabled` is whether the workflow is enabled:
 * a disabled workflow's start triggers are "Off". Times are formatted in
 * `timezone`, relative to `now`.
 */
export const buildTriggerRows = (
  definition: WorkflowDefinition,
  enabled: boolean,
  triggers: ReadonlyArray<Trigger>,
  timezone: string,
  now: Date,
): ReadonlyArray<TriggerRow> => {
  const order = (definition.triggers ?? []).map((trigger) => trigger.id);
  return triggers
    .toSorted((a, b) => order.indexOf(a.triggerId) - order.indexOf(b.triggerId))
    .map((trigger): TriggerRow => {
      const reading = describeTrigger(trigger, timezone, enabled);
      const next =
        trigger.nextFireAt === undefined
          ? "schedule" in trigger.on
            ? ""
            : "On event"
          : `Next ${formatListTime(new Date(trigger.nextFireAt), timezone, now, "future")}`;
      const status: WorkflowStatus =
        reading.healthError !== undefined
          ? { text: reading.healthError.message, tone: "fail" }
          : trigger.kind === "signal"
            ? { text: "", tone: "muted" }
            : trigger.status === "paused"
              ? { text: "Paused", tone: "muted" }
              : !enabled
                ? { text: "Off", tone: "muted" }
                : {
                    text: [next, reading.skippedTicksText ?? ""].filter(Boolean).join(" · "),
                    tone: "muted",
                  };
      return {
        id: trigger.triggerId,
        source: readSource(trigger.on),
        roleText: trigger.kind === "start" ? "Starts a run" : "Resumes a run",
        firesOnText:
          "schedule" in trigger.on ? describeSchedule(trigger.on) : describeTriggerOn(trigger.on),
        status,
      };
    });
};

/** Builds a row for each input `definition` declares, in its order. */
export const buildInputRows = (definition: WorkflowDefinition): ReadonlyArray<InputRow> =>
  (definition.inputs ?? []).map((input) => {
    const schemaType = input.schema?.type;
    return {
      name: input.name,
      typeText:
        input.connection !== undefined
          ? `${input.connection.type} connection`
          : typeof schemaType === "string"
            ? schemaType
            : "JSON",
      requiredText: input.required ? "Required" : "Optional",
      defaultText: input.default === undefined ? "" : JSON.stringify(input.default),
    };
  });
