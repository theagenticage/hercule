import type { PluginIdentity } from "@hercule/client-core";
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
import { findBody, isMotionReduced, trackBody } from "../../app/motion";
import { readLengths, useMeasuredAtTextSize } from "../../app/text-size";
import { useVirtualLines } from "../use-virtual-lines";
import type { InboxRowView } from "@hercule/client-core/inbox";
import { InboxRow, type InboxRowActions } from "./inbox-row";
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

/** The names of the callbacks of `InboxRowActions`. */
const ROW_ACTION_NAMES = [
  "onPick",
  "onToggleSelect",
  "onStartThread",
  "onTakeOn",
  "onHandOff",
  "onGoToTask",
  "onDismiss",
] as const satisfies ReadonlyArray<keyof InboxRowActions>;

/**
 * Returns a set of row actions that never changes identity and calls the
 * latest `actions` given. The owner builds a new set on every render, and a
 * row (which is memoized) would draw again for each of them.
 */
function useStableActions(actions: InboxRowActions): InboxRowActions {
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
      ) as unknown as InboxRowActions,
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
}

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
 * `onViewportChange` is called with the index of the first and of the last
 * row drawn in or near the view, each time either changes or the rows held
 * grow, so the caller can read the rows around the view and the next page.
 * A change of `focusRequest` moves the keyboard focus to the current row.
 * `handle` receives the list's `InboxListHandle`.
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
  onViewportChange,
  handle,
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
  readonly onViewportChange: (firstIndex: number, lastIndex: number) => void;
  readonly handle?: Ref<InboxListHandle> | undefined;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowActions = useStableActions(actions);
  const reserve = footReserve ?? 0;
  const focusRequested = focusRequest ?? 0;
  const rowHeight = useMeasuredAtTextSize(readRowHeight);
  const estimateSize = useCallback(() => rowHeight, [rowHeight]);
  const items = rows.map((view, index) => ({ key: view.ref, view, index }));
  const { lines, totalSize, firstDrawnIndex, lastDrawnIndex, selectedIndex } = useVirtualLines({
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

  useImperativeHandle(handle, () => ({
    findHandAnchor: (ref) => {
      const row = scrollRef.current?.querySelector<HTMLElement>(`[data-ref="${CSS.escape(ref)}"]`);
      return row?.querySelector<HTMLElement>("[data-hand-anchor]") ?? row ?? null;
    },
  }));

  // The least scroll that brings the current row clear of both edges, with the fade at the foot counted out of the view.
  // It runs when the current row or the sizes change, never because new copies of the rows arrived: the user may have scrolled away.
  const foot = FOOT_FADE_PX + reserve;
  const rowsAtLastRender = useRef(rows);
  const rowsChangedAtLastRender = useRef(false);
  useLayoutEffect(() => {
    rowsChangedAtLastRender.current = rowsAtLastRender.current !== rows;
    rowsAtLastRender.current = rows;
  });
  useLayoutEffect(() => {
    const scroll = scrollRef.current!;
    if (selectedIndex < 0 || scroll.clientHeight === 0) return;
    const top = selectedIndex * rowHeight;
    const clear = scroll.clientHeight - foot;
    let target: number | null = null;
    if (top < scroll.scrollTop) target = top;
    else if (top + rowHeight > scroll.scrollTop + clear) target = top + rowHeight - clear;
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
  }, [currentRef, selectedIndex, rowHeight, foot]);

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
    if (firstDrawnIndex !== undefined && lastDrawnIndex !== undefined) {
      onViewportChange(firstDrawnIndex, lastDrawnIndex);
    }
  }, [firstDrawnIndex, lastDrawnIndex, rows.length, onViewportChange]);

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
                  actions={rowActions}
                />
              ),
            )}
            <div
              className="ib-puck"
              hidden={selectedIndex < 0}
              style={{ transform: `translateY(${String(selectedIndex * rowHeight)}px)` }}
              aria-hidden="true"
            />
          </div>
        </div>
      </div>
      <div className="ib-fade" style={{ height: foot }} aria-hidden="true" />
    </div>
  );
}
