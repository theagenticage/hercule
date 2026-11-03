/**
 * The words of a machine's activity list on the desktop Fleet screen: the
 * audit log entries of one machine, filtered, folded and grouped by day.
 *
 * Every function here is pure. The caller passes the entries, as
 * `event.query { runnerId }` returns them (newest first, every loaded page at
 * once), the timezone, and `today` (see `fleet.ts` for what `today` is).
 *
 * This module is its own subpath (`@hercule/client-core/machine-activity`)
 * and is not re-exported from the package index, so the first screen does
 * not carry it.
 */
import {
  RUNNER_ACTIVITY_KINDS,
  type Event,
  type ProviderAccount,
  type RunnerActivityKind,
} from "@hercule/contract";
import { describeActor, readActorSessionId } from "../actor-display";
import { formatClock, formatDayStampWithWeekday, readCalendarDate } from "../time-context";
import { splitDiskSize } from "./machine";

/** Which entries the activity list shows. */
export type MachineActivityFilter =
  | "all"
  | "problems"
  | "connection"
  | "sessions"
  | "workspaces"
  | "settings";

/** The filters in the order the segmented control shows them, with their labels. */
export const MACHINE_ACTIVITY_FILTERS: ReadonlyArray<{
  readonly filter: MachineActivityFilter;
  readonly label: string;
}> = [
  { filter: "all", label: "All" },
  { filter: "problems", label: "Problems" },
  { filter: "connection", label: "Connection" },
  { filter: "sessions", label: "Sessions" },
  { filter: "workspaces", label: "Workspaces" },
  { filter: "settings", label: "Settings" },
];

/**
 * Who did it. The screen draws "you" for `user`, the session's face and name
 * for `session`, "Hercule" for `system`, and the `label` for `other`.
 */
export type MachineActivityActor =
  | { readonly kind: "user" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "system" }
  /** A run (`run 1f3a9c2e`) or a plugin (`plugin:github`), named as `describeActor` names it. */
  | { readonly kind: "other"; readonly label: string };

/** One audit log entry that a folded entry unfolds into. */
export interface MachineActivityDetail {
  readonly eventId: number;
  /**
   * What this one audit log entry was, from its payload alone. Left out when
   * every audit log entry of the folded entry has the same line, because it
   * would only repeat the entry's sentence.
   */
  readonly line?: string;
  /** The session the audit log entry is about, for the screen to name beside `line`. */
  readonly sessionId?: string;
}

/**
 * One line of the list: one audit log entry, or several of one kind that
 * happened in one minute and were folded into one.
 */
export interface MachineActivityEntry {
  /** The newest audit log entry's event id, as text. */
  readonly key: string;
  /** When the entry happened, "09:12": 24-hour, in the display timezone. Every audit log entry of the entry happened in this minute. */
  readonly time: string;
  readonly category: MachineActivityCategory;
  readonly problem: boolean;
  /** Complete without any name that needs a read: "Went offline", "12 sessions spawned". */
  readonly sentence: string;
  /** Set when every audit log entry of the entry was spawned for one workflow run. The screen appends "for <the run's workflow name>". */
  readonly runId?: string;
  readonly actor: MachineActivityActor;
  /** How many audit log entries this entry stands for: the number in "12 sessions spawned", 1 when nothing folded. */
  readonly count: number;
  /**
   * The session a single entry is about, which the screen names after the
   * sentence: " · <title>". Left out for a folded entry, whose sessions are
   * its `details`, and when the audit log entry names no session.
   */
  readonly subjectSessionId?: string;
  /**
   * The audit log entries a folded entry unfolds into, newest first. They are
   * listed only when they tell the user something the sentence does not: at
   * least one has a `sessionId`, or their lines are not all the same.
   * Otherwise empty, because there is nothing to unfold: "3 workspaces of
   * finished runs removed" would unfold into three identical lines. A single
   * entry never has details.
   */
  readonly details: ReadonlyArray<MachineActivityDetail>;
}

