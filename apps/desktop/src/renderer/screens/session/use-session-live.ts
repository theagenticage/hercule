/**
 * Keeps one agent of a session on screen current through the live
 * connection: its transcript rows, and the paragraph the agent is writing.
 * The agent is the session's own agent, or one of its subagents. A thread's
 * agent page keeps one agent current this way, and an assistant's
 * Conversation the running turn of its current session. A page follows
 * exactly one agent, so a subagent's page holds the subagent's topics in
 * place of the thread's, never beside them.
 *
 * Two topics carry an agent's live changes:
 *
 * - its stream (`session:<id>:stream`, or
 *   `session:<id>:subagent:<subagentId>:stream`) delivers stored rows, which
 *   are merged into the cached rows. It stays subscribed while the window is
 *   hidden, as described below.
 * - its tap (`session:<id>:tap`, or `session:<id>:subagent:<subagentId>:tap`)
 *   delivers token deltas, which go into the agent's tail buffer
 *   (`createTailBuffer`). It is subscribed only while the window is visible,
 *   because nobody reads a hidden window (spec 17, rule 3), whichever agent's
 *   tap it is.
 *
 * While the window is hidden, the merged rows are kept aside instead of being
 * written to the cache. Each cache write runs the `select` of every query
 * that reads the rows, which builds the thread's blocks and compares them
 * with the previous ones, and then renders the page. Doing that for each
 * stored row is wasted on a page nobody sees (spec 17, rule 3). When the
 * window is shown, the rows kept aside go into the cache in one write, so the
 * page renders once however many rows arrived. Rows kept aside are dropped if
 * something else writes the cache meanwhile, such as a read another component
 * starts, so that read wins as it does in a visible window. A stream `reset`
 * drops them as well.
 *
 * The stream stays subscribed rather than being dropped like the tap, because
 * a new subscription replays what it missed: the controller sends the first
 * 500 rows in one message and each later row in a message of its own. After a
 * long hide, the page would take hundreds of rows one at a time, just as the
 * user looks at it.
 *
 * The paragraph the agent is writing is painted outside React, into one
 * text node, at most once per animation frame however many deltas arrived.
 * A React render per token would render the whole transcript again for
 * every token. React draws a paragraph only once it has finished, as
 * markdown, so the message renders once per paragraph rather than once per
 * token.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";
import {
  buildStreamCursor,
  createTailBuffer,
  decideStreamDelivery,
  decideTapDelivery,
  splitStreamingText,
  type Live,
} from "@hercule/client-core";
import { buildAgentStreamTopic, buildAgentTapTopic, type TranscriptRow } from "@hercule/contract";
import { isWindowVisible, useWindowVisible } from "../../app/window-visibility";

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

/**
 * The transcript merged from the stream rows delivered while the window is
 * hidden, with the cached rows it was merged onto.
 */
interface HiddenRows {
  /**
   * The value the cache held under `rowsKey` when `transcript` was built.
   * `transcript` is valid only while the cache still holds this very value.
   */
  readonly cached: readonly TranscriptRow[] | undefined;
  /** The whole merged transcript, already trimmed. */
  readonly transcript: readonly TranscriptRow[];
}

/** What `useSessionLive` returns. */
export interface SessionLive {
  /** Attaches the element an open message's paragraph being written is painted into. */
  readonly attachOpenParagraph: AttachOpenParagraph;
  /**
   * When (an ISO time) the controller sent a row this app cannot decode,
   * usually because the controller is newer than the app, or undefined while
   * the stream is readable. The stream has stopped for good, the rows already
   * cached stay, and the screen should tell the user to update the app.
   */
  readonly streamUnreadableAt: string | undefined;
}

