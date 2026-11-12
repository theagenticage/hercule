import type { PluginIdentity } from "@hercule/client-core";
import { useCallback, useEffect, useLayoutEffect, useRef, type JSX } from "react";
import { findBody, isMotionReduced, trackBody } from "../../app/motion";
import { readLengths, useMeasuredAtTextSize } from "../../app/text-size";
import { useVirtualLines, VIRTUAL_OVERSCAN } from "../use-virtual-lines";
import { InboxRow, type InboxRowActions, type InboxRowView } from "./inbox-row";
import {
  ASIDE_PX,
  FADE_EASING,
  LEAVE_FADE_MS,
  useInboxListMotion,
  type InboxLeaveHow,
  type LeavingRow,
} from "./use-inbox-list-motion";
import "./inbox-list.css";

/** The references of no rows, which stays one array so a list with none to name changes nothing. */
const NO_ROWS: ReadonlyArray<string> = [];

/** The height of the fade at the list's foot, in pixels. Rows scroll clear of it. */
const FOOT_FADE_PX = 28;

/** Reads a row's height from the page's CSS: 52px at the default Text size, and a pixel more per line for each step up. */
const readRowHeight = (): number => readLengths({ row: "--list-height-two-line-row" }).row;

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
  const { id, how } = leaving;
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
      <InboxRow
        view={leaving.view}
        plugins={plugins}
        position={1}
        size={1}
        current={false}
        selected={false}
        actions={null}
      />
    </div>
  );
}

/**
 * Renders the Inbox list: the rows in the order given, as a tree of items at
 * level 1 with real selection.
 *
 * - The list is virtual (`useVirtualLines`): only the rows in view and a few
 *   past each edge are drawn, because every row is the same height.
 * - The current row (`currentRef`) is told by a puck under the rows: a fill
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
 * `onNearEnd` is called whenever the rows drawn reach within a few rows of
 * the last one held, so the caller can read the next page. It may be called
 * again for the same end, so the caller ignores it when no page follows.
 * A change of `focusRequest` moves the keyboard focus to the current row.
 */
export function InboxList({
  listId,
  label,
  rows,
  plugins,
  currentRef,
  selection,
  actions,
  leaveHow,
  returning,
  arriving,
  footReserve,
  focusRequest,
  onNearEnd,
}: {
  readonly listId: string;
  /** The list's name for assistive technology, such as "Someone waits on me". */
  readonly label: string;
  readonly rows: ReadonlyArray<InboxRowView>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly currentRef: string | null;
  readonly selection: ReadonlySet<string>;
  readonly actions: InboxRowActions;
  readonly leaveHow?: InboxLeaveHow;
  readonly returning?: ReadonlyArray<string>;
  readonly arriving?: ReadonlyArray<string>;
  readonly footReserve?: number;
  readonly focusRequest?: number;
  readonly onNearEnd: () => void;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const reserve = footReserve ?? 0;
  const focusRequested = focusRequest ?? 0;
  const rowHeight = useMeasuredAtTextSize(readRowHeight);
  const estimateSize = useCallback(() => rowHeight, [rowHeight]);
  const items = rows.map((view, index) => ({ key: view.ref, view, index }));
  const { lines, totalSize, lastDrawnIndex, selectedIndex } = useVirtualLines({
    items,
    scrollRef,
    estimateSize,
    selectedKey: currentRef,
  });
  const { leavingRows, removeLeavingRow } = useInboxListMotion({
    rows,
    listId,
    rowHeight,
    scrollRef,
    leaveHow: leaveHow ?? "taken",
    returning: returning ?? NO_ROWS,
    arriving: arriving ?? NO_ROWS,
  });

  // The least scroll that brings the current row clear of both edges, with the fade at the foot counted out of the view.
  const foot = FOOT_FADE_PX + reserve;
  const rowsAtLastScroll = useRef(rows);
  useLayoutEffect(() => {
    const scroll = scrollRef.current!;
    const changed = rowsAtLastScroll.current !== rows;
    rowsAtLastScroll.current = rows;
    if (selectedIndex < 0 || scroll.clientHeight === 0) return;
    const top = selectedIndex * rowHeight;
    const clear = scroll.clientHeight - foot;
    let target: number | null = null;
    if (top < scroll.scrollTop) target = top;
    else if (top + rowHeight > scroll.scrollTop + clear) target = top + rowHeight - clear;
    if (target === null) return;
    if (changed && !isMotionReduced() && typeof scroll.scrollTo === "function") {
      scroll.scrollTo({ top: target, behavior: "smooth" });
    } else {
      scroll.scrollTop = target;
    }
  }, [selectedIndex, rows, rowHeight, foot]);

  // Only a new request moves the focus, not a new current row.
  const handledFocusRequest = useRef(focusRequested);
  useEffect(() => {
    if (focusRequested === handledFocusRequest.current) return;
    handledFocusRequest.current = focusRequested;
    if (currentRef === null) return;
    scrollRef.current!.querySelector<HTMLElement>(`[data-ref="${CSS.escape(currentRef)}"]`)?.focus({
      preventScroll: true,
    });
  }, [focusRequested, currentRef]);

  useEffect(() => {
    if (lastDrawnIndex !== undefined && lastDrawnIndex >= rows.length - 1 - VIRTUAL_OVERSCAN) {
      onNearEnd();
    }
  }, [lastDrawnIndex, rows.length, onNearEnd]);

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
            <div
              className="ib-puck"
              hidden={selectedIndex < 0}
              style={{ transform: `translateY(${String(selectedIndex * rowHeight)}px)` }}
              aria-hidden="true"
            />
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
                <InboxRow
                  key={line.item.key}
                  view={line.item.view}
                  plugins={plugins}
                  position={line.item.index + 1}
                  size={rows.length}
                  current={line.item.key === currentRef}
                  selected={selection.has(line.item.key)}
                  actions={actions}
                />
              ),
            )}
          </div>
        </div>
      </div>
      <div className="ib-fade" style={{ height: foot }} aria-hidden="true" />
    </div>
  );
}
