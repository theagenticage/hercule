/**
 * The streaming tail of a thread: the text of an assistant message that the
 * token tap has delivered and no stream row holds yet (spec 14 §Live model).
 * It holds no framework state, so the web and the desktop wrap the same rules
 * in their own hooks and paint the text however they like.
 *
 * Two topics carry a message's text, and they relate like this:
 *
 * - `session:<id>:tap` sends each token delta as it happens. It is never
 *   stored and never replayed, so a delta sent while nobody listens is lost.
 * - `session:<id>:stream` sends stored rows. The controller holds an item's
 *   deltas and writes them as one `content.delta` row when the item or its
 *   turn ends, or when the held text reaches 4 KB. Each row holds the text
 *   since the item's previous row.
 *
 * A tap is sent straight to the socket, and a row only after it is written
 * and read back, so taps arrive before the row that holds their text. So when
 * a row lands, the tail usually already holds the row's text and some text
 * after the row's cut. The row's text is removed from the front of the tail,
 * and the rest stays: "the stream wins over the tap".
 *
 * A tap carries no offset into the message, so a tail that missed taps cannot
 * be lined up with the rows again. Such an item is skipped: its tail is
 * dropped, and its taps are ignored until the item completes. Its text still
 * shows, because it arrives in the rows. An item is skipped when:
 *
 * - a row's text is not at the front of its tail, so the tail missed a tap;
 * - it was open while the tap was not subscribed, so taps sent in that time
 *   are lost (`skipOpenItems`);
 * - the stream lost its place, so rows may have landed without being applied
 *   to the tail (`skipOpenItems` again).
 */
import type { TapItem, TranscriptRow } from "@hercule/contract";

/**
 * The streaming tails of one thread, one per assistant message. The caller
 * paints the tail of the thread's open item, as `findOpenItem` returns it
 * from the transcript the caller holds.
 */
export interface TailBuffer {
  /**
   * Adds one tap delta to its item's tail. Only assistant text is kept:
   * reasoning and command output are not the answer, so they never show as
   * one. The item does not need to have started in the transcript yet,
   * because a tap can arrive before the item's `item.started` row.
   */
  appendTap(tap: TapItem): void;
  /**
   * Applies the rows of one stream delivery that the caller's transcript does
   * not hold yet (`findNewRows`), before the caller merges them into it. A
   * replayed row applied a second time would no longer match the tail, and
   * its item would be skipped for nothing. Each row is applied like this:
   *
   * - an assistant text row removes its text from the front of its item's
   *   tail, or skips the item when the tail does not start with that text;
   * - an `item.completed` row forgets the item, skipped or not.
   */
  applyRows(rows: readonly TranscriptRow[]): void;
  /**
   * Skips every item that may have missed taps or rows: the items open in
   * `rows`, and every item this buffer still holds a tail for. Call it with
   * the transcript the caller holds each time the tap is subscribed, first
   * or again, and when the stream is reset.
   */
  skipOpenItems(rows: readonly TranscriptRow[]): void;
  /** Returns the tail of an item: its text so far, or "" for a skipped item or no item. */
  read(itemId: string | null): string;
}

/** Returns the ids of the items that have started in `rows` and not completed. */
const findOpenItemIds = (rows: readonly TranscriptRow[]): ReadonlySet<string> => {
  const open = new Set<string>();
  for (const row of rows) {
    const event = row.event;
    if (event._tag === "item.started") open.add(event.itemId);
    else if (event._tag === "item.completed") open.delete(event.itemId);
  }
  return open;
};

/** Creates the streaming tails of one thread, with no tail and no skipped item. */
export const createTailBuffer = (): TailBuffer => {
  const tails = new Map<string, string>();
  const skipped = new Set<string>();

  const skipItem = (itemId: string): void => {
    tails.delete(itemId);
    skipped.add(itemId);
  };

  return {
    appendTap: (tap) => {
      if (tap.streamKind !== "assistant_text" || skipped.has(tap.itemId)) return;
      tails.set(tap.itemId, (tails.get(tap.itemId) ?? "") + tap.delta);
    },
    applyRows: (rows) => {
      for (const row of rows) {
        const event = row.event;
        if (event._tag === "item.completed") {
          tails.delete(event.itemId);
          skipped.delete(event.itemId);
        } else if (
          event._tag === "content.delta" &&
          event.streamKind === "assistant_text" &&
          !skipped.has(event.itemId)
        ) {
          const tail = tails.get(event.itemId) ?? "";
          if (tail.startsWith(event.delta)) tails.set(event.itemId, tail.slice(event.delta.length));
          else skipItem(event.itemId);
        }
      }
    },
    skipOpenItems: (rows) => {
      for (const itemId of [...findOpenItemIds(rows), ...tails.keys()]) skipItem(itemId);
    },
    read: (itemId) => (itemId === null ? "" : (tails.get(itemId) ?? "")),
  };
};
