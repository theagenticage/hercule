/**
 * Decides everything the desktop sidebar shows for one group of sessions
 * (`SessionGroup`): the row's status, its second line, its dots, and what
 * each session of the group is. The sidebar only lays the result out.
 *
 * A group's *counted* sessions are its Threads not marked Done and its Agent
 * sessions that have not ended. They alone decide the row's status, its dots
 * and whether the row waits. A Done Thread and an ended Agent session stay in
 * the group, so they can still be opened, but they are quiet.
 */
import type {
  Project,
  ProviderInstance,
  Resource,
  Runner,
  Session,
  Workspace,
} from "@hercule/contract";
import { decideGroupProjectId } from "./groups";
import { findOldestOpenRequest } from "./oldest-request";
import type { Pose, ThreadRowStatus } from "./pose";
import { buildThreadPlaceLabel } from "./project-rows";
import { formatRequestQuestion } from "./request-question";
import { buildGroupKey, buildWorkspaceGroupKey, type SessionGroup } from "./session-groups";
import {
  describeSessionTab,
  formatSessionCount,
  labelWorkspaceSessions,
  type SessionTab,
} from "./siblings";
import { describeThreadPlace } from "./thread-place";
import { buildWorkspaceLabelParts, type WorkspaceLabel } from "./workspaces";

/** How many dots a group's row shows before it folds the rest into "+n". */
const MAX_DOTS = 3;

/**
 * What one dot says about a session: it `waiting` on the user, is `working`
 * (queued counts as working), or is `quiet`, which covers everything else,
 * including a Done Thread and an ended Agent session.
 */
export type SessionDot = "waiting" | "working" | "quiet";

/**
 * One session of a group: what the header's tab shows of it (`SessionTab`,
 * labelled among the group's sessions), and what the row's dots and unfolded
 * lines add.
 */
export interface GroupMember extends SessionTab {
  /** A Thread, or an Agent's session: the only kinds a group holds. */
  readonly kind: "thread" | "agent";
  /**
   * `label` when the name tells the session apart from the others, and
   * `null` for the lead, which the row's name already stands for, and so for
   * the only session of a group. The second line and Waiting on you both name
   * an asking session with this.
   */
  readonly askerLabel: string | null;
  /** Whether the session counts toward the row's status, dots and waiting. */
  readonly counted: boolean;
  /** Whether the Office seats the session at work, as `isSessionSeated` decides it. */
  readonly seated: boolean;
  readonly dot: SessionDot;
  /** The oldest open Request's question, or `null` when nothing waits in this session. */
  readonly question: string | null;
}

/** What waits on the user in a group, as the row's second line shows it. */
export interface GroupAsk {
  /**
   * What the asking session is called in its group, such as "review", or
   * `null` when the lead asks or the group has one session: the line then
   * shows the question alone.
   */
  readonly askerLabel: string | null;
  /** The question of the asking session's oldest open Request, such as "Run git push?". */
  readonly question: string;
}

/**
 * The dots of a group of 2 or more sessions, and the words that describe them
 * to assistive technology. The dots button also unfolds the row, so a group
 * of 2 or more always has a summary, even when it has no dot to draw.
 */
export interface GroupSummary {
  /**
   * One dot per counted session, the most urgent first, at most three. A Done
   * Thread and an ended Agent session get none, so a group with one counted
   * session shows one dot and a group with none (on the Done shelf) shows none.
   */
  readonly dots: readonly SessionDot[];
  /** How many counted sessions the dots leave out: the "+n" after them, or 0 for none. */
  readonly hiddenCount: number;
  /**
   * Every session of the group, the most urgent dot first: waiting, then
   * working, then quiet, and in the group's order among equals. The hover
   * card lists them in this order.
   */
  readonly membersByUrgency: readonly GroupMember[];
  /**
   * Every session of the group in words, the Done and ended ones as parts of
   * their own: "10 threads: 1 waiting on you, 3 working, 4 quiet, 2 done", or
   * "3 sessions: 1 working, 1 done, 1 ended". It says "threads" when every
   * session is a Thread, and "sessions" when an Agent session is among them.
   */
  readonly label: string;
}

