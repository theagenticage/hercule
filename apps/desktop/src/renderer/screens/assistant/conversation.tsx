/**
 * An assistant's Conversation: the blocks `buildConversationBlocks` returns,
 * in the region "Conversation", virtualized as the thread's transcript is,
 * opening at the bottom and following new content while the reader is there.
 *
 * The messages are read a page at a time, newest first. When the reader
 * scrolls within one screen of the top, the page of messages before them is
 * read and added above, and the view is moved by the height they add, so
 * the message the reader was looking at stays where it was.
 *
 * Like the transcript, the Conversation is not a live region: the
 * assistant's streaming text would flood a screen reader.
 */
import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type Ref,
} from "react";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  buildConversationBlocks,
  flattenMessagePages,
  resolveBrowserTimezone,
  type ConversationBlock,
  type Pose,
} from "@hercule/client-core";
import type { Assistant, Session, TranscriptRow } from "@hercule/contract";
import { conversationMessagesQuery } from "../../app/queries";
import { Face, type Look } from "../../faces";
import { UserMessage } from "../session/messages";
import { useStartOfToday } from "../session/start-of-today";
import type { AttachOpenParagraph } from "../session/use-session-live";
import { useShowsClassicScrollbar } from "../thread/classic-scrollbar";
import { DayStamp, Notice, OpenReply, StoredReply } from "./conversation-messages";

/**
 * The space above the first block, under the floating header: the book's
 * `--header-clearance`, which thread-header.css sets on `.transcript`.
 */
const HEADER_CLEARANCE = 108;

/**
 * The space between two blocks: the book's `.tx.atx { gap: 20px }`. Every
 * block, the first too, includes it as its top padding, so a block keeps its
 * height when earlier messages are added above it. The column's top padding
 * is the header's clearance less this gap (see assistant.css).
 */
const BLOCK_GAP = 20;

/** Where the first block starts in the column, for the virtualizer. */
const SCROLL_MARGIN = HEADER_CLEARANCE - BLOCK_GAP;

/**
 * The space below the last block before the composer is measured: the
 * thread's `.tx { padding-bottom: 360px }`, which the Conversation's column
 * also has.
 */
const DEFAULT_END_PADDING = 360;

/** How far the composer's stack sits above the pane's bottom edge: `.composer-wrap`'s bottom padding. */
const COMPOSER_BOTTOM_OFFSET = 18;

/** The space between the last line and the composer, when scrolled to the bottom, as the book draws it. */
const LAST_LINE_CLEARANCE = 14;

/** How close to the bottom, in CSS pixels, the reader must be for the Conversation to follow new content. */
const FOLLOW_THRESHOLD = 12;

/** How many blocks are mounted beyond each end of the visible part. */
const OVERSCAN = 6;

/** Roughly how many characters fit on one line of a reply, and of the owner's bubble. */
const REPLY_CHARS_PER_LINE = 100;
const OWNER_CHARS_PER_LINE = 80;

/** The height of one line of a reply, and of the owner's bubble, in CSS pixels. */
const REPLY_LINE_HEIGHT = 22.4;
const OWNER_LINE_HEIGHT = 21.7;

/**
 * Estimates a block's height, without the gap above it, before it is
 * measured: a stamp is one 11px line, a reply its name line and its text
 * lines, the owner's bubble its padding, time and lines, and a notice its
 * face and padding. Only blocks that were never mounted use the estimate.
 */
const estimateBlockHeight = (block: ConversationBlock): number => {
  switch (block.kind) {
    case "stamp":
      return 15;
    case "owner":
      return (
        40 +
        OWNER_LINE_HEIGHT * Math.max(1, Math.ceil(block.message.text.length / OWNER_CHARS_PER_LINE))
      );
    case "reply":
      return (
        21.5 +
        REPLY_LINE_HEIGHT * Math.max(1, Math.ceil(block.message.text.length / REPLY_CHARS_PER_LINE))
      );
    case "notice":
      return 44;
    case "open-reply":
      return 43.9;
  }
};

/** Returns a mounted block's height as laid out, unrounded, as the thread's transcript measures it. */
const measureBlock = (element: Element, entry: ResizeObserverEntry | undefined): number =>
  entry?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height;

/** Returns the key of the first stored message among `blocks`, or `undefined` when there is none. */
const findFirstMessageKey = (blocks: readonly ConversationBlock[]): string | undefined =>
  blocks.find((block) => block.kind !== "stamp" && block.kind !== "open-reply")?.key;

/** What the assistant screen can ask of the Conversation. */
export interface ConversationHandle {
  /** Scrolls to the bottom at once, and follows new content from there. */
  readonly scrollToBottom: () => void;
}

