/**
 * The Request dock of one agent's page: the dock of the shown Request, and
 * above it the pager line that pages between the open Requests and names
 * the agent that asked (spec 17 §Thread, Subagents).
 */
import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildRequestDock } from "@hercule/client-core";
import { sessionQuery, subagentsQuery } from "../../app/queries";
import { useShownRequestId } from "../../app/request-drafts";
import { buildLook } from "../../faces";
import { RequestDock } from "../session/dock";
import { RequestPager } from "../session/request-pager";

/**
 * Renders the dock of the Request `buildRequestDock` decides the page
 * shows, or nothing while no Request is open.
 *
 * - `sessionId` is the thread's session.
 * - `pageSubagentId` is the subagent whose page this is, whose own Requests
 *   are the only ones paged; undefined on the main agent's page, which
 *   pages through every open Request of the session.
 *
 * The pager line is drawn when `buildRequestDock` says so: when several
 * Requests are open, or when a subagent asked the one shown. Paging is kept
 * in the thread's drafts (`useShownRequestId`), so the shown Request is the
 * same on the thread's other pages.
 */
export function AgentRequestDock({
  sessionId,
  pageSubagentId,
}: {
  readonly sessionId: string;
  readonly pageSubagentId: string | undefined;
}): JSX.Element | null {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const subagents = useSuspenseQuery(subagentsQuery(client, sessionId)).data;
  const [shownRequestId, setShownRequestId] = useShownRequestId(sessionId);
  const dock = buildRequestDock(session.openRequests, subagents, pageSubagentId, shownRequestId);
  if (dock === null) return null;
  return (
    <>
      {dock.showsAskerLine ? (
        <RequestPager
          sessionId={sessionId}
          dock={dock}
          asker={dock.asker}
          onShow={setShownRequestId}
        />
      ) : null}
      <RequestDock
        key={dock.request.requestId}
        sessionId={sessionId}
        look={buildLook(sessionId)}
        request={dock.request}
      />
    </>
  );
}