/** A group's row in the sidebar. */
export interface GroupRow {
  /** The group's key, which tells rows apart and stays the same across renders. */
  readonly key: string;
  /** The project the row sits under: the lead's, or `null` when the lead has none or its project no longer exists. */
  readonly projectId: string | null;
  /** The session the row opens: the lead. */
  readonly leadId: string;
  /** The row's name: the lead's title. */
  readonly title: string;
  /** The pose of the session that decides the status. */
  readonly pose: Pose;
  /**
   * The status of the session that asked first while a counted session waits,
   * so the status and the second line (`ask`) describe the same session.
   * Otherwise the status of the most urgent counted session: working, then
   * queued, then the rest, with the most recently active first among equals.
   * A group with no counted session shows its lead's.
   */
  readonly status: ThreadRowStatus;
  /** When the status's session was last active, which an `age` status counts from. */
  readonly activityAt: string;
  /** What waits on the user, or `null` when no counted session waits and the row's second line shows the place. */
  readonly ask: GroupAsk | null;
  /** The harness whose mark leads the second line: the asking session's while one asks, otherwise the lead's. */
  readonly harnessId: string | null;
  /** Where the lead works, as the second line shows it when nothing asks. */
  readonly placeLabel: WorkspaceLabel;
  /** Where the lead works, in words, for the row's accessible description. */
  readonly placeDescription: string;
  /** The name of the machine the lead runs on, or `null` when the runner list does not hold it. */
  readonly machine: string | null;
  /** The branch of the lead's workspace's first checkout, or `null` when there is none. */
  readonly branch: string | null;
  /** Every session of the group, in the group's order: the lead first among the Threads, then by start. */
  readonly members: readonly GroupMember[];
  /** The Threads of the group, in the group's order, whether Done or not. */
  readonly threadIds: readonly string[];
  /**
   * The Threads a Done press on the row marks: those of the group not yet
   * marked Done, in the group's order. An Agent session is never among them,
   * because it cannot be marked Done.
   */
  readonly doneIds: readonly string[];
  /** The dots after the row's name, or `null` for a group of one session, which has no dots and does not unfold. */
  readonly summary: GroupSummary | null;
  /** When the group last started, as `SessionGroup.lastStartedAt` says. */
  readonly lastStartedAt: string;
  /** When the group went to the Done shelf, or `null` while it is in its project's list. */
  readonly doneAt: string | null;
}

/** The records a group's rows are described from. */
export interface GroupRowSources {
  readonly groups: readonly SessionGroup[];
  /** The pose of every session of `groups`, by session id. */
  readonly poses: ReadonlyMap<string, Pose>;
  /** The ids of the sessions with a colleague in the Office. */
  readonly seatedIds: ReadonlySet<string>;
  /** The project list, for each row's project and its name in the place description. */
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
  readonly instances: readonly ProviderInstance[];
}

/**
 * Returns how urgent a status is, lowest first: 0 for a waiting session, 1 for
 * a working one, 2 for a queued one and 3 for the rest.
 */
const rankUrgency = (status: ThreadRowStatus): number => {
  switch (status) {
    case "approval":
    case "question":
      return 0;
    case "working":
      return 1;
    case "queued":
      return 2;
    case "offline":
    case "age":
      return 3;
  }
};

/** Returns the dot's rank, lowest first: waiting, then working, then quiet. */
const rankDot = (dot: SessionDot): number => (dot === "waiting" ? 0 : dot === "working" ? 1 : 2);

/** Checks whether the session counts toward its group's row: a Thread not marked Done, or an Agent session that has not ended. */
const isCounted = (session: Session): boolean =>
  session.kind === "thread" ? session.done === undefined : session.status !== "exited";

/** Returns what a counted session's dot says: its pose, with queued counted as working. */
const decideDot = (counted: boolean, pose: Pose): SessionDot => {
  if (!counted || (pose !== "waiting" && pose !== "working")) return "quiet";
  return pose;
};

/**
 * Returns the dots and the words for `members`, as `GroupSummary` describes
 * them. Only counted members get a dot; every member is in the words.
 */
const summarizeMembers = (members: readonly GroupMember[]): GroupSummary => {
  // `toSorted` is stable, so equals keep the group's order.
  const membersByUrgency = members.toSorted((a, b) => rankDot(a.dot) - rankDot(b.dot));
  const counted = membersByUrgency.filter((member) => member.counted);
  const shown = counted.slice(0, MAX_DOTS);
  const countOf = (dot: SessionDot): number =>
    counted.filter((member) => member.dot === dot).length;
  const parts = [
    [countOf("waiting"), "waiting on you"],
    [countOf("working"), "working"],
    [countOf("quiet"), "quiet"],
    [members.filter((member) => member.done).length, "done"],
    [members.filter((member) => member.kind === "agent" && !member.counted).length, "ended"],
  ]
    .filter(([count]) => count !== 0)
    .map(([count, words]) => `${String(count)} ${words}`);
  return {
    dots: shown.map((member) => member.dot),
    hiddenCount: counted.length - shown.length,
    membersByUrgency,
    label: `${formatSessionCount(members)}: ${parts.join(", ")}`,
  };
};

/**
 * Returns the rows of `groups`, one per group and in the groups' order. Every
 * decision that does not depend on the user's choices (which section is
 * open, which session is selected) is made here:
 *
 * - the status and the second line: when a counted session waits, the one
 *   that asked first (the one whose last activity is oldest) decides both, so
 *   they describe the same session; otherwise the status is the most urgent
 *   counted session's and the second line shows where the lead works;
 * - the dots, none for a group of one session;
 * - the project, resolved so that a deleted project, and a lead with none,
 *   give `null`.
 *
 * Each session's status is decided here from its runner. Its pose and
 * whether it is seated come from `poses` and `seatedIds`, decided once for
 * every session, so the row's pose agrees with the foot and the Go menu.
 */
