import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { computeNextMidnight, formatDayStamp, type HerculeClient } from "@hercule/client-core";
import { computeDayStart } from "@hercule/client-core/list-time";
import {
  buildTimelineBars,
  buildTimelineFires,
  computeTimelineDay,
  findNextTimelineMinute,
  locateTimelineNow,
  type TimelineDay,
  type TimelineHour,
  type TimelineNow,
} from "@hercule/client-core/run-timeline";
import { buildRunRows } from "@hercule/client-core/workflow-detail-rows";
import type { Trigger, WorkflowDefinition } from "@hercule/contract";
import { useClockValue } from "../../../../app/age-clock";
import { workflowDayRunsQuery, workflowRunsQuery } from "../../../../app/queries";
import { useWaitingRunSessions } from "../../../../app/waiting";
import { TimelineLanes } from "../../../../screens/workflows/run-timeline-board";
import { RUN_ROW_HEIGHT, RunListRow } from "../../../../screens/workflows/workflow-detail";

/** How many rows past the visible ones the Runs list keeps mounted on each side. */
const OVERSCAN = 8;

/** A moment so far off that the age clock never reaches it. */
const NEVER = new Date(8.64e15);

/** Returns the start of the minute after `now`, when the now line next moves. */
const findNextMinute = (_moment: string, now: Date): Date => findNextTimelineMinute(now);

/** Returns `now` rounded down to the start of its minute, in milliseconds since the epoch. */
const readMinute = (now: Date): number => Math.floor(now.getTime() / 60_000) * 60_000;

/** The day the timeline shows, and the words the day stepper shows it with. */
export interface ShownDay {
  readonly day: TimelineDay;
  /** "Today", "Yesterday", "27 Sep", or "27 Sep 2025" in another year. */
  readonly dayText: string;
}

/**
 * Returns the day `daysBack` days before today in `timezone`, and its text
 * for the day stepper. Today is read on the age clock, which wakes at local
 * midnight, so the timeline moves to the new day as it starts.
 */
export const useShownDay = (daysBack: number, timezone: string): ShownDay => {
  const findNextMidnight = useCallback(
    (_moment: string, now: Date) => computeNextMidnight(now, timezone) ?? NEVER,
    [timezone],
  );
  const todayStart = useClockValue(
    timezone,
    true,
    findNextMidnight,
    (now) => computeDayStart(now, timezone)?.getTime() ?? readMinute(now),
  );
  const today = new Date(todayStart);
  const day = computeTimelineDay(today, daysBack, timezone);
  return { day, dayText: formatDayStamp(day.start, timezone, today) ?? "" };
};

/**
 * Returns where the now line is drawn on `day`, read in `timezone`, or null
 * on a day that is not today. The age clock moves it once a minute.
 */
export const useTimelineNow = (day: TimelineDay, timezone: string): TimelineNow | null => {
  const minute = useClockValue(day.start.toISOString(), day.isToday, findNextMinute, readMinute);
  return day.isToday ? locateTimelineNow(day, timezone, minute) : null;
};

/**
 * Reads one day of the workflow `workflowId`'s runs and draws them on the
 * timeline's lanes, with the next fires of its `triggers` later today.
 * `isEnabled` is whether the workflow is on: an off workflow fires nothing.
 */
export function RunDayLanes({
  client,
  workflowId,
  definition,
  isEnabled,
  triggers,
  shown,
  hours,
  now,
  timezone,
}: {
  readonly client: HerculeClient;
  readonly workflowId: string;
  readonly definition: WorkflowDefinition;
  readonly isEnabled: boolean;
  readonly triggers: ReadonlyArray<Trigger>;
  readonly shown: ShownDay;
  readonly hours: ReadonlyArray<TimelineHour>;
  readonly now: TimelineNow | null;
  readonly timezone: string;
}): JSX.Element {
  const { day, dayText } = shown;
  const { data: runs } = useSuspenseQuery(workflowDayRunsQuery(client, workflowId, day));
  const waitingRunSessions = useWaitingRunSessions();
  const { bars, trackCount } = buildTimelineBars(runs, definition, waitingRunSessions, day);
  return (
    <TimelineLanes
      key={day.start.toISOString()}
      label={`Runs, ${dayText}`}
      hours={hours}
      now={now}
      bars={bars}
      trackCount={trackCount}
      fires={buildTimelineFires(triggers, isEnabled, day, timezone)}
      emptyText={day.isToday ? "No runs today" : "No runs this day"}
      timezone={timezone}
    />
  );
}

/**
 * Reads the workflow `workflowId`'s runs a page at a time, newest first, and
 * draws them as the Runs list's rows. The list is virtualized in the open
 * workflow's pane, `pane`, which scrolls as one; the next page is read when
 * the last row read is mounted. Until the pane is mounted, `pane` is null and
 * no row is drawn.
 */
export function RunList({
  client,
  workflowId,
  definition,
  timezone,
  pane,
}: {
  readonly client: HerculeClient;
  readonly workflowId: string;
  readonly definition: WorkflowDefinition;
  readonly timezone: string;
  readonly pane: HTMLElement | null;
}): JSX.Element {
  const { data, hasNextPage, isFetchingNextPage, fetchNextPage } = useSuspenseInfiniteQuery(
    workflowRunsQuery(client, workflowId),
  );
  const waitingRunSessions = useWaitingRunSessions();
  const rows = buildRunRows(
    data.pages.flatMap((page) => page.items),
    definition,
    waitingRunSessions,
  );

  // The rows start below the lead, the graph and the tab band, so the
  // virtualizer is told where the list starts in the pane. The pane is the
  // list's offset parent (`position: relative` in workflow-detail.css).
  const listRef = useRef<HTMLDivElement>(null);
  const [listTop, setListTop] = useState(0);
  // Measured after every render, because the list moves whenever anything
  // above it changes height: an error under the name, a wrapped chip, a
  // narrower pane. The state is set only when the top moved, so the second
  // render measures the same top and stops.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const top = listRef.current?.offsetTop ?? 0;
    if (top !== listTop) setListTop(top);
  });

  // eslint-disable-next-line react-hooks/incompatible-library -- The virtualizer returns an object that changes inside while its identity stays the same, which the React Compiler cannot memoize, so the compiler leaves this component alone.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => pane,
    estimateSize: () => RUN_ROW_HEIGHT,
    getItemKey: (index) => rows[index]!.id,
    overscan: OVERSCAN,
    scrollMargin: listTop,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const visible = virtualizer.range;

  const lastIndex = virtualItems.at(-1)?.index;
  useEffect(() => {
    if (lastIndex === rows.length - 1 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [lastIndex, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (rows.length === 0) return <p className="table-empty">No runs yet</p>;
  return (
    <div
      ref={listRef}
      role="list"
      style={{ position: "relative", height: virtualizer.getTotalSize() }}
    >
      {virtualItems.map(({ index, key, start }) => (
        <div
          key={key}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${String(start - listTop)}px)`,
          }}
        >
          <RunListRow
            row={rows[index]!}
            timezone={timezone}
            onScreen={visible !== null && index >= visible.startIndex && index <= visible.endIndex}
          />
        </div>
      ))}
    </div>
  );
}
