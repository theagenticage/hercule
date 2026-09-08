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

  // The cursor the `:stream` subscription starts from, captured once from
  // whatever this hook first saw: computed during render (React's documented
  // lazy-ref pattern), so the subscribing effect below needs no dependency on
  // `rows` and does not resubscribe as the transcript grows.
  const initialCursorRef = useRef<string | undefined>(undefined);
  if (initialCursorRef.current === undefined) {
    const last = rows.at(-1);
    if (last !== undefined) initialCursorRef.current = String(last.position);
  }

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
    const unsubscribe = live.subscribe(
      sessionStreamTopic(sessionId),
      (delta) => {
        if (delta.gone) {
          unsubscribe();
          return;
        }
        if (delta.reset) {
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
        queryClient.setQueryData<readonly TranscriptRow[]>(
          queryKeys.transcript(sessionId),
          (held) => [...(held ?? []), ...items],
        );
      },
      initialCursorRef.current,
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
