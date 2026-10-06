import type { JSX } from "react";
import type { HerculeClient } from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";

/**
 * The card that takes the composer's place on a subagent's page, because a
 * subagent takes no messages: its state and duration, who started it, its
 * tokens, Stop while it runs, and Open parent (spec 14 §Subagents on the
 * thread surface).
 *
 * Not built yet: it renders nothing.
 */
export const StatusCard: (props: {
  readonly client: HerculeClient;
  readonly session: Session;
  /** Every subagent of the session, oldest first. */
  readonly subagents: readonly Subagent[];
  /** The subagent whose page this is. */
  readonly subagent: Subagent;
}) => JSX.Element | null = () => null;
