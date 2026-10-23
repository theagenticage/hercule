/**
 * Reads the sessions the sidebar holds, with the open session merged in, and
 * the groups they form. The sidebar and Waiting on you (and with it the Go
 * menu, the dock badge and the notifications) both read it here, so they
 * always agree on what exists, and the grouping runs once for both.
 */
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMatch, useRouteContext } from "@tanstack/react-router";
import { buildSessionGroups, type SessionGroup } from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import { sessionQuery, threadAndAgentSessionsQuery } from "./queries";

/** The sidebar's sessions, with the open session merged in, and the groups they form. */
export interface SessionGroups {
  readonly sessions: readonly Session[];
  readonly groups: readonly SessionGroup[];
}

/** The last result of `groupSidebarSessions`, with the inputs it was built from. */
let lastGrouped: {
  readonly listed: readonly Session[];
  readonly openSession: Session | null;
  readonly result: SessionGroups;
} | null = null;

/**
 * Returns the sessions of `listed` with `openSession` added, and the groups
 * they form (`buildSessionGroups`).
 *
 * `openSession` is the open session's own record. The sidebar's read leaves
 * out a Thread marked Done more than 14 days ago, so an open one is added
 * here, and its group keeps a row on the Done shelf. A record `listed` holds
 * wins over `openSession`. A session that is not a Thread or an Agent's is
 * never added.
 *
 * The last result is kept, and returned again while `listed` and
 * `openSession` are the same objects, so every caller of one render shares
 * one grouping, and a push that changes neither groups nothing.
 */
export const groupSidebarSessions = (
  listed: readonly Session[],
  openSession: Session | null,
): SessionGroups => {
  if (lastGrouped?.listed === listed && lastGrouped.openSession === openSession) {
    return lastGrouped.result;
  }
  const merges =
    openSession !== null &&
    (openSession.kind === "thread" || openSession.kind === "agent") &&
    !listed.some((session) => session.id === openSession.id);
  const sessions = merges ? [...listed, openSession] : listed;
  const result = { sessions, groups: buildSessionGroups(sessions) };
  lastGrouped = { listed, openSession, result };
  return result;
};

/**
 * Returns the id of the session the user has open: the one on its own
 * screen, or the one in the Office's drawer, or `null` when none is open.
 */
export function useOpenSessionId(): string | null {
  // Each match is read through `select`, so a caller draws again only when the id changes.
  const threadId = useMatch({
    from: "/_connected/_shell/threads/$sessionId",
    shouldThrow: false,
    select: (match) => match.params.sessionId,
  });
  const officeId = useMatch({
    from: "/_connected/_shell/office",
    shouldThrow: false,
    select: (match) => match.search.session,
  });
  return threadId ?? officeId ?? null;
}

/**
 * Returns the sidebar's sessions, with the open session merged in, and their
 * groups, as `groupSidebarSessions` builds them.
 *
 * The open session's record is read from the cache the thread screen filled
 * and never fetched here, so this adds no read. The empty id of no open
 * session names no record.
 */
export function useSessionGroups(): SessionGroups {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const listed = useSuspenseQuery(threadAndAgentSessionsQuery(client)).data;
  const openId = useOpenSessionId();
  const openSession =
    useQuery({ ...sessionQuery(client, openId ?? ""), enabled: false }).data ?? null;
  return groupSidebarSessions(listed, openSession);
}
