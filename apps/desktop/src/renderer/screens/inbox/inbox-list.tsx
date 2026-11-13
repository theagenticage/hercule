import type { PluginIdentity } from "@hercule/client-core";
import type { GroupKey } from "@hercule/client-core/inbox";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type Ref,
} from "react";
import { findBody, isMotionReduced, trackBody } from "../../app/motion";
import { readLengths, useMeasuredAtTextSize } from "../../app/text-size";
import { useVirtualLines } from "../use-virtual-lines";
import { createInboxDrag } from "./inbox-drag";
import { buildEntryTops, readEntryHeight } from "./inbox-entry-tops";
import type { DroppedCopy } from "./inbox-flights";
import { InboxGroupMore } from "./inbox-group-more";
import { InboxGroupRow } from "./inbox-group-row";
import type { InboxListEntry } from "./inbox-list-entry";
import { InboxRow, type InboxClickModifiers, type InboxRowActions } from "./inbox-row";
import {
  ASIDE_PX,
  FADE_EASING,
  LEAVE_FADE_MS,
  useInboxListMotion,
  type InboxLeaveHow,
  type LeavingRow,
} from "./use-inbox-list-motion";
import "./inbox-list.css";
import "./inbox-drag.css";

/** The references of no rows, which stays one array so a list with none to name changes nothing. */
const NO_ROWS: ReadonlyArray<string> = [];

/** The height of the fade at the list's foot, in pixels. Rows scroll clear of it. */
const FOOT_FADE_PX = 28;

/** Reads a row's height from the page's CSS: 52px at the default Text size, and a pixel more per line for each step up. */
const readRowHeight = (): number => readLengths({ row: "--list-height-two-line-row" }).row;

/** What a group's head and its "Show N more" line call back with. Each is given the group's key. */
export interface InboxGroupActions {
  /** The head was clicked: it becomes current, or the selection changes by `modifiers`. */
  readonly onPickGroup: (key: string, modifiers: InboxClickModifiers) => void;
  /** The head's tick was pressed; `whole` (with Shift) selects every member and not only those that answer the query. */
  readonly onToggleGroupSelect: (key: string, whole: boolean) => void;
  /** The head's chevron was pressed: the group opens or closes. */
  readonly onToggleGroupOpen: (key: string) => void;
  /** "Show N more" was pressed. */
  readonly onShowMore: (groupKey: GroupKey) => void;
  /**
   * A row was dropped on another by hand: links the thing `fromKey` with the
   * thing or group `toKey`. Returns whether a link was written; `false` sends the
   * row home.
   */
  readonly onLinkThings: (fromKey: string, toKey: string) => Promise<boolean>;
}

/** Everything the list's lines call back with. */
export type InboxListActions = InboxRowActions & InboxGroupActions;

/** The names of the callbacks of `InboxListActions`. */
const ROW_ACTION_NAMES = [
  "onPick",
  "onToggleSelect",
  "onTakeOn",
  "onHandOff",
  "onGoToTask",
  "onDismiss",
  "onPickGroup",
  "onToggleGroupSelect",
  "onToggleGroupOpen",
  "onShowMore",
  "onLinkThings",
] as const satisfies ReadonlyArray<keyof InboxListActions>;

/**
 * Returns a set of row actions that never changes identity and calls the
 * latest `actions` given. The owner builds a new set on every render, and a
 * row (which is memoized) would draw again for each of them.
 */
function useStableActions(actions: InboxListActions): InboxListActions {
  const latest = useRef(actions);
  useLayoutEffect(() => {
    latest.current = actions;
  });
  const [stable] = useState(
    () =>
      Object.fromEntries(
        ROW_ACTION_NAMES.map((name) => [
          name,
          (...args: unknown[]) => (latest.current[name] as (...args: unknown[]) => void)(...args),
        ]),
      ) as unknown as InboxListActions,
  );
  return stable;
}

/** What the list lets its owner ask of it. */
export interface InboxListHandle {
  /**
   * Returns the element a hand-off menu of the row `ref` opens under: the
   * row's own hand-off button, or the row itself when it draws none. Returns
   * `null` when the row is not drawn (the list is virtual).
   */
  readonly findHandAnchor: (ref: string) => HTMLElement | null;
  /**
   * Scrolls the line with the key `key` (a thing's ref or a group's key) into
   * view, which "Link to..." opens under, and returns its element once the
   * list has drawn it. Returns `null` when the list has no such line. Only
   * the lines in and near the view are drawn, so a line far away is drawn
   * after the scroll, and only the newest request is answered.
   */
  readonly revealLine: (key: string) => Promise<HTMLElement | null>;
}

