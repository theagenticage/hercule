/**
 * Reads what waits on the user, for Waiting on you, the Go menu, the dock
 * badge and the notifications.
 */
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { listWaiting, type Waiting } from "@hercule/client-core";
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
