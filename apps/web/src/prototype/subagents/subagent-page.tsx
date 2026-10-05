/**
 * PROTOTYPE (#354), throwaway. A subagent's page, which takes the thread's
 * place in the main column: a crumb from the thread down to it, its mark,
 * name and an uppercase SUBAGENT label, the brief its parent gave it, its
 * transcript, and a status card where the thread has its composer, because a
 * subagent takes no messages.
 *
 * The desktop page tints its crumb in the subagent's hue. The web has no
 * per-agent hues, and its design language keeps color at word and dot scale,
 * so the web page says what it is in words: the SUBAGENT label in the header
 * and the status card at the foot.
 */
import { useLayoutEffect, useState, type JSX, type ReactNode } from "react";
import { buildTurns, chooseStamps, type HerculeClient } from "@hercule/client-core";
import { buildButtonClassName, cn } from "@hercule/ui";
import { ContentColumn } from "../../screens/content-column";
import { HeaderRow } from "../../screens/header-row";
import { PermissionCard } from "../../screens/thread/permission-card";
import { Turn } from "../../screens/thread/turn";
import { THREAD_ID, type ProtoSubagent } from "./fixture";
import { chooseStateHue, PaneToggle, SubagentMark, SubagentName, TallyPill } from "./parts";
import { StopPill } from "./side-pane";
import {
  formatTokens,
  hasOpenRequest,
  listAncestors,
  listDescendants,
  listOpenRequests,
  listSubagents,
  measureSubagent,
  nameSubagent,
  open,
  SCENARIO,
  stopSubagent,
  useProto,
} from "./store";

const TIMEZONE = "Europe/Amsterdam";

/** Returns the open subagent's page, or `thread` when no subagent is open. */
export function SubagentPageOrThread({
  client,
  thread,
}: {
  readonly client: HerculeClient;
  readonly thread: ReactNode;
}): ReactNode {
  const s = useProto();
  const sub = listSubagents(s).find((each) => each.id === s.open);
  return sub === undefined ? thread : <SubagentPage key={sub.id} client={client} sub={sub} />;
}

function SubagentPage({
  client,
  sub,
}: {
  readonly client: HerculeClient;
  readonly sub: ProtoSubagent;
}): JSX.Element {
  const s = useProto();
  const subagents = listSubagents(s);
  const ancestors = listAncestors(subagents, sub);
  const parent = ancestors.at(-1);
  const waiting = hasOpenRequest(s, sub.id);
  const request = listOpenRequests(s).find((each) => each.subagentId === sub.id);
  const turns = buildTurns(sub.rows, request?.request.itemId);
  const stamps = chooseStamps(
    turns.map((turn) => turn.startedAt),
    TIMEZONE,
  );

  // A subagent's page opens at its top, where the brief is.
  useLayoutEffect(() => {
    document.querySelector("main")?.scrollTo({ top: 0 });
  }, []);

  return (
    <div className="flex flex-1 flex-col">
      <HeaderRow
        crumb={
          <>
            <CrumbButton onClick={() => open(null)}>{SCENARIO.session.title}</CrumbButton>
            {ancestors.map((each) => (
              <span key={each.id}>
                {" / "}
                <CrumbButton onClick={() => open(each.id)}>{nameSubagent(each)}</CrumbButton>
              </span>
            ))}
          </>
        }
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="flex w-3 shrink-0 justify-center">
              <SubagentMark sub={sub} waiting={waiting} />
            </span>
            <SubagentName sub={sub} />
            <span className="shrink-0 text-label font-emph tracking-[0.1em] text-faint uppercase">
              Subagent
            </span>
          </span>
        }
        actions={<PaneToggle />}
      />
      <ContentColumn className="gap-6">
        <div className="flex flex-1 flex-col gap-6 pb-4">
          <Brief sub={sub} parent={parent} />
          {turns.map((turn, index) => {
            const isLive =
              sub.status === "running" && index === turns.length - 1 && turn.duration === null;
            return <Turn key={turn.turnId} turn={turn} live={isLive} stamp={stamps[index]} />;
          })}
        </div>
        <div className="sticky bottom-0 flex flex-col gap-2">
          <TallyPill />
          <div className="flex flex-col">
            {request === undefined ? null : (
              <PermissionCard
                key={request.request.requestId}
                client={client}
                sessionId={THREAD_ID}
                request={request.request}
              />
            )}
            <StatusCard sub={sub} parent={parent} waiting={waiting} />
          </div>
        </div>
      </ContentColumn>
    </div>
  );
}

