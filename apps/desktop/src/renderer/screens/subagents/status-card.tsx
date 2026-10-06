/**
 * The status card: what takes the composer's place on a subagent's page,
 * because a subagent takes no messages (spec 14 §Subagents on the thread
 * surface, spec 17 §Thread, Subagents).
 */
import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, linkOptions, notFound, useRouteContext } from "@tanstack/react-router";
import { describeStatusCard, isSubagentWaiting, readErrorMessage } from "@hercule/client-core";
import { ageClock, useDurationText } from "../../app/age-clock";
import { sessionQuery, subagentsQuery } from "../../app/queries";
import { StopIcon } from "../../icons/stop";
import { useStopAgent } from "../use-stop-agent";
import { SubagentFace } from "./subagent-face";
import "./status-card.css";

/** The size of the subagent's face on the card, in CSS pixels, as the prototype draws it. */
const FACE_SIZE = 26;

/**
 * Renders the status card of the subagent `subagentId` of the thread
 * `sessionId`. It shows:
 *
 * - the subagent's face, still;
 * - how the subagent stands, such as "Working for 16m 2s", kept current
 *   while it runs, and coloured for waiting and failed;
 * - who started it, its tokens, and that it takes no messages;
 * - Open parent, to the page of the subagent that started it, or to the
 *   thread's own page when the session's own agent started it;
 * - Stop while it runs, which also stops every subagent below it. When a
 *   Stop fails, the card shows the error's message under the words.
 *
 * Stop is how the user turns down a subagent's question, so the card keeps
 * it even while the main agent is idle.
 *
 * The card reads the session and its subagents itself, because it owns the
 * Stop that acts on them. Both are in the cache before it renders, read by
 * the thread's loader. Fails with `notFound` when the session has no
 * subagent `subagentId`.
 */
export function StatusCard({
  sessionId,
  subagentId,
}: {
  readonly sessionId: string;
  readonly subagentId: string;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { openRequests } = useSuspenseQuery(sessionQuery(controller.client, sessionId)).data;
  const subagents = useSuspenseQuery(subagentsQuery(controller.client, sessionId)).data;
  const subagent = subagents.find((each) => each.id === subagentId);
  // The subagent's page has already checked that the subagent exists, and a
  // subagent record is never deleted, so this only guards the type.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (subagent === undefined) throw notFound();
  const stopAgent = useStopAgent(controller.client, sessionId);
  const headline = useDurationText(
    subagent.startedAt,
    subagent.status === "running",
    (now) => describeStatusCard(subagent, subagents, openRequests, new Date(now)).headline,
  );
  // The headline above keeps itself current. The rest of the card does not
  // change with the time, so it is read at the age clock's last reading.
  const card = describeStatusCard(subagent, subagents, openRequests, ageClock.readNow());
  const parentLink =
    subagent.parentSubagentId === undefined
      ? linkOptions({ to: "/threads/$sessionId", params: { sessionId: subagent.sessionId } })
      : linkOptions({
          to: "/threads/$sessionId/subagents/$subagentId",
          params: { sessionId: subagent.sessionId, subagentId: subagent.parentSubagentId },
        });

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
      <Link {...parentLink} className="btn btn--sm">
        Open parent
      </Link>
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
