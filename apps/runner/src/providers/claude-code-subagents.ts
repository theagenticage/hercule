/**
 * The subagents of one Claude Code session, as the normalizer knows them
 * (spec 06 section 13.6). This module holds only the bookkeeping: it builds no
 * events from the harness's messages and calls nothing.
 *
 * Claude Code names a subagent two ways, and the registry links them:
 *
 * - its **agent call**: the id of the `Agent` tool_use block that started it.
 *   Every assistant, user and stream frame from inside the subagent carries it
 *   as `parent_tool_use_id`.
 * - its **SubagentId**: the agent id. `task_started` and `task_notification`
 *   carry it as `task_id`, beside the agent call as `tool_use_id`, and
 *   `canUseTool` carries it as `agentID`.
 *
 * No frame names a subagent's parent. The parent is the agent whose frame
 * carried the `Agent` call, so the registry records the owner of every agent
 * call it sees.
 */
import type { ContinuedSubagent, ProviderEvent, SubagentId } from "@hercule/protocol";
import { truncateFact } from "./text";

/**
 * Where a subagent's turn stands:
 *
 * - `idle`: no turn is open;
 * - `pending`: `task_started` arrived, and the turn opens at the subagent's
 *   first frame, with `prompt` as its `user_message`;
 * - `open`: the turn is open under `turnId`.
 */
type SubagentTurn =
  | { readonly phase: "idle" }
  | { readonly phase: "pending"; readonly prompt: string | undefined }
  | { readonly phase: "open"; readonly turnId: string };

/**
 * Where a stop of the subagent stands:
 *
 * - `none`: nobody asked to stop it;
 * - `wanted`: the user stopped it, or a subagent above it, while it was idle.
 *   The adapter sends `stopTask` as soon as it works again;
 * - `sent`: the adapter sent `stopTask` for it. If the subagent then ends
 *   `completed` or `failed`, `stopTask` stopped nothing, and the stop is
 *   `wanted` again. If the harness refused `stopTask` or did not answer, the
 *   stop is `none` again, so only the user's next Stop sends it again;
 * - `stopped`: the harness reported it stopped. A stopped Claude subagent
 *   cannot be continued, so it runs no more turns.
 */
type SubagentStop = "none" | "wanted" | "sent" | "stopped";

/** One subagent the session's harness started, in this process or an earlier one. */
export interface Subagent {
  readonly subagentId: SubagentId;
  /**
   * The `Agent` call that started the subagent, which is also the item id of
   * that call in its parent's transcript. Absent for a subagent from an
   * earlier process whose record has no item.
   */
  readonly agentCallId: string | undefined;
  /** The subagent that started this one. Absent when the session's own agent did. */
  readonly parentSubagentId: SubagentId | undefined;
  /** Whether `subagent.started` was sent for it in this process. */
  introduced: boolean;
  turn: SubagentTurn;
  stop: SubagentStop;
  /**
   * Whether the normalizer dropped frames of the subagent before its turn
   * opened. Those frames may have been the ones that open its turn, so a
   * request it asks would wait for ever for a turn to be shown in. Cleared
   * when its turn opens.
   */
  openingFramesLost: boolean;
}

/** A `request.opened` event, the only kind of event that waits for a subagent's turn. */
export type RequestOpened = Extract<ProviderEvent, { readonly _tag: "request.opened" }>;

/**
 * Everything the normalizer knows about the session's subagents.
 *
 * - `byId`, `byAgentCall`, `agentCallOwners` and `agentCallsByName` grow by a
 *   few short strings with each `Agent` call and are never pruned, because a
 *   subagent can be continued or stopped at any time while the process lives.
 * - `waitingRequests` holds whole events, but only until the subagent's turn
 *   opens or its frames are dropped, whichever comes first.
 * - `droppedAgentCalls` holds an agent call only until a `task_started`
 *   links it.
 */
export interface SubagentRegistry {
  /** Every known subagent, by SubagentId. */
  readonly byId: Map<SubagentId, Subagent>;
  /** The SubagentId each agent call started. */
  readonly byAgentCall: Map<string, SubagentId>;
  /**
   * The agent that made each `Agent` call seen in this process: a SubagentId,
   * or `undefined` for the session's own agent. A subagent's parent is read
   * from here when its `task_started` arrives.
   */
  readonly agentCallOwners: Map<string, SubagentId | undefined>;
  /**
   * The agent call for each `name` an `Agent` call gave its subagent. A
   * `SendMessage` may address a subagent by that name.
   */
  readonly agentCallsByName: Map<string, string>;
  /**
   * The `request.opened` events that wait for a subagent's turn to open, by
   * SubagentId. The id may name a subagent the registry does not know yet.
   */
  readonly waitingRequests: Map<SubagentId, Array<RequestOpened>>;
  /**
   * The agent calls whose frames the normalizer dropped before any
   * `task_started` linked them. The subagent a later `task_started` links to
   * one of them has lost its opening frames.
   */
  readonly droppedAgentCalls: Set<string>;
}

