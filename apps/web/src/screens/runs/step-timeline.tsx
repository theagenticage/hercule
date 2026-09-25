import type { CSSProperties, JSX } from "react";
import {
  buildTimeline,
  describeStepDuration,
  formatElapsed,
  isRunLive,
} from "@hercule/client-core";
import type { Run } from "@hercule/contract";
import { WORK_STATE_HUES, cn, useElementWidth, type WorkState } from "@hercule/ui";
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
  // Measured before the first paint, so the ticks never show at a width they
  // were not laid out for. An unmeasured axis gets only the tick at 0.
  const { observeElement: observeAxis, width: axisWidth = 0 } = useElementWidth();
  const timeline = buildTimeline(run, now, axisWidth / TICK_LABEL_CHARACTER_WIDTH);
  const isLive = isRunLive(run.status);
  const { ticks } = timeline;
  return (
    <div className="rounded-card border border-line-soft bg-surface px-1.5 py-1">
      <div style={GRID} className="grid h-10 items-end pb-1.5" aria-hidden="true">
        <span />
        <span />
        <span ref={observeAxis} className="relative h-full">
          {ticks.map((tick) => (
            <span
              key={tick.position}
              style={{ left: formatPercent(tick.position) }}
              // Every label is centred on its tick. The label at either end
              // of the axis reaches into the empty header cell beside it.
              className="absolute bottom-0 -translate-x-1/2 font-mono text-label text-faint tabular-nums"
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
          {timeline.lines.map(({ line, bar, note }) => {
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
                    {note !== undefined ? (
                      // The note ends at its position by the same fraction of
                      // its own width as its position is of the axis, so near
                      // the end of the axis it stays inside the track. Its
                      // background and padding keep it clear of the gridlines.
                      <span
                        style={{
                          left: formatPercent(note.position),
                          transform: `translate(-${formatPercent(note.position)}, -50%)`,
                        }}
                        className="absolute top-1/2 bg-surface px-1.5 text-fine whitespace-nowrap text-faint"
                      >
                        {note.text}
                      </span>
                    ) : bar === undefined ? null : (
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
