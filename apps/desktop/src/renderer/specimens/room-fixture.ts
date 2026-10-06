/**
 * The Office as the first run furnishes it, one room per step: the rooms the
 * Bureau book's desktop/first-run.html draws in variant B, where the room
 * fills the window. The book's `world()` reads the same flags from the
 * prototype's state: Hercule runs on this Mac (studio-mac), both providers
 * are ready, and GitHub is connected as rogier.
 */
import type { RoomContents } from "@hercule/client-core";
import { buildProject } from "@hercule/client-core/threads/testing";
import type { Project } from "@hercule/contract";
import type { RoomShot } from "../screens/office";
import type { RoomStepName } from "./room-steps";

/** The room a step of the first run shows, and the shot that frames it. */
export interface RoomStep {
  readonly shot: RoomShot;
  readonly contents: RoomContents;
}

/** The one project the first run adds. As the first project, it takes the first tint, webshop's. */
export const ROOM_PROJECTS: readonly Project[] = [buildProject("p-webshop", "webshop")];

/** The room on the welcome page, before Hercule on this Mac has answered: the office is closed. */
const CLOSED: RoomContents = {
  lightsOn: false,
  wing: null,
  yourDesk: false,
  assistant: null,
  triage: null,
  gitHubAccount: null,
};

/** The runner's wing on this Mac, before its desks are set out. */
const WING = { runnerName: "studio-mac", note: "this Mac", deskCount: 0, firstThread: null };

const ACCOUNT: RoomContents = { ...CLOSED, lightsOn: true, wing: WING };
/** Hercule, with the id the first-run fixture gives it, so both specimens draw the same face. */
const HERCULE = { id: "01a06d02-a000-7000-8000-000000000001", name: "Hercule" };
const PROVIDERS: RoomContents = { ...ACCOUNT, yourDesk: true, assistant: HERCULE };
/** The same wing once studio-mac's six desks are set out. */
const FURNISHED_WING = { ...WING, note: "this Mac · 6 desks", deskCount: 6 };

const GITHUB: RoomContents = { ...PROVIDERS, wing: FURNISHED_WING };
const PROJECT: RoomContents = {
  ...GITHUB,
  triage: { note: "reads GitHub" },
  gitHubAccount: "rogier",
};
const DONE: RoomContents = {
  ...PROJECT,
  wing: { ...FURNISHED_WING, firstThread: { projectId: "p-webshop", projectName: "webshop" } },
};

/** The room each step shows. */
export const ROOM_STEPS: { readonly [Name in RoomStepName]: RoomStep } = {
  welcome: { shot: "room", contents: CLOSED },
  account: { shot: "room", contents: ACCOUNT },
  providers: { shot: "your-desk", contents: PROVIDERS },
  github: { shot: "wing", contents: GITHUB },
  project: { shot: "triage", contents: PROJECT },
  done: { shot: "room", contents: DONE },
};
