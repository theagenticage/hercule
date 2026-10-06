import type { JSX } from "react";
import type { HerculeClient } from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";
import { PermissionCard } from "./permission-card";

/**
 * The dock above the composer, or above a subagent's status card, that shows
 * one open Request at a time, the oldest first. On the thread's page it
 * shows every open Request of the session; on a subagent's page, only that
 * subagent's own. Renders nothing while no Request is open.
 */
export function RequestDock({
  client,
  session,
  subagentId,
}: {
  readonly client: HerculeClient;
  readonly session: Session;
  /** Every subagent of the session, oldest first, which name the agent that asks. */
  readonly subagents: readonly Subagent[];
  /** The subagent whose page this is; undefined on the thread's own page. */
  readonly subagentId: string | undefined;
}): JSX.Element | null {
  const request =
    subagentId === undefined
      ? session.openRequests[0]
      : session.openRequests.find((each) => each.subagentId === subagentId);
  return request === undefined ? null : (
    <PermissionCard
      // A new request gets a new card, so the answered state of the previous
      // request is not carried over.
      key={request.requestId}
      client={client}
      sessionId={session.id}
      request={request}
    />
  );
}
