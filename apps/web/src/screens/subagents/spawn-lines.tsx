import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { buildSpawnLines, findSpawnedSubagents, type ThreadTurn } from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";
import { useDurationClock } from "../use-duration-clock";
import { SUBAGENT_HUE_CLASSES, SubagentMark } from "./subagent-mark";

/**
 * Renders the lines in a turn, one per subagent the turn started: `↳`, its
 * state mark, its name, its state and duration, "N below" when it started
 * subagents of its own, and "one waits on you" when one below it asks the
 * user something. A subagent that asks itself shows "waiting on you" as its
 * state instead. A line links to the subagent's page (spec 14
 * §Subagents on the thread surface). Renders nothing for a turn that started
 * no subagent.
 *
 * A running subagent's duration counts up while the line is shown.
 */
export function SpawnLines({
  session,
  subagents,
  agentSubagentId,
  turn,
}: {
  readonly session: Session;
  /** Every subagent of the session, oldest first. */
  readonly subagents: readonly Subagent[];
  /** The agent whose turn it is: a subagent's id, or undefined for the session's own agent. */
  readonly agentSubagentId: string | undefined;
  readonly turn: ThreadTurn;
}): JSX.Element | null {
  const spawned = findSpawnedSubagents(turn, agentSubagentId, subagents);
  const now = useDurationClock(
    spawned
      .filter((subagent) => subagent.status === "running")
      .map((subagent) => subagent.startedAt),
  );
  const lines = buildSpawnLines(spawned, subagents, session.openRequests, now);
  if (lines.length === 0) return null;

  return (
    <ul aria-label="Subagents started here" className="-mx-2 flex flex-col">
      {lines.map((line) => (
        <li key={line.subagentId}>
          <Link
            to="/threads/$sessionId/subagents/$subagentId"
            params={{ sessionId: session.id, subagentId: line.subagentId }}
            className="flex w-full items-center gap-2 rounded-control px-2 py-[3px] text-row hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-live"
          >
            <span aria-hidden="true" className="text-faint">
              ↳
            </span>
            <span className="flex w-3 shrink-0 justify-center">
              <SubagentMark status={line.status} waiting={line.waiting} />
            </span>
            <span title={line.name} className="min-w-0 truncate font-emph text-ink">
              {line.name}
            </span>
            <span className="shrink-0 text-meta whitespace-nowrap text-muted">
              <span className={SUBAGENT_HUE_CLASSES[line.state.hue]}>{line.state.word}</span>
              {" · "}
              <span className="font-mono text-fine tabular-nums">{line.state.duration}</span>
              {line.below > 0 ? ` · ${String(line.below)} below` : null}
              {line.waitsOnUserBelow ? (
                <span className="text-attn"> · one waits on you</span>
              ) : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
