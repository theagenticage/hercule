/**
 * The events an adapter reports about an input it has just delivered, rather
 * than about something the harness said.
 */
import type { ProviderEvent } from "@hydra/protocol";
import { now } from "../report";

/**
 * The user's own message, as the pair of events one item is. Every adapter
 * reports it itself rather than off the harness's echo of it, because only the
 * adapter knows whether the input steered a running turn: an echo cannot say
 * which input it echoes.
 */
export const userMessage = (input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly text: string;
  readonly steered: boolean;
  /** The native ids the item joins to, where the adapter has any. */
  readonly providerRefs?: Readonly<Record<string, string>>;
}): readonly [ProviderEvent, ProviderEvent] => {
  const item = {
    sessionId: input.sessionId,
    at: now(),
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
