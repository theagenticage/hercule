/**
 * The rules of the desktop's first run: which step comes next, and what
 * stands in the Office room behind the steps.
 *
 * Every rule reads state the controller already holds, so a later visit
 * draws the same room and resumes at the same step. The only state of the
 * first run's own is the list of steps the user put off.
 */
import type {
  Assistant,
  Connection,
  ProviderInstance,
  Project,
  Resource,
  Runner,
} from "@hercule/contract";
import { DEVICE_FLOW_ENDINGS, filterGitHubConnections, type DeviceFlowStep } from "./connections";
import { buildProviderRows, type ProviderRow } from "./provider-rows";
import { parseRepositoryName } from "./remote";
import { formatRepoName, listProjectRepos } from "./threads/workspaces";

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

/**
 * How a step stands in the first run's ladder:
 *
 * - `now`: the step on screen;
 * - `done`: the step's fact is true;
 * - `put-off`: the user put the step off and it is not done;
 * - `next`: none of these yet.
 */
export type FirstRunRungStatus = "now" | "done" | "put-off" | "next";

/**
 * Returns each step's status in the ladder, in step order, while the first
 * run shows `now`. A step's tick or pause mark follows its fact, not its
 * place in the order, so a step done after the user went back to an earlier
 * one still shows its tick.
 */
export const buildFirstRunLadder = (
  now: FirstRunStep | "done",
  done: FirstRunFacts,
  putOff: readonly FirstRunStep[],
): readonly { readonly step: FirstRunStep; readonly status: FirstRunRungStatus }[] =>
  FIRST_RUN_STEPS.map((step) => ({
    step,
    status: step === now ? "now" : done[step] ? "done" : putOff.includes(step) ? "put-off" : "next",
  }));

/**
 * Returns the host and port of a controller's origin, such as
 * `127.0.0.1:4937` for `http://127.0.0.1:4937`, as the welcome shows it.
 * Returns `origin` unchanged when it does not parse.
 */
export const formatControllerAddress = (origin: string): string =>
  URL.canParse(origin) ? new URL(origin).host : origin;

/**
 * Checks whether a controller's origin, such as `http://127.0.0.1:4937`, is
 * on this machine: its host is `127.0.0.1`, `localhost` or `[::1]`. Returns
 * false for an origin that does not parse.
 *
 * The first run's welcome greets a controller on this Mac as Hercule found
 * running here, and a controller elsewhere goes straight to the account step.
 */
export const isLoopbackOrigin = (origin: string): boolean => {
  if (!URL.canParse(origin)) return false;
  return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname);
};

/**
 * The machine the first run's copy names as the one that runs Hercule: "this
 * Mac", or the name of the controller's runner when Hercule runs on another
 * machine.
 */
export interface FirstRunHost {
  readonly name: string;
  readonly isThisMac: boolean;
}

/**
 * Returns the machine that runs the controller at `origin`: this Mac when the
 * origin is on this machine, else the machine of the controller's
 * `localRunner`. Without a local runner, Hercule knows no name for that
 * machine, so the copy calls it "the machine that runs Hercule".
 */
export const buildFirstRunHost = (origin: string, localRunner: Runner | null): FirstRunHost =>
  isLoopbackOrigin(origin)
    ? { name: "this Mac", isThisMac: true }
    : { name: localRunner?.name ?? "the machine that runs Hercule", isThisMac: false };

/** Joins names as a reader would list them: "A", "A and B", "A, B and C". */
export const joinNames = (names: readonly string[], conjunction: "and" | "or"): string =>
  new Intl.ListFormat("en", {
    type: conjunction === "and" ? "conjunction" : "disjunction",
  })
    .format(names)
    // A list of three or more gets no comma before the conjunction, as the book writes it.
    .replace(/, (and|or) /, " $1 ");

/** The heading, the line under it, and the rows of the providers step. */
export interface ProvidersStepText {
  readonly heading: string;
  readonly sub: string;
  /** The rows the step lists: the harnesses found, or every harness when none was found. */
  readonly rows: readonly ProviderRow[];
}

/**
 * Builds the providers step's text from the provider rows of the controller's
 * runner, and the machine that runner is on:
 *
 * - When some harnesses are on that machine, the step names them and lists
 *   them, so the user logs in to the ones they want.
 * - When none is, the step lists every harness, each with its Install.
 * - When `rows` is null, the controller's runner has not joined yet, as
 *   happens in the seconds after Hercule starts, so there is nothing to list
 *   until it does.
 */
