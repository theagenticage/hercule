/**
 * The rules of the desktop's first run: which step comes next, and what
 * stands in the Office room behind the steps.
 *
 * Every rule reads state the controller already holds, so a later visit
 * draws the same room and resumes at the same step. The only state of the
 * first run's own is the list of steps the user put off.
 */
import type { Assistant, Connection, ProviderInstance, Project, Runner } from "@hercule/contract";
import { filterGitHubConnections } from "./connections";
import { buildProviderRows } from "./provider-rows";

/** The first run's steps, in the order the user takes them. */
export const FIRST_RUN_STEPS = ["account", "providers", "github", "project"] as const;

export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

/** Which steps are done, one flag per step. */
export type FirstRunFacts = Readonly<Record<FirstRunStep, boolean>>;

/** The query data the first run reads. */
export interface FirstRunReads {
  /** Whether `setup.complete` has run, so the user has an account. */
  readonly setupComplete: boolean;
  /** The controller's local runner, or null while it has not joined or when there is none. */
  readonly localRunner: Runner | null;
  readonly instances: readonly ProviderInstance[];
  readonly connections: readonly Connection[];
  readonly projects: readonly Project[];
}

/**
 * Returns which first-run steps are done:
 *
 * - `account` when setup is complete;
 * - `providers` when a provider instance is logged in on the controller's
 *   local runner (a login on another runner does not count, because the
 *   first threads run on the local one);
 * - `github` when a GitHub Connection exists;
 * - `project` when a project exists.
 */
export const buildFirstRunFacts = (reads: FirstRunReads): FirstRunFacts => ({
  account: reads.setupComplete,
  providers:
    reads.localRunner !== null &&
    buildProviderRows(reads.localRunner, reads.instances).some((row) => row.loggedIn),
  github: filterGitHubConnections(reads.connections).length > 0,
  project: reads.projects.length > 0,
});

/**
 * Returns the step the first run shows: the first step that is neither done
 * nor put off, or `"done"` when there is none.
 */
export const decideFirstRunStep = (
  done: FirstRunFacts,
  putOff: readonly FirstRunStep[],
): FirstRunStep | "done" =>
  FIRST_RUN_STEPS.find((step) => !done[step] && !putOff.includes(step)) ?? "done";

/** Triage's note in the room when no Connection brings it anything to read. */
export const TRIAGE_WITHOUT_CONNECTIONS = "no Connections yet";

/**
 * Triage's note in the room once GitHub is connected. It names no time:
 * Triage does not run on a schedule yet, so a time would be a promise
 * nothing keeps.
 */
export const TRIAGE_READING_GITHUB = "reads GitHub";

/** How many desks a wing seats. A runner that hosts more sessions still gets this many. */
const WING_DESKS = 8;

/**
 * The local runner's wing in the Office. It stands once the runner is known;
 * its desks come in once a provider is logged in there.
 */
export interface RoomWing {
  /** The runner's name, engraved on the wing's plate. */
  readonly runnerName: string;
  /**
   * What the plate says after the name: "this Mac · 6 desks", "this Mac",
   * "6 desks", or "" when there is nothing to add.
   */
  readonly note: string;
  /** One desk per session the runner can host, at most eight; 0 until a provider is logged in. */
  readonly deskCount: number;
  /**
   * The first thread, at a desk in the oldest project's tint. The screen
   * reads the tint from `projectId`, because the palette belongs to each app.
   */
  readonly firstThread: { readonly projectId: string; readonly projectName: string } | null;
}

/** What stands in the Office room. Each piece is null, or false, until its step adds it. */
export interface RoomContents {
  /** False until Hercule answers; the room is drawn dimmed until then. */
  readonly lightsOn: boolean;
  readonly wing: RoomWing | null;
  /** The user's desk and hat stand. */
  readonly yourDesk: boolean;
  /** The oldest assistant, asleep in the club chair. */
  readonly assistant: { readonly name: string } | null;
  /** Triage at its desk, with the note under its name. */
  readonly triage: { readonly note: string } | null;
  /** The GitHub account on the plaque, which also draws the tube to Triage's desk. */
  readonly gitHubAccount: string | null;
}

/** Returns the item created first, or undefined when there is none. */
const findOldest = <Item extends { readonly createdAt: string }>(
  items: readonly Item[],
): Item | undefined =>
  items.reduce<Item | undefined>(
    (oldest, item) => (oldest === undefined || item.createdAt < oldest.createdAt ? item : oldest),
    undefined,
  );

/**
 * Builds `runner`'s wing. Its desks, and the first thread in `project`, come
 * in only when `providersDone` is true.
 */
const buildWing = (
  runner: Runner,
  controllerOnThisMac: boolean,
  providersDone: boolean,
  project: Project | undefined,
): RoomWing => {
  const deskCount = providersDone ? Math.min(runner.maxConcurrentSessions, WING_DESKS) : 0;
  return {
    runnerName: runner.name,
    note: [
      controllerOnThisMac ? "this Mac" : null,
      deskCount === 0 ? null : `${deskCount} ${deskCount === 1 ? "desk" : "desks"}`,
    ]
      .filter((part) => part !== null)
      .join(" · "),
    deskCount,
    firstThread:
      providersDone && project !== undefined
        ? { projectId: project.id, projectName: project.name }
        : null,
  };
};

/**
 * Returns what stands in the Office room, from the first run's reads:
 *
 * - the lights, once Hercule answers;
 * - the local runner's wing as soon as that runner is known, with "this Mac"
 *   on its plate when the controller runs on this Mac;
 * - after `account`: your desk, the hat stand, and the assistant;
 * - after `providers`: the wing's desks, one per session the runner can host,
 *   at most eight;
 * - once `github` is done or put off: Triage at its desk; the GitHub plaque
 *   and the tube only when GitHub is connected;
 * - after `project`, with a provider logged in: the first thread, in the
 *   oldest project.
 *
 * Each piece follows its step's fact rather than the step the user is on, so
 * a step done outside the first run, in the web app or the CLI, shows too.
 */
export const buildRoomContents = (
  reads: FirstRunReads & {
    /** Whether Hercule answers at the address the app knows. */
    readonly answered: boolean;
    /** Whether the controller runs on this Mac, which the wing's plate says. */
    readonly controllerOnThisMac: boolean;
    readonly assistants: readonly Assistant[];
    readonly putOff: readonly FirstRunStep[];
  },
): RoomContents => {
  const done = buildFirstRunFacts(reads);
  const gitHub = filterGitHubConnections(reads.connections)[0];
  const project = findOldest(reads.projects);
  const assistant = findOldest(reads.assistants);
  return {
    lightsOn: reads.answered,
    wing:
      reads.localRunner === null
        ? null
        : buildWing(reads.localRunner, reads.controllerOnThisMac, done.providers, project),
    yourDesk: done.account,
    assistant: done.account && assistant !== undefined ? { name: assistant.name } : null,
    triage:
      done.github || reads.putOff.includes("github")
        ? { note: gitHub === undefined ? TRIAGE_WITHOUT_CONNECTIONS : TRIAGE_READING_GITHUB }
        : null,
    // A Connection with no account name is named after its type, so the
    // label stands in for the account.
    gitHubAccount:
      gitHub === undefined
        ? null
        : gitHub.displayName.trim() === ""
          ? gitHub.label
          : gitHub.displayName,
  };
};
