/**
 * The status card a subagent's page shows where a thread has its composer,
 * because a subagent takes no messages.
 */
import type { SessionRequest, Subagent } from "@hercule/contract";
import {
  describeSubagentState,
  describeSubagentStop,
  formatSubagentTokens,
  isSubagentWaiting,
  nameSubagentParent,
  type SubagentHue,
  type SubagentState,
  type SubagentStop,
} from "./describe";

/** The words a subagent's status card shows. */
export interface StatusCardText {
  /** How the subagent stands, such as "Working for 16m 2s" or "Done in 2m 20s". */
  readonly headline: string;
  readonly hue: SubagentHue;
  /** Such as "Subagent of the main agent · 6.2k tokens · takes no messages". */
  readonly detail: string;
  /** The Stop button, while the subagent runs; null once it has ended. */
  readonly stop: SubagentStop | null;
}

/**
 * Describes the status card of `subagent`. `subagents` are its session's
 * subagents, which name its parent and count the ones below it.
 * `openRequests` are the session's open Requests, and `now` is the moment a
 * running subagent's duration is measured to.
 */
export const describeStatusCard = (
  subagent: Subagent,
  subagents: readonly Subagent[],
  openRequests: readonly SessionRequest[],
  now: Date,
): StatusCardText => {
  const state = describeSubagentState(subagent, isSubagentWaiting(subagent, openRequests), now);
  const headlines: Record<SubagentState["word"], string> = {
    working: `Working for ${state.duration}`,
    "waiting on you": "Waiting on you",
    done: `Done in ${state.duration}`,
    failed: `Failed after ${state.duration}`,
    stopped: `Stopped after ${state.duration}`,
  };
  const tokens = formatSubagentTokens(subagent);
  return {
    headline: headlines[state.word],
    hue: state.hue,
    detail: [
      `Subagent of ${nameSubagentParent(subagent, subagents)}`,
      tokens === undefined ? undefined : `${tokens} tokens`,
      "takes no messages",
    ]
      .filter((part) => part !== undefined)
      .join(" · "),
    stop: describeSubagentStop(subagent, subagents),
  };
};