/**
 * Converts an id the harness gives for a subagent into a SubagentId. Returns
 * `undefined` when the value is missing, not a string, or empty: the protocol
 * does not accept an empty id. Every place that reads a subagent's id from
 * the harness goes through this function, so one subagent has one spelling.
 *
 * A SubagentId may not contain `:`, so each one becomes `_`, and an id
 * longer than the protocol accepts is cut short. Claude agent ids are short
 * hexadecimal strings, so this never changes a real one. If it did, the
 * normalizer warns when the subagent starts, and `stopTask` would get the
 * changed id, fail, and warn too. Either is better than losing every event of
 * the subagent to a frame nobody can decode.
 */
export const cleanSubagentId = (raw: unknown): SubagentId | undefined =>
  typeof raw === "string" && raw !== "" ? truncateFact(raw.replaceAll(":", "_")) : undefined;

/**
 * Returns a registry that knows the subagents of an earlier process. Frames
 * from a seeded subagent's agent call route to it, but it is not introduced in
 * this process yet, so its first event is preceded by `subagent.started`.
 */
export const buildSubagentRegistry = (
  seeded: ReadonlyArray<ContinuedSubagent> = [],
): SubagentRegistry => {
  const registry: SubagentRegistry = {
    byId: new Map(),
    byAgentCall: new Map(),
    agentCallOwners: new Map(),
    agentCallsByName: new Map(),
    waitingRequests: new Map(),
    droppedAgentCalls: new Set(),
  };
  for (const known of seeded) {
    registry.byId.set(known.subagentId, {
      subagentId: known.subagentId,
      agentCallId: known.itemId,
      parentSubagentId: known.parentSubagentId,
      introduced: false,
      turn: { phase: "idle" },
      stop: "none",
      openingFramesLost: false,
    });
    if (known.itemId !== undefined) registry.byAgentCall.set(known.itemId, known.subagentId);
  }
  return registry;
};

/**
 * Records an `Agent` call: which agent made it (`owner`, `undefined` for the
 * session's own agent), and the `name` it gave its subagent, if any.
 */
export const recordAgentCall = (
  registry: SubagentRegistry,
  agentCallId: string,
  owner: SubagentId | undefined,
  name: string | undefined,
): void => {
  registry.agentCallOwners.set(agentCallId, owner);
  if (name !== undefined && name !== "") registry.agentCallsByName.set(name, agentCallId);
};

/**
 * Returns the subagent with this id, recording it first if it is new. A new
 * subagent's parent is the agent that made its agent call. A known one keeps
 * the parent it has, because an earlier process saw the call that started it.
 * Either way the agent call is linked to the subagent, so its frames route to
 * it.
 *
 * A new subagent under a parent that was stopped is stopped too: its stop is
 * `wanted`. Claude Code does not stop a background child with its parent, and
 * a parent can start a child after the user stopped it (spec 06 section 13.4).
 *
 * When the normalizer dropped frames of the agent call, the subagent is
 * marked as having lost its opening frames, and the requests waiting for its
 * turn are dropped: that turn may never open.
 */
export const registerSubagent = (
  registry: SubagentRegistry,
  subagentId: SubagentId,
  agentCallId: string | undefined,
): Subagent => {
  let subagent = registry.byId.get(subagentId);
  if (subagent === undefined) {
    const parentSubagentId =
      agentCallId === undefined ? undefined : registry.agentCallOwners.get(agentCallId);
    const parentStop =
      parentSubagentId === undefined ? "none" : registry.byId.get(parentSubagentId)?.stop;
    subagent = {
      subagentId,
      agentCallId,
      parentSubagentId,
      introduced: false,
      turn: { phase: "idle" },
      stop: parentStop === undefined || parentStop === "none" ? "none" : "wanted",
      openingFramesLost: false,
    };
    registry.byId.set(subagentId, subagent);
  }
  if (agentCallId === undefined) return subagent;
  registry.byAgentCall.set(agentCallId, subagentId);
  if (registry.droppedAgentCalls.delete(agentCallId)) {
    subagent.openingFramesLost = true;
    registry.waitingRequests.delete(subagentId);
  }
  return subagent;
};

/** Returns the subagent an agent call started, or `undefined` if none is known. */
export const findSubagentByAgentCall = (
  registry: SubagentRegistry,
  agentCallId: string,
): Subagent | undefined => {
  const subagentId = registry.byAgentCall.get(agentCallId);
  return subagentId === undefined ? undefined : registry.byId.get(subagentId);
};

/**
 * Returns the SubagentId a `SendMessage` call's `to` names, or `undefined`
 * when it names no known subagent. `to` is either a SubagentId or the `name`
 * an `Agent` call gave its subagent.
 */
