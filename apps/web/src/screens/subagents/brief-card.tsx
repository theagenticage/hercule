import type { JSX } from "react";
import type { ThreadTurn } from "@hercule/client-core";
import type { Subagent } from "@hercule/contract";

/**
 * The card at the top of a subagent's page: "Brief from <parent> · <agent
 * type> agent", then the brief its parent gave it, cut to three lines until
 * clicked. The brief is the input of the subagent's first turn (spec 14
 * §Subagents on the thread surface).
 *
 * Not built yet: it renders nothing.
 */
export const BriefCard: (props: {
  /** Every subagent of the session, oldest first, which name the parent. */
  readonly subagents: readonly Subagent[];
  /** The subagent whose page this is. */
  readonly subagent: Subagent;
  /** The subagent's turns, oldest first. */
  readonly turns: readonly ThreadTurn[];
}) => JSX.Element | null = () => null;
