import type { CSSProperties, JSX } from "react";
import {
  describeStepDuration,
  describeUnstartedStep,
  formatElapsed,
  type Timeline,
} from "@hercule/client-core";
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

/** The track column's edges, for the line of now that crosses every row's track. */
const TRACK: CSSProperties = {
  left: ROW_PADDING + MARK_COLUMN + COLUMN_GAP + STEP_COLUMN + COLUMN_GAP,
  right: ROW_PADDING + DURATION_COLUMN + COLUMN_GAP,
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
 * run has not reached. A vertical line marks now; it moves while the run is
 * live and stands where the run ended once it has ended.
 */
export function StepTimeline({
  timeline,
  isLive,
  now,
}: {
  readonly timeline: Timeline;
  /** Whether the run is pending or running. */
  readonly isLive: boolean;
  /** The time a running step's duration counts to, in milliseconds since the epoch. */
  readonly now: number;
}): JSX.Element {
  const { ticks } = timeline;
  return (
    <div className="rounded-card border border-line-soft bg-surface px-1.5 py-1">
      <div style={GRID} className="grid h-10 items-end pb-1.5" aria-hidden="true">
        <span />
        <span />
        <span className="relative h-full">
          {ticks.map((tick, index) => (
            <span
              key={tick.position}
              style={{ left: formatPercent(tick.position) }}
              className={cn(
                "absolute bottom-0 font-mono text-label text-faint tabular-nums",
                index === 0
                  ? ""
                  : index === ticks.length - 1
                    ? "-translate-x-full"
                    : "-translate-x-1/2",
              )}
            >
              {tick.label}
            </span>
          ))}
          {isLive ? (
            <span
              style={{ left: formatPercent(timeline.now) }}
              className="absolute top-0 -translate-x-1/2 rounded-control bg-surface px-1 font-mono text-label text-live tabular-nums"
            >
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
                        <span
                          style={{ left: formatPercent(timeline.now) }}
                          className="absolute top-1/2 ml-2 -translate-y-1/2 text-fine whitespace-nowrap text-faint"
                        >
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
            style={{ left: formatPercent(timeline.now) }}
            className={cn(
              "absolute inset-y-0 w-px",
              isLive ? "bg-[color-mix(in_oklch,var(--live)_70%,transparent)]" : "bg-line",
            )}
          />
        </div>
      </div>
    </div>
  );
}
