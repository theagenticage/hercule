import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { computeNextMidnight, formatDayStamp, type HerculeClient } from "@hercule/client-core";
import { computeDayStart } from "@hercule/client-core/list-time";
import {
  buildTimelineBars,
  buildTimelineFires,
  buildTimelineHours,
  computeTimelineDay,
  findNextTimelineMinute,
  locateTimelineNow,
  type TimelineDay,
  type TimelineNow,
} from "@hercule/client-core/run-timeline";
import { buildRunRows } from "@hercule/client-core/workflow-detail-rows";
import type { Trigger, WorkflowDefinition } from "@hercule/contract";
import { useClockValue } from "../../../../app/age-clock";
import { workflowDayRunsQuery, workflowRunsQuery } from "../../../../app/queries";
import { useWaitingRunSessions } from "../../../../app/waiting";
import {
  TimelineAxis,
  TimelineLanes,
  type RunsView,
} from "../../../../screens/workflows/run-timeline-board";
import { RUN_ROW_HEIGHT, RunListRow } from "../../../../screens/workflows/workflow-detail";

/** How many rows past the visible ones the Runs list keeps mounted on each side. */
const OVERSCAN = 8;

/** A moment so far off that the age clock never reaches it. */
const NEVER = new Date(8.64e15);

/**
 * Returns the start of the minute after `now`, when the now line next moves.
 * It is a module-level function, not an arrow inside `useTimelineNow`,
 * because the age clock subscribes again whenever this function changes.
 */
const findNextMinute = (_moment: string, now: Date): Date => findNextTimelineMinute(now);

/** Returns the start of the minute `now` falls in, in milliseconds since the epoch. */
const computeMinuteStart = (now: Date): number => Math.floor(now.getTime() / 60_000) * 60_000;

/**
 * Returns how the Runs tab moves between its views and its days. Both
 * replace the history entry, so Back leaves the workflow.
 *
 * - `pickView` shows the runs as `view`, and goes back to today.
 * - `showDay` shows the day `daysBack` days before today on the timeline,
 *   keeping the view.
 */
export const useRunsNavigation = (): {
  readonly pickView: (view: RunsView) => void;
  readonly showDay: (daysBack: number) => void;
} => {
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  return {
    pickView: (view) => {
      void navigate({
        to: ".",
        search: (previous) => {
          const kept = { ...previous };
          delete kept.runsView;
          delete kept.daysBack;
          return view === "timeline" ? { ...kept, runsView: "timeline" as const } : kept;
        },
        replace: true,
      });
    },
    showDay: (daysBack) => {
      void navigate({
        to: ".",
        search: (previous) => {
          const kept = { ...previous };
          delete kept.daysBack;
          return daysBack === 0 ? kept : { ...kept, daysBack };
        },
        replace: true,
      });
    },
  };
};

/** The day the timeline shows, and the words the day stepper shows it with. */
export interface ShownDay {
  /** How many days before today the day is, as the user chose it: 0 for today. */
  readonly daysBack: number;
  readonly day: TimelineDay;
  /** "Today", "Yesterday", "27 Sep", or "27 Sep 2025" in another year. */
  readonly dayText: string;
}

/**
 * Returns the day `daysBack` days before today in `timezone`, and its text
 * for the day stepper. Today is read on the age clock, which wakes at local
 * midnight while `isShown` is true, so the timeline moves to the new day as
 * it starts. While `isShown` is false, the day is not kept current, so the
 * page sets no timer for a timeline nobody sees.
 */
export const useShownDay = (daysBack: number, timezone: string, isShown: boolean): ShownDay => {
  const findNextMidnight = useCallback(
    (_moment: string, now: Date) => computeNextMidnight(now, timezone) ?? NEVER,
    [timezone],
  );
  // The time zone was resolved before it reached here, so the day always has a start.
  const todayStart = useClockValue(timezone, isShown, findNextMidnight, (now) =>
    computeDayStart(now, timezone)!.getTime(),
  );
  const today = new Date(todayStart);
  const day = computeTimelineDay(today, daysBack, timezone);
  return { daysBack, day, dayText: formatDayStamp(day.start, timezone, today) ?? "" };
};

