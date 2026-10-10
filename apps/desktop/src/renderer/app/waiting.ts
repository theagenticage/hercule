/**
 * Reads what waits on the user, for Waiting on you, the Go menu, the dock
 * badge and the notifications.
 */
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { listWaiting, type Waiting, type WaitingThread } from "@hercule/client-core";
import { waitingRunSessionsQuery } from "../screens/workflows/workflow-queries";
import { useAssistantRows } from "./assistant-rows";
import { threadsQuery } from "./queries";

/**
 * Returns the threads and the assistants waiting on the user, most recently
 * active first, as `listWaiting` builds them from the thread list and
 * `useAssistantRows`. Every place that shows what waits reads it here, so
 * they always agree.
 */
export function useWaiting(): Waiting[] {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const threads = useSuspenseQuery(threadsQuery(client)).data;
  return listWaiting(threads, useAssistantRows());
}

/**
 * PROTOTYPE. Returns the sessions of runs that wait on the user, most
 * recently active first, each built as `listWaiting` builds a thread's
 * entry: its title, which for a run's agent step is "<workflow name> ·
 * <step id>", and its oldest open Request as one question. Waiting on you
 * lists them under "From runs".
 *
 * The read needs a filter `session.query` does not have yet (see
 * workflow-queries.ts), so it is disabled and never runs: outside a
 * specimen, which seeds the cache, the list is empty. The Workflows ticket
 * makes it a read the shell's loader makes, and decides whether the dock
 * badge, the notifications and the Go menu count these runs too. Until
 * then they count threads and assistants only, as `useWaiting` returns
 * them.
 */
export function useWaitingRuns(): WaitingThread[] {
  const sessions = useQuery({ ...waitingRunSessionsQuery(), enabled: false }).data ?? [];
  return listWaiting(sessions, []).filter((entry) => entry.kind === "thread");
}
