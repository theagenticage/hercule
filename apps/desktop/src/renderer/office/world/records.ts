/**
 * PROTOTYPE - the API records the real sidebar reads, built from the office's
 * world, so the sidebar beside the office lists the same threads the office
 * draws. Assistants, Triage and Juno are not threads, so the sidebar leaves
 * them out.
 */
import type { OpenRequest, ProviderInstance, Session } from "@hercule/contract";
import { buildProject, buildRunner } from "@hercule/client-core/threads/testing";
import type { SidebarRecords } from "../../specimens/shell-page";
import {
  buildSpecimenSession,
  CLAUDE_OPUS,
  CLAUDE_SONNET,
  GPT,
  SPECIMEN_INSTANCES,
  type SpecimenModel,
} from "../../specimens/sidebar-fixture";
import { FIX_THREAD, THREAD_PAGE_RECORDS } from "../../specimens/thread-fixture";
import type { ColleagueState } from "../engine/contracts";
import type { Colleague, Pose, World } from "./types";

const PROJECT_IDS = {
  webshop: "p-webshop",
  "payments-api": "p-payments-api",
  ops: "p-ops",
} as const;

/** Returns the specimen model closest to the colleague's model name. */
const pickModel = (name: string | null): SpecimenModel =>
  name === "Opus 5.5" ? CLAUDE_OPUS : name === "gpt-5.4" ? GPT : CLAUDE_SONNET;

/** Returns the open request the sidebar shows for a waiting colleague. */
const buildOpenRequest = (colleague: Colleague): OpenRequest | null => {
  const request = colleague.request;
  if (request === null) return null;
  return request.kind === "command"
    ? {
        requestId: `rq-${colleague.id}`,
        itemId: `it-${colleague.id}`,
        kind: "command_approval",
        decisions: ["allow", "deny"],
        detail: { command: request.prompt.split("  #")[0]! },
      }
    : {
        requestId: `rq-${colleague.id}`,
        itemId: `it-${colleague.id}`,
        kind: "question",
        detail: {
          questions: [
            {
              question: request.prompt,
              header: "Question",
              options: request.answers.map((label) => ({ label, description: label })),
              multiSelect: false,
            },
          ],
        },
      };
};

/** Parses "22m", "idle 2h" or "waiting 10m" into minutes since the colleague's last activity. */
const parseMinutesAgo = (label: string): number => {
  const match = /(\d+)\s*([mh])/.exec(label);
  if (match === null) return 1;
  return Number(match[1]) * (match[2] === "h" ? 60 : 1);
};

/** Returns the status a session has while its colleague is in `pose`. */
const decideSessionStatus = (pose: Pose): "idle" | "busy" =>
  pose === "idle" || pose === "paused" ? "idle" : "busy";

/** Builds the session the sidebar lists for one colleague. */
const buildColleagueSession = (colleague: Colleague): Session => {
  if (colleague.threadId === FIX_THREAD.session.id) return FIX_THREAD.session;
  return buildSpecimenSession({
    id: colleague.id,
    title: colleague.title,
    projectId: colleague.project === null ? "p-webshop" : PROJECT_IDS[colleague.project],
    status: decideSessionStatus(colleague.pose),
    minutesAgo: parseMinutesAgo(colleague.stateLabel),
    model: pickModel(colleague.model),
    runnerId: colleague.runnerId ?? "r-studio-mac",
    openRequest: buildOpenRequest(colleague),
  });
};

/**
 * Returns the session the sidebar lists for `colleague` while the office's sim
 * holds it in the state `live`: waiting on a request the sim made up, or
 * working again once the user answered. A colleague still in the state the
 * world gives it keeps the session the page opened with.
 */
export function buildLiveSession(colleague: Colleague, live: ColleagueState | undefined): Session {
  const session = buildColleagueSession(colleague);
  if (live === undefined || (live.pose === colleague.pose && live.request === colleague.request)) {
    return session;
  }
  return {
    ...session,
    status: decideSessionStatus(live.pose),
    openRequest: buildOpenRequest({ ...colleague, ...live }),
  };
}

/**
 * Returns `instance` with its capability snapshot copied to every runner in
 * `world`. The shared fixture logs each provider in on one machine only, and
 * the thread footer would call every other runner "not logged in".
 */
function logInOnEveryRunner(instance: ProviderInstance, world: World): ProviderInstance {
  return {
    ...instance,
    snapshots: world.runners.flatMap((runner) =>
      instance.snapshots.slice(0, 1).map((snapshot) => ({ ...snapshot, runnerId: runner.id })),
    ),
  };
}

/** Returns every list the sidebar reads, for `world`. */
export function buildSidebarRecords(world: World): SidebarRecords {
  return {
    threads: world.colleagues
      .filter((colleague) => colleague.role === "session")
      .map(buildColleagueSession),
    projects: [
      buildProject("p-webshop", "webshop"),
      buildProject("p-payments-api", "payments-api"),
      buildProject("p-ops", "ops"),
    ],
    // The Fix thread works in its own worktree, which its thread header reads.
    workspaces: THREAD_PAGE_RECORDS.workspaces,
    resources: [],
    runners: world.runners.map((runner) => buildRunner(runner.id, runner.name)),
    instances: SPECIMEN_INSTANCES.map((instance) => logInOnEveryRunner(instance, world)),
    user: { username: "Rogier" },
  };
}