/** The entries of one local day. */
export interface MachineActivityDay {
  /** The local date, "2026-11-03". */
  readonly key: string;
  /** "Today", "Yesterday", else the weekday and date: "Sun 1 Nov", with the year when it is not this year. */
  readonly heading: string;
  readonly entries: ReadonlyArray<MachineActivityEntry>;
}

/** Which filter besides "all" and "problems" an entry belongs to. */
export type MachineActivityCategory = "connection" | "sessions" | "workspaces" | "settings";

/** The words of an entry: for one audit log entry, and for several folded together. */
interface Wording {
  readonly forOne: string;
  readonly forCount: (count: number) => string;
}

/** What one audit log entry stands for. */
interface Reading {
  readonly category: MachineActivityCategory;
  readonly problem: boolean;
  readonly wording: Wording;
  /**
   * Entries fold only when this is equal as well as their kind, actor and
   * minute. It is whatever changes the words, such as the connection state.
   */
  readonly foldVariant: string;
  readonly sessionId?: string;
  readonly runId?: string;
}

type EventPayload = Event["payload"];

const formatCount = (count: number): string => count.toLocaleString("en-US");

/**
 * Builds the words for a kind whose entries are things to count. `forMany`
 * holds a `#` where the count goes: "# sessions spawned" reads "12 sessions
 * spawned".
 */
const buildCountedWording = (forOne: string, forMany: string): Wording => ({
  forOne,
  forCount: (count) => forMany.replace("#", formatCount(count)),
});

/** Builds the words for an entry that is not a thing to count; folded, it reads "Went offline (2 times)". */
const buildRepeatedWording = (forOne: string): Wording => ({
  forOne,
  forCount: (count) => `${forOne} (${formatCount(count)} times)`,
});

const readText = (payload: EventPayload, key: string): string | undefined => {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
};

const readFlag = (payload: EventPayload, key: string): boolean | undefined => {
  const value = payload[key];
  return typeof value === "boolean" ? value : undefined;
};

const readNumber = (payload: EventPayload, key: string): number | undefined => {
  const value = payload[key];
  return typeof value === "number" ? value : undefined;
};

/** Reads the `{ old, new }` pair that the `changes` of a `runner.updated` entry hold for `field`, or `undefined` when the field is missing or not a pair. */
const readChange = (
  changes: EventPayload,
  field: string,
): { old: unknown; new: unknown } | undefined => {
  const change = changes[field];
  return typeof change === "object" && change !== null && "old" in change && "new" in change
    ? { old: change.old, new: change.new }
    : undefined;
};

const readLabels = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((label) => typeof label === "string") ? value : undefined;

const formatDiskLimit = (bytes: number): string => {
  const size = splitDiskSize(bytes);
  return `${size.amount} ${size.unit}`;
};

/** Describes the change of the labels: "added label gpu", "removed labels a, b", or both. */
const describeLabelChange = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): string => {
  const had = new Set(before);
  const has = new Set(after);
  const added = after.filter((label) => !had.has(label));
  const removed = before.filter((label) => !has.has(label));
  const parts = [
    ...(added.length === 0
      ? []
      : [`added ${added.length === 1 ? "label" : "labels"} ${added.join(", ")}`]),
    ...(removed.length === 0
      ? []
      : [`removed ${removed.length === 1 ? "label" : "labels"} ${removed.join(", ")}`]),
  ];
  return parts.length === 0 ? "labels changed" : parts.join(" and ");
};

/**
 * Describes what a `runner.updated` entry changed, in the order the page's
 * Settings list the fields, such as "Session cap changed from 10 to 13; disk
 * limit changed from 10.7 GB to 20 GB". A field whose values are not of the
 * shape the controller writes is left out; when nothing is left, it reads
 * "Settings changed".
 */
