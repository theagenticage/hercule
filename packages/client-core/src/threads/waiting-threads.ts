/**
 * The threads waiting on the user, which the desktop app counts on its dock
 * badge and shows notifications for. A thread waits on the user while its
 * session has an open Request, whichever of its agents asked; answering the
 * last one, wherever it is answered, ends the wait.
 */
import type { Session, Subagent } from "@hercule/contract";
import { nameSubagent } from "../subagents/name";
import { formatRequestQuestion } from "./request-question";

/** A thread waiting on the user, and the text of its notification. */
export interface WaitingThread {
  readonly sessionId: string;
  readonly title: string;
  /**
   * The notification's body, about the newest open Request, such as
   * "Explore the auth module asks: Run git push? +1 more waiting". It is
   * null while the subagent that asked the newest Request is still being
   * read: the thread counts as waiting, but its notification waits for a
   * body that can name the subagent.
   */
  readonly body: string | null;
  /**
   * The ids of every open Request, oldest first. The last one is the
   * Request the body is about.
   */
  readonly openRequestIds: readonly [string, ...string[]];
}

/** A thread whose newest open Request a subagent asked, and that subagent. */
export interface AskingSubagent {
  readonly sessionId: string;
  readonly subagentId: string;
}

/**
 * Returns the threads in `sessions` whose newest open Request a subagent
 * asked, in the order of `sessions`, each with the id of that subagent. A
 * thread whose newest Request its own agent asked, or that has no open
 * Request, is left out.
 */
export const listAskingSubagents = (sessions: readonly Session[]): AskingSubagent[] =>
  sessions.flatMap((session) => {
    const subagentId = session.openRequests.at(-1)?.subagentId;
    return subagentId === undefined ? [] : [{ sessionId: session.id, subagentId }];
  });

/**
 * Returns the threads in `sessions` that have an open Request, in the order
 * of `sessions`, each with the body of its notification:
 *
 * - the newest Request's question, in one line, such as "Run git push?";
 * - starting with "<subagent> asks: " when a subagent asked it;
 * - ending with " +N more waiting" when other Requests are open too.
 *
 * `askerReads` holds, by session id, the result of reading the subagent
 * that asked each thread's newest Request, for the threads
 * `listAskingSubagents` returns:
 *
 * - the subagent's record, which names it;
 * - `undefined` when the read failed or found no such subagent, which names
 *   it "A subagent";
 * - no entry while the read is still running, which makes the body null.
 *
 * The notification follows the newest Request because that is the one the
 * user has not heard about yet.
 */
export const listWaitingThreads = (
  sessions: readonly Session[],
  askerReads: ReadonlyMap<string, Subagent | undefined>,
): WaitingThread[] => {
  const askers = new Map(
    listAskingSubagents(sessions).map(({ sessionId, subagentId }) => [sessionId, subagentId]),
  );
  // Names the newest Request's asker, as the start of the body: "" for the
  // session's own agent, and null while the subagent is still being read.
  const buildAskerPrefix = (sessionId: string): string | null => {
    const subagentId = askers.get(sessionId);
    if (subagentId === undefined) return "";
    if (!askerReads.has(sessionId)) return null;
    const subagent = askerReads.get(sessionId);
    return `${subagent?.id === subagentId ? nameSubagent(subagent) : "A subagent"} asks: `;
  };
  return sessions.flatMap((session) => {
    const [oldest, ...newer] = session.openRequests;
    if (oldest === undefined) return [];
    const newest = newer.at(-1) ?? oldest;
    const prefix = buildAskerPrefix(session.id);
    const more = newer.length > 0 ? ` +${String(newer.length)} more waiting` : "";
    return [
      {
        sessionId: session.id,
        title: session.title,
        body: prefix === null ? null : `${prefix}${formatRequestQuestion(newest)}${more}`,
        openRequestIds: [oldest.requestId, ...newer.map((request) => request.requestId)],
      },
    ];
  });
};
