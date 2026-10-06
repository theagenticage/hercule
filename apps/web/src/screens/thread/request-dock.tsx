import { useState, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { buildRequestDock, type HerculeClient, type RequestAsker } from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";
import { PermissionCard } from "./permission-card";

/**
 * Renders the dock above the composer, or above a subagent's status card,
 * that shows one open Request at a time, the oldest first. Renders nothing
 * while no Request is open.
 *
 * - On the thread's page it pages through every open Request of the session,
 *   whoever asked. The line above the card pages ("‹ 1 of 2 ›") and names
 *   the subagent that asks, with a link to its page, because there the user
 *   can stop that subagent.
 * - On a subagent's page it pages through that subagent's own Requests only,
 *   and the line has the arrows alone, because the page already names the
 *   subagent.
 *
 * The shown Request is remembered by its id, so a Request that opens or
 * closes elsewhere does not move the user off the one they are reading. When
 * the shown Request closes, the dock goes back to the oldest open one.
 */
export function RequestDock({
  client,
  session,
  subagents,
  subagent,
}: {
  readonly client: HerculeClient;
  readonly session: Session;
  /** Every subagent of the session, oldest first, which name the agent that asks. */
  readonly subagents: readonly Subagent[];
  /** The subagent whose page this is; undefined on the thread's own page. */
  readonly subagent: Subagent | undefined;
}): JSX.Element | null {
  const [shownRequestId, setShownRequestId] = useState<string | undefined>(undefined);
  // The Requests the user has sent an answer to. The card of a Request
  // unmounts when the user pages away, so the dock remembers the answer:
  // paging back must not offer a second answer while the controller has not
  // yet closed the Request.
  const [answeredRequestIds, setAnsweredRequestIds] = useState<ReadonlySet<string>>(new Set());
  const dock = buildRequestDock(session.openRequests, subagents, subagent?.id, shownRequestId);
  if (dock === null) return null;
  const { requestId } = dock.request;
  return (
    <>
      {dock.showsAskerLine ? (
        <div className="mx-3.5 flex items-center gap-1.5 px-3 pb-1.5 text-fine text-muted">
          {dock.position === null ? null : (
            <span className="flex shrink-0 items-center gap-0.5">
              <PagerButton
                label="Previous Request"
                requestId={dock.previousRequestId}
                onShow={setShownRequestId}
              >
                ‹
              </PagerButton>
              <span className="font-mono tabular-nums">
                {dock.position.at} of {dock.position.of}
              </span>
              <PagerButton
                label="Next Request"
                requestId={dock.nextRequestId}
                onShow={setShownRequestId}
              >
                ›
              </PagerButton>
            </span>
          )}
          {dock.asker === null ? null : <Asker sessionId={session.id} asker={dock.asker} />}
        </div>
      ) : null}
      <PermissionCard
        // A new request gets a new card, so the draft and the error of the
        // previous request are not carried over.
        key={requestId}
        client={client}
        sessionId={session.id}
        request={dock.request}
        answered={answeredRequestIds.has(requestId)}
        onAnsweredChange={(answered) => {
          setAnsweredRequestIds((ids) => {
            const next = new Set(ids);
            if (answered) next.add(requestId);
            else next.delete(requestId);
            return next;
          });
        }}
      />
    </>
  );
}

/**
 * Renders who asks the shown Request: "<subagent> asks · subagent of
 * <parent>" with a link to the subagent's page, or "The main agent asks".
 */
function Asker({
  sessionId,
  asker,
}: {
  readonly sessionId: string;
  readonly asker: RequestAsker;
}): JSX.Element {
  if (asker.kind === "main agent") {
    return <span className="min-w-0 truncate">The main agent asks</span>;
  }
  return (
    <>
      <span className="min-w-0 truncate">
        <span className="font-emph text-ink">{asker.name}</span> asks
        {/* The parent is unknown while the asker's record has not been read. */}
        {asker.parentName === null ? null : ` · subagent of ${asker.parentName}`}
      </span>
      <Link
        to="/threads/$sessionId/subagents/$subagentId"
        params={{ sessionId, subagentId: asker.subagentId }}
        className="ml-auto shrink-0 rounded-control px-1.5 py-0.5 font-emph text-ink hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-live"
      >
        Open subagent
      </Link>
    </>
  );
}

/** Renders one arrow of the pager; it is disabled when there is no Request that way. */
function PagerButton({
  label,
  requestId,
  onShow,
  children,
}: {
  readonly label: string;
  /** The Request the arrow shows; undefined at either end. */
  readonly requestId: string | undefined;
  readonly onShow: (requestId: string) => void;
  readonly children: string;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={requestId === undefined}
      onClick={() => {
        if (requestId !== undefined) onShow(requestId);
      }}
      className="flex size-5 cursor-pointer items-center justify-center rounded-control text-body leading-none enabled:hover:bg-line-soft enabled:hover:text-ink focus-visible:outline-2 focus-visible:outline-live disabled:cursor-not-allowed disabled:text-faint"
    >
      {children}
    </button>
  );
}
