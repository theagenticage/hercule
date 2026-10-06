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
  /** How many subagents are below it, at any depth. */
  readonly below: number;
  /** Whether it, or any subagent below it, waits on the user. */
  readonly waitsOnYou: boolean;
}

/**
 * Builds the spawn lines of `turn`: one for each `subagent` item of the turn
 * whose subagent is in `subagents`, ordered as the side pane orders siblings,
 * so the two never disagree.
 * `openRequests` are the session's open Requests, and `now` is the moment a
 * running subagent's duration is measured to.
 *
 * A `subagent` item whose record has not been read yet has no line, because
 * there is nothing to name it by; the line appears when the record does.
 */
export const buildSpawnLines = (
  turn: ThreadTurn,
  subagents: readonly Subagent[],
  openRequests: readonly SessionRequest[],
  now: Date,
): readonly SpawnLine[] =>
  turn.items
    .filter((item) => item.kind === "subagent")
    .flatMap((item) => subagents.filter((each) => each.itemId === item.itemId))
    .sort(compareSubagentStarts)
    .map((subagent) => {
      const waiting = isSubagentWaiting(subagent, openRequests);
      const descendants = listSubagentDescendants(subagent, subagents);
      return {
        subagentId: subagent.id,
        status: subagent.status,
        waiting,
        name: nameSubagent(subagent),
        state: describeSubagentState(subagent, waiting, now),
        below: descendants.length,
        waitsOnYou: waiting || descendants.some((each) => isSubagentWaiting(each, openRequests)),
      };
    });
