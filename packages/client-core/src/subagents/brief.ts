/**
 * The brief a subagent's page opens with: the work its parent handed it, and
 * who handed it over.
 */
import type { Subagent } from "@hercule/contract";
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
