/**
 * Where each colleague sits in the Office: a session's desk on an aisle of
 * its project's room, an assistant's corner in the Secretariat, the queue at
 * the user's desk while either has an open Request, and the Lounge while a
 * session rests.
 */
import type { Project, Resource, RunSummary, Runner, Session, Workspace } from "@hercule/contract";
import { compareAssistantRows, type AssistantRow } from "../assistants/rows";
import { decideGroupProjectId, rankLane } from "../threads/groups";
import { decideThreadPose, type Pose, type SessionPose } from "../threads/pose";
import { isMarkedDone } from "../threads/status";

/**
 * The poses a colleague in the Office can show: every pose a session can be
 * in, and `done` for the session of a finished agent step whose run is still
 * going.
 */
export type OfficePose = SessionPose | "done";

/**
 * What a session's colleague is, by how the session was started:
 *
 * - `thread`: a Thread, driven by hand;
 * - `agent-step`: the session of a run's agent step;
 * - `agent`: any other session spawned from an Agent, apart from an
 *   assistant's, which sits in the Secretariat.
 */
export type OfficeSessionKind = "thread" | "agent-step" | "agent";

/** A session at its desk, what kind of session it is, and the pose its character shows. */
export interface OfficeDesk {
  readonly session: Session;
  readonly kind: OfficeSessionKind;
  readonly pose: OfficePose;
}

/**
 * One aisle of a room: the desks of one kind of session. An agent-step aisle
 * seats each run's sessions side by side.
 */
export interface OfficeAisle {
  readonly kind: OfficeSessionKind;
  /** Every desk of the aisle, in desk order. Never empty. */
  readonly desks: readonly OfficeDesk[];
}

export interface OfficeRoom {
  /**
   * The project the room belongs to, or null for the one room the sessions
   * with no project share.
   */
  readonly projectId: string | null;
  /** The project's name, or "No project". */
  readonly name: string;
  /**
   * The room's aisles in the order threads, agent steps, agents. An aisle
   * with no desk is left out, so a room has one aisle at least.
   */
  readonly aisles: readonly OfficeAisle[];
}

export interface OfficeSeating {
  readonly rooms: readonly OfficeRoom[];
  /**
   * Every assistant, in the order of its corner in the Secretariat: the
   * sidebar's order, by name (see `compareAssistantRows`).
   */
  readonly secretariat: readonly AssistantRow[];
  /**
   * The ids of the seated sessions and the assistants with an open Request,
   * in queue order: waiting longest first.
   */
  readonly queue: readonly string[];
  /** The ids of the seated sessions that rest, idle or done, in desk order. */
  readonly lounge: readonly string[];
}

/** The order of the aisles in a room. */
const AISLE_ORDER: readonly OfficeSessionKind[] = ["thread", "agent-step", "agent"];

/** The poses a Thread, or an Agent's session outside a run, has a desk in. */
const AT_WORK_POSES: ReadonlySet<Pose> = new Set<Pose>(["working", "waiting", "idle"]);

/** Compares two strings by their UTF-16 code units, the same way in every locale. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Checks whether a Thread whose pose is `pose` has a colleague in the Office;
 * `markedDone` says whether the user marked it Done. A Thread is seated
 * while it is working, waiting or idle, unless it is marked Done. A Done
 * Thread that waits on the user stays until it is answered, so the Office
 * never hides a Request.
 *
 * The sidebar and the Go menu ask this while the Office is open, to open a
 * thread in the Office's drawer or on its own screen, so they always agree
 * with `decideOfficeSeating` about which threads are in the Office.
 */
export const isThreadSeated = (pose: Pose, markedDone: boolean): boolean =>
  AT_WORK_POSES.has(pose) && (!markedDone || pose === "waiting");

/**
 * Returns the pose of the session of a run's agent step:
 *
 * - an open Request makes it `waiting`;
 * - an exited session has finished its step, and is `done`. The session
 *   record does not say whether the step succeeded, so `done` only means the
 *   session has stopped working;
 * - otherwise its pose is a thread's (`decideThreadPose`).
 */
export const decideAgentStepPose = (session: Session, runner: Runner | undefined): OfficePose => {
  if (session.openRequests.length > 0) return "waiting";
  if (session.status === "exited") return "done";
  return decideThreadPose(session, runner);
};

/**
 * Returns the kind of colleague a session has, or null for an assistant's
 * session, which has no desk: the assistant itself sits in the Secretariat.
 */
