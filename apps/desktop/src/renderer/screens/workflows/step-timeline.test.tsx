/**
 * Tests the step timeline: the axis with its ticks and its "now" pill, a row
 * per step with its mark, error, bar and time taken, rows with a thread that
 * open it, and a live bar whose end the age clock moves by transform alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Run, Session, StepRecord } from "@hercule/contract";
import { buildSession } from "@hercule/client-core/threads/testing";
import { StepTimelineHead, StepTimelineRows, useStepTimeline } from "./step-timeline";

const START = "2026-09-24T12:00:00.000Z";
const at = (ms: number): string => new Date(Date.parse(START) + ms).toISOString();
const RUN_ID = "01a06d02-c111-7a0e-8b3d-9c1f1f3a9c2e";
const REVIEW_SESSION_ID = "01a06d02-c111-7a0e-8b3d-9c1f00005e55";

/** `build`, then `review` with an Agent's session, then `ship`. */
const RUN_FIELDS = {
  id: RUN_ID,
  workflowId: null,
  plan: {
    name: "Release",
    inputs: [],
    triggers: [{ id: "labeled", kind: "start", on: { kind: "github.issue.labeled" } }],
    steps: [
      { id: "build", kind: "action", action: "task.create" },
      { id: "review", kind: "agent", agent: "a-reviewer", prompt: "Review the release." },
      { id: "ship", kind: "action", action: "task.update", terminal: true },
    ],
    edges: [
      { from: "build", to: "review" },
      { from: "review", to: "ship" },
    ],
  },
  inputs: {},
  origin: { kind: "trigger", triggerId: "labeled", eventId: 1 },
  subscriptions: [],
  createdAt: START,
  edgeTraversals: [1, 0],
} as const satisfies Partial<Run>;

const BUILD: StepRecord = {
  stepId: "build",
  iteration: 1,
  status: "completed",
  startedAt: START,
  finishedAt: at(20_000),
  output: { ok: true },
};

/** `build` took 20 seconds; `review` has run since 25 seconds in. */
const RUNNING: Run = {
  ...RUN_FIELDS,
  status: "running",
  startedAt: START,
  steps: [
    BUILD,
    {
      stepId: "review",
      iteration: 1,
      status: "running",
      startedAt: at(25_000),
      sessionId: REVIEW_SESSION_ID,
    },
  ],
};

/** `review` failed 40 seconds in, so `ship` was never reached. */
const FAILED: Run = {
  ...RUN_FIELDS,
  status: "failed",
  failureReason: "step-failed",
  failedStepId: "review",
  startedAt: START,
  finishedAt: at(40_000),
  steps: [
    BUILD,
    {
      stepId: "review",
      iteration: 1,
      status: "failed",
      startedAt: at(25_000),
      finishedAt: at(40_000),
      error: { code: "session_failed", message: "The session exited." },
      sessionId: REVIEW_SESSION_ID,
    },
  ],
};

const QUIET: Session = buildSession({
  id: REVIEW_SESSION_ID,
  runId: RUN_ID,
  stepId: "review",
  openRequests: [],
});

/** Draws both parts of `run`'s timeline, as a run's page puts them in its band and its body. */
function Timeline({
  run,
  onOpenSession,
}: {
  readonly run: Run;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const steps = useStepTimeline(run, [QUIET], true);
  if (steps === undefined) return null;
  return (
    <>
      <StepTimelineHead steps={steps} />
      <StepTimelineRows steps={steps} onOpenSession={onOpenSession} />
    </>
  );
}

/**
 * Gives the axis's track 700px and its digit probe 7px, so the axis is 100
 * characters wide: wide enough that only the most ticks an axis has limits
 * them. jsdom lays nothing out, so both would measure 0.
 */
const stubAxisWidth = () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const width = this.classList.contains("axis-probe")
      ? 7
      : this.classList.contains("track")
        ? 700
        : 0;
    return {
      width,
      height: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  });
};

/**
 * Returns the number in `element`'s inline transform, which is one function
 * of one value: 0.72 for `scaleX(0.72)`, 86 for `translateX(86%)`. The
 * transform is computed in floating point, so tests compare it with
 * `toBeCloseTo`.
 */
const readTransformNumber = (element: Element | null): number =>
  Number(/^\w+\(([^%)]+)%?\)$/.exec((element as HTMLElement | null)?.style.transform ?? "")?.[1]);

