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
  useEffect,
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
import type { Assistant, Attachment, Session, TranscriptRow } from "@hercule/contract";
import { conversationMessagesQuery } from "../../app/queries";
import { Face, type Look } from "../../faces";
import {
  DEFAULT_END_PADDING,
  HEADER_CLEARANCE,
  measureBlock,
  OVERSCAN,
  useMessageList,
} from "../session/message-list";
import { UserMessage } from "../session/messages";
import { useStartOfToday } from "../session/start-of-today";
import type { AttachOpenParagraph } from "../session/use-session-live";
import { DayStamp, Notice, OpenReply, StoredReply } from "./conversation-messages";

/**
 * The space between two blocks: the book's `.tx.atx { gap: 20px }`, which
 * assistant.css sets as `--block-gap`. The two must be equal. Every block,
 * the first too, includes it as its top padding, so a block keeps its
 * height when earlier messages are added above it.
 */
const BLOCK_GAP = 20;

/** Where the first block starts in the column, for the virtualizer: the column's top padding. */
const SCROLL_MARGIN = HEADER_CLEARANCE - BLOCK_GAP;

/** Roughly how many characters fit on one line of a reply, and of the owner's bubble. */
const REPLY_CHARS_PER_LINE = 100;
const OWNER_CHARS_PER_LINE = 80;

/** The height of one line of a reply, in CSS pixels: 14px text at a line height of 1.6. */
const REPLY_LINE_HEIGHT = 22.4;
/** The height of one line of the owner's bubble, in CSS pixels: 14px text at a line height of 1.55. */
const OWNER_LINE_HEIGHT = 21.7;
/** A Conversation's owner message is drawn without images: a `ConversationMessage` holds text only. */
const NO_ATTACHMENTS: readonly Attachment[] = [];

/** The height of a day stamp: one line of 11px text, as the book lays it out. */
const STAMP_HEIGHT = 15;
/** The height of the owner's bubble without its lines: its padding and its time, as the thread's estimate. */
const OWNER_FRAME_HEIGHT = 40;
/** The height of a reply's name line with its 2px margin, above the text. */
const REPLY_NAME_HEIGHT = 21.5;
/** The height of a notice: the 28px failed face inside 8px of padding above and below. */
const NOTICE_HEIGHT = 44;
/** The height of the reply being written before any text: its name line and the caret's line. */
const OPEN_REPLY_HEIGHT = 43.9;

/**
 * Estimates a block's height, without the gap above it, before it is
 * measured, from the heights above. Only blocks that were never mounted use
 * the estimate.
 */
const estimateBlockHeight = (block: ConversationBlock): number => {
  switch (block.kind) {
    case "stamp":
      return STAMP_HEIGHT;
    case "owner":
      return (
        OWNER_FRAME_HEIGHT +
        OWNER_LINE_HEIGHT * Math.max(1, Math.ceil(block.message.text.length / OWNER_CHARS_PER_LINE))
      );
    case "reply":
      return (
        REPLY_NAME_HEIGHT +
        REPLY_LINE_HEIGHT * Math.max(1, Math.ceil(block.message.text.length / REPLY_CHARS_PER_LINE))
      );
    case "notice":
      return NOTICE_HEIGHT;
    case "open-reply":
      return OPEN_REPLY_HEIGHT;
  }
};

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
 * - `composerStack` and `onBottomChange` are as `useMessageList` takes
 *   them.
 * - `ref` receives a `ConversationHandle`.
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
  // The start of today, not the time now: the stamps change only when the
  // day does, and `today` changes then, so the blocks are built again.
  const startOfToday = new Date(today);
  const blocks = buildConversationBlocks({
    messages: flattenMessagePages(messages.data.pages),
    runningTurnRows,
    session,
    reply: assistant.reply,
    pose,
    timezone,
    now: startOfToday,
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

  const { scrollRef, columnRef, showsScrollbar, noteScroll, scrollToBottom } = useMessageList({
    composerStack,
    onBottomChange,
  });

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

  // A list mounted for a new current session opens at the bottom, while the
  // screen may still hold the last list's place higher up; the greeting,
  // which has no list, holds none. So the list says where it opens.
  useEffect(() => {
    onBottomChange(true);
    // Only on mount: later changes are reported by `noteScroll`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  /** Notes where the reader is, and reads earlier messages within one screen of the top. */
  const noteScrollAndReadEarlier = (): void => {
    noteScroll();
    const scroller = scrollRef.current!;
    if (scroller.scrollTop < scroller.clientHeight) readEarlierMessages();
  };

  useImperativeHandle(ref, () => ({ scrollToBottom }));

  /** Returns the element that draws `block`. */
  const renderBlock = (block: ConversationBlock): JSX.Element => {
    switch (block.kind) {
      case "stamp":
        return <DayStamp label={block.label} />;
      case "owner":
        return (
          <UserMessage
            text={block.message.text}
            attachments={NO_ATTACHMENTS}
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
      onScroll={noteScrollAndReadEarlier}
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
