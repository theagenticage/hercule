/**
 * The threads waiting on the user, which the desktop app counts on its dock
 * badge and shows notifications for. A thread waits on the user while its
 * session has an open Request, whichever of its agents asked; answering the
 * last one, wherever it is answered, ends the wait.
 */
import type { Session, Subagent } from "@hercule/contract";
import { nameSubagent } from "../subagents/describe";
import { formatRequestQuestion } from "./request-question";

/** A thread waiting on the user, and the text of its notification. */
export interface WaitingThread {
  readonly sessionId: string;
  readonly title: string;
  /**
   * The notification's body, about the newest open Request, such as
   * "Explore the auth module asks: Run git push? +1 more waiting".
   */
  readonly body: string;
  /**
   * The ids of every open Request, oldest first. The last one is the
   * Request the body is about.
   */
  readonly openRequestIds: readonly string[];
}

/**
 * Returns the threads in `sessions` that have an open Request, in the order
 * of `sessions`, each with the body of its notification:
 *
 * - the newest Request's question, in one line, such as "Run git push?";
 * - starting with "<subagent> asks: " when a subagent asked it. The subagent
 *   is named from `subagentsBySession`, the subagents of each session, by
 *   session id; it is named "A subagent" when its record is not there;
 * - ending with " +N more waiting" when other Requests are open too.
 *
 * The notification follows the newest Request because that is the one the
 * user has not heard about yet.
 */
export const listWaitingThreads = (
  sessions: readonly Session[],
  subagentsBySession: ReadonlyMap<string, readonly Subagent[]>,
): WaitingThread[] =>
  sessions.flatMap((session) => {
    const requests = session.openRequests;
    const newest = requests.at(-1);
    if (newest === undefined) return [];
    let asker = "";
    if (newest.subagentId !== undefined) {
      const subagent = subagentsBySession
        .get(session.id)
        ?.find((each) => each.id === newest.subagentId);
      asker = `${subagent === undefined ? "A subagent" : nameSubagent(subagent)} asks: `;
    }
    const more = requests.length > 1 ? ` +${String(requests.length - 1)} more waiting` : "";
    return [
      {
        sessionId: session.id,
        title: session.title,
        body: `${asker}${formatRequestQuestion(newest)}${more}`,
        openRequestIds: requests.map((request) => request.requestId),
      },
    ];
  });
