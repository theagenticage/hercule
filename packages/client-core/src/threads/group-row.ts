/**
 * Decides everything the desktop sidebar shows for one group of sessions
 * (`SessionGroup`): the row's status, its second line, its dots, and the
 * lines it unfolds into. The sidebar only lays the result out.
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
import { findModelName } from "./model-name";
import { findOldestOpenRequest } from "./oldest-request";
import { decideThreadPose, decideThreadRowStatus, type Pose, type ThreadRowStatus } from "./pose";
import { buildThreadPlaceLabel } from "./project-rows";
import { formatRequestQuestion } from "./request-question";
import type { SessionGroup } from "./session-groups";
import { labelWorkspaceSessions } from "./siblings";
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

/** One session of a group, with what the row's dots and unfolded lines show about it. */
export interface GroupMember {
  readonly sessionId: string;
  /** A Thread, or an Agent's session. */
  readonly kind: "thread" | "agent";
  /** What the session is called inside its group, as `labelWorkspaceSessions` returns it. */
  readonly label: string;
  /** The session's full title, for a tooltip. */
  readonly title: string;
  readonly pose: Pose;
  readonly status: ThreadRowStatus;
  /** When the session was last active, which an `age` status counts from. */
  readonly activityAt: string;
  /** Whether the session counts toward the row's status, dots and waiting. */
  readonly counted: boolean;
  /** Whether the session is a Thread marked Done. */
  readonly done: boolean;
  readonly dot: SessionDot;
  /** The oldest open Request's question, or `null` when nothing waits in this session. */
  readonly question: string | null;
  /** The provider of the session's instance, such as `claude-code`, or `null` when the instance is unknown. */
  readonly providerId: string | null;
  /** The display name of the model the session runs on. */
  readonly model: string;
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
   * The status of the most urgent counted session: waiting first, then
   * working, then queued, then the rest, with the most recently active first
   * among equals. A group with no counted session shows its lead's.
   */
  readonly status: ThreadRowStatus;
  /** When the status's session was last active, which an `age` status counts from. */
  readonly activityAt: string;
  /** What waits on the user, or `null` when no counted session waits and the row's second line shows the place. */
  readonly ask: GroupAsk | null;
  /** The provider whose mark leads the second line: the asking session's while one asks, otherwise the lead's. */
  readonly providerId: string | null;
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
  const counted = members
    .filter((member) => member.counted)
    .toSorted((a, b) => rankDot(a.dot) - rankDot(b.dot));
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
  const noun = members.every((member) => member.kind === "thread") ? "threads" : "sessions";
  return {
    dots: shown.map((member) => member.dot),
    hiddenCount: counted.length - shown.length,
    label: `${String(members.length)} ${noun}: ${parts.join(", ")}`,
  };
};

/**
 * Returns the rows of `groups`, one per group and in the groups' order. Every
 * decision that does not depend on the user's choices (which section is
 * open, which session is selected) is made here:
 *
 * - the status of the most urgent counted session;
 * - the second line: the question of the counted session that asked first
 *   (the one whose last activity is oldest), or else where the lead works;
 * - the dots, none for a group of one session;
 * - the project, resolved so that a deleted project, and a lead with none,
 *   give `null`.
 *
 * Each session's pose and status are decided here from its runner, so no
 * caller computes them for the sidebar.
 */
export const describeGroupRows = ({
  groups,
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
      const runner = runnersById.get(session.runnerId);
      const pose = decideThreadPose(session, runner);
      const counted = isCounted(session);
      const oldest = findOldestOpenRequest(session);
      return {
        sessionId: session.id,
        kind: session.kind === "agent" ? "agent" : "thread",
        label: labels.get(session.id) ?? session.title,
        title: session.title,
        pose,
        status: decideThreadRowStatus(session, runner),
        activityAt: session.lastActivityAt,
        counted,
        done: session.done !== undefined,
        dot: decideDot(counted, pose),
        question: oldest === null ? null : formatRequestQuestion(oldest),
        providerId: instancesById.get(session.instanceId)?.providerId ?? null,
        model: findModelName(instancesById.get(session.instanceId), session.modelSelection.model),
      };
    };
    // The lead is described apart, so the row can fall back to it with no lookup.
    const lead = describeMember(group.lead);
    const members = group.sessions.map((session) =>
      session.id === group.lead.id ? lead : describeMember(session),
    );
    const countedMembers = members.filter((member) => member.counted);

    // `toSorted` is stable, so equals keep the group's order.
    const statusMember =
      countedMembers.toSorted(
        (a, b) =>
          rankUrgency(a.status) - rankUrgency(b.status) ||
          Date.parse(b.activityAt) - Date.parse(a.activityAt),
      )[0] ?? lead;
    const asker = countedMembers
      .flatMap((member) =>
        member.question === null ? [] : [{ member, question: member.question }],
      )
      .toSorted((a, b) => Date.parse(a.member.activityAt) - Date.parse(b.member.activityAt))[0];

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
              askerLabel:
                members.length === 1 || asker.member.sessionId === group.lead.id
                  ? null
                  : asker.member.label,
              question: asker.question,
            },
      providerId: (asker?.member ?? lead).providerId,
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
      summary: members.length < 2 ? null : summarizeMembers(members),
      lastStartedAt: group.lastStartedAt,
      doneAt: group.doneAt,
    };
  });
};

/** The lines an unfolded row draws, and how many sessions it folded into one "n quiet" line. */
export interface GroupLines {
  /** One line per session shown, in the group's order. */
  readonly lines: readonly GroupMember[];
  /** How many quiet sessions the "n quiet" line after `lines` stands for, or 0 when it is not drawn. */
  readonly foldedQuietCount: number;
}

/**
 * Returns the lines an unfolded row draws, one per session in the group's
 * order, with the quiet ones folded into one "n quiet" line when more than
 * two are quiet. A session is quiet when it neither waits nor works; a Done
 * Thread and an ended Agent session are quiet.
 *
 * - `selectedId` is the open session. It always has a line of its own and is
 *   not counted among the quiet ones.
 * - `quietShown` is true when the user opened the "n quiet" line, which
 *   shows every session.
 *
 * Returns no lines for a row of one session, which does not unfold.
 */
export const listGroupLines = (
  row: GroupRow,
  { selectedId, quietShown }: { readonly selectedId: string | null; readonly quietShown: boolean },
): GroupLines => {
  if (row.members.length < 2) return { lines: [], foldedQuietCount: 0 };
  const quiet = new Set(
    row.members
      .filter((member) => member.dot === "quiet" && member.sessionId !== selectedId)
      .map((member) => member.sessionId),
  );
  if (quiet.size <= 2 || quietShown) return { lines: row.members, foldedQuietCount: 0 };
  return {
    lines: row.members.filter((member) => !quiet.has(member.sessionId)),
    foldedQuietCount: quiet.size,
  };
};