/** Renders a link-like button in the header's crumb, cut to one short line. */
function CrumbButton({
  onClick,
  children,
}: {
  readonly onClick: () => void;
  readonly children: string;
}): JSX.Element {
  return (
    <button
      type="button"
      title={children}
      onClick={onClick}
      className="inline-block max-w-[120px] cursor-pointer truncate align-bottom hover:text-ink"
    >
      {children}
    </button>
  );
}

/** Renders the brief the subagent got from its parent, cut to three lines until clicked. */
function Brief({
  sub,
  parent,
}: {
  readonly sub: ProtoSubagent;
  readonly parent: ProtoSubagent | undefined;
}): JSX.Element {
  const [whole, setWhole] = useState(false);
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-line-soft bg-surface px-3.5 py-2.5">
      <span className="text-meta text-muted">
        Brief from{" "}
        <span className="font-emph text-ink">
          {parent === undefined ? "the main agent" : nameSubagent(parent)}
        </span>{" "}
        · <span className="font-mono text-fine">{sub.agentType}</span> agent
      </span>
      <p
        onClick={() => setWhole(!whole)}
        className={cn("cursor-pointer text-row text-ink", !whole && "line-clamp-3")}
      >
        {sub.brief}
      </p>
    </div>
  );
}

/**
 * Renders the card in the composer's place: how the subagent stands, whose
 * subagent it is, and that it takes no messages, with Stop while it runs and
 * a way to its parent.
 */
function StatusCard({
  sub,
  parent,
  waiting,
}: {
  readonly sub: ProtoSubagent;
  readonly parent: ProtoSubagent | undefined;
  readonly waiting: boolean;
}): JSX.Element {
  const s = useProto();
  const below = listDescendants(listSubagents(s), sub.id).length;
  const span = measureSubagent(sub);
  const state =
    sub.status === "running"
      ? waiting
        ? "Waiting on you"
        : `Working for ${span}`
      : sub.status === "completed"
        ? `Done in ${span}`
        : sub.status === "failed"
          ? `Failed after ${span}`
          : `Stopped after ${span}`;
  return (
    <div className="relative z-[1] flex items-center gap-3 rounded-[14px] border border-line bg-raised py-2 pr-2.5 pl-3.5 shadow-lift">
      {/* Two lines on purpose: the state on the first, in its hue, and what
          the page is on the second, so neither wraps mid-phrase. */}
      <p className="flex min-w-0 flex-1 flex-col">
        <span className={cn("text-body font-emph", chooseStateHue(sub, waiting))}>{state}</span>
        <span className="truncate text-meta text-muted">
          Subagent of {parent === undefined ? "the main agent" : nameSubagent(parent)} ·{" "}
          {formatTokens(sub.tokens)} tokens · takes no messages
        </span>
      </p>
      <div className="flex h-7 shrink-0 items-center gap-1.5">
        {sub.status === "running" ? (
          <StopPill
            label={below > 0 ? `Stop with ${String(below)} below` : "Stop"}
            title={below > 0 ? `Also stops the ${String(below)} subagents it started` : undefined}
            onStop={() => stopSubagent(sub.id)}
          />
        ) : null}
        <button
          type="button"
          onClick={() => open(parent?.id ?? null)}
          className={buildButtonClassName("primary", undefined)}
        >
          Open parent
        </button>
      </div>
    </div>
  );
}
