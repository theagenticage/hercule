/**
 * The pure logic of "Running here" on a machine's page and of the faces on the
 * Fleet's cards: the sessions open on one machine, grouped into what the user
 * knows them as (a workflow run, a row of Threads, an assistant).
 *
 * The three exports share one grouping step, so the cards and the page always
 * agree on what a group is and in which order the groups come. Only
 * `buildMachineWork` describes the groups (title, words, time), because the
 * cards are rebuilt on every session push and need nothing of that.
 *
 * The desktop calls these inside a query's `select`. Structural sharing keeps
 * the result's identity only if it is equal, so the result holds plain data
 * only, and nothing in it depends on a session's usage, last activity or tool
 * calls. A push that changes only those leaves the result as it was.
 *
 * This module is its own subpath (`@hercule/client-core/machine-work`) and is
 * not re-exported from the package index, so the first screen does not carry it.
 */
import type { Assistant, Runner, Session } from "@hercule/contract";
import { formatShortMoment } from "../time-context";
import { plural } from "./machine";
import { decideThreadPose, type Pose, type SessionPose } from "../threads/pose";
import type { RowMember } from "../threads/row-members";

/** The most faces a machine's card shows before it folds the rest into "+n". */
const MAX_CARD_FACES = 5;

/** The most faces a group lists for its own sessions before it folds the rest into "+n". */
const MAX_ROW_FACES = 12;

/** One face: which kind of session it is (`kind`), what it is drawn from (`seed`) and its state. */
export interface WorkFace {
  readonly kind: "thread" | "agent" | "run" | "assistant";
  readonly seed: string;
  readonly pose: Pose;
}

/** Where pressing a group or a session leads. */
export type WorkDestination =
  | { readonly kind: "thread"; readonly sessionId: string }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "assistant"; readonly assistantId: string };

/** The faces of a machine's card or of a group, and how many sessions or groups they leave out. */
export interface MachineFaces {
  readonly faces: readonly WorkFace[];
  readonly moreCount: number;
}

/** One group of "Running here": a run, a row of Threads or an assistant. */
export interface MachineWorkGroup {
  /** Tells groups apart and stays the same across renders. */
  readonly key: string;
  /** The row's title, the workflow's name or the assistant's name. */
  readonly title: string;
  /** What kind of group it is: "Workflow run", "Thread", "Threads", "Assistant" or "Agent session". "Thread" is a lone Thread; a row of Threads, or a lone Agent session in one, is "Threads". */
  readonly kindLabel: string;
  /**
   * Which of the group's sessions run here, joined by ", ": a run's step ids, or the labels of a
   * row's sessions without the row's lead. Empty when there is nothing to list.
   */
  readonly memberLabels: string;
  /** The group's sessions in words, such as "2 working · 1 waits for you". */
  readonly status: string;
  /** Whether a session of the group is queued for a free slot, whatever the others do. */
  readonly waitingForSlot: boolean;
  /** When the group's oldest session here started, such as "since 09:12"; `null` if the time cannot be formatted. */
  readonly since: string | null;
  /** The group's own face, in the pose of its most urgent session. */
  readonly face: WorkFace;
  /** One face per session of the group here, at most 12, and how many more there are. */
  readonly faces: MachineFaces;
  readonly opens: WorkDestination;
}

/** One session of the plain "Sessions" list. */
export interface MachineWorkSession {
  readonly id: string;
  readonly face: WorkFace;
  readonly title: string;
  readonly status: "Working" | "Waits for you" | "Waits for a slot" | "Idle" | "Away";
  readonly waitingForSlot: boolean;
  /** When the session started, or was created if it has not started: an ISO timestamp. */
  readonly startedAt: string;
  readonly opens: WorkDestination;
}

/** What "Running here" shows for one machine. */
export interface MachineWork {
  readonly groups: readonly MachineWorkGroup[];
  readonly sessions: readonly MachineWorkSession[];
}

/** The poses an open session can be in. It is never `asleep`, which needs an exited session. */
type OpenPose = Exclude<SessionPose, "asleep">;

/**
 * What a session is doing, as the page words it. It is the session's pose,
 * except that a queued session (by its status) waits for a slot, whatever its
 * pose.
 */
type WorkState = OpenPose | "queued";

/** The states in the order a group's status words list them. */
const STATE_ORDER: readonly WorkState[] = ["working", "waiting", "queued", "idle", "away"];

