/**
 * The brief a subagent's page opens with: the work its parent handed it.
 */
import type { ThreadTurn } from "../threads/turns";

/** A subagent's brief and the turn whose user message holds it. */
export interface SubagentBrief {
  readonly turnId: string;
  readonly text: string;
}

/**
 * Returns the brief of a subagent from its `turns`, oldest first: the user
 * message of its first turn, which is how a harness hands a subagent its
 * brief. Returns undefined while that turn has not been read, or when it
 * holds no user message.
 */
export const findSubagentBrief = (turns: readonly ThreadTurn[]): SubagentBrief | undefined => {
  const first = turns[0];
  if (first === undefined || first.user === "") return undefined;
  return { turnId: first.turnId, text: first.user };
};
