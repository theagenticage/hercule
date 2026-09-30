/**
 * Subscribes the thread surface to its live topics and returns the ref for
 * the live tail element.
 *
 * - `session:<id>:stream` appends rows to the transcript cache.
 * - `session:<id>:tap` streams token deltas into a `TailBuffer`, which keeps
 *   the text of each assistant message that no row holds yet. The open item's
 *   tail is written, unchanged, into one DOM element. The finished prose above
 *   it is made of block elements, so the tail already starts on its own line
 *   and needs no line break.
 *
 * Tap deltas never go into React state. The tail element is written directly,
 * once per animation frame however many deltas arrived, because a `setState`
 * per token would re-render the whole column for every token.
 *
 * Taps sent while the tap is not subscribed are lost, so the items that may
 * have missed some are skipped: they paint no tail, and their text shows when
 * their rows land. The items open in the cached transcript are skipped:
 *
 * - when the tap is subscribed, on mount;
 * - when the live connection tells the tap to `reset` because it subscribes
 *   again, after a reconnect or after the controller ended it;
 * - when the stream's replay lands. It holds the rows written while the stream
 *   was not subscribed, such as during an outage, and an item that started in
 *   them may have sent taps nobody received.
 *
 * A long replay is sent in pages, and only the first page is known to be the
 * replay. An item that starts in a later page and is still open can show its
 * text with a gap until its next stored row. Token positions (#290) will
 * remove the need to guess.
 *
 * When the session no longer exists, the delta arrives with `gone` set and the
 * handler unsubscribes, rather than retrying a subscription that will keep
 * failing.
 */
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  createTailBuffer,
  findNewRows,
  findOpenItem,
  mergeTranscript,
  queryKeys,
  type Live,
} from "@hercule/client-core";
import {
  buildSessionStreamTopic,
  buildSessionTapTopic,
  type TapItem,
  type TranscriptRow,
} from "@hercule/contract";

export const useThreadLive = (
  live: Live,
  queryClient: QueryClient,
  sessionId: string,
  rows: readonly TranscriptRow[],
  /** Called after a paint changes the tail's text: the one way the column grows without a React render. */
  onTapFlush: () => void,
): RefObject<HTMLSpanElement | null> => {
  const tailRef = useRef<HTMLSpanElement | null>(null);
  // One buffer for the life of the screen. When the session changes, the tap
  // is subscribed again, and that drops every tail the buffer still holds.
  const [tail] = useState(createTailBuffer);

  const openItemId = useMemo(() => findOpenItem(rows), [rows]);
  /**
   * True from the moment stream rows are put in the cache until the render
   * that shows them. The tail is not painted in that time: the rows' text has
   * already been removed from it, and painting it before the rows show would
   * make that text vanish for a frame. The cache tells React in a zero-delay
   * timer, so a frame can run in between.
   */
  const rowsLandingRef = useRef(false);

  /** Writes the open item's tail into the tail element, when its text changed. */
  const paintTail = useEffectEvent(() => {
    const element = tailRef.current;
    const text = tail.read(openItemId);
    if (element === null || element.textContent === text) return;
    element.textContent = text;
    onTapFlush();
  });

  /** Skips the items open in the cached transcript, whose earlier taps may be lost. */
  const skipOpenItems = useEffectEvent(() => {
    tail.skipOpenItems(
      queryClient.getQueryData<readonly TranscriptRow[]>(queryKeys.transcript(sessionId)) ?? [],
    );
    if (!rowsLandingRef.current) paintTail();
  });

  // New rows may have taken text from the front of the tail, or changed which
  // item is open. Painting before the browser paints keeps the tail in step
  // with the prose rendered from the same rows, so no text shows twice.
  useLayoutEffect(() => {
    rowsLandingRef.current = false;
    paintTail();
  }, [rows]);

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
          //
          // The refetched rows are never applied to the tail, so the items
          // open in them are skipped.
          skipOpenItems();
          void queryClient.invalidateQueries({ queryKey: queryKeys.transcript(sessionId) });
          return;
        }
        // `:stream` only carries `TranscriptRow`s. The wire type is a union for
        // the whole connection, not per topic, but this topic always has this shape.
        const items = delta.items as ReadonlyArray<TranscriptRow>;
        // Merge by `position` rather than appending after the last row. A row
        // already in the cache is left alone, and a new row is placed in order
        // however late it arrives. Two subscriptions started from the same
        // empty cache both replay from the start of the log, so a later
        // delivery can contain earlier rows.
        const key = queryKeys.transcript(sessionId);
        const current = queryClient.getQueryData<readonly TranscriptRow[]>(key) ?? [];
        const fresh = findNewRows(current, items);
        if (fresh.length === 0) return;
        tail.applyRows(fresh);
        rowsLandingRef.current = true;
        queryClient.setQueryData<readonly TranscriptRow[]>(key, mergeTranscript(current, fresh));
        if (delta.replay) skipOpenItems();
      },
      String(cursor),
    );
    return unsubscribe;
  }, [live, queryClient, sessionId, tail]);

  useEffect(() => {
    let frame: number | null = null;
    skipOpenItems();
    const unsubscribe = live.subscribe(buildSessionTapTopic(sessionId), (delta) => {
      if (delta.gone) {
        unsubscribe();
        return;
      }
      if (delta.reset) {
        skipOpenItems();
        return;
      }
      for (const item of delta.items as ReadonlyArray<TapItem>) tail.appendTap(item);
      frame ??= requestAnimationFrame(() => {
        frame = null;
        if (!rowsLandingRef.current) paintTail();
      });
    });
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [live, sessionId, tail]);

  return tailRef;
};
