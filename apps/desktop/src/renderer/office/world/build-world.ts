/**
 * Builds the world the Office draws from the records the sidebar reads too.
 * Who sits where comes from `decideOfficeSeating` in client-core; this file
 * only turns each seated thread into the colleague the scene draws.
 */
import type { OpenRequest, Project, Runner, Session, Workspace } from "@hercule/contract";
import {
  buildApprovalCard,
  decideOfficeSeating,
  describePose,
  formatRequestQuestion,
} from "@hercule/client-core";
import { buildLook } from "../../faces/look";
import { pickProjectTint } from "../../screens/project-tile";
import type { Colleague, OfficeRequest, Pose, World } from "./types";

/** Every list the world is built from. */
export interface WorldRecords {
  readonly sessions: readonly Session[];
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  readonly runners: readonly Runner[];
  /** The id of the runner on this Mac, or null when it has none. */
  readonly localRunnerId: string | null;
}

/** The id of the room the threads with no project share. */
const NO_PROJECT_ROOM_ID = "no-project";

/**
 * Returns the request a waiting colleague's tag and the queue read: the
 * one-line question the sidebar's Waiting on you row shows, and how many
 * minutes the thread has waited. The thread's last activity stands in for
 * when the request opened, which the session record does not hold.
 */
function buildOfficeRequest(
  request: OpenRequest,
  lastActivityAt: string,
  now: number,
): OfficeRequest {
  const card = buildApprovalCard(request);
  return {
    kind: request.kind === "question" ? "question" : "command",
    short: formatRequestQuestion(request),
    prompt: card.subject.join("\n"),
    answers: card.rows.map((row) => row.label),
    waitingMinutes: Math.max(0, Math.floor((now - Date.parse(lastActivityAt)) / 60_000)),
  };
}

/** Returns the colleague the Office draws for a seated thread in `pose`. */
function buildColleague(session: Session, pose: Pose, now: number): Colleague {
  return {
    id: session.id,
    name: session.title,
    title: session.title,
    role: "session",
    look: { ...buildLook(session.id), headwear: null },
    pose,
    stateLabel: describePose(pose),
    project: session.projectId,
    runnerId: session.runnerId,
    model: session.modelSelection.model,
    activity: [],
    request:
      session.openRequest === null
        ? null
        : buildOfficeRequest(session.openRequest, session.lastActivityAt, now),
    openRequest: session.openRequest,
  };
}

/**
 * Returns the world the Office draws for `records` at time `now`, in
 * milliseconds since the epoch: one colleague per seated thread, one room
 * per project with a seated thread, in the seating's order, and every
 * runner.
 */
export function buildWorld(records: WorldRecords, now: number): World {
  const seating = decideOfficeSeating(records);
  return {
    colleagues: seating.rooms.flatMap((room) =>
      room.desks.map((desk) => buildColleague(desk.session, desk.pose, now)),
    ),
    runners: records.runners.map((runner) => ({
      id: runner.id,
      name: runner.name,
      slots: runner.maxConcurrentSessions,
      local: runner.id === records.localRunnerId,
    })),
    rooms: seating.rooms.map((room) => ({
      id: room.projectId === null ? NO_PROJECT_ROOM_ID : `project-${room.projectId}`,
      projectId: room.projectId,
      name: room.name,
      tint: room.projectId === null ? null : pickProjectTint(room.projectId, records.projects),
      colleagueIds: room.desks.map((desk) => desk.session.id),
    })),
  };
}
