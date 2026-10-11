/**
 * The workflow list: what each workflow's row shows, which group it is in,
 * how many workflows each filter keeps, and the entries a virtualized list
 * draws from the rows (spec 17 §Workflows, "The list").
 *
 * A row holds only strings, numbers, booleans and null, and one array of
 * strings, the strip. Building the rows again after a push gives equal
 * values for every workflow that did not change, so a screen that compares
 * a row field by field, and the strip element by element, redraws only the
 * rows that changed.
 *
 * Times are kept as instants. The screen formats them with
 * `formatListTime` against its own clock, so a row does not change as the
 * day passes.
 */
import {
  isSchedule,
  type RunSummary,
  type Session,
  type Trigger,
  type TriggerFiresOn,
  type WorkflowSummary,
} from "@hercule/contract";
import { isRunLive } from "./run-display";
import { describeCronInWords, describeSchedule } from "./schedule-text";
import { findOldestOpenRequest } from "./threads/oldest-request";
import type { Pose } from "./threads/pose";
import { formatRequestQuestion } from "./threads/request-question";

/**
 * The groups of the list. A workflow is in the first group whose rule it
 * meets, in this order:
 *
 * - `needsYou`: one of its live runs has a session with an open Request;
 * - `failing`: its newest run failed, or one of its start triggers is in
 *   error;
 * - `running`: one of its runs is live;
 * - `everythingElse`: the rest.
 */
export type WorkflowGroup = "needsYou" | "failing" | "running" | "everythingElse";

/** The groups in the order the list shows them, each with its heading. */
const WORKFLOW_GROUPS: ReadonlyArray<{ readonly group: WorkflowGroup; readonly title: string }> = [
  { group: "needsYou", title: "Needs you" },
  { group: "failing", title: "Failing" },
  { group: "running", title: "Running" },
  { group: "everythingElse", title: "Everything else" },
];

/**
 * The state mark that leads a row: its group's mark, or in Everything else
 * `idle`, or `paused` for a workflow that is off.
 */
export type WorkflowRowMark = Extract<Pose, "waiting" | "failed" | "working" | "idle" | "paused">;

/**
 * One run in a row's strip. A run waiting on the user, a running run, a
 * completed run and a failed run each have a mark. A cancelled run and a
 * run that has not started yet have none: the strip draws a faint dot for
 * them, and names it with the state.
 */
export type StripRunState =
  Extract<Pose, "waiting" | "working" | "done" | "failed"> | "cancelled" | "starting";

/** The colour of a row's status text: the user's, failure's, or muted ink. */
export type WorkflowStatusTone = "you" | "fail" | "muted";

/** One workflow, as its row in the list shows it. */
export interface WorkflowRow {
  readonly id: string;
  readonly name: string;
  readonly group: WorkflowGroup;
  readonly mark: WorkflowRowMark;
  /**
   * Whether the workflow starts no runs: its switch is off, or it has start
   * triggers and every one of them is paused. The row is drawn in muted ink.
   */
  readonly isOff: boolean;
  /**
   * What starts the workflow, its start triggers joined with " · ": each
   * schedule in words ("Daily at 01:00", with " (Europe/Amsterdam)" when the
   * schedule has a time zone of its own) or each event's kind. "On demand"
   * when it has no start trigger.
   */
  readonly startsOnText: string;
  /**
   * Whether the first start trigger fires on events or on a schedule, which
   * picks the bolt or the clock that leads the cell. Null with no start
   * trigger.
   */
  readonly startsOnFiresOn: TriggerFiresOn | null;
  /**
   * Whether `startsOnText` is one cron expression with no words for it, which
   * is shown as code.
   */
  readonly startsOnIsCode: boolean;
  /** The newest runs, at most 20, oldest first, so the newest sits at the strip's right end. */
  readonly strip: ReadonlyArray<StripRunState>;
  /** Completed runs out of completed and failed ones in the strip, as "85%". Empty when there are none. */
  readonly successText: string;
  /** The status text of the last run, such as "review asks: Ship v2.4?", "At review" or "Done". */
  readonly statusText: string;
  readonly statusTone: WorkflowStatusTone;
  /** When the newest run was created, an ISO instant. Null when the workflow has no runs. */
  readonly lastRunAt: string | null;
  /**
   * When the workflow next starts, in words, when it is no time: "Off" while
   * its switch is off, "On demand" with no start trigger, "Paused" when every
   * start trigger is paused, "On event" when an active one fires on events.
   * Empty when `nextFireAt` is set, and when the only active triggers are
   * schedules whose next fire is not known yet.
   */
  readonly nextText: string;
  /** The soonest next fire of the active scheduled start triggers, an ISO instant, or null. */
  readonly nextFireAt: string | null;
  /** The words a search looks in, in lower case: the name, the description, Starts on and the trigger ids. */
  readonly searchText: string;
}

