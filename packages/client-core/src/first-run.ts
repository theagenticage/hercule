/**
 * The rules of the desktop's first run: which step comes next, and what
 * stands in the Office room behind the steps.
 *
 * Every rule reads state the controller already holds, so a later visit
 * draws the same room and resumes at the same step. The only state of the
 * first run's own is the list of steps the user put off.
 */
import type { Connection, ProviderInstance, Project, Runner } from "@hercule/contract";
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

/** Triage's line in the room when no Connection brings it anything to read. */
export const TRIAGE_WITHOUT_CONNECTIONS = "no Connections yet";

/**
 * Triage's line in the room once GitHub is connected. It names no time:
 * Triage does not run on a schedule yet, so a time would be a promise
 * nothing keeps.
 */
export const TRIAGE_READING = "reads it a few times a day";

/** How many desks a wing seats. A runner that hosts more sessions still gets this many. */
const WING_DESKS = 8;

/** The local runner's wing in the Office: one desk per session it can host. */
export interface RoomWing {
  /** The runner's name, which labels the wing. */
  readonly runnerName: string;
  readonly desks: number;
  /** The wing's plate: "this Mac · 6 desks" for a controller on this Mac, "6 desks" otherwise. */
  readonly note: string;
}

/** What stands in the Office room. Each piece is null, or false, until its step adds it. */
export interface RoomContents {
  /** On once Hercule answers. */
  readonly lights: boolean;
  /** The user's desk and hat stand, and the assistant asleep in the club chair. */
  readonly yourDesk: boolean;
  readonly wing: RoomWing | null;
  /** Triage at its desk, with the line under its name. */
  readonly triage: { readonly label: string } | null;
  /** The tube to Triage's desk and the plaque "GitHub / <account>". */
  readonly github: { readonly account: string } | null;
  /** The first thread's desk, drawn in its project's tint. */
  readonly firstThread: { readonly projectId: string; readonly projectName: string } | null;
}

/**
 * Returns what stands in the Office room, from the first run's reads:
 *
 * - the lights, once Hercule answers;
 * - after `account`: your desk, the hat stand, and the assistant;
 * - after `providers`: the local runner's wing, with one desk per session it
 *   can host, at most eight;
 * - once `github` is done or put off: Triage at its desk; the tube and the
 *   plaque only when GitHub is connected;
 * - after `project`, with a provider logged in: the first thread's desk, in
 *   the oldest project.
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
    readonly putOff: readonly FirstRunStep[];
  },
): RoomContents => {
  const done = buildFirstRunFacts(reads);
  const desks = Math.min(reads.localRunner?.maxConcurrentSessions ?? 0, WING_DESKS);
  const gitHub = filterGitHubConnections(reads.connections)[0];
  const project = [...reads.projects].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  return {
    lights: reads.answered,
    yourDesk: done.account,
    wing:
      done.providers && reads.localRunner !== null
        ? {
            runnerName: reads.localRunner.name,
            desks,
            note: [
              reads.controllerOnThisMac ? "this Mac" : null,
              `${desks} ${desks === 1 ? "desk" : "desks"}`,
            ]
              .filter((part) => part !== null)
              .join(" · "),
          }
        : null,
    triage:
      done.github || reads.putOff.includes("github")
        ? { label: gitHub === undefined ? TRIAGE_WITHOUT_CONNECTIONS : TRIAGE_READING }
        : null,
    // A Connection with no account name is named after its type, so the
    // label stands in for the account.
    github:
      gitHub === undefined
        ? null
        : { account: gitHub.displayName.trim() === "" ? gitHub.label : gitHub.displayName },
    firstThread:
      project !== undefined && done.providers
        ? { projectId: project.id, projectName: project.name }
        : null,
  };
};
