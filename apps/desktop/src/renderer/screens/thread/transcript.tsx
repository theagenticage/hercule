/**
 * The thread's transcript: the blocks `buildThreadBlocks` returns, in the
 * region "Transcript", virtualized, opening at the bottom and following new
 * content while the reader is there.
 *
 * Only the blocks in and near the visible part are mounted. Each mounted block
 * is measured (`measureElement`), and an empty spacer stands in for the
 * blocks above and below that are not mounted. The mounted blocks sit in
 * normal flow, as the sidebar's rows do, rather than each at its own `top`:
 * when the streaming tail grows the last block, the column grows with it in
 * the same layout, so the transcript follows in the frame that drew the text,
 * without waiting for React to render.
 *
 * The transcript is not a live region: the agent's streaming text would flood
 * a screen reader.
 */
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { resolveBrowserTimezone, type Pose, type ThreadBlock } from "@hercule/client-core";
import { ageClock } from "../../app/age-clock";
import { AgentMessage, LiveRow, TurnEnding, UserMessage, WaitingNote, WorkDivider } from "./blocks";
import type { AttachOpenParagraph } from "./use-thread-live";

/**
 * The space above the first block, under the floating header: the book's
 * `--header-clearance`, which thread.css sets on `.transcript`. The two must
 * be equal, because the virtualizer places the first block here.
 */
const HEADER_CLEARANCE = 108;

/**
 * The space below the last block before the composer is measured: the book's
 * `.tx { padding-bottom: 360px }`, which thread.css also sets.
 */
const DEFAULT_END_PADDING = 360;

/** How far the composer's stack sits above the pane's bottom edge: `.composer-wrap`'s bottom padding. */
const COMPOSER_BOTTOM_OFFSET = 18;

/** The space between the last line of the transcript and the composer, when scrolled to the bottom, as the book draws it. */
const LAST_LINE_CLEARANCE = 14;

/**
 * How close to the bottom, in CSS pixels, the reader must be for the
 * transcript to follow new content: the book's `atBottom`.
 */
const FOLLOW_THRESHOLD = 12;

/**
 * How many blocks are mounted beyond each end of the visible part, so a short
 * scroll shows no empty space before React draws the new blocks.
 */
const OVERSCAN = 6;

/** The space between two blocks: the book's `.tx { gap: 22px }`. Each block but the first includes it. */
const BLOCK_GAP = 22;

/** Roughly how many characters fit on one line of an agent message, and of a user's bubble. */
const AGENT_CHARS_PER_LINE = 100;
const USER_CHARS_PER_LINE = 80;

/** The height of one line of an agent message, in CSS pixels: 14px text at a line height of 1.6. */
const AGENT_LINE_HEIGHT = 22.4;
/** The height of one line of a user's bubble, in CSS pixels: 14px text at a line height of 1.55. */
const USER_LINE_HEIGHT = 21.7;

/**
 * Estimates a block's height before it is measured, from the book's
 * measurements: the lines of text, a meta line 20.4px with its margin, a
 * divider or a note 17.4px, and a bubble's padding and time 40px. Only blocks
 * that were never mounted use the estimate.
 */
const estimateBlockHeight = (block: ThreadBlock): number => {
  switch (block.kind) {
    case "user":
      return (
        40 + USER_LINE_HEIGHT * Math.max(1, Math.ceil(block.text.length / USER_CHARS_PER_LINE))
      );
    case "agent":
      return (
        20.4 + AGENT_LINE_HEIGHT * Math.max(1, Math.ceil(block.text.length / AGENT_CHARS_PER_LINE))
      );
    case "live":
      return 42.8;
    case "work":
    case "ending":
    case "waiting":
      return 17.4;
  }
};

/**
 * Returns a mounted block's height as laid out, unrounded. The virtualizer's
 * own measure rounds it, and the spacers, built from the measured heights,
 * would then drift from the blocks they stand in for.
 */
const measureBlock = (element: Element, entry: ResizeObserverEntry | undefined): number =>
  entry?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height;

/** Returns the first moment of the local day `now` falls on, in milliseconds since the epoch. */
const findStartOfDay = (now: Date): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

/** Registers with the age clock to be told when the local day changes. */
const subscribeToDayChange = (onChange: () => void): (() => void) =>
  ageClock.watch((now) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), onChange);

/**
 * Returns the start of the current local day, in milliseconds since the epoch,
 * and draws the caller again when the day changes. The day is read from the
 * age clock, which keeps one timer for every label on screen, so the day
 * change costs no timer of its own.
 */
const useStartOfToday = (): number =>
  useSyncExternalStore(subscribeToDayChange, () => findStartOfDay(ageClock.readNow()));

/**
 * Renders the transcript of the thread `sessionId`.
 *
 * - `blocks` are the thread's blocks in reading order.
 * - `pose` is the thread's pose, drawn on the block that holds the working face.
 * - `describeAgent` returns the start of an agent message's meta line, such
 *   as "Claude Code · Opus 5.5", for the model slug the message ran on.
 * - `attachOpenParagraph` attaches the element an open message's paragraph
 *   being written is painted into.
 * - `composerStack` is the composer's stack, whose height sets the space
 *   below the last block, so the last line always clears the composer. It is
 *   `null` until the composer is mounted.
 */
