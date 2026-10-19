/**
 * Helpers for tests of a thread that opens from its saved copy: saving a copy
 * before the app starts, and a stubbed controller that answers a transcript
 * read for the rows after a position.
 */
import type { TranscriptRow } from "@hercule/contract";
import {
  buildErrorBody,
  CONTROLLER_URL,
  type Answer,
  type Call,
  type ThreadRecords,
} from "./testing";
import { openThreadCopies } from "./thread-copies";

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
  openThreadCopies(CONTROLLER_URL).save({
    session: thread.session,
    subagents: thread.subagents ?? [],
    queuedInputs: [],
    transcript: copied.transcript ?? thread.transcript,
    subagentTranscripts: copied.subagentTranscripts ?? {},
  });

/**
 * Returns the handler for a read of a transcript that answers from `thread`
 * as the controller does: only the rows whose position is above `after` when
 * the read has one, the subagent's rows when it names a subagent, and
 * `not_found` for a subagent the thread has no transcript for.
 */
export const answerTranscriptRead =
  (thread: ThreadRecords) =>
  (call: Call): Answer => {
    const query = new URLSearchParams(call.search);
    const subagentId = query.get("subagentId");
    const rows = subagentId === null ? thread.transcript : thread.subagentTranscripts?.[subagentId];
    if (rows === undefined) {
      return {
        status: 404,
        body: buildErrorBody("not_found", `no subagent ${String(subagentId)}`),
      };
    }
    const after = Number(query.get("after") ?? 0);
    return { body: { items: rows.filter((row) => row.position > after) } };
  };

/** Returns the `after` and `subagentId` of each transcript read in `calls`, as the app sent them. */
export const readTranscriptReads = (
  calls: readonly { readonly path: string; readonly search: string }[],
  sessionId: string,
): { readonly after: string | null; readonly subagentId: string | null }[] =>
  calls
    .filter((call) => call.path === `/api/v1/sessions/${sessionId}/transcript`)
    .map((call) => {
      const query = new URLSearchParams(call.search);
      return { after: query.get("after"), subagentId: query.get("subagentId") };
    });
