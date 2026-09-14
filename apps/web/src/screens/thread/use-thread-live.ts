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
import { mergeTranscript, openItemOf, queryKeys, type Live } from "@hydra/client-core";
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
  /**
   * Whether the tail opens a paragraph of its own: true where the turn's
   * committed assistant text ends in another item than the open one. A turn
   * holds any number of assistant messages (spec 06 §6.2), and the break a new
   * one gets when its row lands has to be there while it is still streaming,
   * or the two run together as one sentence until it does.
   */
  breakBeforeTail: boolean,
  /** Called after a tap flush paints text - the one growth path no React render follows. */
  onTapFlush: () => void,
): RefObject<HTMLSpanElement | null> => {
  const tailRef = useRef<HTMLSpanElement | null>(null);
  const bufferRef = useRef("");
  const openItemIdRef = useRef<string | null>(null);
  const frameRef = useRef<number | null>(null);

  // Read at flush time rather than rendered beside the text: the break belongs
  // to text this hook writes to the DOM directly, and rendering it in React
  // would leave a blank paragraph standing whenever the tail holds nothing -
  // an open item that is a command, or an assistant message between its first
  // row and its first token.
  const breakRef = useRef(breakBeforeTail);

  const flushTail = useCallback(() => {
    const text = bufferRef.current;
    if (tailRef.current !== null) {
      tailRef.current.textContent = text === "" || !breakRef.current ? text : `\n\n${text}`;
    }
    onTapFlush();
  }, [onTapFlush]);

  // Mirrored into the ref the tap handler reads synchronously, the way the
  // open item below is, rather than written during render.
  useEffect(() => {
    breakRef.current = breakBeforeTail;
    flushTail();
  }, [breakBeforeTail, flushTail]);

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
    // An empty cache subscribes from the start of the log, not from the head:
    // a just-spawned session is read before its first rows exist, and "no
    // cursor" means "whatever happens next", so every row written between that
    // read and this subscription would be lost from a cache that is never
    // refetched. Positions start at 1 (`session_stream`'s
    // `COALESCE(MAX(position), 0) + 1`) and the controller replays everything
    // strictly after the cursor, so 0 names no row and asks for all of them -
    // it is also never past the head, which is the only cursor the controller
    // refuses.
    const cursor = held?.at(-1)?.position ?? 0;

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
        // Merged on `position`, not appended after the last row held: a row
        // this cache already has is the same row and is left alone, and one it
        // does not is placed in order however late it arrives. Two
        // subscriptions seeded from the same empty cache both replay from the
        // start of the log, so the later delivery can be the earlier rows.
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