/**
 * Returns the element of one line of the list: a row, a group's head, or its
 * "Show N more" line. With `actions` null the line is an inert copy, such as
 * one that fades out of the list. The element's key is the entry's key.
 *
 * It is a function and not a component: each of the three is memoized itself,
 * so a step of the current entry draws again only the lines whose own props
 * changed, and a wrapper component would add a render to every line drawn.
 */
function renderInboxLine({
  entry,
  plugins,
  position,
  size,
  isCurrent,
  isSelected,
  actions,
}: {
  readonly entry: InboxListEntry;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly position: number;
  readonly size: number;
  readonly isCurrent: boolean;
  readonly isSelected: boolean;
  readonly actions: InboxListActions | null;
}): JSX.Element {
  switch (entry.kind) {
    case "thing":
    case "member":
      return (
        <InboxRow
          key={entry.key}
          view={entry.view}
          plugins={plugins}
          position={position}
          size={size}
          current={isCurrent}
          selected={isSelected}
          actions={actions}
          member={entry.kind === "member" ? entry.member : undefined}
        />
      );
    case "head":
      return (
        <InboxGroupRow
          key={entry.key}
          view={entry.view}
          plugins={plugins}
          isCurrent={isCurrent}
          isOpen={entry.isOpen}
          tick={entry.tick}
          unloadedCount={entry.unloadedCount}
          onPick={actions?.onPickGroup ?? NO_CALL}
          onToggleSelect={actions?.onToggleGroupSelect ?? NO_CALL}
          onToggleOpen={actions?.onToggleGroupOpen ?? NO_CALL}
          onTakeOn={actions?.onTakeOn ?? NO_CALL}
          onDismiss={actions?.onDismiss ?? NO_CALL}
        />
      );
    case "more":
      return (
        <InboxGroupMore
          key={entry.key}
          groupKey={entry.groupKey}
          hiddenCount={entry.hiddenCount}
          unloadedCount={entry.unloadedCount}
          isCurrent={isCurrent}
          onShowMore={actions?.onShowMore ?? NO_CALL}
        />
      );
  }
}

/** The callback of an inert copy, which no one can press. */
const NO_CALL = (): void => {};

/** Renders the copy of a row that left, which fades out under the list and then asks to be removed. */
function LeavingCopy({
  leaving,
  plugins,
  onGone,
}: {
  readonly leaving: LeavingRow;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onGone: (id: number) => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const { id, how, entry } = leaving;
  useLayoutEffect(() => {
    const element = ref.current!;
    if (isMotionReduced()) {
      onGone(id);
      return;
    }
    const gone = (): void => {
      onGone(id);
    };
    const fade = element.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: LEAVE_FADE_MS,
      easing: FADE_EASING,
      fill: "forwards",
    });
    if (how === "dismiss") trackBody(element).to({ x: ASIDE_PX }, "travel");
    void fade.finished.then(gone, gone);
    return () => {
      fade.cancel();
      findBody(element)?.clear();
    };
  }, [id, how, onGone]);
  return (
    <div ref={ref} className="ib-leaving-row" style={{ top: leaving.top }}>
      {renderInboxLine({
        entry,
        plugins,
        position: 1,
        size: 1,
        isCurrent: false,
        isSelected: false,
        actions: null,
      })}
    </div>
  );
}

/**
 * Renders the Inbox list: the entries in the order given, as a tree of items
 * with real selection. An entry is a thing, a group's head, one of its
 * members, or its "Show N more" line (`InboxListEntry`); each is one line, and
 * every line is as tall as a row except "Show N more", which is shorter.
 *
 * - The list is virtual (`useVirtualLines`): only the lines in view and a few
 *   past each edge are drawn, because the height of each line is known
 *   without measuring it (`buildEntryTops`).
 * - The current entry (`currentKey`) is told by a puck under the rows: a fill
 *   with a 2px edge on its left, and the focus ring when the keyboard holds
 *   the list. The puck jumps in the same frame as the current row, and the
 *   rows move into it. Only the current row is in the tab order.
 * - The list scrolls only when the current row would leave it, by the least
 *   distance, smoothly while rows move, and clear of the fade at its foot.
 *   `footReserve` is how many pixels more than the fade the foot needs while
 *   the undo line or the selection bar covers it.
 * - Rows that leave fade under the list and the rows after them close up;
 *   `leaveHow` says whether the rows that left in this change were dismissed.
 *   Rows an undo put back are `returning`, rows "Show" took in are `arriving`.
 *   The list animates only what changed between two renders; `listId` names
 *   the list, and a new one shows at once.
 *
 * `onViewportChange` is called with the index of the first and of the last
 * entry drawn in or near the view, each time either changes or the rows held
 * grow, so the caller can read the rows around the view and the next page.
 * A change of `focusRequest` moves the keyboard focus to the current row.
 * `handle` receives the list's `InboxListHandle`.
 */