/** What the list reads, and the workflow rows are built from (spec 17 §Workflows, "What the pages read"). */
export interface WorkflowListReads {
  /** Every workflow, from `workflow.query`. */
  readonly workflows: ReadonlyArray<WorkflowSummary>;
  /** Every trigger of every workflow, from `trigger.query`. */
  readonly triggers: ReadonlyArray<Trigger>;
  /**
   * Each workflow's newest runs, newest first, from `run.query({ workflowId,
   * limit: 20 })`, by workflow id. A workflow whose strip is not read yet
   * has no entry.
   */
  readonly strips: ReadonlyMap<string, ReadonlyArray<RunSummary>>;
  /** Every live run, from `run.query` with `status: "running"` and with `status: "pending"`. */
  readonly liveRuns: ReadonlyArray<RunSummary>;
  /**
   * The live sessions that are not threads. Those with a `runId` and an open
   * Request are the ones a run waits on the user through.
   */
  readonly sessions: ReadonlyArray<Session>;
}

/**
 * Returns `items` in lists by the key `readKey` reads from each, every list in
 * the order of `items`.
 */
const groupByKey = <Item, Key>(
  items: ReadonlyArray<Item>,
  readKey: (item: Item) => Key,
): ReadonlyMap<Key, ReadonlyArray<Item>> => {
  const groups = new Map<Key, Item[]>();
  for (const item of items) {
    const key = readKey(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
};

/** Checks whether a run has not started any step yet: it is pending, or running with nothing active or awaited. */
const isRunStarting = (run: RunSummary): boolean =>
  run.status === "pending" ||
  (run.status === "running" && run.activeStepIds.length === 0 && run.awaitedSignalIds.length === 0);

/** Returns the newer of two runs, by when they were created. */
const pickNewerRun = (a: RunSummary | undefined, b: RunSummary): RunSummary =>
  a === undefined || Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a;

/** Returns a run's state in a strip. `isWaiting` tells whether a session of the run waits on the user. */
const decideStripRunState = (run: RunSummary, isWaiting: boolean): StripRunState => {
  if (isWaiting) return "waiting";
  if (isRunStarting(run)) return "starting";
  if (run.status === "running") return "working";
  if (run.status === "completed") return "done";
  if (run.status === "failed") return "failed";
  return "cancelled";
};

/**
 * Returns the status text of a workflow that waits on the user, from the
 * session that has waited longest: "review asks: Ship v2.4?", the step and
 * the question of its oldest open Request. A session that is no step's
 * reads "Waiting on you".
 */
const describeWaitingSession = (session: Session): string => {
  const request = findOldestOpenRequest(session);
  return request === null || session.stepId === null
    ? "Waiting on you"
    : `${session.stepId} asks: ${formatRequestQuestion(request)}`;
};

/**
 * Returns where a workflow's live runs are: "At review", "Waiting for
 * approved" while a run waits on a signal, or "Starting" before a run has
 * started a step. Several live runs are counted, and their places listed
 * once each: "2 runs · at fix, waiting for pr_merged".
 */
const describeLiveRuns = (runs: ReadonlyArray<RunSummary>): string => {
  const places = new Set<string>();
  for (const run of runs) {
    if (isRunStarting(run)) places.add("starting");
    if (run.status !== "running") continue;
    for (const stepId of run.activeStepIds) places.add(`at ${stepId}`);
    for (const signalId of run.awaitedSignalIds) places.add(`waiting for ${signalId}`);
  }
  const where = [...places].join(", ");
  return runs.length > 1
    ? `${String(runs.length)} runs · ${where}`
    : where.charAt(0).toUpperCase() + where.slice(1);
};

/** Returns the status text of a run that has ended: "Failed at review", "Failed", "Cancelled" or "Done". */
const describeEndedRun = (run: RunSummary): string => {
  if (run.status === "failed") {
    return "failedStepId" in run && run.failedStepId !== undefined
      ? `Failed at ${run.failedStepId}`
      : "Failed";
  }
  return run.status === "cancelled" ? "Cancelled" : "Done";
};

/**
 * Returns the text of one start trigger in Starts on: its schedule in words,
 * or as its cron expression when it has no words, or its event's kind.
 */
const describeStartTrigger = (trigger: Trigger): string =>
  isSchedule(trigger.on) ? describeSchedule(trigger.on) : trigger.on.kind;

/**
 * Builds the row of each workflow from what the list reads, sorted by group
 * in the list's order and by name within a group.
 *
 * The newest run decides between Failing and Running. It is the newest of
 * the strip's runs and the workflow's live runs, so a run that started after
 * the strip was read still counts. Running reads the live runs, never the
 * strip, so a live run older than the strip's 20 counts too.
 */
export const buildWorkflowRows = ({
  workflows,
  triggers,
  strips,
  liveRuns,
  sessions,
}: WorkflowListReads): ReadonlyArray<WorkflowRow> => {
  const triggersByWorkflow = groupByKey(triggers, (trigger) => trigger.workflowId);
  const liveRunsByWorkflow = groupByKey(liveRuns, (run) => run.workflowId);
  const liveRunWorkflows = new Map(liveRuns.map((run) => [run.id, run.workflowId]));

  // The sessions waiting on the user, by the workflow of their run, the one
  // that has waited longest first.
  const waitingSessions = sessions
    .filter((session) => session.runId !== null && session.openRequests.length > 0)
    .toSorted(
      (a, b) =>
        Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt) || a.id.localeCompare(b.id),
    );
  const waitingRunIds = new Set(waitingSessions.map((session) => session.runId));
  const waitingByWorkflow = groupByKey(waitingSessions, (session) =>
    liveRunWorkflows.get(session.runId ?? ""),
  );

  const rows = workflows.map((workflow): WorkflowRow => {
    const own = triggersByWorkflow.get(workflow.id) ?? [];
    const starts = own.filter((trigger) => trigger.kind === "start");
    const active = starts.filter((trigger) => trigger.status !== "paused");
    const brokenStart = starts.find((trigger) => trigger.health?.state === "error");
    const strip = strips.get(workflow.id) ?? [];
    const live = liveRunsByWorkflow.get(workflow.id) ?? [];
    const waiting = waitingByWorkflow.get(workflow.id)?.[0];
    const newest = [...strip.slice(0, 1), ...live].reduce<RunSummary | undefined>(
      pickNewerRun,
      undefined,
    );
    const isOff = !workflow.enabled || (starts.length > 0 && active.length === 0);

    const group: WorkflowGroup =
      waiting !== undefined
        ? "needsYou"
        : newest?.status === "failed" || brokenStart !== undefined
          ? "failing"
          : live.length > 0
            ? "running"
            : "everythingElse";

    // A workflow in Failing whose newest run did not fail is there because
    // of a start trigger in error, so its status names the trigger.
    const lastEnded = strip.find((run) => !isRunLive(run.status));
    const statusText =
      waiting !== undefined
        ? describeWaitingSession(waiting)
        : group === "failing" &&
            newest?.status !== "failed" &&
            brokenStart?.health?.state === "error"
          ? `${brokenStart.triggerId}: ${brokenStart.health.message}`
          : group === "running"
            ? describeLiveRuns(live)
            : lastEnded === undefined
              ? "No runs yet"
              : describeEndedRun(lastEnded);

    const startTexts = starts.map(describeStartTrigger);
    const firstStart = starts[0];
    const onlyStartOn = starts.length === 1 ? firstStart?.on : undefined;
    const completed = strip.filter((run) => run.status === "completed").length;
    const ended = completed + strip.filter((run) => run.status === "failed").length;
    const nextFireAt =
      active
        .map((trigger) => trigger.nextFireAt)
        .filter((at) => at !== undefined)
        .toSorted((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;

    return {
      id: workflow.id,
      name: workflow.name,
      group,
      mark:
        group === "needsYou"
          ? "waiting"
          : group === "failing"
            ? "failed"
            : group === "running"
              ? "working"
              : isOff
                ? "paused"
                : "idle",
      isOff,
      startsOnText: starts.length === 0 ? "On demand" : startTexts.join(" · "),
      startsOnFiresOn:
        firstStart === undefined ? null : isSchedule(firstStart.on) ? "schedule" : "event",
      startsOnIsCode:
        onlyStartOn !== undefined &&
        isSchedule(onlyStartOn) &&
        describeCronInWords(onlyStartOn.schedule) === undefined,
      strip: strip.toReversed().map((run) => decideStripRunState(run, waitingRunIds.has(run.id))),
      successText: ended === 0 ? "" : `${String(Math.round((completed / ended) * 100))}%`,
      statusText,
      statusTone: group === "needsYou" ? "you" : group === "failing" ? "fail" : "muted",
      lastRunAt: newest?.createdAt ?? null,
      nextText: !workflow.enabled
        ? "Off"
        : starts.length === 0
          ? "On demand"
          : active.length === 0
            ? "Paused"
            : nextFireAt === null && active.some((trigger) => !isSchedule(trigger.on))
              ? "On event"
              : "",
      nextFireAt: workflow.enabled ? nextFireAt : null,
      searchText: [workflow.name, workflow.description ?? "", ...startTexts]
        .concat(own.map((trigger) => trigger.triggerId))
        .join(" ")
        .toLowerCase(),
    };
  });

  const order = WORKFLOW_GROUPS.map(({ group }) => group);
  return rows.toSorted(
    (a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.name.localeCompare(b.name),
  );
};

/** Which rows the list shows: all, one group's, or the workflows that are off, from every group. */
export type WorkflowListFilter = "all" | "needsYou" | "failing" | "running" | "off";

/** The filters, in the order the list's header offers them, each with its label. */
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

/** Checks whether `row` passes `filter`. */
const isRowShown = (row: WorkflowRow, filter: WorkflowListFilter): boolean =>
  filter === "all" ? true : filter === "off" ? row.isOff : row.group === filter;

/**
 * Counts how many of `rows` each filter keeps. The counts are taken before
 * any search, so they do not change as the user types.
 */
export const countWorkflowsByFilter = (
  rows: ReadonlyArray<WorkflowRow>,
): Readonly<Record<WorkflowListFilter, number>> => ({
  all: rows.length,
  needsYou: rows.filter((row) => isRowShown(row, "needsYou")).length,
  failing: rows.filter((row) => isRowShown(row, "failing")).length,
  running: rows.filter((row) => isRowShown(row, "running")).length,
  off: rows.filter((row) => isRowShown(row, "off")).length,
});

/**
 * One entry of the list, as the virtualizer draws it: a group's heading or a
 * workflow's row. `key` is unique in the list and stays the same while the
 * entry is shown, so a row that moves to another group keeps its key.
 */
export type WorkflowListItem =
  | {
      readonly kind: "group-header";
      readonly key: string;
      readonly group: WorkflowGroup;
      readonly title: string;
      /** How many of the group's rows are shown. */
      readonly count: number;
    }
  | { readonly kind: "workflow-row"; readonly key: string; readonly row: WorkflowRow };

/** Returns the key of the heading of `group`. */
const buildGroupHeaderKey = (group: WorkflowGroup): string => `group:${group}`;

/**
 * Builds the entries the list draws from `rows`, which `buildWorkflowRows`
 * sorted: each group's heading, with how many rows it shows, followed by
 * those rows. Only the rows that pass `filter` and contain every word of
 * `search`, ignoring case, are kept. A group left with no rows has no
 * heading.
 */
export const buildWorkflowListItems = (
  rows: ReadonlyArray<WorkflowRow>,
  filter: WorkflowListFilter,
  search: string,
): ReadonlyArray<WorkflowListItem> => {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows.filter(
    (row) => isRowShown(row, filter) && words.every((word) => row.searchText.includes(word)),
  );
  return WORKFLOW_GROUPS.flatMap(({ group, title }): ReadonlyArray<WorkflowListItem> => {
    const inGroup = shown.filter((row) => row.group === group);
    if (inGroup.length === 0) return [];
    return [
      {
        kind: "group-header",
        key: buildGroupHeaderKey(group),
        group,
        title,
        count: inGroup.length,
      },
      ...inGroup.map((row) => ({ kind: "workflow-row" as const, key: `workflow:${row.id}`, row })),
    ];
  });
};

/**
 * Returns the key of the entry that takes focus when the focused entry,
 * `goneKey`, leaves the list, or null when the list is now empty. `before`
 * is the list that held the entry and `after` the list without it. The first
 * of these that exists wins:
 *
 * - for a row, the heading of the group it was in;
 * - the entry that now sits where the gone entry sat, or the last entry when
 *   the list is now shorter than that.
 *
 * A row leaves when a filter or a search hides it. Focus stays in the list, so a keyboard user never lands
 * back at the top of the page.
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
