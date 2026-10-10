/**
 * PROTOTYPE. Decides what each row of the workflow list shows, and in which
 * group, from the workflow list, every trigger, and the sessions of the runs
 * that wait on the user. The Workflows ticket moves it into
 * `@hercule/client-core`, and its two time formats into `time-context.ts`.
 */
import { findOldestOpenRequest, formatDayStamp, formatRequestQuestion } from "@hercule/client-core";
import type { RunStatus, Session, Trigger } from "@hercule/contract";
import type { MarkState } from "../../marks/mark-state";
import type { RecentRun, WorkflowListEntry } from "./proposed-contract";
import { describeSchedule } from "./schedule-text";

/**
 * The groups of the list, in the order it shows them. A workflow belongs to
 * the first group whose rule it meets:
 *
 * - `needsYou`: one of its runs waits on the user;
 * - `failing`: its newest run failed, or one of its start triggers is in
 *   error. An older failure does not count once a newer run has started:
 *   the newer run is the workflow's answer to it, and red should name what
 *   is wrong now;
 * - `running`: one of its runs is live;
 * - `rest`: everything else.
 */
export const WORKFLOW_GROUPS = [
  { key: "needsYou", title: "Needs you" },
  { key: "failing", title: "Failing" },
  { key: "running", title: "Running" },
  { key: "rest", title: "Everything else" },
] as const;

export type WorkflowGroupKey = (typeof WORKFLOW_GROUPS)[number]["key"];

/** Which rows the list shows: all of them, one group, or the workflows that are off. */
export type WorkflowListFilter = "all" | "needsYou" | "failing" | "running" | "off";

/** A row's status line, and the colour it is set in. */
export interface WorkflowStatus {
  readonly text: string;
  readonly tone: "you" | "fail" | "muted";
}

/** One workflow, as its row in the list shows it. */
export interface WorkflowRow {
  readonly id: string;
  readonly name: string;
  readonly group: WorkflowGroupKey;
  /** The state mark that leads the row. */
  readonly mark: MarkState;
  /** Whether the workflow starts no runs: it is disabled, or every start trigger is paused. */
  readonly isOff: boolean;
  /**
   * What starts the workflow's runs: each start trigger's event kind or
   * schedule in words, joined with " · ". `firesOnSchedule` is the first
   * start trigger's, and picks the clock or the bolt drawn before the text.
   * `undefined` when the workflow has no start trigger, so only the user, an
   * agent or another run starts it.
   */
  readonly startsOn: { readonly firesOnSchedule: boolean; readonly text: string } | undefined;
  /** The mark of each recent run, oldest first, so the newest is at the strip's right end. */
  readonly strip: ReadonlyArray<{ readonly runId: string; readonly mark: MarkState }>;
  /** The share of recent runs that completed, of those that completed or failed: "85%". Empty when none did either. */
  readonly successText: string;
  readonly status: WorkflowStatus;
  /** When the latest run started: "10:31" today, "Sun" this week, "1 Oct" before. Empty with no runs. */
  readonly timeText: string;
  /**
   * When the workflow next starts a run: the soonest scheduled time, "On
   * event", "On demand", "Paused" or "Off". Empty when no next time is known yet.
   */
  readonly nextText: string;
  /** The words a search matches, in lower case: the name, the description and the triggers. */
  readonly searchText: string;
}

/**
 * One entry of the list, as the virtualizer draws it: a group's header or a
 * workflow's row. `key` is unique in the list and stays the same while the
 * entry is shown, so a workflow that moves to another group keeps its key.
 */
export type WorkflowListItem =
  | {
      readonly kind: "group-header";
      readonly key: string;
      readonly group: WorkflowGroupKey;
      readonly title: string;
      readonly count: number;
    }
  | { readonly kind: "workflow-row"; readonly key: string; readonly row: WorkflowRow };

/** Returns the key of the header of `group`. */
const buildGroupHeaderKey = (group: WorkflowGroupKey): string => `group:${group}`;

/**
 * The mark of a run in the strip, by its status. A live run that waits on the
 * user is drawn as waiting instead. The book has no mark for a cancelled
 * run, so it recedes as idle.
 */
export const RUN_MARKS: Readonly<Record<RunStatus, MarkState>> = {
  pending: "working",
  running: "working",
  completed: "done",
  failed: "failed",
  cancelled: "idle",
};

