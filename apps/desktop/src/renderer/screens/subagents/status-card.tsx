/**
 * The status card: what takes the composer's place on a subagent's page,
 * because a subagent takes no messages (spec 14 §Subagents on the thread
 * surface, spec 17 §Thread, Subagents).
 */
import type { JSX } from "react";
import { Link, useRouteContext } from "@tanstack/react-router";
import { describeStatusCard, isSubagentWaiting, readErrorMessage } from "@hercule/client-core";
import type { SessionRequest, Subagent } from "@hercule/contract";
import { useDurationText } from "../../app/age-clock";
import { StopIcon } from "../../icons/stop";
import { useStopAgent } from "../use-stop-agent";
import { SubagentFace } from "./subagent-face";
import "./status-card.css";

/** The size of the subagent's face on the card, in CSS pixels, as the prototype draws it. */
const FACE_SIZE = 26;

/**
 * Renders the status card of `subagent`. It shows:
 *
 * - the subagent's face, still;
 * - how the subagent stands, such as "Working for 16m 2s", kept current
 *   while it runs, and coloured for waiting and failed;
 * - who started it, its tokens, and that it takes no messages;
 * - Open parent, to the page of the subagent that started it, or to the
 *   thread's own page when the session's own agent started it;
 * - Stop while it runs, which also stops every subagent below it. A Stop
 *   that fails says why under the words.
 *
 * `subagents` are the session's subagents and `openRequests` its open
 * Requests. Stop is how the user turns down a subagent's question, so the
 * card keeps it even while the main agent is idle.
 */
export function StatusCard({
  subagent,
  subagents,
  openRequests,
}: {
  readonly subagent: Subagent;
  readonly subagents: readonly Subagent[];
  readonly openRequests: readonly SessionRequest[];
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const stopAgent = useStopAgent(controller.client, subagent.sessionId);
  const headline = useDurationText(
    subagent.startedAt,
    subagent.status === "running",
    (now) => describeStatusCard(subagent, subagents, openRequests, new Date(now)).headline,
  );
  // Everything but the headline does not depend on the time, so any moment
  // will do, and reading the clock while rendering would make the render
  // impure.
  const card = describeStatusCard(subagent, subagents, openRequests, new Date(subagent.startedAt));

  return (
    <div className="composer-card status-card">
      <SubagentFace
        subagent={subagent}
        waiting={isSubagentWaiting(subagent, openRequests)}
        size={FACE_SIZE}
      />
      <span className="status-card-text">
        <b data-hue={card.hue}>{headline}</b>
        <span>{card.detail}</span>
        {stopAgent.error === null ? null : (
          <span role="alert" className="status-card-error">
            {readErrorMessage(stopAgent.error)}
          </span>
        )}
      </span>
      {subagent.parentSubagentId === undefined ? (
        <Link
          to="/threads/$sessionId"
          params={{ sessionId: subagent.sessionId }}
          className="btn btn--sm"
        >
          Open parent
        </Link>
      ) : (
        <Link
          to="/threads/$sessionId/subagents/$subagentId"
          params={{ sessionId: subagent.sessionId, subagentId: subagent.parentSubagentId }}
          className="btn btn--sm"
        >
          Open parent
        </Link>
      )}
      {card.stop === null ? null : (
        <button
          type="button"
          className="btn btn--sm status-card-stop"
          title={card.stop.title}
          // Not `disabled`, so the button keeps the focus while the stop
          // is on its way. `stop` ignores a second click meanwhile.
          aria-disabled={stopAgent.isPending || undefined}
          onClick={() => {
            stopAgent.stop(subagent.id);
          }}
        >
          <StopIcon size={12} />
          {card.stop.label}
        </button>
      )}
    </div>
  );
}
