/**
 * What waits on the user: the Threads, the Agents' sessions and the
 * assistants whose session has an open Request, whichever of its agents asked. Answering the last one,
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
 *
 * The sessions of runs that wait on the user are a list of their own
 * (`listWaitingRunSessions`). Waiting on you shows them under "From runs",
 * but the badge, the notifications and the Go menu leave them out (spec 17
 * §Native behaviour), so they are not entries of this list.
 */
import type { Session, SessionRequest } from "@hercule/contract";
import type { AssistantRow } from "./assistants/rows";
import { findOldestOpenRequest } from "./threads/oldest-request";
import { compareNewestFirst } from "./threads/rows";
import { formatRequestQuestion } from "./threads/request-question";
import { buildSessionGroups } from "./threads/session-groups";
import { labelWorkspaceSessions } from "./threads/siblings";

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

/**
 * A Thread or an Agent's session waiting on the user, and the Requests it
 * waits on. Both open as a thread, so both have this kind.
 */
export interface WaitingThread extends WaitingSession {
  readonly kind: "thread";
  /** The session's own title. */
  readonly title: string;
  /** The name of the sidebar row that holds the session: the title of its group's lead. */
  readonly groupName: string;
  /**
   * What the session is called in its group, such as "review", or `null`
   * when it is the lead or alone in its group, so nothing needs telling
   * apart.
   */
  readonly askerLabel: string | null;
}

/** An assistant waiting on the user, and the Requests its session waits on. */
export interface WaitingAssistant extends WaitingSession {
  readonly kind: "assistant";
  readonly assistantId: string;
  readonly name: string;
}

/** A Thread, an Agent's session or an assistant waiting on the user. */
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
 * Returns the name of the sidebar row that holds each session of `sessions`,
 * and what the session is called in that row (`WaitingThread.askerLabel`),
 * by session id. A session no row holds, such as an Agent's session in a
 * workspace where no Thread works, has no entry.
 */
const mapSessionsToGroupNames = (
  sessions: readonly Session[],
): ReadonlyMap<string, { readonly groupName: string; readonly askerLabel: string | null }> => {
  const names = new Map<string, { groupName: string; askerLabel: string | null }>();
  for (const group of buildSessionGroups(sessions)) {
    const labels = labelWorkspaceSessions(group.sessions);
    for (const session of group.sessions) {
      names.set(session.id, {
        groupName: group.lead.title,
        askerLabel:
          group.sessions.length === 1 || session.id === group.lead.id
            ? null
            : (labels.get(session.id) ?? null),
      });
    }
  }
  return names;
};

/**
 * Returns every Thread and Agent session in `sessions`, and every assistant
 * in `assistantRows`, whose session has an open Request, each with its open
 * Requests. An assistant's session is the one on its row; an assistant with
 * no session waits on nothing.
 *
 * - Sessions of other kinds are ignored. When `sessions` holds a session
 *   twice, the last read wins.
 * - A Thread marked Done is listed while it waits, because a question must
 *   never hide.
 * - A session's entry names its group, the sidebar row that holds it, and
 *   what the session is called in it. A session with no group is named by its
 *   own title.
 *
 * The list is sorted with the most recently active first, sessions and
 * assistants mixed, and two entries active at the same moment by session id.
 */
export const listWaiting = (
  sessions: readonly Session[],
  assistantRows: readonly AssistantRow[],
): Waiting[] => {
  const latestReads = new Map(sessions.map((session) => [session.id, session]));
  const threads = [...latestReads.values()].filter(
    (session) => session.kind === "thread" || session.kind === "agent",
  );
  const groupNames = mapSessionsToGroupNames(threads);
  return [
    ...threads.flatMap((session): Waiting[] => {
      const fields = buildRequestFields(session);
      if (fields === null) return [];
      const names = groupNames.get(session.id) ?? { groupName: session.title, askerLabel: null };
      return [{ kind: "thread", title: session.title, ...names, ...fields }];
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
};

/** A run's session waiting on the user: an agent step that asks something. */
export interface WaitingRunSession {
  readonly sessionId: string;
  /** The run whose agent step started the session. */
  readonly runId: string;
  /** The agent step that started the session, or null for a session that is no step's. */
  readonly stepId: string | null;
  /** The session's title, "<workflow name> · <step id>". */
  readonly title: string;
  /** What the oldest open Request asks, in one line, such as "Run git push?". */
  readonly question: string;
  /** When the session was last active. */
  readonly activityAt: string;
}

/**
 * Returns every session in `sessions` that belongs to a run and has an open
 * Request, with the question of its oldest Request. Sessions of no run, such
 * as an assistant's, are left out.
 *
 * The list is sorted with the most recently active first, and two sessions
 * active at the same moment by session id, as `listWaiting` sorts.
 * `sessions` is expected to hold live sessions only: the read that feeds it
 * asks the controller for those.
 */
export const listWaitingRunSessions = (sessions: readonly Session[]): WaitingRunSession[] =>
  sessions
    .flatMap((session): WaitingRunSession[] => {
      const oldest = findOldestOpenRequest(session);
      // A run's session always has its run's id; the check narrows the type.
      return session.kind !== "run" || session.runId === null || oldest === null
        ? []
        : [
            {
              sessionId: session.id,
              runId: session.runId,
              stepId: session.stepId,
              title: session.title,
              question: formatRequestQuestion(oldest),
              activityAt: session.lastActivityAt,
            },
          ];
    })
    .sort((a, b) =>
      compareNewestFirst(
        { activityAt: a.activityAt, id: a.sessionId },
        { activityAt: b.activityAt, id: b.sessionId },
      ),
    );