/**
 * The poses in the order a group takes its own from, most urgent first. A
 * group in a pose that needs the user comes before one that works, and one
 * that works before one that idles.
 */
const POSE_URGENCY: readonly OpenPose[] = ["waiting", "working", "idle", "away"];

const SESSION_STATUS: Readonly<Record<WorkState, MachineWorkSession["status"]>> = {
  working: "Working",
  waiting: "Waits for you",
  queued: "Waits for a slot",
  idle: "Idle",
  away: "Away",
};

/** Returns the count of sessions in `state` in words, such as "2 wait for you". */
const describeStateCount = (state: WorkState, count: number): string => {
  const waits = plural(count, "waits", "wait");
  switch (state) {
    case "waiting":
      return `${String(count)} ${waits} for you`;
    case "queued":
      return `${String(count)} ${waits} for a slot`;
    default:
      return `${String(count)} ${state}`;
  }
};

/** Checks that the session has not exited. */
const isOpen = (session: Session): boolean => session.status !== "exited";

/** A session open on the machine, with what the page needs to know of it. */
interface OpenSession {
  readonly session: Session;
  readonly state: WorkState;
  readonly face: WorkFace;
  /** Where the session itself leads. */
  readonly opens: WorkDestination;
  /** The sidebar row that lists the session; only a Thread or an Agent session has one. */
  readonly row: RowMember | undefined;
  /** The group the session belongs to, and what the group is drawn from and leads to. */
  readonly group: {
    readonly key: string;
    readonly kind: WorkFace["kind"];
    readonly seed: string;
    readonly opens: WorkDestination;
  };
  /** When the session started, or was created if it has not started, in milliseconds. */
  readonly startedAtMs: number;
  /** What orders the sessions: the creation time of a queued session, the start of any other. */
  readonly orderMs: number;
}

/** A group of open sessions, with what orders it and what the cards draw. */
interface OpenGroup {
  readonly key: string;
  readonly face: WorkFace;
  readonly opens: WorkDestination;
  /** The group's sessions in the order of the "Sessions" list. */
  readonly members: readonly OpenSession[];
}

/**
 * Describes `session` as an open session of a machine whose runner is
 * `runner`, and decides its group:
 *
 * - a run's step session belongs to its run;
 * - an assistant's session belongs to the assistant;
 * - a Thread or an Agent session belongs to the sidebar's row that lists it
 *   (`row`), and leads to the row's lead;
 * - a Thread or an Agent session no row lists is a group of its own.
 *
 * A group is drawn from, and leads to, its session, unless a row lists the
 * session.
 */
const describeOpenSession = (
  session: Session,
  runner: Runner | undefined,
  row: RowMember | undefined,
): OpenSession => {
  // An open session is never asleep: `decideThreadPose` returns that only for an exited one.
  const pose = decideThreadPose(session, runner) as OpenPose;
  const state: WorkState = session.status === "queued" ? "queued" : pose;
  // A queued session that would otherwise work is not at work yet, so its face is idle. One that
  // waits on the user, or whose machine is away, keeps that pose.
  const facePose = state === "queued" && pose === "working" ? "idle" : pose;
  const startedAtMs = Date.parse(session.startedAt ?? session.createdAt);
  const common = {
    session,
    state,
    startedAtMs,
    orderMs: state === "queued" ? Date.parse(session.createdAt) : startedAtMs,
  };
  switch (session.kind) {
    case "run": {
      const runId = session.runId!;
      const opens: WorkDestination = { kind: "run", runId };
      return {
        ...common,
        face: { kind: "run", seed: session.id, pose: facePose },
        opens,
        row: undefined,
        group: { key: `run:${runId}`, kind: "run", seed: runId, opens },
      };
    }
    case "assistant": {
      const assistantId = session.agentId!;
      const opens: WorkDestination = { kind: "assistant", assistantId };
      return {
        ...common,
        face: { kind: "assistant", seed: assistantId, pose: facePose },
        opens,
        row: undefined,
        group: { key: `assistant:${assistantId}`, kind: "assistant", seed: assistantId, opens },
      };
    }
    case "thread":
    case "agent": {
      const opens: WorkDestination = { kind: "thread", sessionId: session.id };
      return {
        ...common,
        face: { kind: session.kind, seed: session.id, pose: facePose },
        opens,
        row,
        group:
          row === undefined
            ? { key: `session:${session.id}`, kind: session.kind, seed: session.id, opens }
            : {
                key: row.rowKey,
                kind: "thread",
                seed: row.leadId,
                opens: { kind: "thread", sessionId: row.leadId },
              },
      };
    }
  }
};

