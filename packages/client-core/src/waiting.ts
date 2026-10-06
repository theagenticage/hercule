/**
 * What waits on the user: the threads and the assistants whose session has
 * an open Request, whichever of its agents asked. Answering the last one,
 * wherever it is answered, ends the wait.
 *
 * The desktop app counts these on its dock badge, shows a notification for
 * each, lists them in Waiting on you and in its Go menu. All of them read
 * this one list, so they always agree.
 *
 * Each entry carries two views of the open Requests, because spec 17 asks
 * for different ones:
 *
 * - Waiting on you shows the oldest Request, as the dock on the composer and
 *   the Office do;
 * - the notification shows the newest, the one that just opened, and counts
 *   the others.
 */
import type { Session, SessionRequest } from "@hercule/contract";
import type { AssistantRow } from "./assistants/rows";
import { findOldestOpenRequest } from "./threads/oldest-request";
import { compareNewestFirst } from "./threads/rows";
import { formatRequestQuestion } from "./threads/request-question";

/** The fields every entry has, read from the session that waits and its open Requests. */
interface WaitingSession {
  /**
   * The session that asks: the thread's own, or the current session of the
   * assistant's main conversation.
   */
  readonly sessionId: string;
  /**
   * The oldest open Request's id. When it is answered, the next oldest takes
   * its place, with a new id.
   */
  readonly requestId: string;
  /** What the oldest Request asks, in one line, such as "Run git push?". */
  readonly question: string;
  /** The newest open Request's id: the Request the notification shows. */
  readonly newestRequestId: string;
  /** The ids of every open Request, oldest first. */
  readonly openRequestIds: readonly string[];
  /**
   * The text of the notification, as `formatNotificationBody` builds it from
   * the newest Request, such as "Run git push?".
   */
  readonly notificationBody: string;
  /** When the session was last active. */
  readonly activityAt: string;
}

/** A thread waiting on the user, and the Requests it waits on. */
export interface WaitingThread extends WaitingSession {
  readonly kind: "thread";
  readonly title: string;
}

/** An assistant waiting on the user, and the Requests its session waits on. */
export interface WaitingAssistant extends WaitingSession {
  readonly kind: "assistant";
  readonly assistantId: string;
  readonly name: string;
}

/** A thread or an assistant waiting on the user. */
export type Waiting = WaitingThread | WaitingAssistant;

/**
 * Returns the text of the notification about `newest`, the newest open
 * Request of a session that has `others` more open:
 *
 * - the Request's question, such as "Run git push?";
 * - starting with the subagent's name, such as "Review the diff asks: ",
 *   when a subagent asked it;
 * - followed by a second line, "+N more waiting", when others are open.
 *
 * The controller puts the subagent's name on the Request. A subagent has
 * no name while its record holds neither a description nor an agent type,
 * and its Request then starts with "A subagent asks: ". That happens when
 * the harness reported the Request before it introduced the subagent, or
 * introduced it with neither field.
 */
const formatNotificationBody = (newest: SessionRequest, others: number): string => {
  const asker =
    newest.subagentId === undefined ? "" : `${newest.subagentName ?? "A subagent"} asks: `;
  const more = others === 0 ? "" : `\n+${String(others)} more waiting`;
  return `${asker}${formatRequestQuestion(newest)}${more}`;
};

/**
 * Returns the parts of an entry that come from `session` and its open
 * Requests, or null when it has none and so does not wait on the user.
 */
const buildRequestFields = (session: Session): WaitingSession | null => {
  const oldest = findOldestOpenRequest(session);
  const newest = session.openRequests.at(-1);
  if (oldest === null || newest === undefined) return null;
  return {
    sessionId: session.id,
    requestId: oldest.requestId,
    question: formatRequestQuestion(oldest),
    newestRequestId: newest.requestId,
    openRequestIds: session.openRequests.map((request) => request.requestId),
    notificationBody: formatNotificationBody(newest, session.openRequests.length - 1),
    activityAt: session.lastActivityAt,
  };
};

/**
 * Returns every thread in `threads` and every assistant in `assistantRows`
 * whose session has an open Request, each with its open Requests. An
 * assistant's session is the one on its row; an assistant with no session
 * waits on nothing.
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
      const fields = buildRequestFields(session);
      return fields === null ? [] : [{ kind: "thread", title: session.title, ...fields }];
    }),
    ...assistantRows.flatMap((row): Waiting[] => {
      const fields = row.session === null ? null : buildRequestFields(row.session);
      return fields === null
        ? []
        : [{ kind: "assistant", assistantId: row.id, name: row.name, ...fields }];
    }),
  ].sort((a, b) =>
    compareNewestFirst(
      { activityAt: a.activityAt, id: a.sessionId },
      { activityAt: b.activityAt, id: b.sessionId },
    ),
  );
