/**
 * The status card a subagent's page shows where a thread has its composer,
 * because a subagent takes no messages.
 */
import type { Session, Subagent, SubagentId } from "@hercule/contract";
import {
  describeSubagentState,
  formatSubagentTokens,
  isSubagentWaiting,
  nameSubagent,
  type SubagentHue,
  type SubagentState,
} from "./describe";
import { listSubagentDescendants } from "./tree";

/** What a subagent's status card shows. */
export interface StatusCard {
  /** How the subagent stands, such as "Working for 16m 2s" or "Done in 2m 20s". */
  readonly headline: string;
  readonly hue: SubagentHue;
  /** Such as "Subagent of the main agent · 6.2k tokens · takes no messages". */
  readonly detail: string;
  /** The Stop button, while the subagent runs; null once it has ended. */
  readonly stop: { readonly label: string; readonly title: string | undefined } | null;
  /** The subagent Open parent goes to; undefined when the session's own agent started it. */
  readonly parentSubagentId: SubagentId | undefined;
}

/**
 * Returns the Stop button of a running subagent. Stopping a subagent stops
 * every subagent below it too, so the label says how many: "Stop", or "Stop
 * with 2 below".
 */
const describeStop = (below: number): NonNullable<StatusCard["stop"]> => {
  if (below === 0) return { label: "Stop", title: undefined };
  return {
    label: `Stop with ${String(below)} below`,
    title:
      below === 1
        ? "Also stops the subagent below it"
        : `Also stops the ${String(below)} subagents below it`,
  };
};

/**
 * Describes the status card of `subagent`. `subagents` are its session's
 * subagents, which name its parent and count the ones below it, and
 * `session` holds the open Requests. `now` is the moment a running
 * subagent's duration is measured to.
 */
export const describeStatusCard = (
  subagent: Subagent,
  subagents: readonly Subagent[],
  session: Session,
  now: Date,
): StatusCard => {
  const state = describeSubagentState(
    subagent,
    isSubagentWaiting(subagent, session.openRequests),
    now,
  );
  const headlines: Record<SubagentState["word"], string> = {
    working: `Working for ${state.duration}`,
    "waiting on you": "Waiting on you",
    done: `Done in ${state.duration}`,
    failed: `Failed after ${state.duration}`,
    stopped: `Stopped after ${state.duration}`,
  };
  const parent = subagents.find((each) => each.id === subagent.parentSubagentId);
  const tokens = formatSubagentTokens(subagent);
  return {
    headline: headlines[state.word],
    hue: state.hue,
    detail: [
      `Subagent of ${parent === undefined ? "the main agent" : nameSubagent(parent)}`,
      tokens === undefined ? undefined : `${tokens} tokens`,
      "takes no messages",
    ]
      .filter((part) => part !== undefined)
      .join(" · "),
    stop:
      subagent.status === "running"
        ? describeStop(listSubagentDescendants(subagent, subagents).length)
        : null,
    parentSubagentId: subagent.parentSubagentId,
  };
};