const describeSettingsChange = (payload: EventPayload): string => {
  const changes = payload["changes"];
  const record = (typeof changes === "object" && changes !== null ? changes : {}) as EventPayload;
  const fragments: string[] = [];

  const name = readChange(record, "name");
  if (typeof name?.old === "string" && typeof name.new === "string") {
    fragments.push(`renamed from ${name.old} to ${name.new}`);
  }
  const cap = readChange(record, "maxConcurrentSessions");
  if (typeof cap?.old === "number" && typeof cap.new === "number") {
    fragments.push(`session cap changed from ${formatCount(cap.old)} to ${formatCount(cap.new)}`);
  }
  const labels = readChange(record, "labels");
  const labelsBefore = readLabels(labels?.old);
  const labelsAfter = readLabels(labels?.new);
  if (labelsBefore !== undefined && labelsAfter !== undefined) {
    fragments.push(describeLabelChange(labelsBefore, labelsAfter));
  }
  const reserved = readChange(record, "reserved");
  if (typeof reserved?.new === "boolean") {
    fragments.push(reserved.new ? "marked as reserved" : "no longer reserved");
  }
  const disk = readChange(record, "diskWatermarkBytes");
  if (typeof disk?.old === "number" && typeof disk.new === "number") {
    fragments.push(
      `disk limit changed from ${formatDiskLimit(disk.old)} to ${formatDiskLimit(disk.new)}`,
    );
  }

  if (fragments.length === 0) return "Settings changed";
  const sentence = fragments.join("; ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
};

/** The phrase for a workspace the sweep removed, by the reason it records: singular, then plural. */
const SWEPT_WORKSPACES: ReadonlyMap<string, readonly [string, string]> = new Map([
  ["none", ["a workspace of a finished run", "workspaces of finished runs"]],
  ["orphan", ["a workspace no thread can resume", "workspaces no thread can resume"]],
  ["idle", ["an idle workspace", "idle workspaces"]],
  ["inspection", ["a workspace kept for inspection", "workspaces kept for inspection"]],
  ["archived", ["an archived thread's workspace", "archived threads' workspaces"]],
]);

/**
 * Returns the phrase for `count` workspaces the sweep removed for `reason`,
 * such as "a workspace of a finished run" or "2 workspaces of finished runs".
 * A reason this list does not know gives "a workspace" or "2 workspaces".
 */
export const describeSweptWorkspaces = (reason: string, count: number): string => {
  const swept = SWEPT_WORKSPACES.get(reason);
  if (count === 1) return swept === undefined ? "a workspace" : swept[0];
  return `${String(count)} ${swept === undefined ? "workspaces" : swept[1]}`;
};

/** Words for a session that was stopped, by the reason the entry records. */
const STOPPED_SESSIONS: ReadonlyMap<string, Wording> = new Map([
  ["crash", buildCountedWording("Session crashed", "# sessions crashed")],
  [
    "workspace_failed",
    buildCountedWording(
      "Session could not start: its workspace failed",
      "# sessions could not start: their workspaces failed",
    ),
  ],
  [
    "runner_retired",
    buildCountedWording(
      "Session ended: the machine was retired",
      "# sessions ended: the machine was retired",
    ),
  ],
]);

/** Checks whether the controller writes `kind` for a machine's activity. A newer controller may write kinds this list does not know. */
const isRunnerActivityKind = (kind: string): kind is RunnerActivityKind =>
  (RUNNER_ACTIVITY_KINDS as ReadonlyArray<string>).includes(kind);

/**
 * Interprets what one audit log entry stands for. Returns `undefined` for a
 * kind this list does not show, such as one a newer controller writes.
 *
 * The switch names every kind in `RUNNER_ACTIVITY_KINDS`, and the compiler
 * fails when a kind is added to that list without a case here.
 *
 * Categories:
 * - connection: whether the controller can use the machine. Besides its
 *   state, that covers joining, retiring, the runner restarting in a loop,
 *   and the disk limit, which makes the machine take or refuse new sessions.
 * - settings: what a person changes about the machine (its settings, stopping
 *   new work) and the accounts signed in on it.
 * - sessions and workspaces: by the kind's prefix.
 */
const interpretAuditEntry = (
  event: Pick<Event, "kind" | "payload">,
  accountLabels: ReadonlyMap<string, string | null>,
): Reading | undefined => {
  const { payload, kind } = event;
  if (!isRunnerActivityKind(kind)) return undefined;

  const sessionId = readText(payload, "sessionId");
  const buildReading = (
    category: MachineActivityCategory,
    wording: Wording,
    options: { problem?: boolean; foldVariant?: string; runId?: string } = {},
  ): Reading => ({
    category,
    problem: options.problem ?? false,
    wording,
    foldVariant: options.foldVariant ?? wording.forOne,
    ...(sessionId === undefined || category !== "sessions" ? {} : { sessionId }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
  });

  switch (kind) {
    case "runner.joined": {
      const reserved = readFlag(payload, "reserved") === true;
      const isDefault = readFlag(payload, "becameDefaultRunner") === true;
      return buildReading(
        "connection",
        buildRepeatedWording(
          `Joined${reserved ? " as a reserved machine" : ""}${isDefault ? " and became the default machine" : ""}`,
        ),
      );
    }
    case "runner.stateChanged": {
      const state = readText(payload, "state");
      if (state === "online")
        return buildReading("connection", buildRepeatedWording("Back online"));
      if (state === "offline") {
        return buildReading("connection", buildRepeatedWording("Went offline"), { problem: true });
      }
      if (state === "unreachable") {
        return buildReading("connection", buildRepeatedWording("Became unreachable"), {
          problem: true,
        });
      }
      return buildReading(
        "connection",
        buildRepeatedWording(`Changed state to ${state ?? "an unknown state"}`),
      );
    }
    case "runner.updated":
      return buildReading("settings", buildRepeatedWording(describeSettingsChange(payload)));
    case "runner.drained":
      return buildReading("settings", buildRepeatedWording("Set to take no new work"));
    case "runner.undrained":
      return buildReading("settings", buildRepeatedWording("Set to take new work again"));
    case "runner.placementsChanged": {
      const accepting = readFlag(payload, "acceptingPlacements");
      if (accepting === true) {
        return buildReading(
          "connection",
          buildRepeatedWording("Takes new sessions again: free disk is above its limit"),
        );
      }
      if (accepting === false) {
        return buildReading(
          "connection",
          buildRepeatedWording("Takes no new sessions: free disk is below its limit"),
          { problem: true },
        );
      }
      return buildReading(
        "connection",
        buildRepeatedWording("Changed whether it takes new sessions"),
      );
    }
    case "runner.crashLooping": {
      const count = readNumber(payload, "count");
      return buildReading(
        "connection",
        buildRepeatedWording(
          `Runner stopped ${count === undefined ? "again and again" : `${formatCount(count)} times`} in a few minutes and is being started again`,
        ),
      );
    }
    case "runner.retired":
      return buildReading(
        "connection",
        buildRepeatedWording(
          readFlag(payload, "forced") === true
            ? "Retired without checking for sessions"
            : "Retired",
        ),
      );

    case "workspace.created":
      return buildReading(
        "workspaces",
        buildCountedWording("Workspace created", "# workspaces created"),
      );
    case "workspace.disposalRequested":
      return readText(payload, "operation") === "workspaceDetach"
        ? buildReading(
            "workspaces",
            buildCountedWording(
              "Asked to detach a main workspace",
              "Asked to detach # main workspaces",
            ),
          )
        : buildReading(
            "workspaces",
            buildCountedWording("Asked to remove a workspace", "Asked to remove # workspaces"),
          );
    case "workspace.disposalRefused": {
      const runnerMessage = readText(payload, "runnerMessage");
      return buildReading(
        "workspaces",
        {
          forOne:
            runnerMessage === undefined
              ? "Could not remove a workspace"
              : `Could not remove a workspace: ${runnerMessage}`,
          forCount: (count) => `Could not remove ${formatCount(count)} workspaces`,
        },
        { problem: true, foldVariant: "refused" },
      );
    }
    case "workspace.deleted": {
      const swept = SWEPT_WORKSPACES.get(readText(payload, "reason") ?? "");
      return buildReading(
        "workspaces",
        swept === undefined
          ? buildCountedWording("Removed a workspace", "# workspaces removed")
          : buildCountedWording(`Removed ${swept[0]}`, `# ${swept[1]} removed`),
      );
    }
    case "workspace.detached":
      return buildReading(
        "workspaces",
        buildCountedWording(
          "Detached a main workspace, files kept",
          "# main workspaces detached, files kept",
        ),
      );
    case "workspace.attachmentRetried":
      return buildReading("workspaces", buildRepeatedWording("Retried attaching a main workspace"));

    case "session.spawned": {
      const runId = readText(payload, "runId");
      return buildReading(
        "sessions",
        buildCountedWording("Session spawned", "# sessions spawned"),
        {
          foldVariant: `run:${runId ?? ""}`,
          ...(runId === undefined ? {} : { runId }),
        },
      );
    }
    case "session.stopped":
      return buildReading(
        "sessions",
        STOPPED_SESSIONS.get(readText(payload, "reason") ?? "") ??
          buildCountedWording("Session stopped", "# sessions stopped"),
      );
    case "session.reconciled":
      return readText(payload, "reason") === "runner_lost"
        ? buildReading(
            "sessions",
            buildCountedWording(
              "Session lost: contact with the machine was lost",
              "# sessions lost: contact with the machine was lost",
            ),
            { problem: true },
          )
        : readText(payload, "reason") === "runner_restart"
          ? buildReading(
              "sessions",
              buildCountedWording(
                "Session ended when the runner restarted",
                "# sessions ended when the runner restarted",
              ),
            )
          : buildReading("sessions", buildCountedWording("Session ended", "# sessions ended"));
    case "session.archived":
      return buildReading(
        "sessions",
        buildCountedWording("Session archived", "# sessions archived"),
      );

    case "providerAccount.signedIn": {
      const accountId = readText(payload, "providerAccountId");
      const label = accountId === undefined ? undefined : accountLabels.get(accountId);
      return buildReading(
        "settings",
        buildRepeatedWording(`${label ?? "An account"} signed in here`),
      );
    }
    default:
      return kind satisfies never;
  }
};

/**
 * Names the actor of an audit log entry. A missing actor is the controller's
 * own act: no one who holds a credential caused it, so it reads as `system`.
 * A run or a plugin keeps its own identity in the label.
 */
const describeEntryActor = (actor: string | null): MachineActivityActor => {
  if (actor === null || actor === "system") return { kind: "system" };
  if (actor === "user") return { kind: "user" };
  const sessionId = readActorSessionId(actor);
  if (sessionId !== undefined) return { kind: "session", sessionId };
  return { kind: "other", label: describeActor(actor).label };
};

const MS_PER_MINUTE = 60_000;

const MS_PER_DAY = 86_400_000;

/** Builds the key of a local day, "2026-11-03", from its number of days since 1 January 1970. */
const buildDayKey = (dayNumber: number): string =>
  new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10);

/** An audit log entry while its entry is built: it always has its line, which `selectDetails` may leave out. */
type PendingLogEntry = MachineActivityDetail & { readonly line: string };

/**
 * Returns the details to list under a folded entry, or an empty list when
 * they tell the user nothing the sentence does not: no audit log entry has a
 * session and every line is the same. A detail keeps its `line` only when
 * the lines differ, because otherwise it would only repeat the sentence.
 */
const selectDetails = (
  logEntries: ReadonlyArray<PendingLogEntry>,
): ReadonlyArray<MachineActivityDetail> => {
  const linesDiffer = logEntries.some((each) => each.line !== logEntries[0]?.line);
  if (linesDiffer) return logEntries;
  if (logEntries.every((each) => each.sessionId === undefined)) return [];
  return logEntries.map(({ eventId, sessionId }) => ({
    eventId,
    ...(sessionId === undefined ? {} : { sessionId }),
  }));
};

/** What the display timezone shows for one minute: the clock time and the local day. */
interface MinuteDisplay {
  readonly time: string;
  readonly dayKey: string;
}

/** Reads the clock time and the local day of the minute that holds `instant`, or `undefined` when either cannot be read. */
const readMinuteDisplay = (instant: Date, timezone: string): MinuteDisplay | undefined => {
  const time = formatClock(instant, timezone);
  const date = readCalendarDate(instant, timezone);
  return time === undefined || date === undefined
    ? undefined
    : { time, dayKey: buildDayKey(date.dayNumber) };
};

/** An entry being built: its audit log entries are added while the list is read. */
interface PendingEntry {
  readonly key: string;
  readonly time: string;
  readonly reading: Reading;
  readonly actor: MachineActivityActor;
  readonly logEntries: PendingLogEntry[];
}

/** One day being built, in the order the list reaches it. */
interface PendingDay {
  readonly key: string;
  readonly heading: string;
  readonly entries: PendingEntry[];
}

/**
 * Describes the activity of one machine as days of entries, newest first.
 *
 * - `events` are the machine's audit log entries as `event.query` returns
 *   them, newest first, all loaded pages at once. Folding looks at every
 *   entry, so it does not depend on how many pages are loaded.
 * - The filter applies to single entries before anything folds, so the
 *   Problems filter never shows a healthy entry folded into a problem.
 * - Entries fold into one when they have the same kind, the same wording, the
 *   same actor and, for spawned sessions, the same run, and happened in the
 *   same minute. They need not be next to each other in the list. The folded
 *   entry stands where its newest audit log entry stands. The actor is compared
 *   as it is shown, so an entry without an actor folds with one stamped `system`.
 * - The minute is counted from the instant (a whole number of minutes since
 *   1970), not from the clock the screen shows, because in the hour that
 *   repeats when daylight saving time ends two different minutes show the
 *   same time. The timezone only decides the time and the day shown.
 * - A kind this list does not show is left out, and so is an entry whose
 *   `receivedAt` is not a valid date.
 * - `accounts` name the account in "Claude Max signed in here". An account
 *   the list does not hold, or one without a label, reads "An account".
 */
export const describeMachineActivity = (
  events: ReadonlyArray<Pick<Event, "id" | "kind" | "payload" | "actor" | "receivedAt">>,
  options: {
    readonly filter: MachineActivityFilter;
    readonly timezone: string;
    readonly today: Date;
    readonly accounts: ReadonlyArray<Pick<ProviderAccount, "id" | "label">>;
  },
): ReadonlyArray<MachineActivityDay> => {
  const { filter, timezone, today } = options;
  const accountLabels = new Map(options.accounts.map((account) => [account.id, account.label]));

  // A burst of entries shares one minute, so each minute is read once.
  const displaysByMinute = new Map<number, MinuteDisplay | undefined>();
  const days: PendingDay[] = [];
  const daysByKey = new Map<string, PendingDay>();
  const entriesByFold = new Map<string, PendingEntry>();

  for (const event of events) {
    const reading = interpretAuditEntry(event, accountLabels);
    if (reading === undefined) continue;
    if (
      filter === "problems" ? !reading.problem : filter !== "all" && filter !== reading.category
    ) {
      continue;
    }

    const instant = Date.parse(event.receivedAt);
    const minute = Math.floor(instant / MS_PER_MINUTE);
    if (!displaysByMinute.has(minute)) {
      displaysByMinute.set(minute, readMinuteDisplay(new Date(instant), timezone));
    }
    const display = displaysByMinute.get(minute);
    if (display === undefined) continue;

    const logEntry: PendingLogEntry = {
      eventId: event.id,
      line: reading.wording.forOne,
      ...(reading.sessionId === undefined ? {} : { sessionId: reading.sessionId }),
    };
    const actor = describeEntryActor(event.actor);
    // Keyed by the full actor, not the displayed one: two runs whose ids end the same
    // read alike ("run 0000bbbb") but are different actors. A missing actor is the
    // controller's own act, like "system".
    const foldKey = [event.kind, reading.foldVariant, event.actor ?? "system", minute].join(
      "\u0000",
    );
    const folded = entriesByFold.get(foldKey);
    if (folded !== undefined) {
      folded.logEntries.push(logEntry);
      continue;
    }

    let day = daysByKey.get(display.dayKey);
    if (day === undefined) {
      const heading = formatDayStampWithWeekday(new Date(instant), timezone, today);
      if (heading === undefined) continue;
      day = { key: display.dayKey, heading, entries: [] };
      daysByKey.set(display.dayKey, day);
      days.push(day);
    }
    const entry: PendingEntry = {
      key: String(event.id),
      time: display.time,
      reading,
      actor,
      logEntries: [logEntry],
    };
    entriesByFold.set(foldKey, entry);
    day.entries.push(entry);
  }

  return days.map((day) => ({
    key: day.key,
    heading: day.heading,
    entries: day.entries.map(({ key, time, reading, actor, logEntries }): MachineActivityEntry => {
      const [first] = logEntries;
      const isFolded = logEntries.length > 1;
      return {
        key,
        time,
        category: reading.category,
        problem: reading.problem,
        sentence: isFolded ? reading.wording.forCount(logEntries.length) : reading.wording.forOne,
        ...(reading.runId === undefined ? {} : { runId: reading.runId }),
        actor,
        count: logEntries.length,
        ...(isFolded || first?.sessionId === undefined
          ? {}
          : { subjectSessionId: first.sessionId }),
        details: isFolded ? selectDetails(logEntries) : [],
      };
    }),
  }));
};

/** One of Recent's entries: a machine activity entry and the day it happened, or undefined when it happened today. */
export interface RecentMachineActivityEntry extends MachineActivityEntry {
  readonly day: string | undefined;
}

/** How many entries Recent lists. */
const RECENT_ENTRY_COUNT = 5;

/**
 * Returns the newest five entries of a machine's activity, unfiltered, each
 * with its day unless it happened today. Recent lists entries without day
 * headings, so an entry from another day carries its day to show beside it.
 *
 * It describes `events` as `describeMachineActivity` does with the filter
 * "all". Whether an entry is from today is decided by comparing dates in
 * `timezone`, not by the words of the day heading.
 */
export const describeRecentMachineActivity = (
  events: ReadonlyArray<Pick<Event, "id" | "kind" | "payload" | "actor" | "receivedAt">>,
  options: {
    readonly timezone: string;
    readonly today: Date;
    readonly accounts: ReadonlyArray<Pick<ProviderAccount, "id" | "label">>;
  },
): ReadonlyArray<RecentMachineActivityEntry> => {
  const todayDate = readCalendarDate(options.today, options.timezone);
  if (todayDate === undefined) return [];
  const todayKey = buildDayKey(todayDate.dayNumber);

  return describeMachineActivity(events, { ...options, filter: "all" })
    .flatMap((day) =>
      day.entries.map((entry) => ({
        ...entry,
        day: day.key === todayKey ? undefined : day.heading,
      })),
    )
    .slice(0, RECENT_ENTRY_COUNT);
};

/** Describes why no entry shows for `filter` on the machine `machineName`, as a sentence for the empty list. */
export const describeEmptyMachineActivity = (
  filter: MachineActivityFilter,
  machineName: string,
): string => {
  switch (filter) {
    case "all":
      return `Nothing has happened on ${machineName} yet.`;
    case "problems":
      return `No problems on ${machineName}.`;
    case "connection":
      return `No connection changes on ${machineName}.`;
    case "sessions":
      return `No session activity on ${machineName}.`;
    case "workspaces":
      return `No workspace activity on ${machineName}.`;
    case "settings":
      return `No settings changes on ${machineName}.`;
  }
};
