/**
 * The world the 3D Office draws: who works here, what each one is doing,
 * in which room, and on which machine. `build-world.ts` builds it from the
 * user's sessions, live runs and assistants.
 */
import type { OfficePose, OfficeSessionKind } from "@hercule/client-core";
import type { OpenRequest } from "@hercule/contract";
import type { Look } from "../../faces/look";
import type { ProjectTint } from "../../screens/project-tile";

/** A question a colleague waits on the user to answer. */
export interface OfficeRequest {
  /** A command approval shows the command; a question shows its text. */
  readonly kind: "command" | "question";
  /** The short form, as the name tag's speech bubble shows it: "Run git push?". */
  readonly short: string;
  /** The full prompt: the command, or the question. */
  readonly prompt: string;
  /** The answers, the suggested one first. */
  readonly answers: ReadonlyArray<string>;
  /**
   * When the colleague started waiting on the user, as an ISO 8601 time. The
   * session records no time for when its Request opened, so the thread's last
   * activity stands in for it.
   */
  readonly waitingSince: string;
}

/**
 * What a colleague is: a session's, of one of the kinds `OfficeSessionKind`
 * names, or an assistant.
 */
export type ColleagueKind = OfficeSessionKind | "assistant";

/** One colleague: a session at a desk, or an assistant. */
export interface Colleague {
  /**
   * A session has a desk on its kind's aisle of its project's room, or in
   * the café when it has no project, while `decideOfficeSeating` seats it.
   * An assistant has a corner in the Secretariat, in every pose.
   */
  readonly kind: ColleagueKind;
  /** The session's id, or the assistant's id for an assistant. */
  readonly id: string;
  /**
   * The id of the session the colleague's Requests belong to: its own id,
   * or the assistant's current session, or null while an assistant has none.
   * Answers to a Request are sent to this session.
   */
  readonly sessionId: string | null;
  /**
   * The short name the Office's tag shows: the session's title, which for an
   * agent step names its workflow and step, or the assistant's name.
   */
  readonly name: string;
  readonly look: Look;
  /**
   * A Thread and another Agent's session are never `asleep`, `away` or
   * `done`: such a session has no colleague. An agent step's session can be
   * in any pose but `asleep` while its run is live; it is `done` once its
   * step has finished. An assistant is never `done`.
   */
  readonly pose: OfficePose;
  /** What the tag shows after the name: "typing", "idle". */
  readonly stateLabel: string;
  /**
   * The run whose agent step the session runs, or null for any other
   * colleague. A run's sessions share a table in the café.
   */
  readonly runId: string | null;
  /** The runner the session runs on, or null before it is placed or while an assistant has no session. */
  readonly runnerId: string | null;
  /** The model's display name, or null when it is not known. */
  readonly model: string | null;
  /** The request as the Office's tag and queue show it, or null. */
  readonly request: OfficeRequest | null;
  /**
   * The oldest of the session's open Requests, which the dossier card
   * answers, or null when nothing waits on the user.
   */
  readonly oldestRequest: OpenRequest | null;
  /**
   * When an assistant's current session was last active, as an ISO 8601
   * time, or null for a session and for an assistant with no session.
   */
  readonly lastActivityAt: string | null;
}

/** One aisle of a room: the desks of one kind of session. */
export interface RoomAisle {
  readonly kind: OfficeSessionKind;
  /** The ids of the colleagues with a desk on the aisle, in desk order. Never empty. */
  readonly colleagueIds: ReadonlyArray<string>;
}

/** One project's room, with the desks of the sessions that belong to the project. */
export interface ProjectRoom {
  /** The room's id in the Office, unique among its rooms. */
  readonly id: string;
  readonly projectId: string;
  /** The name on the plaque: the project's name. */
  readonly name: string;
  /** The project's tint, which inlays the room's floor. */
  readonly tint: ProjectTint;
  /** The room's aisles: threads, then agent steps, then other Agents' sessions. Never empty. */
  readonly aisles: ReadonlyArray<RoomAisle>;
}

/** One machine of the fleet. */
interface RunnerInfo {
  readonly id: string;
  readonly name: string;
  readonly slots: number;
  /** The runner on this Mac. */
  readonly local: boolean;
}

/** Everything the Office draws. */
export interface World {
  readonly colleagues: ReadonlyArray<Colleague>;
  readonly runners: ReadonlyArray<RunnerInfo>;
  /** The project rooms, in the order they fill the wings. */
  readonly rooms: ReadonlyArray<ProjectRoom>;
  /**
   * The aisles of the sessions with no project, which sit in the café across
   * the street, in the same order as a project room's. Empty while the café
   * is closed.
   */
  readonly cafe: ReadonlyArray<RoomAisle>;
  /** The ids of the assistants, in the order of their corners in the Secretariat. */
  readonly secretariat: ReadonlyArray<string>;
  /**
   * The ids of the colleagues with an open Request, in the order they queue
   * at the user's desk: the longest waiting first.
   */
  readonly queue: ReadonlyArray<string>;
  /**
   * The ids of the colleagues who rest in the Lounge, idle or done, in desk
   * order. A colleague in the café rests in the café.
   */
  readonly lounge: ReadonlyArray<string>;
}
