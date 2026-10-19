import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { liveAgentSessionsQuery, threadsQuery } from "../../app/queries";
import { ThreadHeader } from "./thread-header";
import "./opening.css";

/**
 * Renders the screen shown while the thread `sessionId` opens: the thread's
 * header, drawn from the session record in the sidebar's lists, and one quiet
 * line where the transcript will be. The sidebar marks the clicked thread at
 * once, so the screen names the same thread rather than leaving the previous
 * one on display until the transcript has been read.
 *
 * A session in neither list, such as an archived one opened from a link,
 * has no header here: only the line shows until its own read answers.
 *
 * The lists are shell data, cached before any thread opens, so nothing here
 * waits.
 */
export function ThreadOpening({ sessionId }: { readonly sessionId: string }): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const threads = useSuspenseQuery(threadsQuery(client)).data;
  const agentSessions = useSuspenseQuery(liveAgentSessionsQuery(client)).data;
  const session =
    threads.find((each) => each.id === sessionId) ??
    agentSessions.find((each) => each.id === sessionId);

  return (
    <>
      {session === undefined ? null : <ThreadHeader session={session} />}
      <p className="thread-opening" role="status">
        Opening the thread…
      </p>
    </>
  );
}