/** The mark that leads a row in each group but the last, whose rows are paused or idle. */
const GROUP_MARKS: Readonly<Record<Exclude<WorkflowGroupKey, "rest">, MarkState>> = {
  needsYou: "waiting",
  failing: "failed",
  running: "working",
};

/** Checks whether a run is pending or running. */
const isLive = (run: RecentRun): boolean => run.status === "pending" || run.status === "running";

/** Returns the time a run started, as the list shows it. */
const formatRunTime = (run: RecentRun | undefined, timezone: string, now: Date): string =>
  run === undefined ? "" : formatListTime(new Date(run.createdAt), timezone, now, "past");

/**
 * Returns what a step of run `runId` asks the user, such as "security asks:
 * Run npm audit fix?", from the first of `sessions` that belongs to the run
 * and has an open Request. Returns `undefined` when none does.
 */
export const describeRunRequest = (
  runId: string,
  sessions: ReadonlyArray<Session>,
): string | undefined => {
  const session = sessions.find(
    (candidate) => candidate.runId === runId && findOldestOpenRequest(candidate) !== null,
  );
  const request = session === undefined ? null : findOldestOpenRequest(session);
  if (session === undefined || request === null) return undefined;
  const question = formatRequestQuestion(request);
  return session.stepId === null ? question : `${session.stepId} asks: ${question}`;
};

/**
 * Returns the status line of a workflow that waits on the user: what the
 * step of its longest-waiting run asks. Falls back to "Waiting on you" while
 * that run's sessions are not read yet.
 */
const describeWaiting = (
  waitingRuns: ReadonlyArray<RecentRun>,
  sessions: ReadonlyArray<Session>,
): WorkflowStatus => {
  // The list holds runs newest first, so the last is the one waiting longest.
  const oldest = waitingRuns.at(-1)!;
  return { text: describeRunRequest(oldest.id, sessions) ?? "Waiting on you", tone: "you" };
};

/**
 * Returns where a workflow's live runs are: "At fix", or "2 runs · at fix,
 * waiting on pr_merged" when several are live. A run that waits for a signal
 * trigger is "waiting on" it; a run with no step started yet is "starting".
 */
const describeLive = (
  liveRuns: ReadonlyArray<RecentRun>,
  signalIds: ReadonlySet<string>,
): string => {
  const ids = [...new Set(liveRuns.flatMap((run) => run.stepIds))];
  const where =
    ids.length === 0
      ? "starting"
      : ids.map((id) => (signalIds.has(id) ? `waiting on ${id}` : `at ${id}`)).join(", ");
  return liveRuns.length > 1
    ? `${String(liveRuns.length)} runs · ${where}`
    : where.charAt(0).toUpperCase() + where.slice(1);
};

/** Returns the status line of a workflow whose latest ended run is `run`, or that has no ended run. */
const describeEnded = (run: RecentRun | undefined): WorkflowStatus => {
  if (run === undefined) return { text: "No runs yet", tone: "muted" };
  if (run.status === "failed") {
    const step = run.stepIds[0];
    return { text: step === undefined ? "Failed" : `Failed at ${step}`, tone: "fail" };
  }
  return { text: run.status === "cancelled" ? "Cancelled" : "Done", tone: "muted" };
};

/**
 * Returns when a workflow next starts a run:
 *
 * - "Off" when it is disabled;
 * - "On demand" when it has no start trigger, so only the user, an agent or
 *   another run starts it;
 * - "Paused" when every start trigger is paused;
 * - the soonest next time of its active scheduled triggers;
 * - "On event" when an active trigger fires on events;
 * - empty when no next time is known yet.
 */
const describeNext = (
  enabled: boolean,
  starts: ReadonlyArray<Trigger>,
  timezone: string,
  now: Date,
): string => {
  if (!enabled) return "Off";
  if (starts.length === 0) return "On demand";
  const active = starts.filter((trigger) => trigger.status !== "paused");
  if (active.length === 0) return "Paused";
  const soonest = active
    .map((trigger) => trigger.nextFireAt)
    .filter((at) => at !== undefined)
    .toSorted()[0];
  if (soonest !== undefined) return formatListTime(new Date(soonest), timezone, now, "future");
  return active.some((trigger) => !("schedule" in trigger.on)) ? "On event" : "";
};

/** Returns the text of what a start trigger fires on: its event kind, or its schedule in words. */
const describeStart = (trigger: Trigger): string =>
  "schedule" in trigger.on ? describeSchedule(trigger.on) : trigger.on.kind;

