import type { JSX } from "react";
import type { Session, Subagent } from "@hercule/contract";

/**
 * The pill above the composer, or above a subagent's status card, that reads
 * `Subagents · n of m running` while the thread has any subagent. A click
 * shows or hides the side pane on its Subagents surface (spec 14 §Subagents
 * on the thread surface).
 *
 * Not built yet: it renders nothing.
 */
export const TallyPill: (props: {
  readonly session: Session;
  /** Every subagent of the session, oldest first. */
  readonly subagents: readonly Subagent[];
}) => JSX.Element | null = () => null;
