/**
 * Keeps a session on screen current through the live connection: its
 * transcript rows, and the paragraph the agent is writing. The thread screen
 * keeps a thread's session current this way, and an assistant's Conversation
 * the running turn of its current session.
 *
 * Two topics carry a session's live changes:
 *
 * - `session:<id>:stream` delivers stored rows, which are merged into the
 *   cached rows. It stays subscribed while the window is hidden, so the
 *   rows are whole when the window is shown again.
 * - `session:<id>:tap` delivers token deltas, which go into the session's
 *   tail buffer (`createTailBuffer`). It is subscribed only while the window
 *   is visible, because nobody reads a hidden window (spec 17, rule 3).
 *
 * The paragraph the agent is writing is painted outside React, into one text
 * node, at most once per animation frame however many deltas arrived. A React
 * render per token would render the whole transcript again for every token.
 * React draws a paragraph only once it has finished, as markdown, so the
 * message renders once per paragraph rather than once per token.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import {
  buildStreamCursor,
  createTailBuffer,
  decideStreamDelivery,
  decideTapDelivery,
  splitStreamingText,
  type Live,
} from "@hercule/client-core";
import {
  buildSessionStreamTopic,
  buildSessionTapTopic,
  type TranscriptRow,
} from "@hercule/contract";

/**
 * A message the agent is still writing, as it attaches the element that its
 * open paragraph, the one being written, is painted into.
 */
export interface OpenMessage {
  /** The message's item id, whose tail is painted. */
  readonly itemId: string;
  /** The text the transcript's rows hold for the message. */
  readonly storedText: string;
  /**
   * The finished paragraphs the message draws as markdown before the
   * element: a `settled` part that `splitStreamingText` returned for its text.
   */
  readonly settledText: string;
  /**
   * Called with the message's finished paragraphs when they change: when one
   * more has finished, or when the tail was dropped and fewer are known. The
   * message then draws them, and attaches again with them.
   */
  readonly onSettle: (settledText: string) => void;
}

/**
 * Attaches `element` as the element the open paragraph of `message` is
 * painted into, and returns the function that detaches it. Call it from a ref
 * callback, which React calls with `null` only when it returned nothing.
 */
export type AttachOpenParagraph = (
  element: HTMLElement | null,
  message: OpenMessage,
) => (() => void) | undefined;

/** Calls `onChange` each time the window is hidden or shown. Returns a function that stops. */
const subscribeToVisibility = (onChange: () => void): (() => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
  };
};

/**
 * Checks whether the window can be seen. In Electron the page is hidden
 * while its window is hidden (⌘W hides it) or minimized, and on macOS also
 * while other windows cover it completely.
 */
const isWindowVisible = (): boolean => document.visibilityState === "visible";

/**
 * Subscribes the session `sessionId` to its live topics, and returns the
 * function that attaches the element an open message's paragraph being written is
 * painted into. The open message draws its finished paragraphs as markdown,
 * then that element, empty, such as
 * `<p ref={(element) => attachOpenParagraph(element, message)} />`: the hook
 * puts one text node inside it and writes there the rest of the message's
 * text, stored and streamed.
 *
 * - `live` is the controller's live connection, or `null` to draw the
 *   session without live changes, as the thread specimen does.
 * - `queryKey` is the key the session's rows are cached under: the thread
 *   passes `queryKeys.transcript(sessionId)`, the Conversation the key of its
 *   running turn's rows. Stream rows are merged into the rows held there, and
 *   a stream `reset` reads them again through that key.
 * - `rows` are the rows cached under `queryKey`, so that the tail is painted
 *   in the same commit as the rows that hold its text.
 *
 * The hook keeps one tail buffer, and reads `queryKey` once, for the life of
 * the component, so the caller mounts the component again for another
 * session: the thread route keys the screen by session id. Reading the key
 * once also means a caller may build it inline on every render without the
 * subscriptions starting again.
 *
 * What the hook does with each delivery, as `decideStreamDelivery` and
 * `decideTapDelivery` decide it:
 *
 * - Stream rows not held yet update the tail buffer first, and are then
 *   merged into the cached rows. The subscription starts after the
 *   last held row (`buildStreamCursor`).
 * - A stream `reset` means rows may have been missed, so the rows are
 *   read again, and the open items are skipped: their tails are cleared.
 * - A `gone` on either topic ends that subscription: the session no longer
 *   exists.
 *
 * The tail buffer skips the items that were open while the tap was not
 * subscribed, because the taps sent in that time are lost:
 *
 * - When the tap is subscribed, at mount and when the window is shown, and
 *   when the live connection tells it to `reset` because it subscribes again,
 *   after a reconnect or after the controller ended it. The items open in the
 *   rows held then are skipped.
 * - When the stream delivers its replay, which holds the rows written while
 *   it was not subscribed, such as during an outage. An item that started in
 *   those rows may have sent taps nobody received, so the items open once
 *   the replay is merged are skipped too.
 *
 * A long replay is sent in pages, and only the first page is known to be the
 * replay. An item that starts in a later page and is still open can show its
 * text with a gap until its next stored row. Token positions (#290) will
 * remove the need to guess.
 */
