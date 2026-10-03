/**
 * PROTOTYPE - the world the 3D office draws: who works here, what each one is
 * doing, and on which machine. Every variant reads the same world, so the
 * variants differ in layout and navigation, never in data.
 */
import type { Accessory, Hue, Shape } from "../../faces/look";

/** What a colleague is doing, drawn as a pose. The eight poses of the Bureau book. */
export type Pose =
  "working" | "waiting" | "idle" | "asleep" | "paused" | "failed" | "done" | "away";

/** The headwear only the three assistants wear. */
export type Headwear = "cloche" | "headset" | "beret";

/** The three projects of the fixture world, plus the extra ones the larger fleets add. */
export type ProjectKey = "webshop" | "payments-api" | "ops";

/** Whether a colleague is a thread's agent, an assistant, or the Triage workflow. */
export type Role = "session" | "assistant" | "triage";

/**
 * Where a colleague's work belongs: an area of a project's code, or a kind of
 * work that is not about one area (the meta rooms).
 */
export type Area =
  // webshop
  | "checkout"
  | "cart"
  // payments-api
  | "webhooks"
  | "payouts"
  // ops
  | "infra"
  | "dashboards"
  | "secrets"
  // meta rooms
  | "research"
  | "review"
  | "release"
  | "correspondence"
  | "triage"
  | "assistants";

/** The project each code area belongs to. Meta areas belong to none. */
export const AREA_PROJECT: Readonly<Record<Area, ProjectKey | null>> = {
  checkout: "webshop",
  cart: "webshop",
  webhooks: "payments-api",
  payouts: "payments-api",
  infra: "ops",
  dashboards: "ops",
  secrets: "ops",
  research: null,
  review: null,
  release: null,
  correspondence: null,
  triage: null,
  assistants: null,
};

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
  /** The short form, as the waiting row and the speech bubble show it: "Run git push?". */
  readonly short: string;
  /** The full prompt: the command, or the question. */
  readonly prompt: string;
  /** The answers, the suggested one first. */
  readonly answers: ReadonlyArray<string>;
  /** Minutes the request has waited. */
  readonly waitingMinutes: number;
}

/** One colleague: a live session's agent, an assistant, or Triage. */
export interface Colleague {
  readonly id: string;
  /** The short name the office's tag shows: "Refactor cart totals", "Ada". */
  readonly name: string;
  /** The thread's full title. */
  readonly title: string;
  readonly role: Role;
  readonly look: CrewLook;
  readonly pose: Pose;
  /** What the tag shows after the name: "22m", "idle 20m", "heartbeat", "paused". */
  readonly stateLabel: string;
  readonly project: ProjectKey | null;
  readonly area: Area;
  /** The runner the session runs on; null for Triage and Juno, which hold no session. */
  readonly runnerId: string | null;
  /** The model's display name, or null for one that runs none. */
  readonly model: string | null;
  /** What the colleague did last, oldest first: one line each, as a status ticker shows them. */
  readonly activity: ReadonlyArray<string>;
  readonly request: OfficeRequest | null;
  /** The id of the thread fixture whose transcript the thread drawer shows, when one exists. */
  readonly threadId: string | null;
}

/** One machine of the fleet. */
export interface RunnerInfo {
  readonly id: string;
  readonly name: string;
  readonly slots: number;
  /** The runner on this Mac. */
  readonly local: boolean;
}

/** Everything the office draws. */
export interface World {
  readonly colleagues: ReadonlyArray<Colleague>;
  readonly runners: ReadonlyArray<RunnerInfo>;
  readonly projects: ReadonlyArray<ProjectKey>;
  /** Proposals pinned on the case board, and how many of them burn. */
  readonly proposals: { readonly total: number; readonly burning: number };
  /** Open Tasks in the filing cabinets. */
  readonly openTasks: number;
  /** When Triage last ran and next runs, as the tag shows them. */
  readonly triage: { readonly lastRun: string; readonly nextRun: string };
}

/** The fleet sizes the controls offer. */
export type FleetSize = "today" | "growing" | "ten-x";
