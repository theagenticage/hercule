import { useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import {
  buildTimeline,
  describeStepDuration,
  describeUnstartedStep,
  formatElapsed,
  isRunLive,
  type TickAlign,
} from "@hercule/client-core";
import type { Run } from "@hercule/contract";
import { WORK_STATE_HUES, cn, type WorkState } from "@hercule/ui";
import { StepCells, StepErrorLine } from "./step-parts";

/** The widths of the timeline's columns and the spacing around them, in pixels. */
const MARK_COLUMN = 20;
const STEP_COLUMN = 220;
const DURATION_COLUMN = 64;
const COLUMN_GAP = 12;
const ROW_PADDING = 10;

/** The columns of every timeline row: mark, step, track, duration. */
const GRID: CSSProperties = {
  gridTemplateColumns: `${String(MARK_COLUMN)}px ${String(STEP_COLUMN)}px minmax(0, 1fr) ${String(DURATION_COLUMN)}px`,
  columnGap: COLUMN_GAP,
  paddingInline: ROW_PADDING,
};

/** The track column's edges, for the line at the end of the axis that crosses every row's track. */
const TRACK: CSSProperties = {
  left: ROW_PADDING + MARK_COLUMN + COLUMN_GAP + STEP_COLUMN + COLUMN_GAP,
  right: ROW_PADDING + DURATION_COLUMN + COLUMN_GAP,
};

/**
 * The width of one character of a tick label: IBM Plex Mono, whose every
 * glyph is 0.6em wide, at `text-label`, 10.5px.
 */
const TICK_LABEL_CHARACTER_WIDTH = 10.5 * 0.6;

/** The shift that puts each end of a tick's label at the tick, by the label's alignment. */
const TICK_LABEL_SHIFT: Readonly<Record<TickAlign, string>> = {
  start: "",
  center: "-translate-x-1/2",
  end: "-translate-x-full",
};

/** Converts a fraction of the axis to a CSS length. */
const formatPercent = (fraction: number): string => `${String(fraction * 100)}%`;

/** The fill of each state's bar: live while it runs, the fail hue once it failed. */
const BAR_FILL: Readonly<Partial<Record<WorkState, string>>> = {
  running: "bg-live",
  completed: "bg-[color-mix(in_oklch,var(--muted)_50%,transparent)]",
  failed: "bg-fail",
  cancelled: "bg-[color-mix(in_oklch,var(--faint)_45%,transparent)]",
};

/**
 * Renders the steps of a run on a shared time axis: one row per step record with a
 * bar from its start to its end, or to now while it runs, then the steps the
 * run has not reached. The axis ends at now while the run is live, and where
 * the run ended once it has ended; a vertical line marks that end.
 *
 * The ticks are as close together as the axis's width lets their labels be,
 * so the timeline measures its axis, and measures it again when it resizes.
 */
export function StepTimeline({
  run,
  now,
}: {
  readonly run: Run;
  /** The time a running step's duration counts to, in milliseconds since the epoch. */
  readonly now: number;
}): JSX.Element {
  const axis = useRef<HTMLSpanElement>(null);
  const [axisWidth, setAxisWidth] = useState(0);
  // Measured before the first paint, so the ticks never show at a width they
  // were not laid out for.
  useLayoutEffect(() => {
    const element = axis.current;
    if (element === null) return;
    setAxisWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setAxisWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  const timeline = buildTimeline(run, now, axisWidth / TICK_LABEL_CHARACTER_WIDTH);
  const isLive = isRunLive(run.status);
  const { ticks } = timeline;
  return (
    <div className="rounded-card border border-line-soft bg-surface px-1.5 py-1">
      <div style={GRID} className="grid h-10 items-end pb-1.5" aria-hidden="true">
        <span />
        <span />
        <span ref={axis} className="relative h-full">
          {ticks.map((tick) => (
            <span
              key={tick.position}
              style={{ left: formatPercent(tick.position) }}
              className={cn(
                "absolute bottom-0 font-mono text-label text-faint tabular-nums",
                TICK_LABEL_SHIFT[tick.align],
              )}
            >
              {tick.label}
            </span>
          ))}
          {isLive ? (
            <span className="absolute top-0 right-0 rounded-control bg-surface font-mono text-label whitespace-nowrap text-live tabular-nums">
              {`now ${formatElapsed(timeline.elapsedMs)}`}
            </span>
          ) : null}
        </span>
        <span />
      </div>
      <div className="relative">
        <ul>
          {timeline.lines.map(({ line, bar }) => {
            return (
              <li key={line.key} className="border-t border-line-soft">
                <div style={GRID} className="grid min-h-10 items-center">
                  <StepCells line={line} />{" "}
                  <span className="relative h-full min-h-10">
                    {ticks.map((tick) => (
                      <span
                        key={tick.position}
                        style={{ left: formatPercent(tick.position) }}
                        className="absolute inset-y-0 w-px bg-line-soft"
                      />
                    ))}
                    {bar === undefined ? (
                      describeUnstartedStep(line.state) === undefined ? null : (
                        <span className="absolute top-1/2 right-0 mr-2 -translate-y-1/2 text-fine whitespace-nowrap text-faint">
                          {describeUnstartedStep(line.state)}
                        </span>
                      )
                    ) : (
                      <span
                        // A bar is at least as wide as its round ends, so a step
                        // of a millisecond still shows.
                        style={{
                          left: formatPercent(bar.start),
                          width: `max(6px, ${formatPercent(bar.end - bar.start)})`,
                        }}
                        className={cn(
                          "absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full",
                          BAR_FILL[line.state],
                        )}
                      />
                    )}
                  </span>{" "}
                  <span
                    className={cn(
                      "text-right font-mono text-fine tabular-nums",
                      WORK_STATE_HUES[line.state] ?? "text-muted",
                    )}
                  >
                    {describeStepDuration(line, now)}
                  </span>
                </div>
                {line.error === undefined ? null : <StepErrorLine error={line.error} />}
              </li>
            );
          })}
        </ul>
        <div aria-hidden="true" style={TRACK} className="pointer-events-none absolute inset-y-0">
          <span
            className={cn(
              "absolute inset-y-0 left-full w-px",
              isLive ? "bg-[color-mix(in_oklch,var(--live)_70%,transparent)]" : "bg-line",
            )}
          />
        </div>
      </div>
    </div>
  );
}