export const useSessionLive = (
  live: Live | null,
  queryClient: QueryClient,
  sessionId: string,
  queryKey: QueryKey,
  rows: readonly TranscriptRow[],
): AttachOpenParagraph => {
  const [buffer] = useState(createTailBuffer);
  const [rowsKey] = useState(() => queryKey);
  const visible = useSyncExternalStore(subscribeToVisibility, isWindowVisible);
  /** The open message attached last, and the text node its open paragraph is written into. */
  const targetRef = useRef<{ readonly node: Text; readonly message: OpenMessage } | null>(null);
  const frameRef = useRef<number | null>(null);
  /**
   * True from the moment stream rows are put in the cache until the render
   * that shows them. Nothing is painted in that time: the rows' text has
   * already been removed from the tail, and the open message still holds the
   * stored text from before the rows, so the rows' text would vanish for a
   * frame.
   */
  const rowsLandingRef = useRef(false);

  /**
   * Paints the open message's paragraph being written: its text, stored and
   * streamed, after its finished paragraphs. When the finished paragraphs
   * have changed, it hands them to the message instead, and paints nothing.
   * The message draws them and attaches again, which paints the rest in the
   * same commit, so no frame shows a paragraph twice or not at all.
   */
  const paint = useCallback((): void => {
    const target = targetRef.current;
    if (target === null || rowsLandingRef.current) return;
    const { itemId, storedText, settledText, onSettle } = target.message;
    const text = splitStreamingText(storedText + buffer.read(itemId), settledText);
    if (text.settled !== settledText) onSettle(text.settled);
    else if (target.node.data !== text.open) target.node.data = text.open;
  }, [buffer]);

  /** Paints at the next animation frame, unless a paint is already due then. */
  const schedulePaint = useCallback((): void => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      // A paragraph that finished is drawn in this frame too: the message
      // renders before `flushSync` returns, not in a later task. Rows that
      // landed before that task would block the paint that follows the
      // render, and the paragraph being written would vanish for a frame.
      flushSync(paint);
    });
  }, [paint]);

  /**
   * Skips every item that may have missed taps or rows, judged from the
   * rows in the cache, which can hold rows not rendered yet, and paints
   * the result.
   */
  const skipOpenItems = useCallback((): void => {
    buffer.skipOpenItems(queryClient.getQueryData<readonly TranscriptRow[]>(rowsKey) ?? []);
    schedulePaint();
  }, [buffer, queryClient, rowsKey, schedulePaint]);

  // Runs in the commit that shows new rows, before the browser paints, so the
  // text a row took from the tail and the row itself show in the same frame.
  // When the rows added to the open message's text, the message attached
  // again earlier in this commit, because a child's ref is attached before
  // its parent's effects run. That attach painted nothing, because the rows
  // were still landing then.
  useLayoutEffect(() => {
    rowsLandingRef.current = false;
    paint();
  }, [rows, paint]);

  useEffect(() => {
    if (live === null) return;
    const readHeldRows = (): readonly TranscriptRow[] =>
      queryClient.getQueryData<readonly TranscriptRow[]>(rowsKey) ?? [];
    const unsubscribe = live.subscribe(
      buildSessionStreamTopic(sessionId),
      (delta) => {
        const delivery = decideStreamDelivery(readHeldRows(), delta);
        if (delivery.kind === "gone") {
          unsubscribe();
        } else if (delivery.kind === "reset") {
          // The live connection subscribes again from the head at once, while
          // the rows are still being read, so a row written in between
          // is in neither. This gap is accepted: a reset happens only when
          // the log was replaced, and waiting for the read would hold the
          // stream back.
          skipOpenItems();
          void queryClient.invalidateQueries({ queryKey: rowsKey });
        } else if (delivery.kind === "rows") {
          buffer.applyRows(delivery.fresh);
          rowsLandingRef.current = true;
          queryClient.setQueryData(rowsKey, delivery.transcript);
          if (delivery.replay) skipOpenItems();
        }
      },
      buildStreamCursor(readHeldRows()),
    );
    return unsubscribe;
  }, [live, queryClient, sessionId, rowsKey, buffer, skipOpenItems]);

  useEffect(() => {
    if (live === null || !visible) return;
    skipOpenItems();
    const unsubscribe = live.subscribe(buildSessionTapTopic(sessionId), (delta) => {
      const delivery = decideTapDelivery(delta);
      if (delivery.kind === "gone") {
        unsubscribe();
      } else if (delivery.kind === "reset") {
        skipOpenItems();
      } else {
        for (const tap of delivery.taps) buffer.appendTap(tap);
        schedulePaint();
      }
    });
    return unsubscribe;
  }, [live, sessionId, visible, buffer, schedulePaint, skipOpenItems]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  // React calls the cleanup this returns when the element goes, or before
  // the ref callback changes, rather than calling the ref with null.
  return useCallback(
    (element, message) => {
      if (element === null) return undefined;
      const node = document.createTextNode("");
      element.replaceChildren(node);
      const target = { node, message };
      targetRef.current = target;
      paint();
      return () => {
        if (targetRef.current === target) targetRef.current = null;
      };
    },
    [paint],
  );
};