const decideSessionKind = (session: Session): OfficeSessionKind | null => {
  if (session.agentId === null) return "thread";
  if (session.runId !== null) return "agent-step";
  return session.conversationId === null ? "agent" : null;
};

/**
 * Returns the project whose room a session sits in, or null for the room of
 * the sessions with no project. Only a project in `projects` has a room.
 *
 * - A session with a project sits in that project's room. A Thread whose
 *   project is not listed sits with the sessions with no project, as it does
 *   in the sidebar.
 * - A session with no project of its own, such as an agent step's, sits in
 *   the room of a project that every repo of its workspace belongs to. When
 *   several projects share all of those repos, the first in `projects` wins,
 *   so the room is the same at every read.
 * - A session with no workspace, a workspace missing from `workspaces`, or a
 *   workspace with no checkout, sits with the sessions with no project.
 *
 * Only the Office reads a project from the workspace: a run belongs to no
 * project, and nothing stores one for its sessions.
 */
export const decideOfficeProjectId = (
  session: Session,
  projects: readonly Project[],
  workspacesById: ReadonlyMap<string, Workspace>,
  resourcesById: ReadonlyMap<string, Resource>,
): string | null => {
  const listed = new Set(projects.map((project) => project.id));
  if (session.projectId !== null || session.agentId === null) {
    return decideGroupProjectId(session.projectId, listed);
  }
  const workspace =
    session.workspaceId === null ? undefined : workspacesById.get(session.workspaceId);
  if (workspace === undefined || workspace.checkouts.length === 0) return null;
  const projectIdLists = workspace.checkouts.map(
    (checkout) => resourcesById.get(checkout.resourceId)?.projectIds ?? [],
  );
  const shared = projects.find((project) =>
    projectIdLists.every((projectIds) => projectIds.includes(project.id)),
  );
  return shared?.id ?? null;
};

/**
 * Returns where each session and each assistant sits in the Office.
 *
 * Who has a desk, by kind of session:
 *
 * - A Thread, while `isThreadSeated` holds: working, waiting or idle, and
 *   not marked Done unless it waits on the user. An `asleep` or `away`
 *   Thread has no desk, though the sidebar still lists it: a user can have
 *   hundreds of old threads, and the Office costs more for every character
 *   it draws.
 * - The session of a run's agent step, in any pose, while its run is in
 *   `liveRuns`. When the run ends, all of its sessions leave together. A
 *   session whose step has finished rests, `done`, until then.
 * - Any other session spawned from an Agent, while it is working, waiting or
 *   idle. It cannot be marked Done, so it leaves when its session exits.
 * - An assistant's session has no desk: the assistant has a corner in the
 *   Secretariat instead.
 *
 * Where each desk is:
 *
 * - Each project with at least one desk has a room, in the order of
 *   `projects`. The sessions with no project share one room, which comes
 *   last (see `decideOfficeProjectId`).
 * - Rooms are not sorted by latest activity, as the sidebar's projects are.
 *   A room is a place in a 3D scene, and a place that moves whenever a
 *   thread works would leave the user unable to find anything.
 * - A room splits into aisles: threads, then agent steps, then other
 *   Agents' sessions. So a project's agents sit together, and the room's
 *   size shows how much is going on in the project.
 * - On the threads' aisle, desks are grouped by workspace in the sidebar's
 *   order (see `rankLane`), and inside a workspace the oldest thread comes
 *   first, so a desk keeps its place when a new thread starts.
 * - On the agent steps' aisle, each run's sessions sit together, the oldest
 *   run first, and inside a run the oldest session first.
 * - On the agents' aisle, the oldest session comes first.
 * - A session keeps its desk while it queues or rests in the Lounge, so it
 *   has a place to return to.
 *
 * And the rest:
 *
 * - Every assistant has a corner in the Secretariat, whatever its pose, in
 *   the sidebar's order, by name, whatever the order of `assistants`.
 *   Assistants are few, and one that can't be reached should be easy to
 *   spot. Its pose and current session are the row's.
 * - `queue` holds the seated sessions and assistants with an open Request,
 *   waiting longest first. An assistant is queued by its own id.
 * - `lounge` holds the seated sessions that rest, idle or done, in desk
 *   order. An idle assistant stays at its desk in the Secretariat.
 */
