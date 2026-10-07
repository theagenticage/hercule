/**
 * The pager line above the Request dock, which pages between a session's
 * open Requests and, on a thread, names the agent that asked (spec 17
 * §Thread, Subagents). A thread's agent page and an assistant's
 * Conversation both draw it.
 */
import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import {
  describeRequestAsker,
  type RequestAsker,
  type RequestDockState,
} from "@hercule/client-core";
import { buildHueStyle, buildLook } from "../../faces";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { buildAgentFaceSeed } from "../subagents/subagent-face";
import "./request-pager.css";

/**
 * The class of the pager line. `ComposerFrame` reads it too: a click or
 * focus on the line keeps the composer at its size, as `dock-mini`'s
 * answers do.
 */
export const REQUEST_PAGER_CLASS = "request-pager";

/**
 * Renders the pager line above the dock, as the subagents prototype's
 * `.proto-pager` draws it:
 *
 * - while several Requests are open, ‹ and › to the Request before and
 *   after, around "2 of 3", as `dock` places the shown one;
 * - when `asker` is not null, which agent asks: "The main agent asks", or a
 *   subagent's name in its hue, "asks", whose subagent it is, and a link to
 *   the subagent's page.
 *
 * `asker` is null where the page already names the agent: on a subagent's
 * page, and in an assistant's Conversation, which has one agent. Only the
 * arrows are drawn then. `sessionId` is the session whose Requests are
 * paged, and `onShow` is called with the Request an arrow shows.
 */
export function RequestPager({
  sessionId,
  dock,
  asker,
  onShow,
}: {
  readonly sessionId: string;
  readonly dock: Pick<RequestDockState, "position" | "previousRequestId" | "nextRequestId">;
  readonly asker: RequestAsker | null;
  readonly onShow: (requestId: string) => void;
}): JSX.Element {
  const { position, previousRequestId, nextRequestId } = dock;
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
