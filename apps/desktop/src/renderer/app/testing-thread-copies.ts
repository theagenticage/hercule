/**
 * Fixtures for tests of the saved thread copies: copies that pass the
 * contract's schema check, which the store applies when it reads one back.
 */
import type { ThreadCopy } from "@hercule/client-core";
import { buildSession } from "@hercule/client-core/threads/testing";

const AT = "2026-10-19T09:00:00.000Z";

/** Builds the canonical lowercase UUIDv7 the contract demands of an id, numbered `n`. */
export const buildId = (n: number): string =>
  `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** Builds a copy of thread `id`, in `projectId`, whose transcript has one row and which has one subagent, `a1`. */
export const buildThreadCopyFixture = (
  id: string,
  projectId: string | null = buildId(900),
): ThreadCopy => ({
  // The builder's default ids are readable but not UUIDv7, which the schema check refuses.
  session: buildSession({
    id,
    projectId,
    permissionProfileId: buildId(800),
    instanceId: buildId(801),
    runnerId: buildId(802),
  }),
  subagents: [{ id: "a1", sessionId: id, status: "running", toolCalls: 0, startedAt: AT }],
  queuedInputs: [],
  transcript: [
    {
      position: 1,
      at: AT,
      event: { _tag: "turn.started", eventId: `e-${id}`, sessionId: id, at: AT, turnId: "t-1" },
    },
  ],
  subagentTranscripts: {},
});
