/**
 * Events an adapter reports itself about input it has just delivered, rather
 * than events it reads from the harness's output. Also the helper that makes an
 * id valid for the protocol.
 */
import type { ProviderEvent, SubagentId } from "@hercule/protocol";
import { now } from "../report";
import { truncateFact } from "./text";

/**
 * Returns `given` truncated to the length the protocol allows, or a new random
 * id when `given` is empty. A longer id would make the frame impossible to
 * decode, and the whole event would be lost. When the harness gives no id, a
 * random one is used so the event is still reported.
 */
export const ensureId = (given: string): string =>
  given === "" ? crypto.randomUUID() : truncateFact(given);

/**
 * Returns the user's message as the pair of events for one item:
 * `item.started` and `item.completed`. Every adapter builds these itself rather
 * than from the harness's echo of the message, because only the adapter knows
 * whether the input steered a running turn. The echo does not identify which
 * input it belongs to.
 */
export const buildUserMessage = (input: {
  readonly sessionId: string;
  /** The subagent the message is for, or undefined for the session's own agent. */
  readonly subagentId?: SubagentId | undefined;
  readonly turnId: string;
  readonly text: string;
  readonly steered: boolean;
  /** The harness's own ids for the item, if the adapter has any. */
  readonly providerRefs?: Readonly<Record<string, string>>;
}): readonly [ProviderEvent, ProviderEvent] => {
  const item = {
    sessionId: input.sessionId,
    at: now(),
    ...(input.subagentId === undefined ? {} : { subagentId: input.subagentId }),
    turnId: input.turnId,
    itemId: crypto.randomUUID(),
    kind: "user_message",
    detail: { text: input.text, ...(input.steered ? { steered: true } : {}) },
    ...(input.providerRefs === undefined ? {} : { providerRefs: input.providerRefs }),
  } as const;
  return [
    { _tag: "item.started", eventId: crypto.randomUUID(), ...item },
    { _tag: "item.completed", eventId: crypto.randomUUID(), ...item, status: "completed" },
  ];
};
