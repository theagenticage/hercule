/**
 * The threads waiting on the user, which the desktop app counts on its dock
 * badge and shows notifications for. A thread waits on the user while its
 * session has an open Request; answering the Request, wherever it is
 * answered, ends the wait.
 */
import type { Session } from "@hercule/contract";
import { formatRequestQuestion } from "./request-question";

/** A thread waiting on the user, and the Request it waits on. */
export interface WaitingThread {
  readonly sessionId: string;
  /** The open Request's id. A new Request on the same thread has a new id. */
  readonly requestId: string;
  readonly title: string;
  /** What the agent asks, in one line, such as "Run git push?". */
  readonly question: string;
}

/** Returns the threads in `sessions` that have an open Request, in the order of `sessions`. */
export const listWaitingThreads = (sessions: readonly Session[]): WaitingThread[] =>
  sessions.flatMap((session) =>
    session.openRequest === null
      ? []
      : [
          {
            sessionId: session.id,
            requestId: session.openRequest.requestId,
            title: session.title,
            question: formatRequestQuestion(session.openRequest),
          },
        ],
  );