export const decideOfficeSeating = ({
  sessions,
  liveRuns,
  projects,
  workspaces,
  resources,
  runners,
  assistants,
}: {
  /**
   * The sessions to seat, each once: Threads, Agents' sessions and the
   * sessions of runs, in any order. Assistants' sessions are left out.
   */
  readonly sessions: readonly Session[];
  /** The runs that are pending or running. */
  readonly liveRuns: readonly RunSummary[];
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
  /** The sidebar's assistant rows, from `buildAssistantRows`. */
  readonly assistants: readonly AssistantRow[];
}): OfficeSeating => {
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const runsById = new Map(liveRuns.map((run) => [run.id, run]));
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));

  const decideDesk = (session: Session): OfficeDesk | null => {
    const kind = decideSessionKind(session);
    const runner = runnersById.get(session.runnerId);
    switch (kind) {
      case null:
        return null;
      case "thread": {
        const pose = decideThreadPose(session, runner);
        return isThreadSeated(pose, isMarkedDone(session)) ? { session, kind, pose } : null;
      }
      case "agent-step":
        return session.runId !== null && runsById.has(session.runId)
          ? { session, kind, pose: decideAgentStepPose(session, runner) }
          : null;
      case "agent": {
        const pose = decideThreadPose(session, runner);
        return AT_WORK_POSES.has(pose) ? { session, kind, pose } : null;
      }
    }
  };

  const compareAge = (a: Session, b: Session): number =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt) || compareText(a.id, b.id);
  const compareRuns = (a: Session, b: Session): number => {
    const runA = runsById.get(a.runId ?? "");
    const runB = runsById.get(b.runId ?? "");
    return (
      Date.parse(runA?.createdAt ?? "") - Date.parse(runB?.createdAt ?? "") ||
      compareText(a.runId ?? "", b.runId ?? "")
    );
  };
  // Workspaces of equal rank, such as two main workspaces, are told apart by
  // id so that each keeps its desks together. Sessions created in the same
  // instant are told apart by id so that the order never depends on the
  // order of `sessions`.
  const compareDesks = ({ session: a, kind }: OfficeDesk, { session: b }: OfficeDesk): number => {
    switch (kind) {
      case "thread":
        return (
          rankLane(a.workspaceId, workspaces) - rankLane(b.workspaceId, workspaces) ||
          compareText(a.workspaceId ?? "", b.workspaceId ?? "") ||
          compareAge(a, b)
        );
      case "agent-step":
        return compareRuns(a, b) || compareAge(a, b);
      case "agent":
        return compareAge(a, b);
    }
  };

  const desksByProject = new Map<string | null, OfficeDesk[]>();
  for (const session of sessions) {
    const desk = decideDesk(session);
    if (desk === null) continue;
    const projectId = decideOfficeProjectId(session, projects, workspacesById, resourcesById);
    const roomDesks = desksByProject.get(projectId);
    if (roomDesks === undefined) desksByProject.set(projectId, [desk]);
    else roomDesks.push(desk);
  }
  const buildAisles = (desks: readonly OfficeDesk[]): OfficeAisle[] =>
    AISLE_ORDER.flatMap((kind) => {
      const aisle = desks.filter((desk) => desk.kind === kind).sort(compareDesks);
      return aisle.length === 0 ? [] : [{ kind, desks: aisle }];
    });

  const rooms: OfficeRoom[] = [
    ...projects.map((project) => ({ projectId: project.id, name: project.name })),
    { projectId: null, name: "No project" },
  ].flatMap(({ projectId, name }) => {
    const aisles = buildAisles(desksByProject.get(projectId) ?? []);
    return aisles.length === 0 ? [] : [{ projectId, name, aisles }];
  });

  const seated = rooms.flatMap((room) => room.aisles.flatMap((aisle) => aisle.desks));
  // A session records no time for when its Requests opened. The session is
  // active until a Request opens and then waits, so the oldest
  // `lastActivityAt` stands in for the longest wait.
  const queue = [
    ...seated.map((desk) => ({ id: desk.session.id, session: desk.session })),
    ...assistants.flatMap(({ id, session }) => (session === null ? [] : [{ id, session }])),
  ]
    .filter(({ session }) => session.openRequests.length > 0)
    .sort(
      (a, b) =>
        Date.parse(a.session.lastActivityAt) - Date.parse(b.session.lastActivityAt) ||
        compareText(a.id, b.id),
    )
    .map(({ id }) => id);
  const lounge = seated
    .filter((desk) => desk.pose === "idle" || desk.pose === "done")
    .map((desk) => desk.session.id);

  const secretariat = [...assistants].sort(compareAssistantRows);

  return { rooms, secretariat, queue, lounge };
};
