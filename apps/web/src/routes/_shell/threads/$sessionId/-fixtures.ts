/**
 * The session, subagent, Request and controller fixtures that the thread's
 * integration tests share. They share one copy so that a field added to a
 * record reaches every test. Each test spreads its own overrides over these.
 */
import type { Session, SessionRequest, Subagent } from "@hercule/contract";
import type { Handler } from "../../../../app/testing";

export const SESSION_ID = "01a06d02-b100-7000-8000-000000000001";

/** The time zone the user's settings name, which the time separators use. */
export const ZONE = "Europe/Amsterdam";

/** An idle thread with no open Request, whose harness has reported no token usage. */
export const SESSION: Session = {
  id: SESSION_ID,
  title: "Fix the login bug",
  status: "idle",
  resumable: false,
  resumeHeld: false,
  permissionProfileId: "01a06d02-2000-7000-8000-000000000001",
  agentId: null,
  conversationId: null,
  runId: null,
  stepId: null,
  instanceId: "01a06d02-1000-7000-8000-000000000001",
  runnerId: "01a06d02-3000-7000-8000-000000000001",
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequests: [],
  openPermissionRequests: [],
  createdAt: "2026-09-08T09:59:00.000Z",
  startedAt: "2026-09-08T09:59:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-08T10:01:03.000Z",
  unenforced: [],
};

/** Builds `SESSION` with `over` applied. */
export const buildSession = (over: Partial<Session> = {}): Session => ({ ...SESSION, ...over });

/**
 * Builds a running subagent of `SESSION` that the session's own agent
 * started at 10:00, with `over` applied.
 */
export const buildSubagent = (over: Partial<Subagent> & { readonly id: string }): Subagent => ({
  sessionId: SESSION_ID,
  status: "running",
  toolCalls: 0,
  startedAt: "2026-09-08T10:00:00.000Z",
  ...over,
});

/**
 * Builds an open approval to run `command`. `subagentId` makes it that
 * subagent's; without it, the session's own agent asks.
 */
export const buildRequest = (
  requestId: string,
  subagentId?: string,
  command = "ls",
): SessionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command },
  ...(subagentId === undefined ? {} : { subagentId }),
});

/**
 * The thread as the stubbed controller holds it. A test may change it, and
 * then push a live nudge, because every read answers from it at the time
 * of the read.
 */
export interface ControllerState {
  session: Session;
  subagents: readonly Subagent[];
}

/**
 * Builds the stubbed controller routes for the app and for the thread in
 * `state`, with `extra` added over them. The thread's transcript and queued
 * inputs are empty, and the controller has no providers, runners, profiles
 * or assistants; a test that needs any of them passes them in `extra`.
 */
export const buildController = (
  state: ControllerState,
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => {
  const { id } = state.session;
  return {
    "GET /api/v1/setup": { body: { complete: true } },
    "GET /api/v1/settings": {
      body: {
        controller: {},
        user: { "onboarding.completedSteps": ["timezone", "assistant"], timezone: ZONE },
      },
    },
    [`GET /api/v1/sessions/${id}`]: () => ({ body: state.session }),
    [`GET /api/v1/sessions/${id}/subagents`]: () => ({ body: { items: state.subagents } }),
    [`GET /api/v1/sessions/${id}/transcript`]: { body: { items: [] } },
    [`GET /api/v1/sessions/${id}/inputs`]: { body: { items: [] } },
    "GET /api/v1/providers": { body: [] },
    "GET /api/v1/runners": { body: { items: [] } },
    "GET /api/v1/profiles": { body: { items: [] } },
    "GET /api/v1/assistants": { body: { items: [] } },
    ...extra,
  };
};
