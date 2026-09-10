/**
 * The thread surface's live wiring: `session:<id>:stream` appends rows to the
 * transcript cache, `session:<id>:tap` streams the open item's token deltas
 * straight into one DOM node. Nothing here writes React state from a tap
 * delta - the tail node is written to directly, once per animation frame, no
 * matter how many deltas arrived since the last one, because a `setState` per
 * token would re-render the whole column on every keystroke the agent types.
 *
 * A session that no longer exists tells its own subscriber so, rather than
 * this end retrying a refusal that will never stop repeating; the subscriber
 * ends its own subscription once told.
 */
import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { openItemOf, queryKeys, type Live } from "@hydra/client-core";
import {
  sessionStreamTopic,
  sessionTapTopic,
  type TapItem,
  type TranscriptRow,
} from "@hydra/contract";

/** The item a row's event names, or nothing for an event that names none (a turn boundary). */
const itemIdOf = (event: TranscriptRow["event"]): string | undefined =>
  "itemId" in event ? event.itemId : undefined;

export const useThreadLive = (
  live: Live,
  queryClient: QueryClient,
  sessionId: string,
  rows: readonly TranscriptRow[],
  /** Called after a tap flush paints text - the one growth path no React render follows. */
  onTapFlush: () => void,
): RefObject<HTMLSpanElement | null> => {
  const tailRef = useRef<HTMLSpanElement | null>(null);
  const bufferRef = useRef("");
  const openItemIdRef = useRef<string | null>(null);
  const frameRef = useRef<number | null>(null);

  const flushTail = useCallback(() => {
    if (tailRef.current !== null) tailRef.current.textContent = bufferRef.current;
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

  // Which item is open is read off the rows already in hand, not computed as
  // a side effect: this only mirrors the answer into the ref the tap handler
  // reads synchronously, and drops whatever was buffered for an item that
  // just stopped being the open one.
  const openItemId = useMemo(() => openItemOf(rows), [rows]);
  useEffect(() => {
    if (openItemId !== openItemIdRef.current) clearTail();
    openItemIdRef.current = openItemId;
  }, [openItemId, clearTail]);

  useEffect(() => {
    // The cursor is read from the cache at the moment this subscribes, not
    // from what the first render happened to see: an effect that re-runs then
    // resumes from wherever the transcript actually stands, instead of
    // replaying everything since the page opened into the cache a second time.
    const held = queryClient.getQueryData<readonly TranscriptRow[]>(
      queryKeys.transcript(sessionId),
    );
    const cursor = held?.at(-1);

    const unsubscribe = live.subscribe(
      sessionStreamTopic(sessionId),
      (delta) => {
        if (delta.gone) {
          unsubscribe();
          return;
        }
        if (delta.reset) {
          // `live.ts` re-subscribes from the head the moment it reports this,
          // while the refetch below is still in flight - so a row written
          // between the two is neither in the refetched answer nor delivered
          // as a delta. Left as is: a reset needs a replaced transcript log,
          // and closing the window would mean holding the subscription back
          // on an HTTP read, which is exactly what the reset is escaping.
          clearTail();
          void queryClient.invalidateQueries({ queryKey: queryKeys.transcript(sessionId) });
          return;
        }
        // `:stream` only ever carries `TranscriptRow`s: the wire union is
        // per-connection, not per-topic, but this topic is always this shape.
        const items = delta.items as ReadonlyArray<TranscriptRow>;
        if (items.length === 0) return;
        // A row for the open item wins over whatever the tail held for it -
        // a row for any other item (another item starting, a turn boundary)
        // leaves the open item's own buffered tail exactly as it was.
        if (items.some((item) => itemIdOf(item.event) === openItemIdRef.current)) clearTail();
        // Appended on `position`, never blindly: the transcript log is
        // append-only and strictly ordered, so a row at or below the last one
        // held is one this cache already has - a replay the subscription
        // resumed from, or the same delta delivered twice.
        queryClient.setQueryData<readonly TranscriptRow[]>(
          queryKeys.transcript(sessionId),
          (current) => {
            const last = current?.at(-1)?.position ?? -1;
            const fresh = items.filter((item) => item.position > last);
            return fresh.length === 0 ? current : [...(current ?? []), ...fresh];
          },
        );
      },
      cursor === undefined ? undefined : String(cursor.position),
    );
    return unsubscribe;
  }, [live, queryClient, sessionId, clearTail]);

  useEffect(() => {
    const unsubscribe = live.subscribe(sessionTapTopic(sessionId), (delta) => {
      if (delta.gone) {
        unsubscribe();
        return;
      }
      const items = delta.items as ReadonlyArray<TapItem>;
      for (const item of items) {
        if (item.itemId !== openItemIdRef.current) continue;
        // Only assistant prose is painted here; a reasoning or command-output
        // tap on the same open item is not the answer and would otherwise
        // show as if it were, until its own row lands and replaces it.
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
