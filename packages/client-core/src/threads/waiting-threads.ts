/**
 * The threads waiting on the user, which the desktop app counts on its dock
 * badge and shows notifications for. A thread waits on the user while its
 * session has an open Request, whichever of its agents asked; answering the
 * last one, wherever it is answered, ends the wait.
 */
import type { Session } from "@hercule/contract";
import { findOldestOpenRequest } from "./oldest-request";
import { formatRequestQuestion } from "./request-question";

/** A thread waiting on the user, and the oldest Request it waits on. */
export interface WaitingThread {
  readonly sessionId: string;
  /**
   * The oldest open Request's id. When it is answered, the next oldest takes
   * its place, with a new id.
   */
  readonly requestId: string;
  readonly title: string;
  /** What the agent asks, in one line, such as "Run git push?". */
  readonly question: string;
}

/**
 * Returns the threads in `sessions` that have an open Request, in the order
 * of `sessions`, each with the oldest of its Requests: the one its agents
 * have waited on longest.
 */
export const listWaitingThreads = (sessions: readonly Session[]): WaitingThread[] =>
  sessions.flatMap((session) => {
    const oldest = findOldestOpenRequest(session);
    return oldest === null
      ? []
      : [
          {
            sessionId: session.id,
            requestId: oldest.requestId,
            title: session.title,
            question: formatRequestQuestion(oldest),
          },
        ];
  });
