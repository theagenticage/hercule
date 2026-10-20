/**
 * Helpers for tests of a thread that opens from its thread copy: a stubbed
 * controller that answers a transcript read for the rows after a position.
 */
import { buildErrorBody, type Answer, type Call, type ThreadRecords } from "./testing";

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
