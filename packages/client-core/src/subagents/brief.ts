/**
 * The brief a subagent's page opens with: the work its parent handed it, and
 * who handed it over.
 */
import type { Subagent } from "@hercule/contract";
import type { ThreadBlock } from "../threads/blocks";
import type { ThreadTurn } from "../threads/turns";
import { nameSubagentParent } from "./describe";

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

/** A subagent's transcript blocks with its brief taken out of them. */
export interface SubagentBriefSplit {
  /** The brief's text, or undefined while the first turn has not been read or holds no user message. */
  readonly brief: string | undefined;
  /** The blocks to draw below the brief card: every block but the brief's own message. */
  readonly blocks: readonly ThreadBlock[];
}

/**
 * Splits the brief off a subagent's transcript `blocks`, as
 * `buildThreadBlocks` returns them. The brief is the user message the
 * subagent's first turn opens with, which is the first block when the
 * harness handed the subagent a brief. The page draws it in the brief card,
 * so that message is left out of the blocks. When the first block is not a
 * user message with text, the brief is undefined and the blocks are
 * returned as they are.
 *
 * This is `findSubagentBrief` for a screen that draws blocks rather than
 * turns.
 */
export const splitSubagentBrief = (blocks: readonly ThreadBlock[]): SubagentBriefSplit => {
  const first = blocks[0];
  if (first?.kind !== "user" || first.text === "") return { brief: undefined, blocks };
  return { brief: first.text, blocks: blocks.slice(1) };
};

/**
 * Who handed a subagent its brief, as the line above the brief shows it:
 * "Brief from <parent> · <agentType> agent", or "Brief from <parent>" when
 * the record holds no agent type. The parts are kept apart so each app can
 * draw the parent name and the agent type in its own style.
 */
export interface BriefSource {
  /** The agent that started the subagent, as `nameSubagentParent` names it, such as "the main agent". */
  readonly parent: string;
  /** The subagent's agent type, such as "Explore", or undefined when the record holds none. */
  readonly agentType: string | undefined;
}

/**
 * Returns who handed `subagent` its brief: its parent's name and its agent
 * type. `subagents` are the session's subagents, which hold the parent.
 */
export const describeBriefSource = (
  subagent: Subagent,
  subagents: readonly Subagent[],
): BriefSource => ({
  parent: nameSubagentParent(subagent, subagents),
  agentType: subagent.agentType,
});