export function InboxList({
  listId,
  label,
  entries,
  plugins,
  currentKey,
  selection,
  actions,
  leaveHow,
  returning,
  arriving,
  footReserve,
  focusRequest,
  onViewportChange,
  handle,
}: {
  readonly listId: string;
  /** The list's name for assistive technology, such as "Someone waits on me". */
  readonly label: string;
  readonly entries: ReadonlyArray<InboxListEntry>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  /** The key of the current entry. */
  readonly currentKey: string | null;
  /** The refs of the selected things. A head is ticked by its own `tick`. */
  readonly selection: ReadonlySet<string>;
  readonly actions: InboxListActions;
  readonly leaveHow?: InboxLeaveHow;
  readonly returning?: ReadonlyArray<string>;
  readonly arriving?: ReadonlyArray<string>;
  readonly footReserve?: number;
  readonly focusRequest?: number;
  readonly onViewportChange: (firstIndex: number, lastIndex: number) => void;
  readonly handle?: Ref<InboxListHandle> | undefined;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowActions = useStableActions(actions);
  const reserve = footReserve ?? 0;
  const focusRequested = focusRequest ?? 0;
  const rowHeight = useMeasuredAtTextSize(readRowHeight);
  const estimateSize = useCallback(
    (item: { readonly entry: InboxListEntry }) => readEntryHeight(item.entry, rowHeight),
    [rowHeight],
  );
  const tops = useMemo(() => buildEntryTops(entries, rowHeight), [entries, rowHeight]);
  const flightsRef = useRef<HTMLDivElement>(null);
  const carryRef = useRef<HTMLDivElement>(null);
  const droppedRef = useRef<DroppedCopy | null>(null);
  const items = entries.map((entry, index) => ({ key: entry.key, entry, index }));
  const { lines, totalSize, firstDrawnIndex, lastDrawnIndex, selectedIndex, scrollToKey } =
    useVirtualLines({
      items,
      scrollRef,
      estimateSize,
      selectedKey: currentKey,
    });
  const { leavingRows, removeLeavingRow } = useInboxListMotion({
    rows: entries,
    listId,
    rowHeight,
    scrollRef,
    leaveHow: leaveHow ?? "taken",
    returning: returning ?? NO_ROWS,
    arriving: arriving ?? NO_ROWS,
    flightsRef,
    droppedRef,
  });

  // Carrying a row onto another links them. The gesture listens only while a row is pressed or held.
  useEffect(
    () =>
      createInboxDrag({
        scroll: scrollRef.current!,
        carryLayer: carryRef.current!,
        dropped: droppedRef,
        linkRows: rowActions.onLinkThings,
      }).destroy,
    [rowActions],
  );

  // The request of `revealLine` that waits for its line to be drawn.
  const revealing = useRef<{
    readonly key: string;
    readonly resolve: (line: HTMLElement | null) => void;
  } | null>(null);
  const findLine = (key: string): HTMLElement | null =>
    scrollRef.current?.querySelector<HTMLElement>(`[data-ref="${CSS.escape(key)}"]`) ?? null;
  // After every draw, answers the request that waits for a line the scroll has now brought in.
  useLayoutEffect(() => {
    const waiting = revealing.current;
    if (waiting === null) return;
    const line = findLine(waiting.key);
    if (line === null) return;
    revealing.current = null;
    waiting.resolve(line);
  });

  useImperativeHandle(handle, () => ({
    findHandAnchor: (ref) => {
      const row = scrollRef.current?.querySelector<HTMLElement>(`[data-ref="${CSS.escape(ref)}"]`);
      return row?.querySelector<HTMLElement>("[data-hand-anchor]") ?? row ?? null;
    },
    revealLine: (key) => {
      revealing.current?.resolve(null);
      revealing.current = null;
      const drawn = findLine(key);
      if (drawn !== null) {
        drawn.scrollIntoView({ block: "nearest" });
        return Promise.resolve(drawn);
      }
      if (!entries.some((entry) => entry.key === key)) return Promise.resolve(null);
      scrollToKey(key);
      return new Promise((resolve) => {
        revealing.current = { key, resolve };
      });
    },
  }));

  // The least scroll that brings the current row clear of both edges, with the fade at the foot counted out of the view.
  // It runs when the current row or the sizes change, never because new copies of the rows arrived: the user may have scrolled away.
  const foot = FOOT_FADE_PX + reserve;
  const rowsAtLastRender = useRef(entries);
  const rowsChangedAtLastRender = useRef(false);
  useLayoutEffect(() => {
    rowsChangedAtLastRender.current = rowsAtLastRender.current !== entries;
    rowsAtLastRender.current = entries;
  });
  const currentTop = selectedIndex < 0 ? -1 : tops[selectedIndex]!;
  const currentBottom = selectedIndex < 0 ? -1 : tops[selectedIndex + 1]!;
  useLayoutEffect(() => {
    const scroll = scrollRef.current!;
    if (currentTop < 0 || scroll.clientHeight === 0) return;
    const top = currentTop;
    const bottom = currentBottom;
    const clear = scroll.clientHeight - foot;
    let target: number | null = null;
    if (top < scroll.scrollTop) target = top;
    else if (bottom > scroll.scrollTop + clear) target = bottom - clear;
    if (target === null) return;
    if (
      rowsChangedAtLastRender.current &&
      !isMotionReduced() &&
      typeof scroll.scrollTo === "function"
    ) {
      scroll.scrollTo({ top: target, behavior: "smooth" });
    } else {
      scroll.scrollTop = target;
    }
  }, [currentKey, currentTop, currentBottom, foot]);

  // Only a new request moves the focus, not a new current row.
  const handledFocusRequest = useRef(focusRequested);
  useEffect(() => {
    if (focusRequested === handledFocusRequest.current) return;
    handledFocusRequest.current = focusRequested;
    if (currentKey === null) return;
    scrollRef.current!.querySelector<HTMLElement>(`[data-ref="${CSS.escape(currentKey)}"]`)?.focus({
      preventScroll: true,
    });
  }, [focusRequested, currentKey]);

  useEffect(() => {
    if (firstDrawnIndex !== undefined && lastDrawnIndex !== undefined) {
      onViewportChange(firstDrawnIndex, lastDrawnIndex);
    }
  }, [firstDrawnIndex, lastDrawnIndex, entries.length, onViewportChange]);

  return (
    <div className="ib-list">
      <div ref={scrollRef} className="ib-scroll" style={{ scrollPaddingBottom: foot }}>
        <div className="ib-lines" style={{ paddingBottom: foot }}>
          <div
            className="ib-rows"
            role="tree"
            aria-label={label}
            aria-multiselectable="true"
            style={{ minHeight: totalSize }}
          >
            <div ref={flightsRef} className="ib-flights" aria-hidden="true" inert />
            <div className="ib-leaving" aria-hidden="true" inert>
              {leavingRows.map((leaving) => (
                <LeavingCopy
                  key={leaving.id}
                  leaving={leaving}
                  plugins={plugins}
                  onGone={removeLeavingRow}
                />
              ))}
            </div>
            {lines.map((line) =>
              line.kind === "gap" ? (
                <div key={line.key} role="presentation" style={{ height: line.height }} />
              ) : (
                renderInboxLine({
                  entry: line.item.entry,
                  plugins,
                  position: line.item.index + 1,
                  size: entries.length,
                  isCurrent: line.item.key === currentKey,
                  isSelected: selection.has(line.item.key),
                  actions: rowActions,
                })
              ),
            )}
            <div
              className="ib-puck"
              hidden={selectedIndex < 0}
              style={{
                height:
                  selectedIndex < 0 ? undefined : tops[selectedIndex + 1]! - tops[selectedIndex]!,
                transform: `translateY(${String(selectedIndex < 0 ? 0 : tops[selectedIndex]!)}px)`,
              }}
              aria-hidden="true"
            />
          </div>
        </div>
      </div>
      <div className="ib-fade" style={{ height: foot }} aria-hidden="true" />
      <div ref={carryRef} className="ib-carry" aria-hidden="true" inert />
    </div>
  );
}
