/**
 * The pure logic of "Running here" on a machine's page and of the faces on the
 * Fleet's cards: the sessions open on one machine, grouped into what the user
 * knows them as (a workflow run, a row of Threads, an assistant).
 *
 * Both functions share one grouping step, so the cards and the page always
 * agree on what a group is and in which order the groups come.
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

/** One face: who it looks like (`look`), what it is drawn from (`seed`) and its state. */
export interface WorkFace {
  readonly look: "thread" | "agent" | "run" | "assistant";
  readonly seed: string;
  readonly pose: Pose;
}

/** Where pressing a group or a session leads. */
export type WorkDestination =
  | { readonly kind: "thread"; readonly sessionId: string }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "assistant"; readonly assistantId: string };

/** One group of "Running here": a run, a row of Threads or an assistant. */
export interface MachineWorkGroup {
  /** Tells groups apart and stays the same across renders. */
  readonly key: string;
  readonly kind: "threads" | "run" | "assistant";
  /** The row's title, the workflow's name or the assistant's name. */
  readonly title: string;
  /** What the group is and which of its sessions run here, such as "Threads · review, tests", which leaves out the row's lead, or "Threads" when it is the only session here. */
  readonly detail: string;
  /** The group's sessions in words, such as "2 working · 1 waits for you". */
  readonly status: string;
  /** Whether a session of the group is queued for a free slot, whatever the others do. */
  readonly waitingForSlot: boolean;
  /** When the group's oldest session here started, such as "since 09:12"; `null` if the time cannot be formatted. */
  readonly since: string | null;
  /** The group's own face, in the pose of its most urgent session. */
  readonly face: WorkFace;
  /** One face per session of the group here. */
  readonly faces: readonly WorkFace[];
  readonly opens: WorkDestination;
}

/** One session of the plain "Sessions" list. */
export interface MachineWorkSession {
  readonly id: string;
  readonly face: WorkFace;
  readonly title: string;
  readonly status: "Working" | "Waits for you" | "Waits for a slot" | "Idle" | "Away" | "Asleep";
  readonly waitingForSlot: boolean;
  /** When the session started, or was created if it has not started: an ISO timestamp. */
  readonly runningSince: string;
  readonly opens: WorkDestination;
}

/** What "Running here" shows for one machine. */
export interface MachineWork {
  readonly groups: readonly MachineWorkGroup[];
  readonly sessions: readonly MachineWorkSession[];
}

/** The faces a machine's card shows, and how many groups they leave out. */
export interface MachineFaces {
  readonly faces: readonly WorkFace[];
  readonly moreCount: number;
}

/**
 * What a session is doing, as the page words it. It is the session's pose,
 * except that a queued session (by its status) waits for a slot, whatever its
 * pose.
 */
type WorkState = SessionPose | "queued";

/** The states in the order a group's status words list them. */
const STATE_ORDER: readonly WorkState[] = [
  "working",
  "waiting",
  "queued",
  "idle",
  "away",
  "asleep",
];

/**
 * The poses in the order a group takes its own from, most urgent first. A
 * group in a pose that needs the user comes before one that works, and one
 * that works before one that idles.
 */
const POSE_URGENCY: readonly Pose[] = ["waiting", "working", "idle", "away", "asleep"];