export const buildProvidersStepText = (
  rows: readonly ProviderRow[] | null,
  host: FirstRunHost,
): ProvidersStepText => {
  if (rows === null) {
    return {
      heading: "Waiting for the runner",
      sub: `Your agents run on a runner, and the one on ${host.name} hasn’t joined Hercule yet. Its coding tools show here once it does.`,
      rows: [],
    };
  }
  // A harness the runner found has its binary's path, or `installed` when the runner did not say where.
  const found = rows.filter((row) => row.path !== null || row.location === "installed");
  if (found.length === 0) {
    return {
      heading: "Your agents need a coding tool",
      sub: `Hercule drives ${joinNames(
        rows.map((row) => row.name),
        "or",
      )}, and found none of them on ${host.name}. Install one and log in to it; Hercule can install it for you.`,
      rows,
    };
  }
  return {
    heading: `${joinNames(
      found.map((row) => row.name),
      "and",
    )} ${found.length === 1 ? "is" : "are"} on ${host.name}`,
    sub: `Log in to the ones you want your agents to use. The login runs on ${host.name} and its credential stays ${host.isThisMac ? "here" : "there"}.`,
    rows: found,
  };
};

/**
 * Returns how many whole minutes a device code still works at `now`, rounded
 * up, from its `expiresAt`. Returns at least 1, so a screen never says a code
 * that still works expires in 0 minutes.
 */
export const countCodeMinutes = (expiresAt: string, now: number): number =>
  Math.max(1, Math.ceil((Date.parse(expiresAt) - now) / 60_000));

/**
 * Returns what the GitHub step says when signing in with a code ends without
 * a Connection: the line for the ending, then what to do next. A failed
 * sign-in gives the controller's own `message`, which differs from case to
 * case. `codeMinutes` is how long the code lasted when it was handed out.
 */
export const describeGitHubSignInEnding = (
  ending: Extract<DeviceFlowStep, { kind: "ended" }>,
  codeMinutes: number,
): { readonly line: string; readonly next: string } => {
  const line = DEVICE_FLOW_ENDINGS[ending.status];
  switch (ending.status) {
    case "expired":
      return {
        line,
        next: `A code lasts ${String(codeMinutes)} ${codeMinutes === 1 ? "minute" : "minutes"}. Start again for a new one.`,
      };
    case "denied":
      return {
        line,
        next: "Hercule was declined on GitHub’s approval page. Start again if that was a mistake.",
      };
    case "failed":
      return { line, next: ending.message };
  }
};

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
  const gitHubAccount = findGitHubAccount(reads.connections);
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
        ? { note: gitHubAccount === null ? TRIAGE_WITHOUT_CONNECTIONS : TRIAGE_READING_GITHUB }
        : null,
    gitHubAccount,
  };
};

/**
 * Returns the account of the first GitHub Connection, or null when there is
 * none. A Connection with no account name is named after its type, so its
 * label stands in for the account.
 */
export const findGitHubAccount = (connections: readonly Connection[]): string | null => {
  const gitHub = filterGitHubConnections(connections)[0];
  if (gitHub === undefined) return null;
  return gitHub.displayName.trim() === "" ? gitHub.label : gitHub.displayName;
};

/** What All set lists, one entry per step. */
export interface AllSetRecap {
  /**
   * The harnesses logged in on the controller's runner, as one name list
   * ("Claude Code and Codex"), or null when none is.
   */
  readonly providerNames: string | null;
  /** The provider whose mark stands for the row: the first logged in, else the first listed. */
  readonly providerId: string | null;
  readonly gitHubAccount: string | null;
  /**
   * The first project, with its first repository as `owner/name`, or null
   * for the repository when the project has none yet.
   */
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly repository: string | null;
  } | null;
}

/** Builds what All set lists from the first run's reads and every resource. */
export const buildAllSetRecap = (
  reads: FirstRunReads & { readonly resources: readonly Resource[] },
): AllSetRecap => {
  const rows =
    reads.localRunner === null ? [] : buildProviderRows(reads.localRunner, reads.instances);
  const loggedIn = rows.filter((row) => row.loggedIn);
  const project = findOldest(reads.projects);
  const repo = project === undefined ? undefined : listProjectRepos(reads.resources, project.id)[0];
  return {
    providerNames:
      loggedIn.length === 0
        ? null
        : joinNames(
            loggedIn.map((row) => row.name),
            "and",
          ),
    providerId: (loggedIn[0] ?? rows[0])?.providerId ?? null,
    gitHubAccount: findGitHubAccount(reads.connections),
    project:
      project === undefined
        ? null
        : {
            id: project.id,
            name: project.name,
            repository:
              repo === undefined
                ? null
                : (parseRepositoryName(repo.remote ?? "") ?? formatRepoName(repo)),
          },
  };
};
