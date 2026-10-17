/**
 * The world the 3D Office draws: who works here, what each one is doing,
 * in which room, and on which machine. `build-world.ts` builds it from the
 * work in progress and the assistants.
 */
import type { OfficePose, OfficeRoom, Work, WorkKind } from "@hercule/client-core";
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
 * What a colleague is: a session doing a kind of work, a Thread, a run or
 * an Agent's, or an assistant.
 */
export type ColleagueKind = WorkKind | "assistant";

/** One colleague: a session at work, or an assistant. */
export interface Colleague {
  /**
   * A session sits with the rest of its work, in its project's room, or in
   * the café when the work has no project. An assistant has a corner in the
   * Secretariat, in every pose.
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
   * A Thread can be in any pose but `done`: it is seated until it is marked
   * Done. An Agent's session is never `asleep`, `away` or `done`: such a
   * session is no work in progress. A run's session can be in any pose but
   * `asleep` while its run is live; it is `done` once its step has
   * finished. An assistant is never `done`.
   */
  readonly pose: OfficePose;
  /** What the tag shows after the name: "typing", "idle". */
  readonly stateLabel: string;
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
  /**
   * When the session came into the Office, as an ISO 8601 time
   * (`decideArrivedAt`), or null for an assistant, which is always there.
   */
  readonly arrivedAt: string | null;
  /**
   * When the colleague's work ended, as an ISO 8601 time, for a colleague the
   * world holds only because it may still be walking out: only the world the
   * Office opens on holds one (`buildWorld` with `endedSince`). Null for
   * everyone else.
   */
  readonly leftAt: string | null;
}

/** One project's room: the work of the project, each piece at a group of seats. */
export interface ProjectRoom extends OfficeRoom {
  /** The room's id in the Office, unique among its rooms. */
  readonly id: string;
  readonly projectId: string;
  /** The project's tint, which inlays the room's floor. */
  readonly tint: ProjectTint;
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
   * The work with no project, which sits in the café across the street, in
   * seating order. Empty while the café is closed.
   */
  readonly cafe: ReadonlyArray<Work>;
  /** The ids of the assistants, in the order of their corners in the Secretariat. */
  readonly secretariat: ReadonlyArray<string>;
  /**
   * The ids of the colleagues with an open Request, in the order they queue
   * at the user's desk: the longest waiting first.
   */
  readonly queue: ReadonlyArray<string>;
  /**
   * The ids of the colleagues who rest in the Lounge (`isRestingPose`:
   * idle, done, asleep or away), in desk order. A colleague in the café rests in the café.
   */
  readonly lounge: ReadonlyArray<string>;
}
