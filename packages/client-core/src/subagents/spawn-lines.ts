/**
 * The spawn lines a turn shows: one line per subagent the turn started, in
 * the transcript where its agent started it.
 */
import type { SessionRequest, Subagent, SubagentId, SubagentStatus } from "@hercule/contract";
import type { ThreadTurn } from "../threads/turns";
import {
  describeSubagentState,
  isSubagentWaiting,
  nameSubagent,
  type SubagentLine,
  type SubagentState,
} from "./describe";
import { compareSubagentStarts, listSubagentDescendants } from "./tree";

/** One subagent a turn started, as its spawn line shows it. */
export interface SpawnLine {
  readonly subagentId: SubagentId;
  readonly status: SubagentStatus;
  /** Whether the subagent itself waits on the user, as `isSubagentWaiting` decides. */
  readonly waiting: boolean;
  readonly name: string;
  readonly state: SubagentState;
  /**
   * The words after its state and duration, in order, each a separate note:
   *
   * - "N below", in `muted`, when it has subagents of its own, counted at
   *   any depth;
   * - "one waits on you", in `attn`, when a subagent below it waits on the
   *   user. The subagent's own waiting is left out, because its state
   *   already reads "waiting on you".
   */
  readonly notes: readonly SubagentLine[];
}

/**
 * Returns the subagents `turn` started, ordered as the side pane orders
 * siblings, so the two never disagree. `agentSubagentId` is the agent whose
 * turn it is: a subagent's id, or undefined for the session's own agent.
 *
 * A subagent belongs to the turn when its `itemId` is one of the turn's
 * `subagent` items and the turn's agent started it. Both are checked,
 * because an item id is unique only within one agent's transcript.
 *
 * A `subagent` item whose record has not been read yet has no subagent
 * here, because there is nothing to name it by; it appears when the record
 * does.
 */
export const findSpawnedSubagents = (
  turn: ThreadTurn,
  agentSubagentId: SubagentId | undefined,
  subagents: readonly Subagent[],
): readonly Subagent[] => {
  const itemIds = new Set(
    turn.items.filter((item) => item.kind === "subagent").map((item) => item.itemId),
  );
  return subagents
    .filter(
      (subagent) =>
        subagent.parentSubagentId === agentSubagentId &&
        subagent.itemId !== undefined &&
        itemIds.has(subagent.itemId),
    )
    .sort(compareSubagentStarts);
};

/**
 * Builds one spawn line per subagent of `spawned`, which
 * `findSpawnedSubagents` returns, in the same order. `subagents` are the
 * session's subagents, which count the ones below each line's subagent;
 * `openRequests` are the session's open Requests, and `now` is the moment a
 * running subagent's duration is measured to.
 */
export const buildSpawnLines = (
  spawned: readonly Subagent[],
  subagents: readonly Subagent[],
  openRequests: readonly SessionRequest[],
  now: Date,
): readonly SpawnLine[] =>
  spawned.map((subagent) => {
    const waiting = isSubagentWaiting(subagent, openRequests);
    const descendants = listSubagentDescendants(subagent, subagents);
    const notes: SubagentLine[] = [];
    if (descendants.length > 0) {
      notes.push({ text: `${String(descendants.length)} below`, hue: "muted" });
    }
    if (descendants.some((each) => isSubagentWaiting(each, openRequests))) {
      notes.push({ text: "one waits on you", hue: "attn" });
    }
    return {
      subagentId: subagent.id,
      status: subagent.status,
      waiting,
      name: nameSubagent(subagent),
      state: describeSubagentState(subagent, waiting, now),
      notes,
    };
  });
