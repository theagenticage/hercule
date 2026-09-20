/**
 * Which item a session's transcript is still in the middle of, if any: the
 * one whose `item.started` has no matching `item.completed` yet. Everything
 * before it is settled and already the transcript's own text, so this is the
 * one item a live token stream still has something to say about.
 *
 * A `user_message` is never open: it is complete the moment it is sent, and
 * both its `item.started` and `item.completed` carry the same text.
 */
import type { TranscriptRow } from "@hercule/contract";

export const openItemOf = (rows: readonly TranscriptRow[]): string | null => {
  const started: string[] = [];
  const completed = new Set<string>();

  for (const row of rows) {
    const event = row.event;
    if (event._tag === "item.started" && event.kind !== "user_message") {
      started.push(event.itemId);
    } else if (event._tag === "item.completed" && event.kind !== "user_message") {
      completed.add(event.itemId);
    }
  }

  for (let index = started.length - 1; index >= 0; index--) {
    const itemId = started[index]!;
    if (!completed.has(itemId)) return itemId;
  }
  return null;
};
