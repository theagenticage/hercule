import type { JSX } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { MarkState } from "../../marks/mark-state";
import { TimelineBoard } from "./run-timeline-board";
import type { TimelineAxis, TimelineBar } from "./run-timeline";

afterEach(cleanup);

const AXIS: TimelineAxis = { dayText: "Today", hours: [], now: undefined };

/** Builds the bar of a run that started at 9:00 and is in `mark`. */
function buildBar(runId: string, mark: MarkState): TimelineBar {
  return {
    run: {
      id: runId,
      mark,
      status: { text: "", tone: "muted" },
      startedBy: { source: undefined, text: "You" },
      isLive: mark === "working",
      durationText: "2m",
      timeText: "09:00",
    },
    from: 0.375,
    to: 0.4,
    track: 0,
    startsBefore: false,
    endsAfter: false,
  };
}

/** Builds a board of `bars`, with the props that do not matter here filled in. */
function buildBoard(bars: ReadonlyArray<TimelineBar>): JSX.Element {
  return (
    <TimelineBoard
      label="Runs on today"
      axis={AXIS}
      bars={bars}
      trackCount={1}
      fires={[]}
      drawnRunId={undefined}
      onPickRun={() => undefined}
      emptyText="No runs"
    />
  );
}

describe("TimelineBoard", () => {
  it("draws no bar as late when it is first drawn", () => {
    const { container } = render(buildBoard([buildBar("d-1", "working"), buildBar("d-2", "done")]));
    expect(container.querySelectorAll(".rt-bar")).toHaveLength(2);
    expect(container.querySelectorAll(".rt-bar.is-late")).toHaveLength(0);
  });

  it("draws a bar as late when its run arrives or changes after the first drawing", () => {
    const { container, rerender } = render(
      buildBoard([buildBar("d-1", "working"), buildBar("d-2", "done")]),
    );
    rerender(
      buildBoard([buildBar("d-3", "working"), buildBar("d-1", "done"), buildBar("d-2", "done")]),
    );
    const late = [...container.querySelectorAll(".rt-bar")].map((bar) =>
      bar.classList.contains("is-late"),
    );
    expect(late).toEqual([true, true, false]);
  });

  it("keeps a bar late once it is, even when its mark goes back", () => {
    const { container, rerender } = render(buildBoard([buildBar("d-1", "working")]));
    rerender(buildBoard([buildBar("d-1", "waiting")]));
    rerender(buildBoard([buildBar("d-1", "working")]));
    expect(container.querySelectorAll(".rt-bar.is-late")).toHaveLength(1);
  });

  it("draws a new mark when a late bar's run changes, so its arrival plays again", () => {
    const { container, rerender } = render(buildBoard([buildBar("d-1", "working")]));
    rerender(buildBoard([buildBar("d-1", "waiting")]));
    const waitingMark = container.querySelector(".rt-bar > .mark");
    rerender(buildBoard([buildBar("d-1", "done")]));
    const doneMark = container.querySelector(".rt-bar > .mark");
    expect(doneMark?.classList.contains("mark--done")).toBe(true);
    expect(doneMark).not.toBe(waitingMark);
  });
});