export const findSendMessageRecipient = (
  registry: SubagentRegistry,
  to: string,
): SubagentId | undefined => {
  if (registry.byId.has(to)) return to;
  const agentCallId = registry.agentCallsByName.get(to);
  return agentCallId === undefined ? undefined : registry.byAgentCall.get(agentCallId);
};

/**
 * Returns the ids of every subagent below this one, at any depth, in no
 * particular order. The subagent itself is not in the list. Each subagent is
 * visited once, so a parent link that loops back cannot make this run for
 * ever.
 */
export const collectDescendants = (
  registry: SubagentRegistry,
  subagentId: SubagentId,
): ReadonlyArray<SubagentId> => {
  const visited = new Set([subagentId]);
  const parents = [subagentId];
  for (let parent = parents.pop(); parent !== undefined; parent = parents.pop()) {
    for (const subagent of registry.byId.values()) {
      if (subagent.parentSubagentId !== parent || visited.has(subagent.subagentId)) continue;
      visited.add(subagent.subagentId);
      parents.push(subagent.subagentId);
    }
  }
  visited.delete(subagentId);
  return [...visited];
};

/** Checks whether the subagent is working: its turn is open or about to open. */
export const isSubagentWorking = (subagent: Subagent): boolean => subagent.turn.phase !== "idle";

/**
 * Marks the stop of each of these subagents as wanted. A subagent whose stop
 * was already sent, or which the harness already reported stopped, is left as
 * it is, so no subagent gets `stopTask` twice. An unknown id is skipped.
 */
export const markStopsWanted = (
  registry: SubagentRegistry,
  subagentIds: ReadonlyArray<SubagentId>,
): void => {
  for (const subagentId of subagentIds) {
    const subagent = registry.byId.get(subagentId);
    if (subagent?.stop === "none") subagent.stop = "wanted";
  }
};

/**
 * Returns the subagents whose stop is wanted and that are working now, and
 * marks their stop as sent. The caller sends `stopTask` for each of them. An
 * idle subagent keeps waiting: there is nothing to stop until it works again.
 */
export const takeStopsDue = (registry: SubagentRegistry): ReadonlyArray<SubagentId> => {
  const due: Array<SubagentId> = [];
  for (const subagent of registry.byId.values()) {
    if (subagent.stop !== "wanted" || !isSubagentWorking(subagent)) continue;
    subagent.stop = "sent";
    due.push(subagent.subagentId);
  }
  return due;
};

/**
 * Marks a subagent whose `stopTask` the harness refused, or did not answer,
 * as not being stopped. The user's next Stop then sends `stopTask` again, and
 * nothing sends it by itself. A stop that is no longer `sent` is left as it
 * is: the harness reported the subagent ended while the request was out.
 */
export const clearRefusedStop = (registry: SubagentRegistry, subagentId: SubagentId): void => {
  const subagent = registry.byId.get(subagentId);
  if (subagent?.stop === "sent") subagent.stop = "none";
};

/**
 * Returns `[opened]` when the turn of the subagent that asked is open, for the
 * caller to publish now. Otherwise stores the event and returns nothing: the
 * normalizer emits it right after the events that open the subagent's next
 * turn. The subagent need not be known yet.
 *
 * Claude Code asks for approval as soon as it reads the tool call, which can
 * be before the frames that open the subagent's turn have been normalized,
 * and a Request must belong to an open turn.
 */
export const deferUntilTurnOpens = (
  registry: SubagentRegistry,
  subagentId: SubagentId,
  opened: RequestOpened,
): ReadonlyArray<RequestOpened> => {
  if (registry.byId.get(subagentId)?.turn.phase === "open") return [opened];
  const waiting = registry.waitingRequests.get(subagentId) ?? [];
  waiting.push(opened);
  registry.waitingRequests.set(subagentId, waiting);
  return [];
};

/** Removes and returns the `request.opened` events waiting for this subagent's turn to open. */
export const takeWaitingRequests = (
  registry: SubagentRegistry,
  subagentId: SubagentId,
): ReadonlyArray<RequestOpened> => {
  const waiting = registry.waitingRequests.get(subagentId) ?? [];
  registry.waitingRequests.delete(subagentId);
  return waiting;
};

/**
 * Records that the normalizer dropped frames of these agent calls, and
 * removes the `request.opened` events waiting for subagents the registry does
 * not know. Those subagents may never be reported, and the dropped frames may
 * have been the ones that open their turns, so their turns may never open.
 */
export const recordDroppedFrames = (
  registry: SubagentRegistry,
  agentCallIds: ReadonlyArray<string>,
): void => {
  for (const agentCallId of agentCallIds) registry.droppedAgentCalls.add(agentCallId);
  for (const subagentId of registry.waitingRequests.keys()) {
    if (!registry.byId.has(subagentId)) registry.waitingRequests.delete(subagentId);
  }
};
