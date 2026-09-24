/**
 * The events an adapter reports about an input it has just delivered, rather
 * than about something the harness said - and the ids they are filed under.
 */
import type { ProviderEvent } from "@hercule/protocol";
import { now } from "../report";
import { truncateFact } from "./text";

/**
 * The id something is filed under, cut to what the protocol carries. An id the
 * protocol will not carry is a frame nobody can decode, which loses the event
 * whole; a harness that named none gets one of ours instead, so what it was
 * about is still reported.
 */
export const ensureId = (given: string): string =>
  given === "" ? crypto.randomUUID() : truncateFact(given);

/**
 * The user's own message, as the pair of events one item is. Every adapter
 * reports it itself rather than off the harness's echo of it, because only the
 * adapter knows whether the input steered a running turn: an echo cannot say
 * which input it echoes.
 */
export const buildUserMessage = (input: {
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
