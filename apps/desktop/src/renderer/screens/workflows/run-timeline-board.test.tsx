/**
 * Tests the timeline's day stepper: its buttons never drop the focus, the
 * step on cannot act on today nor the step back on the oldest day, and
 * "Today" shows only away from today. Then tests that a bar keeps its times
 * current on the age clock only while it is on screen, which bars play
 * the lanes' arrival and which only pop their mark, that the lanes record
 * no motion with Reduce motion on, and that they drop it once it has ended.
 */
import { useState, type JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { TimelineBar } from "@hercule/client-core/run-timeline";
import type { RunRow } from "@hercule/client-core/workflow-detail-rows";
import { stubCssAnimations, stubIntersectionObserver } from "../../app/testing";
import { TimelineDayStepper, TimelineLanes } from "./run-timeline-board";

/** The oldest day the test's stepper shows, in days back from today. */
const OLDEST = 2;

/** Renders the stepper over a count of days back from today, as a route steps it. */
function Stepper({
  onStepOn,
  onStepBack = () => undefined,
}: {
  readonly onStepOn: () => void;
  readonly onStepBack?: () => void;
}): JSX.Element {
  const [daysBack, setDaysBack] = useState(1);
  return (
    <TimelineDayStepper
      dayText={daysBack === 0 ? "Today" : `${String(daysBack)} days ago`}
      isToday={daysBack === 0}
      isOldest={daysBack === OLDEST}
      onStepBack={() => {
        onStepBack();
        setDaysBack(daysBack + 1);
      }}
      onStepOn={() => {
        onStepOn();
        setDaysBack(daysBack - 1);
      }}
      onShowToday={() => {
        setDaysBack(0);
      }}
    />
  );
}

describe("the timeline's day stepper", () => {
  it("keeps the focus on the step on when it steps onto today, where it cannot act", async () => {
    const user = userEvent.setup();
    const onStepOn = vi.fn();
    render(<Stepper onStepOn={onStepOn} />);
    const stepOn = screen.getByRole("button", { name: "Show the day after" });

    await user.click(stepOn);
    expect(screen.getByText("Today")).toBeTruthy();
    expect(stepOn.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(stepOn);

    await user.keyboard("{Enter}");
    expect(onStepOn).toHaveBeenCalledTimes(1);
  });

  it("keeps the focus on the step back when it steps onto the oldest day, where it cannot act", async () => {
    const user = userEvent.setup();
    const onStepBack = vi.fn();
    render(<Stepper onStepOn={vi.fn()} onStepBack={onStepBack} />);
    const stepBack = screen.getByRole("button", { name: "Show the day before" });

    await user.click(stepBack);
    expect(screen.getByText("2 days ago")).toBeTruthy();
    expect(stepBack.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(stepBack);

    await user.keyboard("{Enter}");
    expect(onStepBack).toHaveBeenCalledTimes(1);
  });

  it("moves the focus to the step back when Today is pressed, because Today is gone on today", async () => {
    const user = userEvent.setup();
    render(<Stepper onStepOn={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.queryByRole("button", { name: "Today" })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Show the day before" }),
    );
  });
});

/** A run that started a step at 09:58:48 and is still working. */
const LIVE_BAR: TimelineBar = {
  row: {
    id: "run-1",
    state: "working",
    statusText: "At review",
    statusTone: "muted",
    startedByText: "nightly",
    startedByFiresOn: null,
    createdAt: "2026-10-11T09:58:48.000Z",
    startedAt: "2026-10-11T09:58:48.000Z",
    finishedAt: null,
    isLive: true,
  },
  from: 0.4,
  to: null,
  track: 0,
  startsBefore: false,
  endsAfter: false,
};

/**
 * Draws the lanes of a day with `LIVE_BAR` on them, and returns the bar. A
 * bar is a link to its run's page, so the lanes render with a router's
 * context, which a link needs to build its address.
 */
const renderLiveBar = (): HTMLElement => {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory(),
  });
  render(
    <RouterContextProvider router={router}>
      <TimelineLanes
        label="Runs, Today"
        hours={[]}
        now={null}
        bars={[LIVE_BAR]}
        trackCount={1}
        fires={[]}
        emptyText="No runs today"
        timezone="UTC"
      />
    </RouterContextProvider>,
  );
  return screen.getByRole("link");
};

describe("a bar on the timeline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts its run's duration while it is on screen", () => {
    vi.useFakeTimers({
      now: new Date("2026-10-11T10:00:00.000Z"),
      toFake: ["Date", "setTimeout", "clearTimeout"],
    });
    stubIntersectionObserver();
    const bar = renderLiveBar();
    expect(bar.getAttribute("aria-label")).toBe(
      "At review, started by nightly, 09:58, running for 1m 12s",
    );
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(bar.getAttribute("aria-label")).toBe(
      "At review, started by nightly, 09:58, running for 1m 13s",
    );
  });

  it("sets no timer while it is off screen, and catches up when it comes back", () => {
    vi.useFakeTimers({
      now: new Date("2026-10-11T10:00:00.000Z"),
      toFake: ["Date", "setTimeout", "clearTimeout"],
    });
    const reportOnScreen = stubIntersectionObserver();
    const bar = renderLiveBar();

    reportOnScreen(bar, false);
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(new Date("2026-10-11T10:00:10.000Z"));
    expect(bar.getAttribute("aria-label")).toBe(
      "At review, started by nightly, 09:58, running for 1m 12s",
    );

    reportOnScreen(bar, true);
    expect(bar.getAttribute("aria-label")).toBe(
      "At review, started by nightly, 09:58, running for 1m 22s",
    );
    expect(vi.getTimerCount()).toBe(1);
  });
});

