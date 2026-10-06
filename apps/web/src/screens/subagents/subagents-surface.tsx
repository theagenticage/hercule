/**
 * The Subagents surface of the side pane: every subagent of the thread,
 * running and finished, as a tree in which a subagent sits on a rail under
 * the one that started it, with a footer that sums them up. Spec 14
 * §Subagents on the thread surface owns it.
 */
import { useId, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import {
  buildSubagentTree,
  countUsedTokens,
  describeStatusCard,
  describeSubagentLine,
  describeSubagentMeta,
  describeSubagentState,
  formatTokenCount,
  isSubagentWaiting,
  nameSubagent,
  summarizeSubagents,
  type HerculeClient,
  type SubagentNode,
} from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";
import { LaneLabel, cn } from "@hercule/ui";
import { StopButton } from "../stop-button";
import { useDurationClock } from "../use-duration-clock";
import { useStopAgent } from "../use-stop-agent";
import { SUBAGENT_HUE_CLASSES, SubagentMark } from "./subagent-mark";

/** What every row of the tree reads besides its own subagent. */
interface TreeContext {
  readonly session: Session;
  readonly subagents: readonly Subagent[];
  /** The subagent whose page is open in the main pane, whose row is marked current. */
  readonly subagentId: string | undefined;
  readonly now: Date;
  readonly stop: (subagentId: string) => void;
}

/**
 * Renders the Subagents surface. With no subagents yet, it says so and what
 * will appear. The durations of running subagents count up while it shows.
 */
export function SubagentsSurface({
  client,
  session,
  subagents,
  subagentId,
}: {
  readonly client: HerculeClient;
  readonly session: Session;
  /** Every subagent of the session, oldest first. */
  readonly subagents: readonly Subagent[];
  /** The subagent whose page is open in the main pane; undefined on the thread's own page. */
  readonly subagentId: string | undefined;
}): JSX.Element {
  const running = subagents.filter((subagent) => subagent.status === "running");
  const now = useDurationClock(running.map((subagent) => subagent.startedAt));
  const stopAgent = useStopAgent(client, session.id);
  const headingId = useId();

  if (subagents.length === 0) {
    return (
      <div className="flex flex-col gap-1 px-4 pt-2 text-row">
        <p className="font-emph text-ink">No subagents yet</p>
        <p className="text-muted">
          When an agent of this thread starts subagents, each one shows here with what it is doing.
        </p>
      </div>
    );
  }

  const tree = buildSubagentTree(subagents);
  const context: TreeContext = {
    session,
    subagents,
    subagentId,
    now,
    stop: (id) => {
      stopAgent.stop(id);
    },
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4">
        <LaneLabel id={headingId} className="px-2">
          Started by the main agent · {tree.length}
        </LaneLabel>
        <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
          {tree.map((node) => (
            <SubagentRow key={node.subagent.id} node={node} context={context} />
          ))}
        </ul>
      </div>
      <div className="flex h-12 shrink-0 items-center gap-3 border-t border-line-soft px-4 text-meta text-muted">
        <span>{summarizeSubagents(subagents)}</span>
        {running.length === 0 ? null : (
          <StopButton
            label="Stop all"
            title="Stops the main agent's turn and every running subagent"
            onStop={() => {
              stopAgent.stop();
            }}
          />
        )}
        {/* The session's usage counts its own agent and every subagent. A
            harness that has reported none leaves the total out, rather
            than showing 0. */}
        {session.usage === undefined ? null : (
          <span className="ml-auto font-mono text-fine text-faint tabular-nums">
            Σ {formatTokenCount(countUsedTokens(session.usage))} tok
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Renders one subagent's row, which opens its page, and under it, on a rail,
 * the rows of the subagents it started. A running row shows Stop while the
 * pointer is over it or focus is inside it, in place of its state.
 */
function SubagentRow({
  node,
  context,
}: {
  readonly node: SubagentNode;
  readonly context: TreeContext;
}): JSX.Element {
  const { subagent, children } = node;
  const { session, subagents, now } = context;
  const waiting = isSubagentWaiting(subagent, session.openRequests);
  const state = describeSubagentState(subagent, waiting, now);
  const line = describeSubagentLine(
    subagent,
    session.openRequests.find((request) => request.subagentId === subagent.id),
  );
  // The status card's Stop and this one stop the same subagents, so they
  // share one label: "Stop", or "Stop with 2 below".
  const stop = describeStatusCard(subagent, subagents, session, now).stop;
  const current = subagent.id === context.subagentId;
  const name = nameSubagent(subagent);

  return (
    <li>
      <div
        className={cn(
          "group relative flex gap-2 rounded-control px-2 py-1.5 hover:bg-line-soft",
          current && "bg-line-soft",
        )}
      >
        <span className="flex h-[1lh] w-3 shrink-0 items-center justify-center text-row">
          <SubagentMark status={subagent.status} waiting={waiting} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2 text-row">
            {/* The link's box covers the whole row, so a click anywhere on
                the row opens the subagent's page, while Stop stays a
                separate button above it. */}
            <Link
              to="/threads/$sessionId/subagents/$subagentId"
              params={{ sessionId: session.id, subagentId: subagent.id }}
              aria-current={current ? "page" : undefined}
              title={name}
              className={cn(
                "min-w-0 truncate font-emph text-ink outline-none",
                "after:absolute after:inset-0 after:rounded-control",
                "focus-visible:after:outline-2 focus-visible:after:outline-live",
              )}
            >
              {name}
            </Link>
            <span
              className={cn(
                "ml-auto shrink-0 text-meta whitespace-nowrap",
                stop !== null && "group-focus-within:opacity-0 group-hover:opacity-0",
              )}
            >
              <span className={SUBAGENT_HUE_CLASSES[state.hue]}>{state.word}</span>
              <span className="text-faint"> · </span>
              <span className="font-mono text-fine text-muted tabular-nums">{state.duration}</span>
            </span>
          </span>
          {line === null ? null : (
            <span className={cn("truncate text-meta", SUBAGENT_HUE_CLASSES[line.hue])}>
              {line.text}
            </span>
          )}
          <span className="truncate font-mono text-fine text-faint tabular-nums">
            {describeSubagentMeta(subagent)}
          </span>
        </span>
        {stop === null ? null : (
          // The pill is taller than the first line, so it is centred on that
          // line and overhangs the row's padding rather than growing the row.
          <span className="absolute top-0.5 right-2 z-10 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
            <StopButton
              label={stop.label}
              title={stop.title}
              onStop={() => {
                context.stop(subagent.id);
              }}
            />
          </span>
        )}
      </div>
      {children.length === 0 ? null : (
        <ul className="mt-0.5 ml-[13px] flex flex-col gap-0.5 border-l border-line-soft pl-1.5">
          {children.map((child) => (
            <SubagentRow key={child.subagent.id} node={child} context={context} />
          ))}
        </ul>
      )}
    </li>
  );
}