/**
 * Renders `assistant`'s Conversation, or the greeting while it holds no
 * message and no reply is being written.
 *
 * - `look` is the assistant's look, which every face is drawn in.
 * - `session` is the current session of the Conversation, or `null` when
 *   none has started. Its running turn is in `runningTurnRows`, oldest
 *   first, and `attachOpenParagraph` paints the text it is writing.
 * - `pose` is the assistant's pose, which the open reply's face shows.
 * - `composerStack`, `onBottomChange` and `ref` are as the thread's
 *   transcript takes them: see `Transcript`.
 */
export function Conversation({
  assistant,
  look,
  session,
  runningTurnRows,
  pose,
  attachOpenParagraph,
  composerStack,
  onBottomChange,
  ref,
}: {
  readonly assistant: Assistant;
  readonly look: Look;
  readonly session: Session | null;
  readonly runningTurnRows: readonly TranscriptRow[];
  readonly pose: Pose;
  readonly attachOpenParagraph: AttachOpenParagraph;
  readonly composerStack: HTMLElement | null;
  readonly onBottomChange: (atBottom: boolean) => void;
  readonly ref?: Ref<ConversationHandle>;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const messages = useSuspenseInfiniteQuery(
    conversationMessagesQuery(client, assistant.mainConversationId),
  );
  const [timezone] = useState(() => resolveBrowserTimezone());
  const today = useStartOfToday();
  const blocks = buildConversationBlocks({
    messages: flattenMessagePages(messages.data.pages),
    runningTurnRows,
    session,
    reply: assistant.reply,
    pose,
    timezone,
    now: new Date(today),
  });

  if (blocks.length === 0) {
    return (
      <div className="transcript">
        <div className="hello-who">
          <Face look={look} pose="idle" size={76} />
          <h2>{assistant.name}</h2>
          <p>
            Send a message to start. {assistant.name} falls asleep after a quiet spell and picks up
            where it left off.
          </p>
        </div>
      </div>
    );
  }

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = messages;
  return (
    <ConversationList
      name={assistant.name}
      look={look}
      blocks={blocks}
      timezone={timezone}
      today={today}
      attachOpenParagraph={attachOpenParagraph}
      readEarlierMessages={() => {
        if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
      }}
      composerStack={composerStack}
      onBottomChange={onBottomChange}
      ref={ref}
    />
  );
}

/**
 * Renders the virtualized list of `blocks`. `readEarlierMessages` is called
 * whenever the reader is within one screen of the top; it reads the page of
 * messages before the ones held, unless every page is read or one is on its
 * way. The other props are `Conversation`'s.
 */
function ConversationList({
  name,
  look,
  blocks,
  timezone,
  today,
  attachOpenParagraph,
  readEarlierMessages,
  composerStack,
  onBottomChange,
  ref,
}: {
  readonly name: string;
  readonly look: Look;
  readonly blocks: readonly ConversationBlock[];
  readonly timezone: string;
  readonly today: number;
  readonly attachOpenParagraph: AttachOpenParagraph;
  readonly readEarlierMessages: () => void;
  readonly composerStack: HTMLElement | null;
  readonly onBottomChange: (atBottom: boolean) => void;
  readonly ref?: Ref<ConversationHandle> | undefined;
}): JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const showsScrollbar = useShowsClassicScrollbar(scrollRef);
  // True while the reader is at the bottom. The Conversation opens there.
  const followingRef = useRef(true);
  // Where the view was at the last scroll event, to tell a scroll up from a scroll down.
  const lastScrollTopRef = useRef(0);
  /**
   * The first stored message drawn at the last commit, and where it started
   * in the column. When earlier messages are added above it, the view moves
   * down by as much as it did.
   */
  const anchorRef = useRef<{ readonly key: string; readonly start: number } | null>(null);

  // Memoized by hand, as the thread's transcript explains: the React
  // Compiler leaves this component alone because of the virtualizer.
  const getItemKey = useCallback((index: number) => blocks[index]!.key, [blocks]);
  const estimateSize = useCallback(
    (index: number) => BLOCK_GAP + estimateBlockHeight(blocks[index]!),
    [blocks],
  );
  // The estimated scroll position of the bottom, so the first render mounts
  // the last blocks rather than the first. Read once, when the virtualizer is
  // created.
  const estimateBottomOffset = (): number =>
    Math.max(
      0,
      blocks.reduce((sum, _block, index) => sum + estimateSize(index), SCROLL_MARGIN) +
        DEFAULT_END_PADDING -
        window.innerHeight,
    );

  // eslint-disable-next-line react-hooks/incompatible-library -- The virtualizer returns an object that changes inside while its identity stays the same, which the React Compiler cannot memoize, so the compiler leaves this component alone. The callbacks above keep the renders cheap instead.
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    measureElement: measureBlock,
    overscan: OVERSCAN,
    scrollMargin: SCROLL_MARGIN,
    initialRect: { width: 0, height: window.innerHeight },
    initialOffset: estimateBottomOffset,
  });

  // The space under the last block, and following the bottom, work as in
  // the thread's transcript: see `Transcript`.
  useLayoutEffect(() => {
    const scroller = scrollRef.current!;
    const column = columnRef.current!;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target !== composerStack) continue;
        const stackHeight = entry.borderBoxSize[0]?.blockSize ?? 0;
        column.style.paddingBottom = `${Math.round(stackHeight + COMPOSER_BOTTOM_OFFSET + LAST_LINE_CLEARANCE)}px`;
      }
      if (followingRef.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(scroller);
    observer.observe(column);
    if (composerStack !== null) observer.observe(composerStack);
    return () => {
      observer.disconnect();
    };
  }, [composerStack]);

  // Runs before the browser paints the blocks added above, so the reader
  // never sees the view jump. The added blocks start at their estimated
  // heights; when they are measured, the virtualizer moves the view by the
  // difference itself, because they sit above it.
  useLayoutEffect(() => {
    const key = findFirstMessageKey(blocks);
    const measurements = virtualizer.measurementsCache;
    const previous = anchorRef.current;
    if (previous !== null && previous.key !== key) {
      const moved = measurements[blocks.findIndex((block) => block.key === previous.key)];
      if (moved !== undefined) scrollRef.current!.scrollTop += moved.start - previous.start;
    }
    const first = measurements[blocks.findIndex((block) => block.key === key)];
    anchorRef.current =
      key === undefined || first === undefined ? null : { key, start: first.start };
  });

  const noteScroll = (): void => {
    const scroller = scrollRef.current!;
    const atBottom =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_THRESHOLD;
    // Only the reader scrolling up leaves the bottom. A scroll down that
    // stops short of it is the virtualizer's first scroll to its estimated
    // bottom, whose event can arrive after the blocks were measured taller
    // than estimated; counting it would shrink the composer of a
    // Conversation that was never scrolled.
    const following =
      atBottom || (followingRef.current && scroller.scrollTop >= lastScrollTopRef.current);
    lastScrollTopRef.current = scroller.scrollTop;
    if (scroller.scrollTop < scroller.clientHeight) readEarlierMessages();
    if (following === followingRef.current) return;
    followingRef.current = following;
    onBottomChange(following);
  };

  useImperativeHandle(ref, () => ({
    scrollToBottom: () => {
      const scroller = scrollRef.current!;
      scroller.scrollTop = scroller.scrollHeight;
      noteScroll();
    },
  }));

  /** Returns the element that draws `block`. */
  const renderBlock = (block: ConversationBlock): JSX.Element => {
    switch (block.kind) {
      case "stamp":
        return <DayStamp label={block.label} />;
      case "owner":
        return (
          <UserMessage
            text={block.message.text}
            at={block.message.createdAt}
            timezone={timezone}
            today={today}
          />
        );
      case "reply":
        return (
          <StoredReply
            look={look}
            name={block.message.senderLabel}
            time={block.time}
            text={block.message.text}
          />
        );
      case "notice":
        return <Notice look={look} text={block.message.text} time={block.time} />;
      case "open-reply":
        return (
          <OpenReply
            look={look}
            name={name}
            block={block}
            attachOpenParagraph={attachOpenParagraph}
          />
        );
    }
  };

  const virtualItems = virtualizer.getVirtualItems();
  const first = virtualItems[0];
  const last = virtualItems.at(-1);
  const end = SCROLL_MARGIN + virtualizer.getTotalSize();

  return (
    <section
      ref={scrollRef}
      className={showsScrollbar ? "transcript has-scrollbar" : "transcript"}
      aria-label="Conversation"
      onScroll={noteScroll}
    >
      <div ref={columnRef} className="column tx atx">
        {first === undefined || first.start <= SCROLL_MARGIN ? null : (
          <div style={{ height: first.start - SCROLL_MARGIN }} />
        )}
        {virtualItems.map(({ index, key }) => (
          <div key={key} ref={virtualizer.measureElement} data-index={index} className="atx-item">
            {renderBlock(blocks[index]!)}
          </div>
        ))}
        {last === undefined || last.end >= end ? null : <div style={{ height: end - last.end }} />}
      </div>
      <div className="transcript-end" />
    </section>
  );
}
