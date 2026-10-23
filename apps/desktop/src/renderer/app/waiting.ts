/**
 * Reads what waits on the user, for Waiting on you, the Go menu, the dock
 * badge and the notifications.
 */
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  listWaiting,
  listWaitingRunSessions,
  type Waiting,
  type WaitingRunSession,
} from "@hercule/client-core";
import { useAssistantRows } from "./assistant-rows";
import { liveAgentSessionsQuery, threadAndAgentSessionsQuery } from "./queries";

/**
 * Returns the Threads, the Agents' sessions and the assistants waiting on the
 * user, most recently active first, as `listWaiting` builds them from the
 * sidebar's sessions and `useAssistantRows`. Every place that shows what waits reads it here, so
 * they always agree.
 */
export function useWaiting(): Waiting[] {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const sessions = useSuspenseQuery(threadAndAgentSessionsQuery(client)).data;
  return listWaiting(sessions, useAssistantRows());
}

/**
 * Returns the sessions of runs waiting on the user, most recently active
 * first, as `listWaitingRunSessions` builds them. Waiting on you lists them
 * under "From runs". The Go menu, the dock badge and the notifications leave
 * them out (spec 17 §Native behaviour), so they are not part of `useWaiting`.
 *
 * The list keeps its identity while its entries stay the same, also when
 * another session of the read changes, because Query keeps the previous
 * result of the selector when the new one is equal to it.
 */
export function useWaitingRunSessions(): WaitingRunSession[] {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  return useSuspenseQuery({
    ...liveAgentSessionsQuery(client),
    select: listWaitingRunSessions,
  }).data;
}
