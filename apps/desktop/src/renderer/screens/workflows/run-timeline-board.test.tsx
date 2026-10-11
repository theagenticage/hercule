/**
 * Tests the timeline's day stepper: its buttons never drop the focus, the
 * step on cannot act on today nor the step back on the oldest day, and
 * "Today" shows only away from today. Then tests that a bar keeps its times
 * current on the age clock only while it is on screen.
 */
import { useState, type JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TimelineBar } from "@hercule/client-core/run-timeline";
import { stubIntersectionObserver } from "../../app/testing";
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

/** Draws the lanes of a day with `LIVE_BAR` on them, and returns the bar. */
const renderLiveBar = (): HTMLElement => {
  render(
    <TimelineLanes
      label="Runs, Today"
      hours={[]}
      now={null}
      bars={[LIVE_BAR]}
      trackCount={1}
      fires={[]}
      emptyText="No runs today"
      timezone="UTC"
    />,
  );
  return screen.getByRole("img");
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
