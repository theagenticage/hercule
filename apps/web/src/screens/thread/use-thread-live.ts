/**
 * Subscribes the thread surface to its live topics and returns the ref for
 * the live tail element.
 *
 * - `session:<id>:stream` appends rows to the transcript cache.
 * - `session:<id>:tap` streams the open item's token deltas, unchanged, into
 *   one DOM element. The finished prose above it is made of block elements,
 *   so the tail already starts on its own line and needs no line break.
 *
 * Tap deltas never go into React state. The tail element is written directly,
 * once per animation frame however many deltas arrived, because a `setState`
 * per token would re-render the whole column for every token.
 *
 * When the session no longer exists, the delta says so (`gone`) and the
 * handler unsubscribes, rather than retrying a subscription that will keep
 * failing.
 */
import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { mergeTranscript, findOpenItem, queryKeys, type Live } from "@hercule/client-core";
import {
  buildSessionStreamTopic,
  buildSessionTapTopic,
  type TapItem,
  type TranscriptRow,
} from "@hercule/contract";

/** Returns the item id of a row's event, or undefined for an event with none (a turn boundary). */
const readItemId = (event: TranscriptRow["event"]): string | undefined =>
  "itemId" in event ? event.itemId : undefined;

export const useThreadLive = (
  live: Live,
  queryClient: QueryClient,
  sessionId: string,
  rows: readonly TranscriptRow[],
  /** Called after a tap flush writes text: the one way the column grows without a React render. */
  onTapFlush: () => void,
): RefObject<HTMLSpanElement | null> => {
  const tailRef = useRef<HTMLSpanElement | null>(null);
  const bufferRef = useRef("");
  const openItemIdRef = useRef<string | null>(null);
  const frameRef = useRef<number | null>(null);

  const flushTail = useCallback(() => {
    if (tailRef.current !== null) {
      tailRef.current.textContent = bufferRef.current;
    }
    onTapFlush();
  }, [onTapFlush]);

  const clearTail = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    bufferRef.current = "";
    flushTail();
  }, [flushTail]);

  // The open item is computed from the rows already loaded. The effect only
  // copies it into the ref that the tap handler reads synchronously, and
  // clears the buffered text when a different item becomes the open one.
  const openItemId = useMemo(() => findOpenItem(rows), [rows]);
  useEffect(() => {
    if (openItemId !== openItemIdRef.current) clearTail();
    openItemIdRef.current = openItemId;
  }, [openItemId, clearTail]);

  useEffect(() => {
    // Read the cursor from the cache when subscribing, not from the first
    // render. When this effect re-runs, it then resumes from where the
    // transcript actually is, instead of replaying every row since the page
    // opened into the cache a second time.
    const held = queryClient.getQueryData<readonly TranscriptRow[]>(
      queryKeys.transcript(sessionId),
    );
    // With an empty cache, subscribe from the start of the log, not from the
    // head. A just-spawned session is read before its first rows exist, and
    // "no cursor" means "only what happens next". Every row written between
    // that read and this subscription would then be missing from a cache that
    // is never refetched.
    //
    // Cursor 0 asks for every row: positions start at 1 (`session_stream`
    // uses `COALESCE(MAX(position), 0) + 1`) and the controller replays every
    // row after the cursor. 0 is also never past the head, which is the only
    // cursor the controller rejects.
    const cursor = held?.at(-1)?.position ?? 0;

    const unsubscribe = live.subscribe(
      buildSessionStreamTopic(sessionId),
      (delta) => {
        if (delta.gone) {
          unsubscribe();
          return;
        }
        if (delta.reset) {
          // `live.ts` re-subscribes from the head as soon as it reports a
          // reset, while the refetch below is still in progress. So a row
          // written between the two is neither in the refetched transcript nor
          // delivered as a delta. This gap is accepted: a reset only happens
          // when the transcript log was replaced, and closing the gap would
          // mean holding the subscription back until an HTTP read finishes,
          // which is exactly what the reset avoids.
          clearTail();
          void queryClient.invalidateQueries({ queryKey: queryKeys.transcript(sessionId) });
          return;
        }
        // `:stream` only carries `TranscriptRow`s. The wire type is a union for
        // the whole connection, not per topic, but this topic always has this shape.
        const items = delta.items as ReadonlyArray<TranscriptRow>;
        if (items.length === 0) return;
        // A row for the open item replaces the tail text buffered for it. A
        // row for any other item, such as another item starting or a turn
        // boundary, leaves the open item's buffered tail unchanged.
        if (items.some((item) => readItemId(item.event) === openItemIdRef.current)) clearTail();
        // Merge by `position` rather than appending after the last row. A row
        // already in the cache is left alone, and a new row is placed in order
        // however late it arrives. Two subscriptions started from the same
        // empty cache both replay from the start of the log, so a later
        // delivery can contain earlier rows.
        queryClient.setQueryData<readonly TranscriptRow[]>(
          queryKeys.transcript(sessionId),
          (current) => mergeTranscript(current ?? [], items),
        );
      },
      String(cursor),
    );
    return unsubscribe;
  }, [live, queryClient, sessionId, clearTail]);

  useEffect(() => {
    const unsubscribe = live.subscribe(buildSessionTapTopic(sessionId), (delta) => {
      if (delta.gone) {
        unsubscribe();
        return;
      }
      const items = delta.items as ReadonlyArray<TapItem>;
      for (const item of items) {
        if (item.itemId !== openItemIdRef.current) continue;
        // Only assistant prose is shown here. A reasoning or command-output
        // delta on the same open item is not the answer, and would otherwise
        // appear as if it were until its row arrives and replaces it.
        if (item.streamKind !== "assistant_text") continue;
        bufferRef.current += item.delta;
      }
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null;
          flushTail();
        });
      }
    });
    return () => {
      unsubscribe();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [live, sessionId, flushTail]);

  return tailRef;
};
