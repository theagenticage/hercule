/**
 * Helpers for tests of the thread copies: copies that pass the contract's
 * schema check, which the store applies when it reads one back, and saving a
 * copy before the app starts.
 */
import type { ThreadCopy } from "@hercule/client-core";
import { buildSession } from "@hercule/client-core/threads/testing";
import type { TranscriptRow } from "@hercule/contract";
import { CONTROLLER_URL, type ThreadRecords } from "./testing";
import { createThreadCopies } from "./thread-copies";

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
    providerAccountId: buildId(801),
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

/** The transcript rows a saved copy holds, where they differ from the thread's. */
interface CopiedRows {
  /** The session's own agent's rows. All of the thread's rows when left out. */
  readonly transcript?: readonly TranscriptRow[];
  /** The rows of each subagent whose page was opened, by subagent id. None when left out. */
  readonly subagentTranscripts?: Readonly<Record<string, readonly TranscriptRow[]>>;
}

/**
 * Saves a copy of `thread` in the store the app opens for `CONTROLLER_URL`,
 * and returns when it is written. Call it before the app starts.
 */
export const saveThreadCopy = (thread: ThreadRecords, copied: CopiedRows = {}): Promise<void> =>
  createThreadCopies(CONTROLLER_URL).save({
    session: thread.session,
    subagents: thread.subagents ?? [],
    queuedInputs: [],
    transcript: copied.transcript ?? thread.transcript,
    subagentTranscripts: copied.subagentTranscripts ?? {},
  });
