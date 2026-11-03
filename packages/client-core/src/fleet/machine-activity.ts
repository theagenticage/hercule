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
import type { Event, ProviderAccount } from "@hercule/contract";
import { describeActor, readActorSessionId } from "../actor-display";
import { computeWeekday, readWallClock, type WallClock } from "../time-context";
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

/** One audit log entry inside a folded entry. */
export interface MachineActivityMember {
  readonly eventId: number;
  /** When it happened, "09:12": 24-hour, in the display timezone. */
  readonly time: string;
  /** What this one entry was, from its payload alone. */
  readonly line: string;
  /** The session the entry is about, for the screen to name beside `line`. */
  readonly sessionId?: string;
}

/**
 * One line of the list: one audit log entry, or several of one kind that
 * happened in one minute and were folded into one.
 */
export interface MachineActivityEntry {
  /** The newest member's event id, as text. */
  readonly key: string;
  /** The newest member's time, "09:12". */
  readonly time: string;
  readonly category: "connection" | "sessions" | "workspaces" | "settings";
  readonly problem: boolean;
  /** Complete without any name that needs a read: "Went offline", "12 sessions spawned". */
  readonly sentence: string;
  /** Set when every member was spawned for one workflow run. The screen appends "for <the run's workflow name>". */
  readonly runId?: string;
  readonly actor: MachineActivityActor;
  /** Newest first. Exactly one member when nothing folded into the entry. */
  readonly members: ReadonlyArray<MachineActivityMember>;
}

/** The entries of one local day. */
export interface MachineActivityDay {
  /** The local date, "2026-11-03". */
  readonly key: string;
  /** "Today", "Yesterday", else the weekday and date: "Sun 1 Nov", with the year when it is not this year. */
  readonly heading: string;
  readonly entries: ReadonlyArray<MachineActivityEntry>;
}

type Category = MachineActivityEntry["category"];

/** The words of an entry: for one member, and for `count` members folded together. */
interface Wording {
  readonly one: string;
  readonly many: (count: number) => string;
}

/** What one audit log entry stands for. */
interface Reading {
  readonly category: Category;
  readonly problem: boolean;
  readonly wording: Wording;
  /**
   * Entries fold only when this is equal as well as their kind, actor and
   * minute. It is whatever changes the words, such as the connection state.
   */
  readonly variant: string;
  readonly sessionId?: string;
  readonly runId?: string;
}

type Payload = Event["payload"];

const formatCount = (count: number): string => count.toLocaleString("en-US");

/** Words for a kind whose entries are things to count: "12 sessions spawned". */
const countable = (one: string, many: string): Wording => ({
  one,
  many: (count) => many.replace("#", formatCount(count)),
});

/** Words for an entry that is not a thing to count; folded, it reads "Went offline (2 times)". */
const repeatable = (one: string): Wording => ({
  one,
  many: (count) => `${one} (${formatCount(count)} times)`,
});

const readText = (payload: Payload, key: string): string | undefined => {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
};

const readFlag = (payload: Payload, key: string): boolean | undefined => {
  const value = payload[key];
  return typeof value === "boolean" ? value : undefined;
};

const readNumber = (payload: Payload, key: string): number | undefined => {
  const value = payload[key];
  return typeof value === "number" ? value : undefined;
};

