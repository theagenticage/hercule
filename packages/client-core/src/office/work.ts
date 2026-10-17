/**
 * The work in progress, as the Office draws it: each piece of work and the
 * sessions doing it. A Thread is one piece of work with one session, a Run
 * is one piece of work with a session per agent step, and a session an
 * Agent spawned outside a run is one piece of work of its own.
 *
 * Work is how the Office reads the records the controller already serves;
 * the controller has no such record. Each kind of work has its own rule for
 * when it is over, and those rules live here and nowhere else.
 */
import type { Project, Resource, RunSummary, Runner, Session, Workspace } from "@hercule/contract";
import { decideGroupProjectId } from "../threads/groups";
import { decideThreadPose, isAbsentPose, type Pose, type SessionPose } from "../threads/pose";
import { isMarkedDone } from "../threads/status";

/**
 * The poses a session at work can show: every pose a session can be in, and
 * `done` for a run's session whose step has finished while the run goes on.
 */
export type OfficePose = SessionPose | "done";

/**
 * Where a session came from:
 *
 * - `thread`: a Thread, driven by hand;
 * - `run`: a run's agent step;
 * - `agent`: an Agent, outside any run and any assistant's conversation;
 * - `assistant`: an assistant's conversation.
 */
export type SessionOrigin = "thread" | "run" | "agent" | "assistant";

/** The kinds of work: a Thread, a Run, or an Agent's session outside a run. */
export type WorkKind = Exclude<SessionOrigin, "assistant">;

/** A session doing a piece of work, and the pose its character shows. */
export interface Worker {
  readonly session: Session;
  readonly pose: OfficePose;
}

/** One piece of work in progress, and the sessions doing it. */
export interface Work {
  readonly kind: WorkKind;
  /** The Thread's or the Agent's session id, or the run's id. */
  readonly id: string;
  /**
   * The project the work belongs to, or null for none. A run has no project
   * of its own, so it takes the one its workspace's repos share; see
   * `decideWorkProjectId`.
   */
  readonly projectId: string | null;
  /** When the work started, as an ISO 8601 time. Work is listed oldest first. */
  readonly startedAt: string;
  /** The sessions doing the work, oldest first. Never empty. */
  readonly workers: readonly Worker[];
}

/**
 * Checks whether a session in `pose` rests: it is idle, done with its step,
 * asleep or away. A resting session sits in the Lounge, unless it is in the
 * café, which rests its own at their tables. An asleep or away session
 * dozes there: the sidebar draws an asleep thread like an idle one, so the
 * Office rests both in the same room. An assistant never rests in the
 * Lounge: it keeps to its corner of the Secretariat.
 */
export const isRestingPose = (pose: OfficePose): boolean =>
  pose === "idle" || pose === "done" || isAbsentPose(pose);

/** Returns where `session` came from, from the fields that record its origin. */
const decideSessionOrigin = (session: Session): SessionOrigin => {
  if (session.agentId === null) return "thread";
  if (session.runId !== null) return "run";
  return session.conversationId === null ? "agent" : "assistant";
};

/** The poses an Agent's session outside a run is at work in. */
const AT_WORK_POSES: ReadonlySet<Pose> = new Set<Pose>(["working", "waiting", "idle"]);

/**
 * Checks whether a Thread whose pose is `pose` is work in progress;
 * `markedDone` says whether the user marked it Done. A Thread is at work
 * until it is marked Done, in any pose, so the Office seats every thread
 * the sidebar lists in a project. An asleep or away Thread is still work
 * the user has not finished. An asleep one's process ended, at a runner
 * restart for one, and the next message resumes it; an away one cannot be
 * reached until the user acts or its runner returns. Both rest in the
 * Lounge, as an idle one does (`isRestingPose`). A Done Thread
 * that waits on the user stays until it is answered, so the Office never
 * hides a Request.
 *
 * The sidebar and the Go menu ask this while the Office is open, to open a
 * thread in the Office's drawer or on its own screen, so they always agree
 * with `listLiveWork` about which threads are in the Office.
 */
export const isThreadSeated = (pose: Pose, markedDone: boolean): boolean =>
  !markedDone || pose === "waiting";

