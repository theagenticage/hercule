/**
 * Where each colleague sits in the Office: each piece of work in progress
 * at a group of seats in its project's room, each assistant at its corner of
 * the Secretariat, the queue at the user's desk while either has an open
 * Request, and the Lounge while a session rests.
 */
import type { Project, Workspace } from "@hercule/contract";
import { compareAssistantRows, type AssistantRow } from "../assistants/rows";
import { rankLane } from "../threads/groups";
import type { Work } from "./work";

export interface OfficeRoom {
  /**
   * The project the room belongs to, or null for the one room the work with
   * no project shares.
   */
  readonly projectId: string | null;
  /** The project's name, or "No project". */
  readonly name: string;
  /** The work that sits in the room, each piece at a group of seats, in seating order. Never empty. */
  readonly work: readonly Work[];
}

export interface OfficeSeating {
  readonly rooms: readonly OfficeRoom[];
  /**
   * Every assistant, in the order of its corner in the Secretariat: the
   * sidebar's order, by name (see `compareAssistantRows`).
   */
  readonly secretariat: readonly AssistantRow[];
  /**
   * The ids of the sessions and the assistants with an open Request, in
   * queue order: waiting longest first.
   */
  readonly queue: readonly string[];
  /** The ids of the sessions that rest, idle or done, in seating order. */
  readonly lounge: readonly string[];
}

/** Compares two strings by their UTF-16 code units, the same way in every locale. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Returns where each piece of work and each assistant sits in the Office.
 *
 * - Each project with work in progress has a room, in the order of
 *   `projects`. The work with no project shares one room, which comes last.
 * - Rooms are not sorted by latest activity, as the sidebar's projects are.
 *   A room is a place in a 3D scene, and a place that moves whenever a
 *   thread works would leave the user unable to find anything.
 * - Inside a room, each piece of work sits together. Work in the same
 *   working copy sits side by side, the working copies in the sidebar's
 *   order (see `rankLane`), and inside a working copy the oldest work comes
 *   first, so a group keeps its place when new work starts.
 * - Every assistant has a corner in the Secretariat, whatever its pose, in
 *   the sidebar's order, by name, whatever the order of `assistants`.
 * - `queue` holds the sessions and assistants with an open Request, waiting
 *   longest first. An assistant is queued by its own id.
 * - `lounge` holds the sessions that rest, idle or done. An idle assistant
 *   stays at its desk in the Secretariat.
 */
export const decideOfficeSeating = ({
  work,
  projects,
  workspaces,
  assistants,
}: {
  /** The work in progress, from `listLiveWork`. */
  readonly work: readonly Work[];
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  /** The sidebar's assistant rows, from `buildAssistantRows`. */
  readonly assistants: readonly AssistantRow[];
}): OfficeSeating => {
  const findWorkspaceId = (piece: Work): string | null => piece.workers[0]!.session.workspaceId;
  // Working copies of equal rank, such as two main workspaces, are told
  // apart by id so that each keeps its work together.
  const seated = [...work].sort(
    (a, b) =>
      rankLane(findWorkspaceId(a), workspaces) - rankLane(findWorkspaceId(b), workspaces) ||
      compareText(findWorkspaceId(a) ?? "", findWorkspaceId(b) ?? "") ||
      Date.parse(a.startedAt) - Date.parse(b.startedAt) ||
      compareText(a.id, b.id),
  );
  const rooms: OfficeRoom[] = [
    ...projects.map((project) => ({ projectId: project.id, name: project.name })),
    { projectId: null, name: "No project" },
  ].flatMap(({ projectId, name }) => {
    const roomWork = seated.filter((piece) => piece.projectId === projectId);
    return roomWork.length === 0 ? [] : [{ projectId, name, work: roomWork }];
  });

  const workers = rooms.flatMap((room) => room.work.flatMap((piece) => piece.workers));
  // A session records no time for when its Requests opened. The session is
  // active until a Request opens and then waits, so the oldest
  // `lastActivityAt` stands in for the longest wait.
  const queue = [
    ...workers.map(({ session }) => ({ id: session.id, session })),
    ...assistants.flatMap(({ id, session }) => (session === null ? [] : [{ id, session }])),
  ]
    .filter(({ session }) => session.openRequests.length > 0)
    .sort(
      (a, b) =>
        Date.parse(a.session.lastActivityAt) - Date.parse(b.session.lastActivityAt) ||
        compareText(a.id, b.id),
    )
    .map(({ id }) => id);
  const lounge = workers
    .filter((worker) => worker.pose === "idle" || worker.pose === "done")
    .map((worker) => worker.session.id);

  const secretariat = [...assistants].sort(compareAssistantRows);

  return { rooms, secretariat, queue, lounge };
};