/** Reads `value` as the `{ old, new }` pair that a `runner.updated` entry holds for one field. */
const readChange = (
  changes: Payload,
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

/** Words the change of the labels: "added label gpu", "removed labels a, b", or both. */
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
const describeSettingsChange = (payload: Payload): string => {
  const changes = payload["changes"];
  const record = (typeof changes === "object" && changes !== null ? changes : {}) as Payload;
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

/** Words for a session that was stopped, by the reason the entry records. */
const STOPPED_SESSIONS: ReadonlyMap<string, Wording> = new Map([
  ["crash", countable("Session crashed", "# sessions crashed")],
  [
    "workspace_failed",
    countable(
      "Session could not start: its workspace failed",
      "# sessions could not start: their workspaces failed",
    ),
  ],
  [
    "runner_retired",
    countable(
      "Session ended: the machine was retired",
      "# sessions ended: the machine was retired",
    ),
  ],
]);

/** The advice the controller adds to every refused removal. It is the same for all, so the sentence leaves it out. */
const REFUSED_REMOVAL_ADVICE =
  " The workspace is retained. Automatic cleanup will not retry this removal. Inspect it, resolve the refusal, and explicitly retry removal.";

/** Words the runner's message for a refused removal as the end of a sentence: no advice, no final period. */
const trimRefusalMessage = (message: string): string => {
  const reason = message.endsWith(REFUSED_REMOVAL_ADVICE)
    ? message.slice(0, -REFUSED_REMOVAL_ADVICE.length)
    : message;
  return reason.replace(/\.$/, "");
};

/**
 * Reads what one audit log entry stands for. Returns `undefined` for a kind
 * this list does not show, such as one a newer controller writes.
 *
 * Categories:
 * - connection: whether the controller can use the machine. Besides its
 *   state, that covers joining, retiring, the runner restarting in a loop,
 *   and the disk limit, which makes the machine take or refuse new sessions.
 * - settings: what a person changes about the machine (its settings, stopping
 *   new work) and the accounts signed in on it.
 * - sessions and workspaces: by the kind's prefix.
 */
const readEvent = (
  event: Pick<Event, "kind" | "payload">,
  accountLabels: ReadonlyMap<string, string | null>,
): Reading | undefined => {
  const { payload } = event;
  const sessionId = readText(payload, "sessionId");
  const reading = (
    category: Category,
    wording: Wording,
    more: { problem?: boolean; variant?: string; runId?: string } = {},
  ): Reading => ({
    category,
    problem: more.problem ?? false,
    wording,
    variant: more.variant ?? wording.one,
    ...(sessionId === undefined || category !== "sessions" ? {} : { sessionId }),
    ...(more.runId === undefined ? {} : { runId: more.runId }),
  });

  switch (event.kind) {
    case "runner.joined": {
      const reserved = readFlag(payload, "reserved") === true;
      const isDefault = readFlag(payload, "becameDefaultRunner") === true;
      return reading(
        "connection",
        repeatable(
          `Joined${reserved ? " as a reserved machine" : ""}${isDefault ? " and became the default machine" : ""}`,
        ),
      );
    }
    case "runner.stateChanged": {
      const state = readText(payload, "state");
      if (state === "online") return reading("connection", repeatable("Came online"));
      if (state === "offline") {
        return reading("connection", repeatable("Went offline"), { problem: true });
      }
      if (state === "unreachable") {
        return reading("connection", repeatable("Became unreachable"), { problem: true });
      }
      return reading("connection", repeatable(`Changed state to ${state ?? "an unknown state"}`));
    }
    case "runner.updated":
      return reading("settings", repeatable(describeSettingsChange(payload)));
    case "runner.drained":
      return reading("settings", repeatable("Set to take no new work"));
    case "runner.undrained":
      return reading("settings", repeatable("Set to take new work again"));
    case "runner.placementsChanged": {
      const accepting = readFlag(payload, "acceptingPlacements");
      if (accepting === true) {
        return reading(
          "connection",
          repeatable("Takes new sessions again: free disk is above its limit"),
        );
      }
      if (accepting === false) {
        return reading(
          "connection",
          repeatable("Takes no new sessions: free disk is below its limit"),
          { problem: true },
        );
      }
      return reading("connection", repeatable("Changed whether it takes new sessions"));
    }
    case "runner.crashLooping": {
      const count = readNumber(payload, "count");
      return reading(
        "connection",
        repeatable(
          `Runner stopped ${count === undefined ? "again and again" : `${formatCount(count)} times`} in a few minutes and is being started again`,
        ),
      );
    }
    case "runner.retired":
      return reading(
        "connection",
        repeatable(
          readFlag(payload, "forced") === true
            ? "Retired without checking for sessions"
            : "Retired",
        ),
      );

    case "workspace.created":
      return reading("workspaces", countable("Workspace created", "# workspaces created"));
    case "workspace.disposalRequested":
      return readText(payload, "operation") === "workspaceDetach"
        ? reading(
            "workspaces",
            countable("Asked to detach a main workspace", "Asked to detach # main workspaces"),
          )
        : reading(
            "workspaces",
            countable("Asked to remove a workspace", "Asked to remove # workspaces"),
          );
    case "workspace.disposalRefused": {
      const message = readText(payload, "message");
      const one =
        message === undefined
          ? "Could not remove a workspace"
          : `Could not remove a workspace: ${trimRefusalMessage(message)}`;
      return reading(
        "workspaces",
        { one, many: (count) => `Could not remove ${formatCount(count)} workspaces` },
        { problem: true, variant: "refused" },
      );
    }
    case "workspace.deleted": {
      const swept = SWEPT_WORKSPACES.get(readText(payload, "reason") ?? "");
      return reading(
        "workspaces",
        swept === undefined
          ? countable("Removed a workspace", "# workspaces removed")
          : countable(`Removed ${swept[0]}`, `# ${swept[1]} removed`),
      );
    }
    case "workspace.detached":
      return reading(
        "workspaces",
        countable(
          "Detached a main workspace, files kept",
          "# main workspaces detached, files kept",
        ),
      );
    case "workspace.attachmentRetried":
      return reading("workspaces", repeatable("Retried attaching a main workspace"));

    case "session.spawned": {
      const runId = readText(payload, "runId");
      return reading("sessions", countable("Session spawned", "# sessions spawned"), {
        variant: `run:${runId ?? ""}`,
        ...(runId === undefined ? {} : { runId }),
      });
    }
    case "session.stopped":
      return reading(
        "sessions",
        STOPPED_SESSIONS.get(readText(payload, "reason") ?? "") ??
          countable("Session stopped", "# sessions stopped"),
      );
    case "session.reconciled":
      return readText(payload, "reason") === "runner_lost"
        ? reading(
            "sessions",
            countable(
              "Session lost: contact with the machine was lost",
              "# sessions lost: contact with the machine was lost",
            ),
            { problem: true },
          )
        : readText(payload, "reason") === "runner_restart"
          ? reading(
              "sessions",
              countable(
                "Session ended when the runner restarted",
                "# sessions ended when the runner restarted",
              ),
            )
          : reading("sessions", countable("Session ended", "# sessions ended"));
    case "session.archived":
      return reading("sessions", countable("Session archived", "# sessions archived"));

    case "providerAccount.signedIn": {
      const accountId = readText(payload, "providerAccountId");
      const label = accountId === undefined ? undefined : accountLabels.get(accountId);
      return reading("settings", repeatable(`${label ?? "An account"} signed in here`));
    }
    default:
      return undefined;
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const pad = (value: number): string => String(value).padStart(2, "0");

/** Counts the days from 1 January 1970 to a calendar date, so two consecutive dates differ by 1. */
const countDays = (date: WallClock): number =>
  Date.UTC(date.year, date.month - 1, date.day) / 86_400_000;

/** Words a day for the head of its group: "Today", "Yesterday", "Sun 1 Nov", or "Sun 1 Nov 2025" in another year. */
const describeDay = (date: WallClock, today: WallClock): string => {
  const days = countDays(today) - countDays(date);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const text = `${WEEKDAYS[computeWeekday(date)]} ${String(date.day)} ${MONTHS[date.month - 1]}`;
  return date.year === today.year ? text : `${text} ${String(date.year)}`;
};

const MS_PER_MINUTE = 60_000;

/** An entry being built: its members are added while the list is read. */
interface PendingEntry {
  readonly key: string;
  readonly time: string;
  readonly reading: Reading;
  readonly actor: MachineActivityActor;
  readonly members: MachineActivityMember[];
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
 *   entry stands where its newest member stands.
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
  const { filter, timezone } = options;
  const today = readWallClock(options.today, timezone);
  if (today === undefined) return [];
  const accountLabels = new Map(options.accounts.map((account) => [account.id, account.label]));

  // Entries of one minute share a time and a day, and a burst of spawns
  // shares one minute, so each minute reads the clock once.
  const clocks = new Map<number, WallClock | undefined>();
  const days: PendingDay[] = [];
  const daysByKey = new Map<string, PendingDay>();
  const entriesByFold = new Map<string, PendingEntry>();

  for (const event of events) {
    const reading = readEvent(event, accountLabels);
    if (reading === undefined) continue;
    if (
      filter === "problems" ? !reading.problem : filter !== "all" && filter !== reading.category
    ) {
      continue;
    }

    const instant = Date.parse(event.receivedAt);
    const minute = Math.floor(instant / MS_PER_MINUTE);
    if (!clocks.has(minute)) clocks.set(minute, readWallClock(new Date(instant), timezone));
    const clock = clocks.get(minute);
    if (clock === undefined) continue;
    const time = `${pad(clock.hour)}:${pad(clock.minute)}`;

    const member: MachineActivityMember = {
      eventId: event.id,
      time,
      line: reading.wording.one,
      ...(reading.sessionId === undefined ? {} : { sessionId: reading.sessionId }),
    };
    const foldKey = [event.kind, reading.variant, event.actor ?? "", minute].join("\u0000");
    const folded = entriesByFold.get(foldKey);
    if (folded !== undefined) {
      folded.members.push(member);
      continue;
    }

    const dayKey = `${String(clock.year)}-${pad(clock.month)}-${pad(clock.day)}`;
    let day = daysByKey.get(dayKey);
    if (day === undefined) {
      day = { key: dayKey, heading: describeDay(clock, today), entries: [] };
      daysByKey.set(dayKey, day);
      days.push(day);
    }
    const entry: PendingEntry = {
      key: String(event.id),
      time,
      reading,
      actor: describeEntryActor(event.actor),
      members: [member],
    };
    entriesByFold.set(foldKey, entry);
    day.entries.push(entry);
  }

  return days.map((day) => ({
    key: day.key,
    heading: day.heading,
    entries: day.entries.map(({ key, time, reading, actor, members }): MachineActivityEntry => ({
      key,
      time,
      category: reading.category,
      problem: reading.problem,
      sentence: members.length === 1 ? reading.wording.one : reading.wording.many(members.length),
      ...(reading.runId === undefined ? {} : { runId: reading.runId }),
      actor,
      members,
    })),
  }));
};