/**
 * Builds one row per workflow, sorted by group and then by name. `triggers`
 * holds every trigger of every workflow; `waitingSessions` the sessions of the
 * runs that wait on the user. Times are formatted in `timezone`, relative to
 * `now`.
 */
export const buildWorkflowRows = (
  workflows: ReadonlyArray<WorkflowListEntry>,
  triggers: ReadonlyArray<Trigger>,
  waitingSessions: ReadonlyArray<Session>,
  timezone: string,
  now: Date,
): ReadonlyArray<WorkflowRow> => {
  const triggersByWorkflow = new Map<string, ReadonlyArray<Trigger>>();
  for (const trigger of triggers) {
    const known = triggersByWorkflow.get(trigger.workflowId) ?? [];
    triggersByWorkflow.set(trigger.workflowId, [...known, trigger]);
  }
  const rows = workflows.map((workflow): WorkflowRow => {
    const own = triggersByWorkflow.get(workflow.id) ?? [];
    const starts = own.filter((trigger) => trigger.kind === "start");
    const signalIds = new Set(
      own.filter((trigger) => trigger.kind === "signal").map((trigger) => trigger.triggerId),
    );
    const runs = workflow.recentRuns;
    const waitingRuns = runs.filter((run) => run.waitingOnUser);
    const liveRuns = runs.filter(isLive);
    const latestEnded = runs.find((run) => !isLive(run));
    const newestFailed = runs[0]?.status === "failed";
    const brokenStart = starts.find((trigger) => trigger.health?.state === "error");
    const isOff =
      !workflow.enabled ||
      (starts.length > 0 && starts.every((trigger) => trigger.status === "paused"));

    const group: WorkflowGroupKey =
      waitingRuns.length > 0
        ? "needsYou"
        : newestFailed || brokenStart !== undefined
          ? "failing"
          : liveRuns.length > 0
            ? "running"
            : "rest";
    // A failing workflow whose newest run did not fail is failing because of
    // a start trigger in error, so the line names the trigger.
    const status: WorkflowStatus =
      group === "needsYou"
        ? describeWaiting(waitingRuns, waitingSessions)
        : group === "running"
          ? { text: describeLive(liveRuns, signalIds), tone: "muted" }
          : !newestFailed && brokenStart?.health?.state === "error"
            ? { text: `${brokenStart.triggerId}: ${brokenStart.health.message}`, tone: "fail" }
            : describeEnded(latestEnded);

    const completed = runs.filter((run) => run.status === "completed").length;
    const decided = completed + runs.filter((run) => run.status === "failed").length;
    const firstStart = starts[0];
    const startsOnText = starts.map(describeStart).join(" · ");
    return {
      id: workflow.id,
      name: workflow.name,
      group,
      mark: group === "rest" ? (isOff ? "paused" : "idle") : GROUP_MARKS[group],
      isOff,
      startsOn:
        firstStart === undefined
          ? undefined
          : { firesOnSchedule: "schedule" in firstStart.on, text: startsOnText },
      strip: runs.toReversed().map((run) => ({
        runId: run.id,
        mark: run.waitingOnUser ? "waiting" : RUN_MARKS[run.status],
      })),
      successText: decided === 0 ? "" : `${String(Math.round((completed / decided) * 100))}%`,
      status,
      timeText: formatRunTime(runs[0], timezone, now),
      nextText: describeNext(workflow.enabled, starts, timezone, now),
      searchText: [workflow.name, workflow.description ?? "", startsOnText]
        .concat(own.map((trigger) => trigger.triggerId))
        .join(" ")
        .toLowerCase(),
    };
  });
  const order = WORKFLOW_GROUPS.map((group) => group.key);
  return rows.toSorted(
    (a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.name.localeCompare(b.name),
  );
};

/** Checks whether `row` passes `filter`. */
const isShown = (row: WorkflowRow, filter: WorkflowListFilter): boolean =>
  filter === "all" ? true : filter === "off" ? row.isOff : row.group === filter;

/** The filters, in the order the list's header offers them, with each one's label. */
export const WORKFLOW_LIST_FILTERS: ReadonlyArray<{
  readonly filter: WorkflowListFilter;
  readonly label: string;
}> = [
  { filter: "all", label: "All" },
  { filter: "needsYou", label: "Needs you" },
  { filter: "failing", label: "Failing" },
  { filter: "running", label: "Running" },
  { filter: "off", label: "Off" },
];

/** Returns how many of `rows` pass each filter, before any search. */
export const countWorkflowsByFilter = (
  rows: ReadonlyArray<WorkflowRow>,
): Readonly<Record<WorkflowListFilter, number>> => ({
  all: rows.length,
  needsYou: rows.filter((row) => isShown(row, "needsYou")).length,
  failing: rows.filter((row) => isShown(row, "failing")).length,
  running: rows.filter((row) => isShown(row, "running")).length,
  off: rows.filter((row) => isShown(row, "off")).length,
});

/**
 * Builds the entries the list draws from `rows`: each group's header, with
 * how many rows it holds, followed by its rows. Only the rows that pass
 * `filter` and contain every word of `search` are kept, and a group left with
 * no rows has no header.
 */
export const buildWorkflowListItems = (
  rows: ReadonlyArray<WorkflowRow>,
  filter: WorkflowListFilter,
  search: string,
): ReadonlyArray<WorkflowListItem> => {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows.filter(
    (row) => isShown(row, filter) && words.every((word) => row.searchText.includes(word)),
  );
  return WORKFLOW_GROUPS.flatMap(({ key, title }): ReadonlyArray<WorkflowListItem> => {
    const inGroup = shown.filter((row) => row.group === key);
    return inGroup.length === 0
      ? []
      : [
          {
            kind: "group-header",
            key: buildGroupHeaderKey(key),
            group: key,
            title,
            count: inGroup.length,
          },
          ...inGroup.map((row) => ({
            kind: "workflow-row" as const,
            key: `workflow:${row.id}`,
            row,
          })),
        ];
  });
};

/**
 * Returns the key of the item that should take focus when the focused item,
 * `goneKey`, leaves the list, or `null` when the list is now empty. `before`
 * is the list that held the item and `after` the list without it. The first
 * of these that exists wins:
 *
 * - for a row, the header of the group it was in;
 * - the item that now sits where the gone item sat, or the last item when
 *   the list is now shorter than that.
 *
 * A row leaves when a filter or a search hides it. Focus stays in the list,
 * so a keyboard user never lands back at the top of the page.
 */
export const pickWorkflowFocusFallback = (
  goneKey: string,
  before: ReadonlyArray<WorkflowListItem>,
  after: ReadonlyArray<WorkflowListItem>,
): string | null => {
  const index = before.findIndex((item) => item.key === goneKey);
  const gone = before[index];
  if (gone?.kind === "workflow-row") {
    const headerKey = buildGroupHeaderKey(gone.row.group);
    if (after.some((item) => item.key === headerKey)) return headerKey;
  }
  return after[Math.min(Math.max(index, 0), after.length - 1)]?.key ?? null;
};

/** The calendar date, weekday and clock time of an instant in one timezone. */
interface CalendarParts {
  /** Days since 1 January 1970, so two instants on consecutive dates differ by exactly 1. */
  readonly dayNumber: number;
  /** "Mon". */
  readonly weekday: string;
  /** "09:14". */
  readonly clock: string;
}

/** The formatter of each timezone, built once, because building one is slow. */
const calendarFormatters = new Map<string, Intl.DateTimeFormat>();

/** Reads an instant's calendar parts in `timezone`. */
const readCalendarParts = (instant: Date, timezone: string): CalendarParts => {
  let formatter = calendarFormatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    calendarFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    dayNumber:
      Date.UTC(Number(part("year")), Number(part("month")) - 1, Number(part("day"))) / 86_400_000,
    weekday: part("weekday"),
    clock: `${part("hour")}:${part("minute")}`,
  };
};

/**
 * Formats an instant for a list column, the way a mail app dates its rows:
 * the clock time on the day of `now`, the weekday within the six days before
 * it (`past`) or after it (`future`), and the date otherwise. A future
 * weekday keeps its clock time, "Fri 14:00", because a schedule fires at a
 * time; a past weekday drops it, "Sun", because the row's age matters more.
 * The date is "1 Oct", with the year added when it is not the year of `now`.
 * `timezone` must be a supported zone.
 */
export const formatListTime = (
  instant: Date,
  timezone: string,
  now: Date,
  direction: "past" | "future",
): string => {
  const at = readCalendarParts(instant, timezone);
  const today = readCalendarParts(now, timezone).dayNumber;
  const days = direction === "past" ? today - at.dayNumber : at.dayNumber - today;
  if (days === 0) return at.clock;
  if (days > 0 && days < 7) return direction === "past" ? at.weekday : `${at.weekday} ${at.clock}`;
  return formatDayStamp(instant, timezone, now) ?? "";
};
