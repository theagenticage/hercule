/**
 * The Request dock of one agent's page: the dock of the shown Request, and
 * above it the pager line that pages between the open Requests and names
 * the agent that asked (spec 17 §Thread, Subagents).
 */
import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import {
  buildRequestDock,
  describeRequestAsker,
  type RequestAsker,
  type RequestDockState,
} from "@hercule/client-core";
import { sessionQuery, subagentsQuery } from "../../app/queries";
import { useShownRequestId } from "../../app/thread-drafts";
import { buildHueStyle, buildLook } from "../../faces";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { buildAgentFaceSeed } from "../subagents/subagent-face";
import { RequestDock } from "./dock";
import "./agent-request-dock.css";

/**
 * The class of the pager line. The composer reads it too: a click or focus
 * on the line keeps the composer at its size, as `dock-mini`'s answers do.
 */
export const REQUEST_PAGER_CLASS = "request-pager";

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
  const [shownRequestId, setShownRequestId] = useShownRequestId();
  const dock = buildRequestDock(session.openRequests, subagents, pageSubagentId, shownRequestId);
  if (dock === null) return null;
  return (
    <>
      {dock.showsAskerLine ? (
        <RequestPager sessionId={sessionId} dock={dock} onShow={setShownRequestId} />
      ) : null}
      <RequestDock key={dock.request.requestId} sessionId={sessionId} request={dock.request} />
    </>
  );
}

/**
 * Renders the pager line above the dock, as the subagents prototype's
 * `.proto-pager` draws it:
 *
 * - while several Requests are open, ‹ and › to the Request before and
 *   after, around "2 of 3";
 * - which agent asks: "The main agent asks", or a subagent's name in its
 *   hue, "asks", whose subagent it is, and a link to the subagent's page.
 *
 * On a subagent's page `dock.asker` is null, because the page already names
 * the subagent, and only the arrows are drawn. `onShow` is called with the
 * Request an arrow shows.
 */
function RequestPager({
  sessionId,
  dock,
  onShow,
}: {
  readonly sessionId: string;
  readonly dock: RequestDockState;
  readonly onShow: (requestId: string) => void;
}): JSX.Element {
  const { asker, position, previousRequestId, nextRequestId } = dock;
  const hue =
    asker?.kind === "subagent"
      ? buildHueStyle(buildLook(buildAgentFaceSeed(sessionId, asker.subagentId)).hue)
      : undefined;
  return (
    <div className={REQUEST_PAGER_CLASS} style={hue}>
      {position === null ? null : (
        <span className="request-pager-nav">
          <PagerButton label="Previous Request" requestId={previousRequestId} onShow={onShow}>
            <span className="request-pager-flip">
              <ChevronRightIcon size={12} />
            </span>
          </PagerButton>
          <b>
            {position.at} of {position.of}
          </b>
          <PagerButton label="Next Request" requestId={nextRequestId} onShow={onShow}>
            <ChevronRightIcon size={12} />
          </PagerButton>
        </span>
      )}
      {asker === null ? null : <AskerWords asker={asker} />}
      {asker?.kind === "subagent" ? (
        <>
          <span className="spacer" />
          <Link
            to="/threads/$sessionId/subagents/$subagentId"
            params={{ sessionId, subagentId: asker.subagentId }}
            className="request-pager-open"
          >
            Open subagent <span aria-hidden="true">›</span>
          </Link>
        </>
      ) : null}
    </div>
  );
}

/**
 * Renders which agent asks the shown Request, as `describeRequestAsker`
 * words it: a subagent's name in its hue, then "asks" and whose subagent it
 * is, or "The main agent asks".
 */
function AskerWords({ asker }: { readonly asker: RequestAsker }): JSX.Element {
  const words = describeRequestAsker(asker);
  return (
    <span className="request-pager-who">
      {words.name === null ? null : (
        <>
          <span className="request-pager-name">{words.name}</span>{" "}
        </>
      )}
      {words.asks}
      {words.parent === null ? null : (
        <span className="request-pager-parent"> · {words.parent}</span>
      )}
    </span>
  );
}

/**
 * Renders one of the pager's arrows, which shows the Request `requestId`.
 * At either end there is no such Request, and the arrow is drawn faint and
 * does nothing. It stays focusable rather than `disabled`, so a focused
 * arrow keeps the focus when it reaches the end, and the composer around it
 * does not lose it.
 */
function PagerButton({
  label,
  requestId,
  onShow,
  children,
}: {
  readonly label: string;
  readonly requestId: string | undefined;
  readonly onShow: (requestId: string) => void;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      aria-label={label}
      aria-disabled={requestId === undefined || undefined}
      onClick={() => {
        if (requestId !== undefined) onShow(requestId);
      }}
    >
      {children}
    </button>
  );
}