/** What `useSessionLive` keeps current, and where. */
export interface SessionLiveOptions {
  /**
   * The controller's live connection, or `null` to draw the session without
   * live changes, as the specimens do.
   */
  readonly live: Live | null;
  readonly queryClient: QueryClient;
  /** The session whose agent is followed. */
  readonly sessionId: string;
  /** The subagent to follow, or undefined for the session's own agent. */
  readonly subagentId: string | undefined;
  /**
   * The key the agent's rows are cached under. An agent page passes
   * `queryKeys.transcript(sessionId, subagentId)`, the Conversation
   * `queryKeys.runningTurn(sessionId)`. Stream rows are merged into the rows
   * held there, a stream `reset` reads them again through this key, and the
   * stream is followed only while this query is not fetching.
   */
  readonly rowsKey: QueryKey;
  /**
   * The rows cached under `rowsKey`, so that the tail is painted in the same
   * commit as the rows that hold its text.
   */
  readonly rows: readonly TranscriptRow[];
  /**
   * Trims the rows held under `rowsKey` each time stream rows are merged
   * into them, or is undefined to keep every row. The Conversation passes
   * `trimToRunningTurn`, because it holds only its running turn's rows,
   * and a long session would otherwise keep every earlier turn in memory.
   */
  readonly trimRows?: ((rows: readonly TranscriptRow[]) => readonly TranscriptRow[]) | undefined;
  /**
   * Called once when the agent's stream reports `gone`: the session no longer
   * exists. The thread's page uses it to delete the thread's saved copy.
   */
  readonly onGone?: (() => void) | undefined;
}

/**
 * Subscribes to the live topics of one agent of a session, and returns the
 * function that attaches the element an open message's paragraph being
 * written is painted into (`attachOpenParagraph`), and when the stream
 * became unreadable (`streamUnreadableAt`). The open message draws its finished paragraphs
 * as markdown, then that element, empty, such as
 * `<p ref={(element) => attachOpenParagraph(element, message)} />`: the
 * hook puts one text node inside it and writes there the rest of the
 * message's text, stored and streamed. `options` are described on
 * `SessionLiveOptions`.
 *
 * The hook keeps one tail buffer, and reads `rowsKey`, `trimRows` and `onGone` once,
 * for the life of the component, so the caller mounts the component again
 * for another agent: the thread's routes key the page by session id and
 * subagent id. Reading them once also means a caller may build them inline
 * on every render without the subscriptions starting again.
 *
 * The stream is followed only while the query under `rowsKey` is not
 * fetching. A fetch is a read that brings the rows up to date, such as the
 * one after a thread opens from its saved copy, the read after a stream
 * `reset`, or one that another component starts. While it runs the stream is
 * not subscribed, so no row can arrive only to be replaced by the read's
 * older snapshot and leave a hole in the rows. When the read ends,
 * successfully or not, the stream is subscribed after the last row held then
 * (`buildStreamCursor`), and its replay fills what the read could not. The
 * hook learns of a read from the query cache's own notifications, which are
 * synchronous, never from a React render: a fast read could start and end
 * before React rendered, and a row delivered in between would be replaced.
 *
 * What the hook does with each delivery, as `decideStreamDelivery` and
 * `decideTapDelivery` decide it:
 *
 * - Stream rows not held yet update the tail buffer first, and are then
 *   merged into the cached rows, or kept aside while the window is hidden.
 * - A stream `reset` means rows may have been missed. The hook stops
 *   following the stream, skips the open items (their tails are cleared), and
 *   reads the rows again, which holds the stream back as described above.
 *   Deliveries already on their way are ignored. The rows kept aside are
 *   dropped at once, because they cannot be trusted after a reset.
 * - A `gone` on either topic ends that subscription: the session no longer
 *   exists. A `gone` on the stream also calls `onGone`, and is final: the
 *   stream is not subscribed again, even when the rows query fetches again.
 * - An `unreadable` on the stream means the controller sent a row this app
 *   cannot decode, and the live connection has stopped the subscription for
 *   good. The hook unsubscribes, keeps the cached rows, and returns
 *   `streamUnreadableAt`. It is final too: the stream is not subscribed
 *   again, because it would stop at the same row. The tap is unsubscribed as
 *   well, and the tails it held are dropped: the buffer forgets an item only
 *   when that item's `item.completed` row arrives on the stream, so the taps
 *   would pile up, and the open paragraph would keep painting text that no
 *   row will ever match.
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
 * - When the stream is subscribed, because the rows may have grown while it
 *   was not (a read brought them up to date, or the stream was held back).
 *
 * The controller sends at most 500 rows in a replay's first delivery and each
 * later row in a delivery of its own, so only the first delivery is known to
 * be the replay. An item that starts in a later delivery and is still open
 * can show its text with a gap until its next stored row. Token positions
 * (#290) will remove the need to guess.
 */
