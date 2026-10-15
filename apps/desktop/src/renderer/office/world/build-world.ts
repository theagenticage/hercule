/**
 * Builds the world the Office draws from the records the sidebar and the
 * workflow list read too. Who sits where comes from `decideOfficeSeating` in
 * client-core; this file only turns each seated session and each assistant
 * into the colleague the scene draws, and puts the sessions with no project
 * in the café.
 */
import type {
  OpenRequest,
  Project,
  Resource,
  RunSummary,
  Runner,
  Session,
  Workspace,
} from "@hercule/contract";
import {
  type AssistantRow,
  buildApprovalCard,
  decideOfficeSeating,
  describePose,
  findOldestOpenRequest,
  formatRequestQuestion,
  type OfficeAisle,
  type OfficeDesk,
} from "@hercule/client-core";
import { buildAssistantLook, buildSessionLook } from "../../faces/look";
import { pickProjectTint } from "../../screens/project-tile";
import type { Colleague, OfficeRequest, RoomAisle, World } from "./types";

/** Every list the world is built from. */
interface WorldRecords {
  /** Threads, Agents' sessions and the sessions of the live runs, each once. */
  readonly sessions: readonly Session[];
  /** The runs that are pending or running. */
  readonly liveRuns: readonly RunSummary[];
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
  /** The sidebar's assistant rows, sorted by name. */
  readonly assistants: readonly AssistantRow[];
  /** The id of the runner on this Mac, or null when it has none. */
  readonly localRunnerId: string | null;
}

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

/** Returns the colleague the Office draws for a session at its desk. */
function buildSessionColleague({ session, kind, pose }: OfficeDesk): Colleague {
  const oldestRequest = findOldestOpenRequest(session);
  return {
    kind,
    id: session.id,
    sessionId: session.id,
    name: session.title,
    look: buildSessionLook(session.id, kind),
    pose,
    stateLabel: describePose(pose),
    runId: session.runId,
    runnerId: session.runnerId,
    model: session.modelSelection.model,
    request:
      oldestRequest === null ? null : buildOfficeRequest(oldestRequest, session.lastActivityAt),
    oldestRequest,
    lastActivityAt: null,
  };
}

/**
 * Returns the colleague the Office draws for an assistant. Its runner,
 * model, Request and last activity are its current session's, and absent
 * while it has none.
 */
function buildAssistantColleague({ id, name, pose, session }: AssistantRow): Colleague {
  const oldestRequest = session === null ? null : findOldestOpenRequest(session);
  return {
    kind: "assistant",
    id,
    sessionId: session?.id ?? null,
    name,
    look: buildAssistantLook(id),
    pose,
    stateLabel: describePose(pose),
    runId: null,
    runnerId: session?.runnerId ?? null,
    model: session?.modelSelection.model ?? null,
    request:
      session === null || oldestRequest === null
        ? null
        : buildOfficeRequest(oldestRequest, session.lastActivityAt),
    oldestRequest,
    lastActivityAt: session?.lastActivityAt ?? null,
  };
}

/** Returns the ids of each aisle's colleagues, in desk order. */
function buildRoomAisles(aisles: readonly OfficeAisle[]): RoomAisle[] {
  return aisles.map((aisle) => ({
    kind: aisle.kind,
    colleagueIds: aisle.desks.map((desk) => desk.session.id),
  }));
}

/**
 * Returns the world the Office draws for `records`: one colleague per
 * seated session and per assistant, one room per project with a seated
 * session, in the seating's order, the café's aisles of the sessions with no
 * project, the assistants in the Secretariat's order, every runner, the
 * queue of colleagues waiting on the user, and the resting sessions the
 * Lounge seats. A colleague in the café rests in the café, so the Lounge
 * leaves it out.
 */
export function buildWorld(records: WorldRecords): World {
  const seating = decideOfficeSeating(records);
  const projectRooms = seating.rooms.flatMap((room) =>
    room.projectId === null ? [] : [{ ...room, projectId: room.projectId }],
  );
  const cafeAisles = seating.rooms.find((room) => room.projectId === null)?.aisles ?? [];
  const inCafe = new Set(cafeAisles.flatMap((aisle) => aisle.desks.map((desk) => desk.session.id)));
  return {
    colleagues: [
      ...seating.rooms.flatMap((room) =>
        room.aisles.flatMap((aisle) => aisle.desks.map(buildSessionColleague)),
      ),
      ...seating.secretariat.map(buildAssistantColleague),
    ],
    runners: records.runners.map((runner) => ({
      id: runner.id,
      name: runner.name,
      slots: runner.maxConcurrentSessions,
      local: runner.id === records.localRunnerId,
    })),
    rooms: projectRooms.map((room) => ({
      id: `project-${room.projectId}`,
      projectId: room.projectId,
      name: room.name,
      tint: pickProjectTint(room.projectId, records.projects),
      aisles: buildRoomAisles(room.aisles),
    })),
    cafe: buildRoomAisles(cafeAisles),
    secretariat: seating.secretariat.map((assistant) => assistant.id),
    queue: seating.queue,
    lounge: seating.lounge.filter((id) => !inCafe.has(id)),
  };
}

/**
 * Returns a key that changes whenever `world` needs another building: a room,
 * an aisle, a desk, a café table, an assistant's corner, a name or a runner
 * changed. A colleague's pose, label and request are left out, because the
 * built office plays those without a rebuild. Two worlds with the same key
 * build the same office.
 */
export function computeDeskKey(world: World): string {
  return JSON.stringify([
    world.rooms.map((room) => [room.id, room.name, room.tint, room.aisles]),
    world.cafe,
    world.secretariat,
    // The Lobby's directory counts the sessions on each runner. An
    // assistant's runner is left out: it changes with each new session,
    // and the building need not change with it. A run's sessions share a
    // café table, so a session's run is part of the building.
    world.colleagues.map((colleague) => [
      colleague.id,
      colleague.name,
      colleague.kind === "assistant" ? null : colleague.runnerId,
      colleague.runId,
    ]),
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
