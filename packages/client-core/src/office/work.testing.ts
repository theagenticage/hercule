/**
 * Fixtures for the Office's tests: the fixture world of
 * `threads/workspaces.testing.ts`, with runs, their workspaces and their
 * sessions, and a way to list the live work in it.
 */
import type { OpenRequest, RunSummary, Runner, Session } from "@hercule/contract";
import {
  INFRA,
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  RUNBOOKS,
  THREAD_3F1,
  WEBSHOP,
  WEBSHOP_PROJECT,
  buildCheckout,
  buildSession,
  buildWorkspace,
} from "../threads/workspaces.testing";
import { listWork, type Work } from "./work";

/** A command approval waiting on the user. */
export const REQUEST: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
};

/** Returns the time `minute` minutes past nine on the fixture day. */
export const buildTimestamp = (minute: number): string =>
  `2026-09-10T09:0${String(minute)}:00.000Z`;

/** A workspace of a run with a checkout of each of `resourceIds`. */
export const buildRunWorkspace = (id: string, resourceIds: readonly string[]) =>
  buildWorkspace({
    id,
    kind: "ephemeral",
    checkouts: resourceIds.map((resourceId) => buildCheckout(resourceId, `run/${id}`)),
  });

/** A run's workspace with webshop checked out, so its work belongs to webshop. */
export const WEBSHOP_RUN_WORKSPACE = buildRunWorkspace("ws-run-webshop", [WEBSHOP.id]);
/** A run's workspace with both of ops' repos checked out. */
export const OPS_RUN_WORKSPACE = buildRunWorkspace("ws-run-ops", [INFRA.id, RUNBOOKS.id]);
/** A run's workspace with a repo of webshop and a repo of ops, which share no project. */
export const MIXED_RUN_WORKSPACE = buildRunWorkspace("ws-run-mixed", [WEBSHOP.id, INFRA.id]);

/** Returns a running run created at `minute`. */
export const buildRun = (id: string, minute = 0): RunSummary => ({
  id,
  workflowId: "wf-review",
  workflowName: "Review",
  origin: { kind: "manual", actor: "user" },
  createdAt: buildTimestamp(minute),
  status: "running",
  startedAt: buildTimestamp(minute),
  activeStepIds: [],
  awaitedSignalIds: [],
});

/** Returns a session of an agent step of the run `runId`, working in webshop's run workspace. */
export const buildStepSession = (id: string, runId: string, over: Partial<Session> = {}): Session =>
  buildSession({
    id,
    agentId: "a-reviewer",
    runId,
    stepId: "review",
    workspaceId: WEBSHOP_RUN_WORKSPACE.id,
    ...over,
  });

/** Returns the current session of the main conversation of the assistant `assistantId`. */
export const buildAssistantSession = (assistantId: string, over: Partial<Session> = {}): Session =>
  buildSession({
    id: `s-${assistantId}`,
    agentId: assistantId,
    conversationId: `c-${assistantId}`,
    ...over,
  });

/** Every workspace of the fixture world: the threads' and the runs'. */
export const OFFICE_WORKSPACES = [
  PRIMARY,
  THREAD_3F1,
  WEBSHOP_RUN_WORKSPACE,
  OPS_RUN_WORKSPACE,
  MIXED_RUN_WORKSPACE,
];

/** Returns the live work of `sessions` in the fixture world, with webshop listed before ops. */
export const listFixtureWork = (
  sessions: readonly Session[],
  liveRuns: readonly RunSummary[] = [],
  runners: readonly Runner[] = [MOSS],
): Work[] =>
  listWork({
    sessions,
    runs: liveRuns,
    endedSince: null,
    projects: [WEBSHOP_PROJECT, OPS_PROJECT],
    workspaces: OFFICE_WORKSPACES,
    resources: [WEBSHOP, INFRA, RUNBOOKS],
    runners,
  });