const SESSION_STATUS: Readonly<Record<WorkState, MachineWorkSession["status"]>> = {
  working: "Working",
  waiting: "Waits for you",
  queued: "Waits for a slot",
  idle: "Idle",
  away: "Away",
  asleep: "Asleep",
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

/** A session open on the machine, with what the page needs to know of it. */
interface OpenSession {
  readonly session: Session;
  readonly state: WorkState;
  readonly face: WorkFace;
  readonly opens: WorkDestination;
}

/** A group before its time is formatted: the group and what orders it. */
interface GroupedWork {
  readonly group: Omit<MachineWorkGroup, "since">;
  /** The sessions of the group, in the order of the "Sessions" list. */
  readonly members: readonly OpenSession[];
  /** The earliest start among the members, as milliseconds. */
  readonly startedAtMs: number;
  /** The creation time of the oldest queued member, as milliseconds, or `null` when none is queued. */
  readonly queuedAtMs: number | null;
}

const startedAtMs = (session: Session): number =>
  Date.parse(session.startedAt ?? session.createdAt);

/** Orders by milliseconds, oldest first, then by `tieBreak` so the order never depends on input order. */
const compareOldestFirst = (a: number, b: number, tieA: string, tieB: string): number =>
  a - b || (tieA < tieB ? -1 : tieA > tieB ? 1 : 0);

/** Describes `session` as an open session of a machine whose runner is `runner`. */
const describeOpenSession = (session: Session, runner: Runner | undefined): OpenSession => {
  const pose = decideThreadPose(session, runner);
  const state: WorkState = session.status === "queued" ? "queued" : pose;
  // A queued session that would otherwise work is not at work yet, so its face is idle. One that
  // waits on the user, or whose machine is away, keeps that pose.
  const facePose = state === "queued" && pose === "working" ? "idle" : pose;
  switch (session.kind) {
    case "run":
      return {
        session,
        state,
        face: { look: "run", seed: session.id, pose: facePose },
        opens: { kind: "run", runId: session.runId! },
      };
    case "assistant":
      return {
        session,
        state,
        face: { look: "assistant", seed: session.agentId!, pose: facePose },
        opens: { kind: "assistant", assistantId: session.agentId! },
      };
    case "thread":
    case "agent":
      return {
        session,
        state,
        face: { look: session.kind, seed: session.id, pose: facePose },
        opens: { kind: "thread", sessionId: session.id },
      };
  }
};

/** Everything a group's key, kind, title, detail, face and destination are decided from. */
interface GroupIdentity {
  readonly key: string;
  readonly kind: MachineWorkGroup["kind"];
  readonly title: string;
  readonly detail: (members: readonly OpenSession[]) => string;
  readonly look: WorkFace["look"];
  readonly seed: string;
  readonly opens: WorkDestination;
}

/**
 * Returns the group `open` belongs to, as the user knows it:
 *
 * - a run's step session belongs to its run, named by the workflow's name in
 *   `workflowNames`, or by the session's own title when that has no entry for
 *   the run;
 * - an assistant's session belongs to the assistant;
 * - a Thread or an Agent session belongs to the sidebar's row that lists it
 *   (`rowMembers`), named as the sidebar names it;
 * - a Thread or an Agent session no row lists is a group of its own.
 */
const identifyGroup = (
  { session }: OpenSession,
  rowMembers: Readonly<Record<string, RowMember>>,
  workflowNames: Readonly<Record<string, string>>,
  assistantNames: ReadonlyMap<string, string>,
): GroupIdentity => {
  switch (session.kind) {
    case "run": {
      const runId = session.runId!;
      return {
        key: `run:${runId}`,
        kind: "run",
        title: workflowNames[runId] ?? session.title,
        detail: (members) => {
          const steps = new Set(members.flatMap((member) => member.session.stepId ?? []));
          return `Workflow run · ${[...steps].join(", ")}`;
        },
        look: "run",
        seed: runId,
        opens: { kind: "run", runId },
      };
    }
    case "assistant": {
      const agentId = session.agentId!;
      return {
        key: `assistant:${agentId}`,
        kind: "assistant",
        title: assistantNames.get(agentId) ?? session.title,
        detail: () => "Assistant",
        look: "assistant",
        seed: agentId,
        opens: { kind: "assistant", assistantId: agentId },
      };
    }
    case "thread":
    case "agent": {
      const row = rowMembers[session.id];
      if (row === undefined)
        return {
          key: `session:${session.id}`,
          kind: "threads",
          title: session.title,
          detail: () => (session.kind === "thread" ? "Thread" : "Agent session"),
          look: session.kind,
          seed: session.id,
          opens: { kind: "thread", sessionId: session.id },
        };
      return {
        key: row.rowKey,
        kind: "threads",
        title: row.rowTitle,
        // The lead's label is the row's name, which the title already shows, so only the other
        // sessions are listed, in the order of the "Sessions" list.
        detail: (members) => {
          const others = members.filter((member) => member.session.id !== row.leadId);
          return others.length === 0
            ? "Threads"
            : `Threads · ${others.map((member) => rowMembers[member.session.id]!.label).join(", ")}`;
        },
        look: "thread",
        seed: row.leadId,
        opens: { kind: "thread", sessionId: row.leadId },
      };
    }
  }
};

/** Returns the order of the "Sessions" list: queued sessions first, then the oldest start first. */
const compareSessions = (a: OpenSession, b: OpenSession): number => {
  const queuedA = a.session.status === "queued";
  if (queuedA !== (b.session.status === "queued")) return queuedA ? -1 : 1;
  return queuedA
    ? compareOldestFirst(
        Date.parse(a.session.createdAt),
        Date.parse(b.session.createdAt),
        a.session.id,
        b.session.id,
      )
    : compareOldestFirst(
        startedAtMs(a.session),
        startedAtMs(b.session),
        a.session.id,
        b.session.id,
      );
};

/** Returns the order of the groups: those that wait first, by their oldest queued session, then the oldest start first. */
const compareGroups = (a: GroupedWork, b: GroupedWork): number => {
  if ((a.queuedAtMs === null) !== (b.queuedAtMs === null)) return a.queuedAtMs === null ? 1 : -1;
  return compareOldestFirst(
    a.queuedAtMs ?? a.startedAtMs,
    b.queuedAtMs ?? b.startedAtMs,
    a.group.key,
    b.group.key,
  );
};

/**
 * Returns the groups of `sessions`, in the order they are shown. `sessions`
 * are the open sessions of one machine, whose runner is `runner` (or
 * `undefined` when the runner list does not hold it, which counts as online).
 *
 * This is the one place that decides what a group is, so the page and the
 * cards cannot disagree.
 */
const groupOpenSessions = ({
  sessions,
  runner,
  rowMembers,
  workflowNames,
  assistants,
}: {
  readonly sessions: readonly Session[];
  readonly runner: Runner | undefined;
  readonly rowMembers: Readonly<Record<string, RowMember>>;
  readonly workflowNames: Readonly<Record<string, string>>;
  readonly assistants: readonly Pick<Assistant, "id" | "name">[];
}): readonly GroupedWork[] => {
  const assistantNames = new Map(assistants.map((each) => [each.id, each.name]));

  const grouped = new Map<string, { identity: GroupIdentity; members: OpenSession[] }>();
  for (const open of sessions.map((session) => describeOpenSession(session, runner))) {
    const identity = identifyGroup(open, rowMembers, workflowNames, assistantNames);
    const entry = grouped.get(identity.key) ?? { identity, members: [] };
    entry.members.push(open);
    grouped.set(identity.key, entry);
  }

  return [...grouped.values()]
    .map(({ identity, members }): GroupedWork => {
      const sorted = members.toSorted(compareSessions);
      const counts = STATE_ORDER.map(
        (state) => [state, sorted.filter((member) => member.state === state).length] as const,
      );
      const queued = sorted.filter((member) => member.session.status === "queued");
      const pose = POSE_URGENCY.find((each) => sorted.some((m) => m.face.pose === each))!;
      return {
        group: {
          key: identity.key,
          kind: identity.kind,
          title: identity.title,
          detail: identity.detail(sorted),
          status: counts
            .filter(([, count]) => count > 0)
            .map(([state, count]) => describeStateCount(state, count))
            .join(" · "),
          waitingForSlot: queued.length > 0,
          face: { look: identity.look, seed: identity.seed, pose },
          faces: sorted.map((member) => member.face),
          opens: identity.opens,
        },
        members: sorted,
        startedAtMs: Math.min(...sorted.map((member) => startedAtMs(member.session))),
        // The queued members come first in `sorted`, oldest first.
        queuedAtMs: queued[0] === undefined ? null : Date.parse(queued[0].session.createdAt),
      };
    })
    .toSorted(compareGroups);
};

/**
 * Returns the ids of the runs that have an open step session on `runnerId`,
 * each once and sorted. The caller looks up the workflow names of these runs
 * for `workflowNames`. The result is a plain array, so it keeps its identity
 * while the runs stay the same.
 */
export const listMachineRunIds = (
  sessions: readonly Session[],
  runnerId: string,
): readonly string[] => {
  const ids = new Set(
    sessions.flatMap((session) =>
      session.kind === "run" && session.status !== "exited" && session.runnerId === runnerId
        ? [session.runId!]
        : [],
    ),
  );
  return [...ids].toSorted();
};

/** Returns the sessions of `sessions` that have not exited. */
const listOpenSessions = (sessions: readonly Session[]): readonly Session[] =>
  sessions.filter((session) => session.status !== "exited");

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
 *   it is named by its first session's title.
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
  const open = listOpenSessions(sessions.filter((session) => session.runnerId === runner.id));
  const grouped = groupOpenSessions({
    sessions: open,
    runner,
    rowMembers,
    workflowNames,
    assistants,
  });
  const groups = grouped.map(({ group, startedAtMs: startMs }): MachineWorkGroup => {
    const moment = formatShortMoment(new Date(startMs), today, timezone);
    return { ...group, since: moment === undefined ? null : `since ${moment}` };
  });
  const listed = grouped
    .flatMap(({ members }) => members)
    .toSorted(compareSessions)
    .map(({ session, state, face, opens }): MachineWorkSession => ({
      id: session.id,
      face,
      title: session.title,
      status: SESSION_STATUS[state],
      waitingForSlot: session.status === "queued",
      runningSince: session.startedAt ?? session.createdAt,
      opens,
    }));
  return { groups, sessions: listed };
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
  for (const session of listOpenSessions(sessions)) {
    const open = openByRunnerId.get(session.runnerId) ?? [];
    open.push(session);
    openByRunnerId.set(session.runnerId, open);
  }
  return Object.fromEntries(
    [...openByRunnerId].map(([runnerId, open]) => {
      // Faces need no names, so no workflow or assistant is passed.
      const groups = groupOpenSessions({
        sessions: open,
        runner: runnersById.get(runnerId),
        rowMembers,
        workflowNames: {},
        assistants: [],
      });
      return [
        runnerId,
        {
          faces: groups.slice(0, MAX_CARD_FACES).map(({ group }) => group.face),
          moreCount: Math.max(0, groups.length - MAX_CARD_FACES),
        },
      ];
    }),
  );
};