export const useSessionLive = ({
  live,
  queryClient,
  sessionId,
  subagentId,
  rowsKey: rowsKeyAtMount,
  rows,
  trimRows: trimRowsAtMount,
  onGone: onGoneAtMount,
}: SessionLiveOptions): SessionLive => {
  const [buffer] = useState(createTailBuffer);
  const [streamUnreadableAt, setStreamUnreadableAt] = useState<string | undefined>(undefined);
  const isStreamUnreadable = streamUnreadableAt !== undefined;
  const [rowsKey] = useState(() => rowsKeyAtMount);
  const [trimRows] = useState(() => trimRowsAtMount);
  const [onGone] = useState(() => onGoneAtMount);
  const visible = useWindowVisible();
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
   * True once the stream reported `gone`. The session does not come back, so
   * the stream is never subscribed again, and `onGone` is called only once,
   * however often the rows query fetches afterwards.
   */
  const goneRef = useRef(false);
  /**
   * The held rows with the stream rows delivered while the window is hidden
   * merged in (trimmed by `trimRows`), and the cached rows they were merged
   * onto. It is `null` when no rows are kept aside. The rows are newer than
   * the cache, and are written there when the window is shown.
   */
  const hiddenRowsRef = useRef<HiddenRows | null>(null);

  /**
   * Returns the rows kept aside, or `null` when there are none or they are
   * no longer valid. They are valid while the cache still holds the rows they
   * were merged onto. Any other write to the cache replaces that value, such
   * as the read after a stream `reset`: the rows read are then newer, and the
   * rows kept aside are dropped. A read that returns equal rows keeps the
   * cached value (Query shares the structure), so the rows kept aside stay
   * valid, and they are newer.
   */
  const readHiddenRows = useCallback((): readonly TranscriptRow[] | null => {
    const hidden = hiddenRowsRef.current;
    if (hidden === null) return null;
    const cached = queryClient.getQueryData<readonly TranscriptRow[]>(rowsKey);
    return hidden.cached === cached ? hidden.transcript : null;
  }, [queryClient, rowsKey]);

  /**
   * Returns the rows held for the agent: the rows kept aside while the window
   * is hidden, when there are some and still valid, otherwise the cached rows.
   * The hook decides from these rows which stream rows are new, where the
   * stream starts, and which items are open, so the rows that arrived while
   * the window was hidden count.
   */
  const readHeldRows = useCallback(
    (): readonly TranscriptRow[] =>
      readHiddenRows() ?? queryClient.getQueryData<readonly TranscriptRow[]>(rowsKey) ?? [],
    [queryClient, rowsKey, readHiddenRows],
  );

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
   * held rows, which can include rows not rendered yet, and paints the
   * result.
   */
  const skipOpenItems = useCallback((): void => {
    buffer.skipOpenItems(readHeldRows());
    schedulePaint();
  }, [buffer, readHeldRows, schedulePaint]);

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
    // An unreadable stream does not come back: it would stop at the same row.
    // The delivery already called `stop()`. This effect runs again once the
    // state is set, and its cleanup removes the cache listener below, which
    // would otherwise subscribe to the stream again when the rows are read.
    if (live === null || isStreamUnreadable) return;
    const rowsHash = hashKey(rowsKey);
    const isReadingRows = (): boolean =>
      queryClient.getQueryState(rowsKey)?.fetchStatus === "fetching";
    // Ends the current subscription to the stream, or is null when there is none.
    let stopFollowing: (() => void) | null = null;
    const stop = (): void => {
      stopFollowing?.();
      stopFollowing = null;
    };
    // Subscribes to the stream after the last row held now. The rows kept
    // aside count when they are still valid: the stream must not replay them.
    const follow = (): void => {
      // False once this subscription ends. The live connection may still hand
      // over a delivery that was already on its way, and merging it would put
      // a row in the cache that a read is about to replace.
      let active = true;
      const unsubscribe = live.subscribe(
        buildAgentStreamTopic(sessionId, subagentId),
        (delta) => {
          if (!active) return;
          const delivery = decideStreamDelivery(readHeldRows(), delta);
          if (delivery.kind === "gone") {
            goneRef.current = true;
            stop();
            onGone?.();
          } else if (delivery.kind === "unreadable") {
            stop();
            // Kept if already set, so the time is the first unreadable delta's.
            setStreamUnreadableAt((at) => at ?? new Date().toISOString());
          } else if (delivery.kind === "reset") {
            // The cache listener below follows the stream again when the read ends.
            // "all" starts the read even when no component observes the rows, so
            // the stream cannot stay stopped.
            stop();
            // Cache identity cannot prove the rows kept aside valid after a reset:
            // a read that returns equal rows keeps the same cached array.
            hiddenRowsRef.current = null;
            skipOpenItems();
            void queryClient.invalidateQueries({ queryKey: rowsKey, refetchType: "all" });
          } else if (delivery.kind === "rows") {
            buffer.applyRows(delivery.fresh);
            const transcript =
              trimRows === undefined ? delivery.transcript : trimRows(delivery.transcript);
            // The document is read here, not the `visible` state, so that the
            // stream is not subscribed again each time the window is hidden or
            // shown: a new subscription would replay from the controller.
            if (!isWindowVisible()) {
              hiddenRowsRef.current = {
                cached: queryClient.getQueryData<readonly TranscriptRow[]>(rowsKey),
                transcript,
              };
            } else {
              rowsLandingRef.current = true;
              queryClient.setQueryData(rowsKey, transcript);
              // The transcript includes the rows kept aside, and a row can
              // arrive after the window was shown but before the effect that
              // writes them ran.
              hiddenRowsRef.current = null;
            }
            if (delivery.replay) skipOpenItems();
          }
        },
        buildStreamCursor(readHeldRows()),
      );
      stopFollowing = () => {
        active = false;
        unsubscribe();
      };
      skipOpenItems();
    };
    // The query cache calls this synchronously when the query changes: before
    // a read's function runs, and before the read's result is stored.
    const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.query.queryHash !== rowsHash) return;
      if (event.query.state.fetchStatus === "fetching") stop();
      else if (stopFollowing === null && !goneRef.current) follow();
    });
    if (!isReadingRows() && !goneRef.current) follow();
    return () => {
      unsubscribeCache();
      stop();
    };
  }, [
    live,
    queryClient,
    sessionId,
    subagentId,
    rowsKey,
    trimRows,
    onGone,
    isStreamUnreadable,
    buffer,
    readHeldRows,
    skipOpenItems,
  ]);

  // Writes the rows kept aside to the cache in one write when the window is
  // shown, so the page renders once however many rows arrived. They are
  // written only if the cache still holds the rows they were merged onto. The
  // tap effect below skips the items open in them whichever effect runs
  // first, because `skipOpenItems` reads the rows kept aside too.
  useEffect(() => {
    if (!visible) return;
    const transcript = readHiddenRows();
    hiddenRowsRef.current = null;
    if (transcript === null) return;
    rowsLandingRef.current = true;
    queryClient.setQueryData(rowsKey, transcript);
  }, [visible, queryClient, rowsKey, readHiddenRows]);

  useEffect(() => {
    if (live === null || !visible) return;
    skipOpenItems();
    // With the stream unreadable no row will ever match the tails, so the tap
    // is not followed. The skip above has dropped the tails it held.
    if (isStreamUnreadable) return;
    const unsubscribe = live.subscribe(buildAgentTapTopic(sessionId, subagentId), (delta) => {
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
  }, [
    live,
    sessionId,
    subagentId,
    visible,
    isStreamUnreadable,
    buffer,
    schedulePaint,
    skipOpenItems,
  ]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  // React calls the cleanup that the attach function returns when the element
  // goes, or before the ref callback changes, rather than calling the ref with
  // null.
  const attachOpenParagraph = useCallback<AttachOpenParagraph>(
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
  return { attachOpenParagraph, streamUnreadableAt };
};
