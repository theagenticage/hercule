/**
 * The world the 3D Office draws: who works here, what each one is doing,
 * in which room, and on which machine. `build-world.ts` builds it from the
 * user's threads.
 */
import type { OpenRequest } from "@hercule/contract";
import type { Accessory, Hue, Shape } from "../../faces/look";
import type { ProjectTint } from "../../screens/project-tile";

/** What a colleague is doing, drawn as a pose. The eight poses of the Bureau book. */
export type Pose =
  "working" | "waiting" | "idle" | "asleep" | "paused" | "failed" | "done" | "away";

/** The headwear only assistants wear. */
export type Headwear = "cloche" | "headset" | "beret";

/** Whether a colleague is a thread's agent, an assistant, or the Triage workflow. */
export type Role = "session" | "assistant" | "triage";

/** What a colleague looks like: its crew hue, body shape and what it wears. */
export interface CrewLook {
  readonly hue: Hue;
  readonly shape: Shape;
  readonly accessories: ReadonlyArray<Accessory>;
  readonly headwear: Headwear | null;
}

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
  /** Minutes the request has waited. */
  readonly waitingMinutes: number;
}

/** One colleague: a thread's agent. */
export interface Colleague {
  /** The session's id. */
  readonly id: string;
  /** The short name the Office's tag shows. */
  readonly name: string;
  /** The thread's full title. */
  readonly title: string;
  readonly role: Role;
  readonly look: CrewLook;
  readonly pose: Pose;
  /** What the tag shows after the name: "typing", "idle". */
  readonly stateLabel: string;
  /** The id of the project the thread belongs to, or null. */
  readonly project: string | null;
  /** The runner the session runs on, or null before it is placed. */
  readonly runnerId: string | null;
  /** The model's display name, or null when it is not known. */
  readonly model: string | null;
  /** What the colleague did last, oldest first: one line each. */
  readonly activity: ReadonlyArray<string>;
  /** The request as the Office's tag and queue show it, or null. */
  readonly request: OfficeRequest | null;
  /** The thread's open Request, which the dossier card answers, or null. */
  readonly openRequest: OpenRequest | null;
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
export interface RunnerInfo {
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
  /** The ids of the colleagues who sit in the Lounge: the idle ones, in desk order. */
  readonly lounge: ReadonlyArray<string>;
}
