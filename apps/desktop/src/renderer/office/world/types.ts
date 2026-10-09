/**
 * The world the 3D Office draws: who works here, what each one is doing,
 * in which room, and on which machine. `build-world.ts` builds it from the
 * user's threads and assistants.
 */
import type { SessionPose } from "@hercule/client-core";
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

/** One colleague: a thread's agent, or an assistant. */
export interface Colleague {
  /**
   * A thread has a desk in its project's room while it is working, waiting
   * or idle. An assistant has a corner in the Secretariat, in every pose.
   */
  readonly kind: "thread" | "assistant";
  /** The session's id for a thread, the assistant's id for an assistant. */
  readonly id: string;
  /**
   * The id of the session the colleague's Requests belong to: the thread's
   * own id, or the assistant's current session, or null while an assistant
   * has none. Answers to a Request are sent to this session.
   */
  readonly sessionId: string | null;
  /** The short name the Office's tag shows: the thread's title, or the assistant's name. */
  readonly name: string;
  readonly look: Look;
  /** Only an assistant is ever `asleep` or `away`: such a thread has no colleague. */
  readonly pose: SessionPose;
  /** What the tag shows after the name: "typing", "idle". */
  readonly stateLabel: string;
  /** The id of the project the thread belongs to, or null. Always null for an assistant. */
  readonly project: string | null;
  /** The runner the session runs on, or null before it is placed or while an assistant has no session. */
  readonly runnerId: string | null;
  /** The model's display name, or null when it is not known. */
  readonly model: string | null;
  /** The request as the Office's tag and queue show it, or null. */
  readonly request: OfficeRequest | null;
  /**
   * The oldest of the thread's open Requests, which the dossier card
   * answers, or null when nothing waits on the user.
   */
  readonly oldestRequest: OpenRequest | null;
  /**
   * When an assistant's current session was last active, as an ISO 8601
   * time, or null for a thread and for an assistant with no session.
   */
  readonly lastActivityAt: string | null;
}

/** One room of threads: a project's, or the one the threads with no project share. */
export interface ThreadRoom {
  /** The room's id in the Office, unique among its rooms. */
  readonly id: string;
  /** The project's id, or null for the threads with no project. */
  readonly projectId: string | null;
  /** The name on the plaque: the project's name, or "No project". */
  readonly name: string;
  /** The project's tint, which inlays the room's floor, or null for no project. */
  readonly tint: ProjectTint | null;
  /** The ids of the colleagues with a desk in the room, in desk order. */
  readonly colleagueIds: ReadonlyArray<string>;
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
  /** The thread rooms, in the order they fill the wings. */
  readonly rooms: ReadonlyArray<ThreadRoom>;
  /** The ids of the assistants, in the order of their corners in the Secretariat. */
  readonly secretariat: ReadonlyArray<string>;
  /**
   * The ids of the colleagues with an open Request, in the order they queue
   * at the user's desk: the longest waiting first.
   */
  readonly queue: ReadonlyArray<string>;
  /** The ids of the colleagues who sit in the Lounge: the idle ones, in desk order. */
  readonly lounge: ReadonlyArray<string>;
}
