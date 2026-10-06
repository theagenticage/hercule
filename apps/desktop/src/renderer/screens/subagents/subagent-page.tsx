/**
 * A subagent's page: the agent page of the subagent, with its own header,
 * the brief card above its transcript and its status card in the
 * composer's place.
 *
 * Only the subagent's route imports this module, so the header, the brief
 * card and the status card load the first time a subagent's page opens, not
 * with the thread's page (spec 17 §What subagents cost).
 */
import type { JSX } from "react";
import { AgentPage, type DrawSubagentParts } from "../thread/agent-page";
import { AgentRequestDock } from "../thread/agent-request-dock";
import { BriefCard } from "./brief-card";
import { StatusCard } from "./status-card";
import { SubagentHeader } from "./subagent-header";
import { TallyPill } from "./tally-pill";

/**
 * Renders the page of the subagent `subagentId` of the thread `sessionId`.
 * Mount it keyed by `<sessionId>/<subagentId>`, for the reason `AgentPage`
 * gives. Fails with `notFound` when the session has no such subagent.
 */
export function SubagentPage({
  sessionId,
  subagentId,
}: {
  readonly sessionId: string;
  readonly subagentId: string;
}): JSX.Element {
  return (
    <AgentPage
      sessionId={sessionId}
      subagentId={subagentId}
      drawSubagentParts={drawSubagentParts}
    />
  );
}

/**
 * Returns the header, the brief card, and the stack in the composer's
 * place: the tally pill, the dock of the subagent's own Requests, and the
 * status card.
 */
const drawSubagentParts: DrawSubagentParts = ({ session, subagent, subagents, brief }) => ({
  header: <SubagentHeader session={session} subagent={subagent} subagents={subagents} />,
  lead: <BriefCard subagent={subagent} subagents={subagents} brief={brief} />,
  bottom: (
    <>
      <div className="fold tally-fold">
        <TallyPill sessionId={subagent.sessionId} />
      </div>
      <AgentRequestDock sessionId={subagent.sessionId} pageSubagentId={subagent.id} />
      <StatusCard subagent={subagent} subagents={subagents} openRequests={session.openRequests} />
    </>
  ),
});
