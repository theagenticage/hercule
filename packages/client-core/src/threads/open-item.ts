/**
 * Returns the id of the item a session's transcript is still in the middle of,
 * or `null` if there is none. That is the latest item whose `item.started` has
 * no matching `item.completed` yet. Earlier items are complete and their text
 * is already in the transcript, so the open item is the only one that live
 * token deltas can still add to.
 *
 * A `user_message` is never open: it is complete the moment it is sent, and
 * its `item.started` and `item.completed` have the same text.
 */
import type { TranscriptRow } from "@hercule/contract";

export const findOpenItem = (rows: readonly TranscriptRow[]): string | null => {
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
