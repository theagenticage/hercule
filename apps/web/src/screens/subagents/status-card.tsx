import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { describeStatusCard, readErrorMessage, type HerculeClient } from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";
import { buildButtonClassName, cn } from "@hercule/ui";
import { StopButton } from "../stop-button";
import { useDurationClock } from "../use-duration-clock";
import { useStopAgent } from "../use-stop-agent";
import { SUBAGENT_HUE_CLASSES } from "./subagent-mark";

/**
 * Renders the card that takes the composer's place on a subagent's page,
 * because a subagent takes no messages (spec 14 §Subagents on the thread
 * surface). It shows:
 *
 * - how the subagent stands, such as "Working for 16m 2s", in its state's hue;
 * - who started it, its tokens, and that it takes no messages;
 * - Stop while it runs, which also stops every subagent below it;
 * - Open parent, to the subagent that started it or to the thread.
 *
 * Stop is how the user turns down a subagent's question, which offers no
 * decision of its own, so the card keeps it even while the main agent is
 * idle.
 */
export function StatusCard({
  client,
  session,
  subagents,
  subagent,
}: {
  readonly client: HerculeClient;
  readonly session: Session;
  /** Every subagent of the session, oldest first. */
  readonly subagents: readonly Subagent[];
  /** The subagent whose page this is. */
  readonly subagent: Subagent;
}): JSX.Element {
  const now = useDurationClock(subagent.status === "running" ? [subagent.startedAt] : []);
  const card = describeStatusCard(subagent, subagents, session, now);
  const stopAgent = useStopAgent(client, session.id);
  return (
    <div className="relative z-[1] flex items-center gap-3 rounded-[14px] border border-line bg-raised py-2 pr-2.5 pl-3.5 shadow-lift">
      {/* The state is on the first line, in its hue, and what the page is on
          the second. The second line wraps rather than being cut, because a
          narrow column with the side pane open has no room for all of it. */}
      <p className="flex min-w-0 flex-1 flex-col">
        <span className={cn("text-body font-emph", SUBAGENT_HUE_CLASSES[card.hue])}>
          {card.headline}
        </span>
        <span className="text-meta text-muted">{card.detail}</span>
        {stopAgent.error === null ? null : (
          <span role="alert" className="text-meta text-fail">
            {readErrorMessage(stopAgent.error)}
          </span>
        )}
      </p>
      <div className="flex h-7 shrink-0 items-center gap-1.5">
        {card.stop === null ? null : (
          <StopButton
            label={card.stop.label}
            {...(card.stop.title === undefined ? {} : { title: card.stop.title })}
            onStop={() => {
              stopAgent.stop(subagent.id);
            }}
          />
        )}
        {card.parentSubagentId === undefined ? (
          <Link
            to="/threads/$sessionId"
            params={{ sessionId: session.id }}
            className={buildButtonClassName("primary", undefined)}
          >
            Open parent
          </Link>
        ) : (
          <Link
            to="/threads/$sessionId/subagents/$subagentId"
            params={{ sessionId: session.id, subagentId: card.parentSubagentId }}
            className={buildButtonClassName("primary", undefined)}
          >
            Open parent
          </Link>
        )}
      </div>
    </div>
  );
}
