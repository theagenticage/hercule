import { useCallback, useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { describeSender, type SenderReading } from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import {
  assistantsQuery,
  liveAgentSessionsQuery,
  senderSessionQuery,
  threadAndAgentSessionsQuery,
} from "../../app/queries";

/**
 * Returns how to show the agent of session `senderSessionId` as the sender of
 * a message or a queued input, or `"loading"` while the sender is still being
 * read. The web app's hook of the same name returns the same values.
 *
 * The read never suspends and never throws: a sender whose read is slow, or
 * that first appears while the thread streams, must not hold up the
 * transcript, and a sender that cannot be read, for any reason, is shown as
 * "Another agent" rather than as an error.
 *
 * The sender's session comes from the shell's session lists when they hold
 * it, which is the usual case: they follow every `session` push, so a title
 * generated after the session started shows up, and they cost no request. A
 * sender they do not hold (archived, deleted, another user's) is read once
 * with `senderSessionQuery`, and the thread's loader usually makes that read
 * before the first paint. The assistants are shell data, cached before any
 * thread opens.
 */
export function useSenderReading(senderSessionId: string): SenderReading | "loading" {
  const senderSessionIds = useMemo(() => [senderSessionId], [senderSessionId]);
  const readings = useSenderReadings(senderSessionIds);
  return readings === "loading" ? "loading" : readings[0]!;
}

/**
 * Returns how to show the agents of `senderSessionIds`, in order, or
 * `"loading"` until every one of them is known. Each follows the rules of
 * `useSenderReading`: it never suspends and never throws, and a sender that
 * cannot be read is "Another agent".
 */
export function useSenderReadings(
  senderSessionIds: readonly string[],
): readonly SenderReading[] | "loading" {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  // The lists hold the sidebar's Threads and Agent sessions and every live
  // Agent session, so each reader keeps only the sessions it needs. Query
  // compares the result by value, so a push that changes other sessions does
  // not draw the senders again.
  const selectSenders = useCallback(
    (sessions: readonly Session[]) => {
      const wanted = new Set(senderSessionIds);
      return sessions.filter((session) => wanted.has(session.id));
    },
    [senderSessionIds],
  );
  const threads = useQuery({ ...threadAndAgentSessionsQuery(client), select: selectSenders });
  const agentSessions = useQuery({ ...liveAgentSessionsQuery(client), select: selectSenders });
  const listed = new Map(
    [...(threads.data ?? []), ...(agentSessions.data ?? [])].map((session) => [
      session.id,
      session,
    ]),
  );
  const listsAnswered = !threads.isPending && !agentSessions.isPending;
  const reads = useQueries({
    queries: senderSessionIds.map((id) => ({
      ...senderSessionQuery(client, id),
      // Nothing is read for a sender the lists hold, and nothing before the
      // lists have answered, so a list that is about to hold it costs no request.
      enabled: listsAnswered && !listed.has(id),
    })),
  });
  const assistants = useQuery(assistantsQuery(client));
  // Until every session and the assistants are known, the name is not:
  // showing the session's title first and the assistant's name a moment
  // later, or "Another agent" before the read lands, would print a name that
  // is wrong. A partial list would print names in the wrong places, too.
  if (
    !listsAnswered ||
    assistants.isPending ||
    senderSessionIds.some((id, index) => !listed.has(id) && reads[index]!.isPending)
  ) {
    return "loading";
  }
  return senderSessionIds.map((id, index) =>
    describeSender(id, listed.get(id) ?? reads[index]!.data ?? null, assistants.data ?? []),
  );
}