export function Transcript({
  sessionId,
  blocks,
  pose,
  describeAgent,
  attachOpenParagraph,
  composerStack,
}: {
  readonly sessionId: string;
  readonly blocks: readonly ThreadBlock[];
  readonly pose: Pose;
  readonly describeAgent: (model: string) => string;
  readonly attachOpenParagraph: AttachOpenParagraph;
  readonly composerStack: HTMLElement | null;
}): JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  // True while the reader is at the bottom. The transcript opens there.
  const followingRef = useRef(true);
  const [timezone] = useState(() => resolveBrowserTimezone());
  const today = useStartOfToday();
  // The keys of the work stretches the reader expanded. They are kept here
  // rather than in each divider, so a stretch stays expanded when it scrolls
  // out of the mounted range and back.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((keys) => {
      const next = new Set(keys);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  // The React Compiler does not memoize this component, because it cannot
  // see into the virtualizer (see below). These callbacks are memoized by
  // hand: the virtualizer measures the blocks again whenever `getItemKey`
  // changes.
  // The virtualizer asks only for indexes below `count`, which is `blocks.length`.
  const getItemKey = useCallback((index: number) => blocks[index]!.key, [blocks]);
  const estimateSize = useCallback(
    (index: number) => (index === 0 ? 0 : BLOCK_GAP) + estimateBlockHeight(blocks[index]!),
    [blocks],
  );
  // The estimated scroll position of the bottom, so the first render mounts
  // the last blocks rather than the first. Read once, when the virtualizer is
  // created.
  const estimateBottomOffset = (): number =>
    Math.max(
      0,
      blocks.reduce((sum, _block, index) => sum + estimateSize(index), HEADER_CLEARANCE) +
        DEFAULT_END_PADDING -
        window.innerHeight,
    );

  // eslint-disable-next-line react-hooks/incompatible-library -- The virtualizer returns an object that changes inside while its identity stays the same, which the React Compiler cannot memoize, so the compiler leaves this component alone. The callbacks above and the memoized blocks keep the renders cheap instead.
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    measureElement: measureBlock,
    overscan: OVERSCAN,
    scrollMargin: HEADER_CLEARANCE,
    // The transcript fills the pane, so the window's height is close to its
    // own until the virtualizer measures it.
    initialRect: { width: 0, height: window.innerHeight },
    initialOffset: estimateBottomOffset,
  });

  // One observer for everything that moves the bottom:
  // - the composer's stack, whose height sets the space under the last block;
  // - the column, which grows as blocks grow, are added, or are measured;
  // - the transcript itself, which changes height with the window.
  // The callback runs after layout and before paint, so the new space and
  // the scroll to the bottom show in the same frame as the change.
  useLayoutEffect(() => {
    const scroller = scrollRef.current!;
    const column = columnRef.current!;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target !== composerStack) continue;
        // Rounded, so the bottom lands on a whole pixel as the book's 360px does.
        const stackHeight = entry.borderBoxSize[0]?.blockSize ?? 0;
        column.style.paddingBottom = `${Math.round(stackHeight + COMPOSER_BOTTOM_OFFSET + LAST_LINE_CLEARANCE)}px`;
      }
      if (followingRef.current) scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
    });
    observer.observe(scroller);
    observer.observe(column);
    if (composerStack !== null) observer.observe(composerStack);
    return () => {
      observer.disconnect();
    };
  }, [composerStack]);

  const noteScroll = (): void => {
    const scroller = scrollRef.current!;
    followingRef.current =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_THRESHOLD;
  };

  /** Returns the element that draws `block`. */
  const renderBlock = (block: ThreadBlock, onScreen: boolean): JSX.Element => {
    switch (block.kind) {
      case "user":
        return <UserMessage text={block.text} at={block.at} timezone={timezone} today={today} />;
      case "agent":
        return (
          <AgentMessage
            sessionId={sessionId}
            itemId={block.itemId}
            agent={describeAgent(block.model)}
            text={block.text}
            startedAt={block.startedAt}
            timezone={timezone}
            today={today}
            pose={block.live ? pose : "idle"}
            open={block.open}
            attachOpenParagraph={attachOpenParagraph}
          />
        );
      case "live":
        return <LiveRow sessionId={sessionId} agent={describeAgent(block.model)} pose={pose} />;
      case "work":
        return (
          <WorkDivider
            block={block}
            onScreen={onScreen}
            expanded={expanded.has(block.key)}
            onToggle={toggleExpanded}
          />
        );
      case "ending":
        return <TurnEnding block={block} />;
      case "waiting":
        return (
          <WaitingNote
            openedAt={block.openedAt}
            timezone={timezone}
            today={today}
            onScreen={onScreen}
          />
        );
    }
  };

  const virtualItems = virtualizer.getVirtualItems();
  // The visible part of the transcript, without the overscan. Read after
  // `getVirtualItems`, which computes it.
  const visible = virtualizer.range;
  const first = virtualItems[0];
  const last = virtualItems.at(-1);
  const end = HEADER_CLEARANCE + virtualizer.getTotalSize();

  return (
    <section ref={scrollRef} className="transcript" aria-label="Transcript" onScroll={noteScroll}>
      <div ref={columnRef} className="column tx">
        {first === undefined || first.start <= HEADER_CLEARANCE ? null : (
          <div style={{ height: first.start - HEADER_CLEARANCE }} />
        )}
        {virtualItems.map(({ index, key }) => (
          <div key={key} ref={virtualizer.measureElement} data-index={index} className="tx-item">
            {renderBlock(
              blocks[index]!,
              visible !== null && index >= visible.startIndex && index <= visible.endIndex,
            )}
          </div>
        ))}
        {last === undefined || last.end >= end ? null : <div style={{ height: end - last.end }} />}
      </div>
    </section>
  );
}