export const describeGroupRows = ({
  groups,
  poses,
  seatedIds,
  projects,
  workspaces,
  resources,
  runners,
  instances,
}: GroupRowSources): readonly GroupRow[] => {
  const listedProjectIds = new Set(projects.map((each) => each.id));
  const projectNames = new Map(projects.map((each) => [each.id, each.name]));
  const workspacesById = new Map(workspaces.map((each) => [each.id, each]));
  const runnersById = new Map(runners.map((each) => [each.id, each]));
  const instancesById = new Map(instances.map((each) => [each.id, each]));

  return groups.map((group): GroupRow => {
    const labels = labelWorkspaceSessions(group.sessions);
    const describeMember = (session: Session): GroupMember => {
      const pose = poses.get(session.id)!;
      const counted = isCounted(session);
      const oldest = findOldestOpenRequest(session);
      const tab = describeSessionTab({
        session,
        label: labels.get(session.id) ?? session.title,
        pose,
        runner: runnersById.get(session.runnerId),
        instance: instancesById.get(session.instanceId),
      });
      return {
        ...tab,
        kind: session.kind === "agent" ? "agent" : "thread",
        askerLabel: session.id === group.lead.id ? null : tab.label,
        counted,
        seated: seatedIds.has(session.id),
        dot: decideDot(counted, pose),
        question: oldest === null ? null : formatRequestQuestion(oldest),
      };
    };
    // The lead is described apart, so the row can fall back to it with no lookup.
    const lead = describeMember(group.lead);
    const members = group.sessions.map((session) =>
      session.id === group.lead.id ? lead : describeMember(session),
    );
    const countedMembers = members.filter((member) => member.counted);

    // The session that asked first is the one that has been still the longest. It decides both the
    // status and the second line, so the two never describe different sessions.
    const asker = countedMembers
      .flatMap((member) =>
        member.question === null ? [] : [{ member, question: member.question }],
      )
      .toSorted((a, b) => Date.parse(a.member.activityAt) - Date.parse(b.member.activityAt))[0];
    // Without an asker, no counted session waits. `toSorted` is stable, so equals keep the group's order.
    const statusMember =
      asker?.member ??
      countedMembers.toSorted(
        (a, b) =>
          rankUrgency(a.status) - rankUrgency(b.status) ||
          Date.parse(b.activityAt) - Date.parse(a.activityAt),
      )[0] ??
      lead;

    const projectId = decideGroupProjectId(group.lead.projectId, listedProjectIds);
    const projectName = projectId === null ? null : (projectNames.get(projectId) ?? null);
    const workspace =
      group.lead.workspaceId === null ? undefined : workspacesById.get(group.lead.workspaceId);
    const machine = runnersById.get(group.lead.runnerId)?.name ?? null;
    const branch = workspace?.checkouts[0]?.branch ?? null;

    return {
      key: group.key,
      projectId,
      leadId: group.lead.id,
      title: group.lead.title,
      pose: statusMember.pose,
      status: statusMember.status,
      activityAt: statusMember.activityAt,
      ask:
        asker === undefined
          ? null
          : {
              askerLabel: asker.member.askerLabel,
              question: asker.question,
            },
      harnessId: (asker?.member ?? lead).harnessId,
      placeLabel: buildThreadPlaceLabel({ workspace, branch, machine, resources, runners }),
      placeDescription: describeThreadPlace({
        projectName,
        workspace:
          workspace === undefined
            ? null
            : {
                kind: workspace.kind,
                name: buildWorkspaceLabelParts(workspace, resources, runners).clip,
              },
        machine,
        branch,
      }),
      machine,
      branch,
      members,
      threadIds: members.filter((member) => member.kind === "thread").map((m) => m.sessionId),
      doneIds: members
        .filter((member) => member.kind === "thread" && !member.done)
        .map((member) => member.sessionId),
      summary: members.length < 2 ? null : summarizeMembers(members),
      lastStartedAt: group.lastStartedAt,
      doneAt: group.doneAt,
    };
  });
};

/**
 * Returns the row of the group that holds `session`, or `undefined` when no
 * row does. The row is found by the group's key and must list `session`
 * among its members.
 *
 * Only a Thread or an Agent's session can be in a row. For any other kind,
 * such as a run's step session, this returns `undefined` without looking, even
 * when the step session shares a workspace, and so a key, with a Thread.
 */
export const findGroupRow = (
  groupRows: readonly GroupRow[],
  session: Session,
): GroupRow | undefined => {
  if (session.kind !== "thread" && session.kind !== "agent") return undefined;
  const key = buildGroupKey(session);
  return groupRows.find(
    (row) => row.key === key && row.members.some((member) => member.sessionId === session.id),
  );
};

/**
 * Returns the row of the group of the workspace `workspaceId`, or `undefined`
 * when no row has that key: a workspace that holds no Thread, or none the
 * sidebar lists. A Draft Thread that joins a workspace finds the tabs of its
 * header here, before it has a session of its own.
 */
export const findWorkspaceGroupRow = (
  groupRows: readonly GroupRow[],
  workspaceId: string,
): GroupRow | undefined => {
  const key = buildWorkspaceGroupKey(workspaceId);
  return groupRows.find((row) => row.key === key);
};