/** Builds the bar of the run `runId`, in `state`, otherwise as `LIVE_BAR`. */
const buildBar = (runId: string, state: RunRow["state"]): TimelineBar => ({
  ...LIVE_BAR,
  row: { ...LIVE_BAR.row, id: runId, state },
});

/**
 * Draws the lanes of a day with `bars` on them, and returns a function that
 * draws the same lanes again with other bars, as a push does.
 */
const renderLanes = (
  bars: ReadonlyArray<TimelineBar>,
): ((bars: ReadonlyArray<TimelineBar>) => void) => {
  stubIntersectionObserver();
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory(),
  });
  const buildLanes = (shown: ReadonlyArray<TimelineBar>): JSX.Element => (
    <RouterContextProvider router={router}>
      <TimelineLanes
        label="Runs, Today"
        hours={[]}
        now={null}
        bars={shown}
        trackCount={1}
        fires={[]}
        emptyText="No runs today"
        timezone="UTC"
      />
    </RouterContextProvider>
  );
  const { rerender } = render(buildLanes(bars));
  return (next) => {
    rerender(buildLanes(next));
  };
};

/** Returns, for each bar drawn, whether it carries the class `name`. */
const readBarClass = (name: string): boolean[] =>
  screen.getAllByRole("link").map((bar) => bar.classList.contains(name));

describe("the lanes' arrival", () => {
  it("plays the arrival for only the first eight bars of the first drawing, in order", () => {
    const bars = Array.from({ length: 10 }, (_, index) => buildBar(`run-${String(index)}`, "done"));
    renderLanes(bars);

    expect(readBarClass("is-arriving")).toEqual([...Array<boolean>(8).fill(true), false, false]);
    expect(screen.getAllByRole("link").map((bar) => bar.style.getPropertyValue("--order"))).toEqual(
      ["0", "1", "2", "3", "4", "5", "6", "7", "", ""],
    );
  });

  it("pops no bar's mark when the lanes first draw", () => {
    renderLanes([buildBar("run-1", "working"), buildBar("run-2", "done")]);

    expect(readBarClass("is-new")).toEqual([false, false]);
  });

  it("pops a bar's mark when its run arrives or changes after the first drawing", () => {
    const redraw = renderLanes([buildBar("run-1", "working"), buildBar("run-2", "done")]);

    redraw([buildBar("run-3", "working"), buildBar("run-1", "done"), buildBar("run-2", "done")]);

    expect(readBarClass("is-new")).toEqual([true, true, false]);
    // A bar a later drawing sorts into the first places never starts an arrival.
    expect(readBarClass("is-arriving")).toEqual([false, false, true]);
  });

  it("draws a new mark each time a bar's run changes, so its pop plays again", () => {
    const redraw = renderLanes([buildBar("run-1", "working")]);

    redraw([buildBar("run-1", "waiting")]);
    const waitingMark = screen.getByRole("link").querySelector(".mark");
    redraw([buildBar("run-1", "done")]);
    const doneMark = screen.getByRole("link").querySelector(".mark");

    expect(doneMark?.classList.contains("mark--done")).toBe(true);
    expect(doneMark).not.toBe(waitingMark);
  });
});

describe("the lanes with Reduce motion on", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records no arrival and no change, so turning Reduce motion off plays nothing", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) => ({ matches: query === "(prefers-reduced-motion: reduce)" }) as MediaQueryList,
    );
    const redraw = renderLanes([buildBar("run-1", "working")]);

    redraw([buildBar("run-1", "done"), buildBar("run-2", "working")]);

    expect(screen.getByRole("group").classList.contains("is-arriving")).toBe(false);
    expect(readBarClass("is-arriving")).toEqual([false, false]);
    expect(readBarClass("is-new")).toEqual([false, false]);
  });
});

describe("the end of the lanes' motion", () => {
  it("keeps the motion while an animation still plays, and drops it once none does", () => {
    const setPlaying = stubCssAnimations();
    const redraw = renderLanes([buildBar("run-1", "working"), buildBar("run-2", "done")]);
    redraw([buildBar("run-1", "done"), buildBar("run-2", "done")]);
    const lanes = screen.getByRole("group");

    setPlaying(true);
    fireEvent.animationEnd(lanes);
    expect(lanes.classList.contains("is-arriving")).toBe(true);
    expect(readBarClass("is-new")).toEqual([true, false]);

    setPlaying(false);
    fireEvent.animationEnd(lanes);
    // A bar the lanes then move in the page has no class left to play again.
    expect(lanes.classList.contains("is-arriving")).toBe(false);
    expect(readBarClass("is-arriving")).toEqual([false, false]);
    expect(readBarClass("is-new")).toEqual([false, false]);
  });
});
