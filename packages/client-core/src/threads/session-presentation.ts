/**
 * Prepares what the desktop app shows about the user's Threads and Agent
 * sessions, once per change of the lists it reads. The sidebar, Waiting on
 * you, the Go menu, the dock badge, the notifications and the Office routing
 * all read the one result, so they always agree on what exists and what each
 * session is doing.
 *
 * `prepareSessionPresentation` decides everything that does not depend on the
 * user's choices (which section is open, which row is unfolded). The choices
 * are applied afterwards by `selectSidebar`, which is cheap enough to run on
 * each of them.
 */
import type {
  Project,
  ProviderInstance,
  Resource,
  Runner,
  Session,
  Workspace,
} from "@hercule/contract";
import { isSessionSeated } from "../office/work";
import { listWaitingSessions, type WaitingSession } from "../waiting";
import { describeGroupRows, type GroupRow } from "./group-row";
import { decideThreadPose, type Pose } from "./pose";
import { buildSessionGroups } from "./session-groups";
import { isMarkedDone } from "./status";

/** How many sessions are working, waiting on the user, and idle. */
export interface SessionCounts {
  readonly working: number;
  readonly waiting: number;
  readonly idle: number;
}

/** Everything the app shows about the user's Threads and Agent sessions. */
export interface SessionPresentation {
  /**
   * The Threads and Agent sessions the presentation describes: the listed
   * sessions, and the open session when the list lacks it. A session in this
   * list that is not in `seatedIds` is known not to be seated, unlike a
   * session this list does not hold, whose seat is unknown.
   */
  readonly sessions: readonly Session[];
  /** One row per group of sessions, newest `lastStartedAt` first. */
  readonly groupRows: readonly GroupRow[];
  /**
   * The Threads and Agent sessions that wait on the user, grouped or not. A
   * Thread marked Done is among them while it waits, because a question must
   * never hide. `listWaiting` adds the assistants and sorts them.
   */
  readonly waitingSessions: readonly WaitingSession[];
  /**
   * The count in the sidebar's foot: the Threads and Agent sessions not
   * marked Done, ungrouped ones included, by pose. Asleep and away sessions
   * are not counted, so a fleet with hundreds of old threads reads "4 idle",
   * not "470 idle". A session of a group counts on its own: a row with one
   * working and one idle Thread is both.
   */
  readonly counts: SessionCounts;
  /** The ids of the sessions of `sessions` with a colleague in the Office (`isSessionSeated`). */
  readonly seatedIds: ReadonlySet<string>;
  /** The ids of the listed projects, which tell the project of a draft from a deleted one. */
  readonly listedProjectIds: ReadonlySet<string>;
}

/**
 * Returns the presentation of `reads`.
 *
 * - `listedSessions` is the sidebar's read: the Threads and Agent sessions,
 *   each once, without the Threads marked Done long ago.
 * - `openSession` is the open session's own record, or `null`. The read
 *   leaves out an old Done Thread, so an open one is added here, and its
 *   group keeps a row on the Done shelf. A record `listedSessions` holds wins
 *   over `openSession`. A session that is not a Thread or an Agent's is never
 *   added.
 *
 * Every session's pose is decided once here, and the rows' poses, the counts
 * and the seats all use it. (A row's status is decided from the session and
 * its runner by `decideThreadRowStatus`, which reads the pose rules itself.)
 * The result does not depend on the user's choices, on the
 * time, or on a session's streamed text.
 */
export const prepareSessionPresentation = ({
  listedSessions,
  openSession,
  projects,
  workspaces,
  resources,
  runners,
  instances,
}: {
  readonly listedSessions: readonly Session[];
  readonly openSession: Session | null;
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
  readonly instances: readonly ProviderInstance[];
}): SessionPresentation => {
  const mergesOpenSession =
    openSession !== null &&
    (openSession.kind === "thread" || openSession.kind === "agent") &&
    !listedSessions.some((session) => session.id === openSession.id);
  const sessions = mergesOpenSession ? [...listedSessions, openSession] : listedSessions;

  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const poses = new Map<string, Pose>();
  const seatedIds = new Set<string>();
  const counts = { working: 0, waiting: 0, idle: 0 };
  for (const session of sessions) {
    const pose = decideThreadPose(session, runnersById.get(session.runnerId));
    poses.set(session.id, pose);
    if (isSessionSeated(session, pose)) seatedIds.add(session.id);
    if (!isMarkedDone(session) && (pose === "working" || pose === "waiting" || pose === "idle")) {
      counts[pose] += 1;
    }
  }

  const groupRows = describeGroupRows({
    groups: buildSessionGroups(sessions),
    poses,
    seatedIds,
    projects,
    workspaces,
    resources,
    runners,
    instances,
  });
  return {
    sessions,
    groupRows,
    waitingSessions: listWaitingSessions(sessions, groupRows),
    counts,
    seatedIds,
    listedProjectIds: new Set(projects.map((project) => project.id)),
  };
};
