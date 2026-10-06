/**
 * What waits on the user: the threads and the assistants whose session has
 * an open Request, whichever of its agents asked. Answering the last one,
 * wherever it is answered, ends the wait.
 *
 * The desktop app counts these on its dock badge, shows a notification for
 * each, lists them in Waiting on you and in its Go menu. All of them read
 * this one list, so they always agree.
 */
import type { Session, SessionRequest } from "@hercule/contract";
import type { AssistantRow } from "./assistants/rows";
import { findOldestOpenRequest } from "./threads/oldest-request";
import { compareNewestFirst } from "./threads/rows";
import { formatRequestQuestion } from "./threads/request-question";

/** A thread waiting on the user, and the oldest Request it waits on. */
export interface WaitingThread {
  readonly kind: "thread";
  readonly sessionId: string;
  /**
   * The oldest open Request's id. When it is answered, the next oldest takes
   * its place, with a new id.
   */
  readonly requestId: string;
  readonly title: string;
  /** What the agent asks, in one line, such as "Run git push?". */
  readonly question: string;
  /** When the session was last active. */
  readonly activityAt: string;
}

/** An assistant waiting on the user, and the oldest Request its session waits on. */
export interface WaitingAssistant {
  readonly kind: "assistant";
  readonly assistantId: string;
  readonly name: string;
  /** The current session of the assistant's main conversation: the one that asks. */
  readonly sessionId: string;
  /**
   * The oldest open Request's id. When it is answered, the next oldest takes
   * its place, with a new id.
   */
  readonly requestId: string;
  /** What the agent asks, in one line, such as "Run git push?". */
  readonly question: string;
  /** When the session was last active. */
  readonly activityAt: string;
}

/** A thread or an assistant waiting on the user. */
export type Waiting = WaitingThread | WaitingAssistant;

/** Returns the parts of an entry that come from its session and the Request it waits on. */
const buildRequestFields = (session: Session, request: SessionRequest) => ({
  sessionId: session.id,
  requestId: request.requestId,
  question: formatRequestQuestion(request),
  activityAt: session.lastActivityAt,
});

/**
 * Returns every thread in `threads` and every assistant in `assistantRows`
 * whose session has an open Request, each with the oldest of its Requests:
 * the one its agents have waited on longest. An assistant's session is the
 * one on its row; an assistant with no session waits on nothing.
 *
 * The list is sorted with the most recently active first, threads and
 * assistants mixed, and two entries active at the same moment by session id.
 */
export const listWaiting = (
  threads: readonly Session[],
  assistantRows: readonly AssistantRow[],
): Waiting[] =>
  [
    ...threads.flatMap((session): Waiting[] => {
      const request = findOldestOpenRequest(session);
      return request === null
        ? []
        : [{ kind: "thread", title: session.title, ...buildRequestFields(session, request) }];
    }),
    ...assistantRows.flatMap((row): Waiting[] => {
      if (row.session === null) return [];
      const request = findOldestOpenRequest(row.session);
      return request === null
        ? []
        : [
            {
              kind: "assistant",
              assistantId: row.id,
              name: row.name,
              ...buildRequestFields(row.session, request),
            },
          ];
    }),
  ].sort((a, b) =>
    compareNewestFirst(
      { activityAt: a.activityAt, id: a.sessionId },
      { activityAt: b.activityAt, id: b.sessionId },
    ),
  );