/** Returns the row of `stepId`. */
const findRow = (container: HTMLElement, stepId: string) =>
  [...container.querySelectorAll<HTMLElement>(".table-rows > .table-row")].find(
    (row) => row.querySelector(".record-name")?.firstChild?.textContent === stepId,
  )!;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(at(43_000)), toFake: ["Date", "setTimeout", "clearTimeout"] });
  stubAxisWidth();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the step timeline of a live run", () => {
  it("labels the axis up to the first tick after now, and ends it with how long the run has run", () => {
    const { container } = render(<Timeline run={RUNNING} onOpenSession={vi.fn()} />);
    const head = container.querySelector(".table-heads")!;
    expect([...head.querySelectorAll(".axis-tick")].map((tick) => tick.textContent)).toEqual([
      "0",
      "10s",
      "20s",
      "30s",
      "40s",
      "50s",
    ]);
    expect(head.querySelector(".axis-now")?.textContent).toBe("now 43s");
    // The axis ends at the 50s tick, so now, 43s in, is 86% along it.
    expect(readTransformNumber(head.querySelector(".now-at"))).toBeCloseTo(86);
    expect(head.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws a row per step: its mark, its bar, how long it took, and a quiet name for one not reached", () => {
    const { container } = render(<Timeline run={RUNNING} onOpenSession={vi.fn()} />);
    const build = findRow(container, "build");
    expect(build.querySelector(".table-mark > .mark")?.className).toBe("mark mark--done");
    const bar = build.querySelector<HTMLElement>(".run-bar")!;
    expect(bar.className).toBe("run-bar");
    expect(bar.style.getPropertyValue("--at")).toBe("0%");
    expect(bar.style.getPropertyValue("--span")).toBe("40%");
    expect(build.querySelector(".table-num")?.textContent).toBe("20.0s");

    const ship = findRow(container, "ship");
    expect(ship.querySelector(".record-name")?.className).toBe("record-name is-quiet");
    expect(ship.querySelector(".table-mark")?.childElementCount).toBe(0);
    expect(ship.querySelector(".run-bar")).toBeNull();
    expect(ship.querySelector(".table-num")?.textContent).toBe("");
    // A step the run has not reached has no note: its quiet name says so.
    expect(ship.querySelector(".track-note")).toBeNull();
    // Each row draws the now line at now.
    expect(readTransformNumber(ship.querySelector(".now-at"))).toBeCloseTo(86);
    expect(ship.querySelector(".now-at > .now-line")).not.toBeNull();
  });

  it("opens a step's thread from its row", () => {
    const onOpenSession = vi.fn();
    render(<Timeline run={RUNNING} onOpenSession={onOpenSession} />);
    const review = screen.getByRole("button", { name: "review, Working" });
    expect(review.getAttribute("title")).toBe("Open review’s thread");
    fireEvent.click(review);
    expect(onOpenSession).toHaveBeenCalledWith(REVIEW_SESSION_ID);
    // A step with no thread is no button.
    expect(screen.queryByRole("button", { name: /^build/ })).toBeNull();
  });

  it("moves the running bar's end, the now line and the now pill together, by transform alone", () => {
    const { container } = render(<Timeline run={RUNNING} onOpenSession={vi.fn()} />);
    const review = findRow(container, "review");
    const bar = review.querySelector<HTMLElement>(".run-bar")!;
    // The bar's room runs from 25s to the axis's end at 50s.
    expect(bar.style.getPropertyValue("--at")).toBe("50%");
    expect(bar.style.getPropertyValue("--span")).toBe("50%");
    const line = bar.querySelector<HTMLElement>(".run-bar-line")!;
    const end = bar.querySelector<HTMLElement>(".run-bar-end")!;
    expect(line.style.transform).toMatch(/^scaleX\(/);
    expect(readTransformNumber(line)).toBeCloseTo(0.72);
    expect(end.style.transform).toMatch(/^translateX\(/);
    expect(readTransformNumber(end)).toBeCloseTo(-28);
    expect(end.querySelector(".mark")?.className).toBe("mark mark--working");
    expect(review.querySelector(".table-num")?.textContent).toBe("18s");

    // A duration shows whole seconds, rounded, so the clock moves on at 43.5s.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(readTransformNumber(line)).toBeCloseTo(0.74);
    expect(bar.style.getPropertyValue("--span")).toBe("50%");
    // The bar's end, 50% + 50% × 0.74, meets now on the axis.
    for (const layer of container.querySelectorAll<HTMLElement>(".now-at")) {
      expect(readTransformNumber(layer)).toBeCloseTo(87);
    }
    expect(container.querySelector(".axis-now")?.textContent).toBe("now 44s");
    expect(review.querySelector(".table-num")?.textContent).toBe("19s");
  });

  it("lengthens the axis once now passes its end", () => {
    const { container } = render(<Timeline run={RUNNING} onOpenSession={vi.fn()} />);
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect([...container.querySelectorAll(".axis-tick")].at(-1)?.textContent).toBe("1m");
    expect(
      findRow(container, "build")
        .querySelector<HTMLElement>(".run-bar")!
        .style.getPropertyValue("--span"),
    ).toBe(`${String((20 / 60) * 100)}%`);
  });
});

describe("a queued step", () => {
  it("notes on its track that it waits to start", () => {
    const queued: Run = {
      ...RUNNING,
      steps: [BUILD, { stepId: "review", iteration: 1, status: "pending" }],
    };
    const { container } = render(<Timeline run={queued} onOpenSession={vi.fn()} />);
    const review = findRow(container, "review");
    expect(review.querySelector(".track-note")?.textContent).toBe("Waiting to start");
    expect(review.querySelector(".run-bar")).toBeNull();
  });
});

describe("the step timeline of an ended run", () => {
  it("draws no now pill or now line", () => {
    const { container } = render(<Timeline run={FAILED} onOpenSession={vi.fn()} />);
    expect(container.querySelector(".axis-now, .now-line")).toBeNull();
  });

  it("gives a failed step its error and a bar in fail ink", () => {
    const { container } = render(<Timeline run={FAILED} onOpenSession={vi.fn()} />);
    const review = findRow(container, "review");
    expect(review.querySelector(".record-err")?.textContent).toBe("The session exited.");
    expect(review.querySelector(".run-bar")?.className).toBe("run-bar run-bar--fail");
    expect(review.querySelector(".run-bar > .mark")?.className).toBe("mark mark--failed");
    expect(review.querySelector(".table-num")?.textContent).toBe("15.0s");
  });

  it("leaves a step the run never reached without a note", () => {
    const { container } = render(<Timeline run={FAILED} onOpenSession={vi.fn()} />);
    const ship = findRow(container, "ship");
    expect(ship.querySelector(".record-name")?.className).toBe("record-name is-quiet");
    expect(ship.querySelector(".track-note")).toBeNull();
  });
});
