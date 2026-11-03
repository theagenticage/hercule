import { useCallback, useEffect, useRef, type JSX, type ReactNode, type RefObject } from "react";
import type { MachineActivityDay } from "@hercule/client-core/machine-activity";
import { useMeasuredAtTextSize } from "../../app/text-size";
import { useVirtualLines } from "../use-virtual-lines";
import {
  readMachineActivityHeights,
  type MachineActivityHeights,
} from "./machine-activity-heights";
import { buildMachineActivityItems, type MachineActivityItem } from "./machine-activity-items";
import {
  MachineActivityDayHeading,
  MachineActivityMemberRow,
  MachineActivityRow,
} from "./machine-activity-row";
import { useListTop } from "./use-list-top";
import "./machine-activity.css";

/** Returns the height of `item` in CSS pixels. */
const estimateItemHeight = (heights: MachineActivityHeights, item: MachineActivityItem): number => {
  switch (item.kind) {
    case "day":
      return heights.day;
    case "entry":
      return heights.entry;
    case "member":
      return heights.member;
  }
};

/**
 * Renders the Activity page's content in the Fleet scroll area `scrollRef`:
 * `head` (the page's heading and filters), the days of `days` and `foot`.
 *
 * - The days are a virtual list: each day's heading, each entry and each
 *   member of an unfolded entry is a line of a height the list knows, and
 *   only the lines near the view are drawn (spec 17 §Rules, rule 1). The
 *   members of an unfolded entry are lines of their own, so unfolding a
 *   fold of a hundred log entries draws no more than the few that are in
 *   view.
 * - `openEntryKeys` are the keys of the unfolded entries, and pressing an
 *   entry's Show or Hide calls `onToggleEntry` with its key.
 * - `onEndReached` is called once the last line is drawn, and again each time
 *   the days change while it still is. A list that holds no lines at all is
 *   at its end, too. The caller passes the call that reads the next page, and
 *   `undefined` while that read runs or when there is no next page.
 */
export function MachineActivityList({
  days,
  openEntryKeys,
  onToggleEntry,
  scrollRef,
  head,
  foot,
  onEndReached,
}: {
  readonly days: ReadonlyArray<MachineActivityDay>;
  readonly openEntryKeys: ReadonlySet<string>;
  readonly onToggleEntry: (entryKey: string) => void;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly head: ReactNode;
  readonly foot: ReactNode;
  readonly onEndReached: (() => void) | undefined;
}): JSX.Element {
  const headRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listTop = useListTop(scrollRef, headRef, listRef);
  const heights = useMeasuredAtTextSize(readMachineActivityHeights);
  const items = buildMachineActivityItems(days, openEntryKeys);
  const estimateSize = useCallback(
    (item: MachineActivityItem) => estimateItemHeight(heights, item),
    [heights],
  );
  const { lines, totalSize, lastDrawnIndex } = useVirtualLines(
    items,
    scrollRef,
    estimateSize,
    null,
    null,
    listTop,
  );

  const isEndDrawn = items.length === 0 || (lastDrawnIndex ?? -1) >= items.length - 1;
  useEffect(() => {
    if (isEndDrawn) onEndReached?.();
  }, [isEndDrawn, onEndReached, items]);

  return (
    <>
      <div ref={headRef}>{head}</div>
      <div ref={listRef} className="machine-activity" style={{ height: totalSize }}>
        {lines.map((line) =>
          line.kind === "gap" ? (
            <div key={line.key} style={{ height: line.height }} aria-hidden="true" />
          ) : (
            <MachineActivityLine key={line.item.key} item={line.item} onToggle={onToggleEntry} />
          ),
        )}
      </div>
      {foot}
    </>
  );
}

/** Renders the line for `item`; pressing an entry's Show or Hide calls `onToggle` with the entry's key. */
function MachineActivityLine({
  item,
  onToggle,
}: {
  readonly item: MachineActivityItem;
  readonly onToggle: (entryKey: string) => void;
}): JSX.Element {
  switch (item.kind) {
    case "day":
      return <MachineActivityDayHeading heading={item.heading} />;
    case "entry":
      return (
        <MachineActivityRow
          entry={item.entry}
          dayHeading={undefined}
          joinsAbove={item.joinsAbove}
          isOpen={item.isOpen}
          onToggle={() => onToggle(item.entry.key)}
        />
      );
    case "member":
      return <MachineActivityMemberRow member={item.member} />;
  }
}
