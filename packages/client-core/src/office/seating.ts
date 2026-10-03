/**
 * Where each thread sits in the Office: its desk in a room, its place in the
 * queue at the user's desk while it has an open Request, and the Lounge while
 * it is idle.
 */
import type { Project, Runner, Session, Workspace } from "@hercule/contract";
import { decideGroupProjectId, rankLane } from "../threads/groups";
import { decideThreadPose, type Pose } from "../threads/pose";

/** A thread at its desk, and the pose its character shows. */
export interface OfficeDesk {
  readonly session: Session;
  readonly pose: Pose;
}

export interface OfficeRoom {
  /** The project the room belongs to, or null for the one room the threads with no project share. */
  readonly projectId: string | null;
  /** The project's name, or "No project". */
  readonly name: string;
  /** Every thread with a desk in this room, in desk order. */
  readonly desks: readonly OfficeDesk[];
}

export interface OfficeSeating {
  readonly rooms: readonly OfficeRoom[];
  /** The ids of threads with an open Request, in queue order: waiting longest first. */
  readonly queue: readonly string[];
  /** The ids of idle threads, who sit in the Lounge. */
  readonly lounge: readonly string[];
}

/** The poses of the threads that are seated in the Office. */
const SEATED_POSES: ReadonlySet<Pose> = new Set(["working", "waiting", "idle"]);

/**
 * Checks whether a thread in `pose` has a colleague in the Office: true for
 * `working`, `waiting` and `idle`, false for every other pose.
 *
 * The sidebar and the Go menu ask this while the Office is open, to open a
 * thread in the Office's drawer or on its own screen, so they always agree
 * with `decideOfficeSeating` about who is in the Office.
 */
export const isSeatedPose = (pose: Pose): boolean => SEATED_POSES.has(pose);

/** Compares two strings by their UTF-16 code units, the same way in every locale. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Returns where each thread sits in the Office.
 *
 * - Only Threads sit in the Office. A session an Agent runs belongs to that
 *   Agent, as it does in the sidebar.
 * - Only a thread whose pose is `working`, `waiting` or `idle` is seated. An
 *   `asleep` or `away` thread has no desk and is in no room, queue or Lounge,
 *   though the sidebar still lists it. A user can have hundreds of old
 *   threads, and the Office costs more for every character it draws. A
 *   thread with an open Request on an offline runner is still seated,
 *   because its pose is `waiting`.
 * - Each project with at least one seated thread has a room, in the order of
 *   `projects`. The threads with no project share one room, which comes last.
 *   A thread whose project is not in `projects` joins that room, as it joins
 *   the threads with no project in the sidebar.
 * - Rooms are not sorted by latest activity, as the sidebar's projects are. A
 *   room is a place in a 3D scene, and a place that moves whenever a thread
 *   works would leave the user unable to find anything.
 * - Inside a room, desks are grouped by workspace in the sidebar's order (see
 *   `rankLane`), and inside a workspace the oldest thread comes first, so a
 *   desk keeps its place when a new thread starts.
 * - A thread keeps its desk while it queues or sits in the Lounge, so it has
 *   a place to return to.
 * - `queue` holds the threads with an open Request, waiting longest first.
 * - `lounge` holds the idle threads, in desk order.
 */
export const decideOfficeSeating = ({
  sessions,
  projects,
  workspaces,
  runners,
}: {
  readonly sessions: readonly Session[];
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  readonly runners: readonly Runner[];
}): OfficeSeating => {
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const listedProjectIds = new Set(projects.map((project) => project.id));

  const desks = sessions
    .filter((session) => session.agentId === null)
    .map((session) => ({
      session,
      pose: decideThreadPose(session, runnersById.get(session.runnerId)),
    }))
    .filter((desk) => isSeatedPose(desk.pose))
    // Workspaces of equal rank, such as two main workspaces, are told apart
    // by id so that each keeps its desks together. Threads created in the
    // same instant are told apart by id so that the order never depends on
    // the order of `sessions`.
    .sort(
      ({ session: a }, { session: b }) =>
        rankLane(a.workspaceId, workspaces) - rankLane(b.workspaceId, workspaces) ||
        compareText(a.workspaceId ?? "", b.workspaceId ?? "") ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        compareText(a.id, b.id),
    );
  const desksByProject = new Map<string | null, OfficeDesk[]>();
  for (const desk of desks) {
    const projectId = decideGroupProjectId(desk.session.projectId, listedProjectIds);
    const roomDesks = desksByProject.get(projectId);
    if (roomDesks === undefined) desksByProject.set(projectId, [desk]);
    else roomDesks.push(desk);
  }

  const rooms: OfficeRoom[] = [
    ...projects.map((project) => ({
      projectId: project.id,
      name: project.name,
      desks: desksByProject.get(project.id) ?? [],
    })),
    { projectId: null, name: "No project", desks: desksByProject.get(null) ?? [] },
  ].filter((room) => room.desks.length > 0);

  const seated = rooms.flatMap((room) => room.desks);
  // A session records no time for when its Request opened. The session is
  // active until the Request opens and then waits, so the oldest
  // `lastActivityAt` stands in for the longest wait.
  const queue = seated
    .map((desk) => desk.session)
    .filter((session) => session.openRequest !== null)
    .sort(
      (a, b) =>
        Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt) || compareText(a.id, b.id),
    )
    .map((session) => session.id);
  const lounge = seated.filter((desk) => desk.pose === "idle").map((desk) => desk.session.id);

  return { rooms, queue, lounge };
};
