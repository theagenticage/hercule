import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AgentPage } from "../../../../../screens/thread/agent-page";

/**
 * The thread's own page: the transcript of the session's own agent, with the
 * composer at the bottom. The thread's layout route reads everything the
 * page shows before it renders.
 */
export const Route = createFileRoute("/_connected/_shell/threads/$sessionId/")({
  staticData: { title: "Thread" },
  component: ThreadPage,
});

function ThreadPage(): JSX.Element {
  const { sessionId } = Route.useParams();
  // Keyed by the session id, so another thread starts with fresh state: its
  // own live tail, scroll position and expanded work stretches. The router
  // does not mount the page again when only the param changes.
  return <AgentPage key={sessionId} sessionId={sessionId} subagentId={undefined} />;
}