/** Compares text by code unit, so the order never depends on the locale. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Returns the order of the "Sessions" list: queued sessions first, oldest
 * creation first, then the other sessions, oldest start first. The group key
 * and the session id break ties, so the order never depends on input order.
 */
const compareOpenSessions = (a: OpenSession, b: OpenSession): number =>
  Number(b.state === "queued") - Number(a.state === "queued") ||
  a.orderMs - b.orderMs ||
  compareText(a.group.key, b.group.key) ||
  compareText(a.session.id, b.session.id);

/**
 * Groups the open sessions of one machine, whose runner is `runner` (or
 * `undefined` when the runner list does not hold it, which counts as online).
 * Returns the sessions in the order of the "Sessions" list, and the groups.
 *
 * A group's place is the place of its first session in the sessions' order, so
 * groups that wait for a slot come first, by their oldest queued session, and
 * the rest follow, the oldest start first. Each group's `members` come in the
 * sessions' order too.
 *
 * This is the one place that decides what a group is, so the page and the
 * cards cannot disagree.
 */
const groupOpenSessions = ({
  sessions,
  runner,
  rowMembers,
}: {
  readonly sessions: readonly Session[];
  readonly runner: Runner | undefined;
  readonly rowMembers: Readonly<Record<string, RowMember>>;
}): { readonly ordered: readonly OpenSession[]; readonly groups: readonly OpenGroup[] } => {
  const ordered = sessions
    .map((session) => describeOpenSession(session, runner, rowMembers[session.id]))
    .toSorted(compareOpenSessions);

  const membersByKey = new Map<string, OpenSession[]>();
  for (const open of ordered) {
    const members = membersByKey.get(open.group.key);
    if (members === undefined) membersByKey.set(open.group.key, [open]);
    else members.push(open);
  }

  const groups = [...membersByKey.values()].map((members): OpenGroup => {
    const { group } = members[0]!;
    const pose = POSE_URGENCY.find((each) => members.some((member) => member.face.pose === each))!;
    return {
      key: group.key,
      face: { kind: group.kind, seed: group.seed, pose },
      opens: group.opens,
      members,
    };
  });
  return { ordered, groups };
};

/** Returns the title, kind label and member labels of `group`, as `MachineWorkGroup` describes them. */
const nameGroup = (
  { members }: OpenGroup,
  workflowNames: Readonly<Record<string, string>>,
  assistantNames: ReadonlyMap<string, string>,
): {
  readonly title: string;
  readonly kindLabel: string;
  readonly memberLabels: string;
} => {
  // The group's first session in the sessions' order names it, so the name never depends on input order.
  const { session, row } = members[0]!;
  switch (session.kind) {
    case "run": {
      const steps = new Set(members.flatMap((member) => member.session.stepId ?? []));
      return {
        title: workflowNames[session.runId!] ?? session.title,
        kindLabel: "Workflow run",
        memberLabels: [...steps].join(", "),
      };
    }
    case "assistant":
      return {
        title: assistantNames.get(session.agentId!) ?? session.title,
        kindLabel: "Assistant",
        memberLabels: "",
      };
    case "thread":
    case "agent": {
      if (row === undefined)
        return {
          title: session.title,
          kindLabel: session.kind === "thread" ? "Thread" : "Agent session",
          memberLabels: "",
        };
      // The lead's label is the row's name, which the title already shows, so only the other
      // sessions are listed.
      const labels = members.flatMap((member) =>
        member.row !== undefined && member.session.id !== member.row.leadId
          ? [member.row.label]
          : [],
      );
      // Only a lone Thread is "Thread"; a lone Agent session is still part of a row of Threads.
      return {
        title: row.rowTitle,
        kindLabel: members.length === 1 && session.kind === "thread" ? "Thread" : "Threads",
        memberLabels: labels.join(", "),
      };
    }
  }
};

/**
 * Returns the ids of the runs that have an open step session on `runnerId`,
 * each once and sorted. The caller looks up the workflow names of these runs
 * for `workflowNames`. The result is a plain array; a query's `select` keeps
 * its identity while the runs stay the same, because structural sharing
 * returns the previous array when the new one is equal.
 */
export const listMachineRunIds = (
  sessions: readonly Session[],
  runnerId: string,
): readonly string[] => {
  const ids = new Set(
    sessions.flatMap((session) =>
      session.kind === "run" && isOpen(session) && session.runnerId === runnerId
        ? [session.runId!]
        : [],
    ),
  );
  return [...ids].toSorted();
};

