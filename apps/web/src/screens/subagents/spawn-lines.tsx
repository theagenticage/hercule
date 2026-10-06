import type { JSX } from "react";
import type { ThreadTurn } from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";

/**
 * The lines in a turn, one per subagent the turn started: `↳`, its state
 * mark, its name, its state and duration, "N below" and "one waits on you".
 * A click opens the subagent's page (spec 14 §Subagents on the thread
 * surface).
 *
 * Not built yet: it renders nothing.
 */
export const SpawnLines: (props: {
  readonly session: Session;
  /** Every subagent of the session, oldest first. */
  readonly subagents: readonly Subagent[];
  readonly turn: ThreadTurn;
}) => JSX.Element | null = () => null;
