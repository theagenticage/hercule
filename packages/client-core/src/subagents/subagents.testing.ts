/**
 * Test fixtures for the subagent functions: a Subagent record and an open
 * Request, each with readable defaults a test overrides. Every test suite of
 * this folder shares them, so the records cannot drift apart.
 */
import type { SessionRequest, Subagent } from "@hercule/contract";

/** When every fixture subagent started, unless a test says otherwise. */
export const STARTED_AT = "2026-10-05T09:00:00.000Z";

/** Builds a running subagent the session's own agent started, with `over` applied. */
export const buildSubagent = (over: Partial<Subagent> & { id: string }): Subagent => ({
  sessionId: "s-1",
  status: "running",
  toolCalls: 0,
  startedAt: STARTED_AT,
  ...over,
});

/** Builds an open command approval; `subagentId` makes it that subagent's. */
export const buildRequest = (requestId: string, subagentId?: string): SessionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "ls" },
  ...(subagentId === undefined ? {} : { subagentId }),
});