/**
 * Builds what "Running here" shows for `runner`: its open sessions grouped
 * into runs, rows of Threads and assistants, and the same sessions as a plain
 * list.
 *
 * - `sessions` may hold other runners' sessions and exited ones. Only the
 *   runner's own open sessions count.
 * - `rowMembers` index the sidebar's rows by member session (exited members
 *   included). A row is here when one of its sessions on this runner is open,
 *   and it keeps the sidebar's name even if only its Agent session still works.
 * - `workflowNames` maps a run id to the workflow's name. A run missing from
 *   it is named by the title of its first session in the order of the list.
 *   An assistant missing from `assistants` is named the same way.
 * - `since` is worded as the Fleet words a time ("since 09:12"), in
 *   `timezone`, relative to `today`.
 *
 * Groups that wait for a slot come first, by their oldest queued session.
 * The rest follow, the oldest start first. The sessions are ordered the same
 * way. The result is plain data with no dependence on a session's usage or
 * last activity.
 */
export const buildMachineWork = ({
  runner,
  sessions,
  rowMembers,
  workflowNames,
  assistants,
  timezone,
  today,
}: {
  readonly runner: Runner;
  readonly sessions: readonly Session[];
  readonly rowMembers: Readonly<Record<string, RowMember>>;
  readonly workflowNames: Readonly<Record<string, string>>;
  readonly assistants: readonly Pick<Assistant, "id" | "name">[];
  readonly timezone: string;
  readonly today: Date;
}): MachineWork => {
  const { ordered, groups } = groupOpenSessions({
    sessions: sessions.filter((session) => session.runnerId === runner.id && isOpen(session)),
    runner,
    rowMembers,
  });
  const assistantNames = new Map(assistants.map((each) => [each.id, each.name]));

  return {
    groups: groups.map((group): MachineWorkGroup => {
      const { members } = group;
      const moment = formatShortMoment(
        new Date(Math.min(...members.map((member) => member.startedAtMs))),
        today,
        timezone,
      );
      return {
        key: group.key,
        ...nameGroup(group, workflowNames, assistantNames),
        status: STATE_ORDER.flatMap((state) => {
          const count = members.filter((member) => member.state === state).length;
          return count === 0 ? [] : [describeStateCount(state, count)];
        }).join(" · "),
        // Queued sessions come first in `members`.
        waitingForSlot: members[0]!.state === "queued",
        since: moment === undefined ? null : `since ${moment}`,
        face: group.face,
        faces: {
          faces: members.slice(0, MAX_ROW_FACES).map((member) => member.face),
          moreCount: Math.max(0, members.length - MAX_ROW_FACES),
        },
        opens: group.opens,
      };
    }),
    sessions: ordered.map(({ session, state, face, opens }): MachineWorkSession => ({
      id: session.id,
      face,
      title: session.title,
      status: SESSION_STATUS[state],
      waitingForSlot: state === "queued",
      startedAt: session.startedAt ?? session.createdAt,
      opens,
    })),
  };
};

/**
 * Builds the faces of the Fleet's cards: for each runner with an open
 * session, one face per group of its open sessions, in the order of
 * `buildMachineWork`'s groups, at most 5. `moreCount` is the number of groups
 * beyond them. A runner with no open session has no entry. A session whose
 * runner `runners` does not hold counts as on an online runner.
 */
export const buildFleetFaces = ({
  sessions,
  rowMembers,
  runners,
}: {
  readonly sessions: readonly Session[];
  readonly rowMembers: Readonly<Record<string, RowMember>>;
  readonly runners: readonly Runner[];
}): Readonly<Record<string, MachineFaces>> => {
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const openByRunnerId = new Map<string, Session[]>();
  for (const session of sessions.filter(isOpen)) {
    const open = openByRunnerId.get(session.runnerId);
    if (open === undefined) openByRunnerId.set(session.runnerId, [session]);
    else open.push(session);
  }
  return Object.fromEntries(
    [...openByRunnerId].map(([runnerId, open]) => {
      const { groups } = groupOpenSessions({
        sessions: open,
        runner: runnersById.get(runnerId),
        rowMembers,
      });
      return [
        runnerId,
        {
          faces: groups.slice(0, MAX_CARD_FACES).map((group) => group.face),
          moreCount: Math.max(0, groups.length - MAX_CARD_FACES),
        },
      ];
    }),
  );
};