/**
 * Returns the pose of a session of a run's agent step:
 *
 * - an open Request makes it `waiting`;
 * - an exited session has finished its step, and is `done`. The session
 *   record does not say whether the step succeeded, so `done` only means
 *   the session has stopped working;
 * - otherwise its pose is a thread's (`decideThreadPose`).
 */
const decideRunWorkerPose = (session: Session, runner: Runner | undefined): OfficePose => {
  if (session.openRequests.length > 0) return "waiting";
  if (session.status === "exited") return "done";
  return decideThreadPose(session, runner);
};

/**
 * Returns the project a piece of work belongs to, from its first session,
 * or null for none. Only a project in `projects` counts.
 *
 * - A Thread, or any session with a project of its own, belongs to that
 *   project. A project that is not listed counts as none, as in the sidebar.
 * - A run's session has no project, so the work belongs to the project that
 *   every repo of the session's workspace belongs to; the first in
 *   `projects` when several do, so the answer is the same at every read.
 * - No workspace, a workspace missing from `workspaces`, a workspace with no
 *   checkout, or repos that share no project: none.
 */
const decideWorkProjectId = (
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

/** Compares two strings by their UTF-16 code units, the same way in every locale. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Compares two sessions by age, oldest first; sessions created in the same instant by id. */
const compareAge = (a: Session, b: Session): number =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || compareText(a.id, b.id);

/**
 * Returns the work in progress, oldest first; work that started in the same
 * instant is told apart by id, so the order never depends on the order of
 * `sessions`. Each kind of work has its own rule for when it is over:
 *
 * - A Thread is at work while `isThreadSeated` holds: until it is marked
 *   Done, in any pose.
 * - A Run is at work while it is in `liveRuns`, with every session its
 *   agent steps started, in any pose. A session whose step has finished is
 *   `done`. When the run ends, its sessions all leave together.
 * - An Agent's session outside a run is at work while it is working,
 *   waiting or idle. It cannot be marked Done, so it is over when it exits.
 * - An assistant's session is no work: the assistant is always there.
 */
export const listLiveWork = ({
  sessions,
  liveRuns,
  projects,
  workspaces,
  resources,
  runners,
}: {
  /**
   * The sessions to read the work from, each once: Threads, Agents'
   * sessions, and the sessions of the live runs, exited ones included.
   */
  readonly sessions: readonly Session[];
  /** The runs that are pending or running. */
  readonly liveRuns: readonly RunSummary[];
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
}): Work[] => {
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const runsById = new Map(liveRuns.map((run) => [run.id, run]));
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  const decideProjectId = (session: Session) =>
    decideWorkProjectId(session, projects, workspacesById, resourcesById);

  const work: Work[] = [];
  const runWorkers = new Map<string, Worker[]>();
  for (const session of sessions) {
    const runner = runnersById.get(session.runnerId);
    switch (decideSessionOrigin(session)) {
      case "thread": {
        const pose = decideThreadPose(session, runner);
        if (!isThreadSeated(pose, isMarkedDone(session))) break;
        work.push({
          kind: "thread",
          id: session.id,
          projectId: decideProjectId(session),
          startedAt: session.createdAt,
          workers: [{ session, pose }],
        });
        break;
      }
      case "agent": {
        const pose = decideThreadPose(session, runner);
        if (!AT_WORK_POSES.has(pose)) break;
        work.push({
          kind: "agent",
          id: session.id,
          projectId: decideProjectId(session),
          startedAt: session.createdAt,
          workers: [{ session, pose }],
        });
        break;
      }
      case "run": {
        if (session.runId === null || !runsById.has(session.runId)) break;
        const worker = { session, pose: decideRunWorkerPose(session, runner) };
        const workers = runWorkers.get(session.runId);
        if (workers === undefined) runWorkers.set(session.runId, [worker]);
        else workers.push(worker);
        break;
      }
      case "assistant":
        break;
    }
  }
  for (const [runId, workers] of runWorkers) {
    workers.sort((a, b) => compareAge(a.session, b.session));
    work.push({
      kind: "run",
      id: runId,
      projectId: decideProjectId(workers[0]!.session),
      startedAt: runsById.get(runId)!.createdAt,
      workers,
    });
  }
  return work.sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || compareText(a.id, b.id),
  );
};
