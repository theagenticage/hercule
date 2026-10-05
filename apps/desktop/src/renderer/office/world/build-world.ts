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
  type SeatedPose,
} from "@hercule/client-core";
import { buildLook } from "../../faces/look";
import { pickProjectTint } from "../../screens/project-tile";
import type { Colleague, OfficeRequest, World } from "./types";

/** Every list the world is built from. */
interface WorldRecords {
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
 * one-line question the sidebar's Waiting on you row shows, and since when
 * the thread has waited. The thread's last activity stands in for when the
 * request opened, which the session record does not hold.
 */
function buildOfficeRequest(request: OpenRequest, lastActivityAt: string): OfficeRequest {
  const card = buildApprovalCard(request);
  return {
    kind: request.kind === "question" ? "question" : "command",
    short: formatRequestQuestion(request),
    prompt: card.subject.join("\n"),
    answers: card.rows.map((row) => row.label),
    waitingSince: lastActivityAt,
  };
}

/** Returns the colleague the Office draws for a seated thread in `pose`. */
function buildColleague(session: Session, pose: SeatedPose): Colleague {
  // A thread with several open Requests shows the oldest.
  const oldestRequest = session.openRequests[0] ?? null;
  return {
    id: session.id,
    name: session.title,
    look: { ...buildLook(session.id), headwear: null },
    pose,
    stateLabel: describePose(pose),
    project: session.projectId,
    runnerId: session.runnerId,
    model: session.modelSelection.model,
    request:
      oldestRequest === null ? null : buildOfficeRequest(oldestRequest, session.lastActivityAt),
    oldestRequest,
  };
}

/**
 * Returns the world the Office draws for `records`: one colleague per
 * seated thread, one room per project with a seated thread, in the seating's
 * order, every runner, the queue of colleagues waiting on the user, and the
 * idle colleagues the Lounge seats.
 */
export function buildWorld(records: WorldRecords): World {
  const seating = decideOfficeSeating(records);
  return {
    colleagues: seating.rooms.flatMap((room) =>
      room.desks.map((desk) => buildColleague(desk.session, desk.pose)),
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
    queue: seating.queue,
    lounge: seating.lounge,
  };
}

/**
 * Returns a key that changes whenever `world` needs another building: a room,
 * a desk, a name or a runner changed. A colleague's pose, label and request
 * are left out, because the built office plays those without a rebuild.
 * Two worlds with the same key build the same office.
 */
export function computeDeskKey(world: World): string {
  return JSON.stringify([
    world.rooms.map((room) => [room.id, room.name, room.tint, room.colleagueIds]),
    // The Lobby's directory counts the colleagues on each runner.
    world.colleagues.map((colleague) => [colleague.id, colleague.name, colleague.runnerId]),
    world.runners.map((runner) => [runner.id, runner.name, runner.slots]),
  ]);
}

/**
 * Checks whether two versions of a colleague are in the same state: the same
 * pose, label, and request in every field. The built office moves a colleague
 * into its new state only when this is false, so a field left out here would
 * leave the Office showing the older value.
 */
export function isSameColleagueState(a: Colleague, b: Colleague): boolean {
  return a.pose === b.pose && a.stateLabel === b.stateLabel && isSameRequest(a.request, b.request);
}

/** Checks whether two requests are equal in every field. */
function isSameRequest(a: OfficeRequest | null, b: OfficeRequest | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.kind === b.kind &&
    a.short === b.short &&
    a.prompt === b.prompt &&
    a.answers.length === b.answers.length &&
    a.answers.every((answer, index) => answer === b.answers[index]) &&
    a.waitingSince === b.waitingSince
  );
}
