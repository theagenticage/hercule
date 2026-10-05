/**
 * Decides what an open thread does with each delivery on its two live topics.
 * A screen follows exactly one agent of a session: the session's own agent on
 * `session:<id>:stream` and `:tap`, or one subagent on
 * `session:<id>:subagent:<subagentId>:stream` and `:tap`. Either way:
 *
 * - the `stream` topic delivers the agent's transcript rows as they are
 *   stored;
 * - the `tap` topic delivers the token deltas of the text being written.
 *
 * Both pairs deliver the same shapes, so these functions serve either. They
 * only decide. Each app applies the decision to its own cache, its own tail
 * buffer and its own painting.
 */
import type { TapItem, TranscriptRow } from "@hercule/contract";
import type { LiveDelta } from "../live/live";
import { findNewRows, mergeTranscript } from "./transcript";

/**
 * Returns the cursor a thread subscribes to its stream with: the position of
 * the last row in `held`, or "0" when `held` is empty.
 *
 * Positions start at 1, and the controller replays every row after the
 * cursor, so cursor 0 asks for the whole log, as a thread with no rows yet
 * needs. Without a cursor, the stream would start at the head, and every row
 * written between the transcript's read and the subscription would be
 * missing from the cache. 0 is also never past the head, which is the only
 * cursor the controller rejects.
 */
export const buildStreamCursor = (held: readonly TranscriptRow[]): string =>
  String(held.at(-1)?.position ?? 0);

/**
 * What a thread does with one delivery on its stream:
 *
 * - `gone`: the session no longer exists, so the caller unsubscribes.
 * - `reset`: rows may have been missed, so the caller reads the transcript
 *   again and skips the open items, whose tails can no longer be lined up
 *   with their rows.
 * - `held`: every delivered row is already held, so there is nothing to do.
 * - `rows`: the caller applies `fresh` to its tail buffer, then caches
 *   `transcript`. When `replay` is true, the rows are the ones written while
 *   the stream was not subscribed, such as during an outage. An item that
 *   started in them may have sent taps nobody received, so the caller skips
 *   the items open once `transcript` is cached.
 */
export type StreamDelivery =
  | { readonly kind: "gone" }
  | { readonly kind: "reset" }
  | { readonly kind: "held" }
  | {
      readonly kind: "rows";
      /** The delivered rows `held` lacks, in the order they arrived. */
      readonly fresh: readonly TranscriptRow[];
      /** The held rows with `fresh` merged in, ordered by position. */
      readonly transcript: readonly TranscriptRow[];
      readonly replay: boolean;
    };

/**
 * Decides what to do with `delta`, delivered on a thread's stream, given the
 * rows the thread holds. See `StreamDelivery` for each outcome.
 *
 * A delivery can repeat rows already held, such as the rows replayed after
 * the transcript's read. Only the new rows are handed to the tail buffer: a
 * row applied twice no longer matches the tail, and its item would be
 * skipped for no reason.
 */
export const decideStreamDelivery = (
  held: readonly TranscriptRow[],
  delta: LiveDelta,
): StreamDelivery => {
  if (delta.gone) return { kind: "gone" };
  if (delta.reset) return { kind: "reset" };
  // The stream topic carries only transcript rows. A delivery's type is
  // shared by every topic, so it lists the other topics' items too.
  const fresh = findNewRows(held, delta.items as readonly TranscriptRow[]);
  if (fresh.length === 0) return { kind: "held" };
  return { kind: "rows", fresh, transcript: mergeTranscript(held, fresh), replay: delta.replay };
};

/**
 * What a thread does with one delivery on its tap:
 *
 * - `gone`: the session no longer exists, so the caller unsubscribes.
 * - `reset`: the tap was subscribed again, and the taps sent in between are
 *   lost, so the caller skips the open items.
 * - `taps`: the caller appends `taps` to its tail buffer, in order.
 */
export type TapDelivery =
  | { readonly kind: "gone" }
  | { readonly kind: "reset" }
  | { readonly kind: "taps"; readonly taps: readonly TapItem[] };

/** Decides what to do with `delta`, delivered on a thread's tap. See `TapDelivery` for each outcome. */
export const decideTapDelivery = (delta: LiveDelta): TapDelivery => {
  if (delta.gone) return { kind: "gone" };
  if (delta.reset) return { kind: "reset" };
  // The tap topic carries only tap items; see the stream's cast above.
  return { kind: "taps", taps: delta.items as readonly TapItem[] };
};
