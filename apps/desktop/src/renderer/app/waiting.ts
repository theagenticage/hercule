/**
 * Reads what waits on the user, for Waiting on you, the Go menu, the dock
 * badge and the notifications.
 */
import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  listWaiting,
  listWaitingRunSessions,
  type Waiting,
  type WaitingRunSession,
} from "@hercule/client-core";
import { useAssistantRows } from "./assistant-rows";
import { liveAgentSessionsQuery } from "./queries";
import { useSessionPresentation } from "./session-presentation";

/**
 * Returns the Threads, the Agents' sessions and the assistants waiting on the
 * user, most recently active first, as `listWaiting` builds them from the
 * session presentation's waiting sessions and `useAssistantRows`. The open
 * session is among the sessions, so a Done Thread marked Done long ago still
 * shows while it asks. Every place that shows what waits reads it here, so
 * they always agree.
 *
 * The assistants are added here, not in the presentation, so a change in an
 * assistant does not prepare the sessions again.
 */
export function useWaiting(): Waiting[] {
  const { waitingSessions } = useSessionPresentation();
  const assistantRows = useAssistantRows();
  return useMemo(
    () => listWaiting(waitingSessions, assistantRows),
    [waitingSessions, assistantRows],
  );
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