/**
 * Returns where the now line is drawn on `day`, read in `timezone`, or null
 * on a day that is not today. The age clock moves it once a minute, and only
 * draws again the component that calls this hook.
 */
const useTimelineNow = (day: TimelineDay, timezone: string): TimelineNow | null => {
  const minute = useClockValue(
    day.start.toISOString(),
    day.isToday,
    findNextMinute,
    computeMinuteStart,
  );
  return day.isToday ? locateTimelineNow(day, timezone, minute) : null;
};

/**
 * Renders the timeline's hour axis for `day`, read in `timezone`, with the
 * now line on today. It holds the minute clock itself, so only the axis
 * draws again each minute.
 */
export function RunTimelineAxis({
  day,
  timezone,
}: {
  readonly day: TimelineDay;
  readonly timezone: string;
}): JSX.Element {
  const now = useTimelineNow(day, timezone);
  return <TimelineAxis hours={buildTimelineHours(day, timezone)} now={now} />;
}

/**
 * Reads one day of the workflow `workflowId`'s runs and draws them on the
 * timeline's lanes, with the next fires of its `triggers` later today.
 * `isEnabled` is whether the workflow is on: an off workflow fires nothing.
 * The lanes hold the minute clock for their now line, as the axis does.
 * They are drawn afresh for each day the user steps to, so stepping plays
 * their arrival again. When the day turns at midnight, the lanes stay, so
 * the focus stays on a run that goes on into the new day, and only the bars
 * that arrive or change pop their marks.
 */
export function RunDayLanes({
  client,
  workflowId,
  definition,
  isEnabled,
  triggers,
  shown,
  timezone,
}: {
  readonly client: HerculeClient;
  readonly workflowId: string;
  readonly definition: WorkflowDefinition;
  readonly isEnabled: boolean;
  readonly triggers: ReadonlyArray<Trigger>;
  readonly shown: ShownDay;
  readonly timezone: string;
}): JSX.Element {
  const { day, dayText } = shown;
  const { data: runs } = useSuspenseQuery(workflowDayRunsQuery(client, workflowId, day));
  const waitingRunSessions = useWaitingRunSessions();
  const now = useTimelineNow(day, timezone);
  const { bars, trackCount } = buildTimelineBars(runs, definition, waitingRunSessions, day);
  return (
    <TimelineLanes
      key={shown.daysBack}
      label={`Runs, ${dayText}`}
      hours={buildTimelineHours(day, timezone)}
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
  // list's offset parent (`position: relative` in workflow-detail.css). The
  // list moves whenever anything above it changes height: an error under the
  // name, a wrapped chip, a narrower pane. So each of the pane's children
  // above the list is watched, and the top is measured again when one
  // resizes, with no work on a render that moves nothing.
  const listRef = useRef<HTMLDivElement>(null);
  const [listTop, setListTop] = useState(0);
  const hasRows = rows.length > 0;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (pane === null || list === null) return;
    const measureListTop = (): void => {
      setListTop(list.offsetTop);
    };
    measureListTop();
    const observer = new ResizeObserver(measureListTop);
    for (const child of pane.children) {
      if (child.contains(list)) break;
      observer.observe(child);
    }
    return () => {
      observer.disconnect();
    };
  }, [pane, hasRows]);

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

  if (!hasRows) return <p className="table-empty">No runs yet</p>;
  return (
    <div
      ref={listRef}
      role="list"
      style={{ position: "relative", height: virtualizer.getTotalSize() }}
    >
      {virtualItems.map(({ index, key, start }) => (
        <div
          key={key}
          role="listitem"
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
