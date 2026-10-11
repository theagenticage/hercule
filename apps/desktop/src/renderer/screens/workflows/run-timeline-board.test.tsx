/**
 * Tests the timeline's day stepper: its buttons never drop the focus, the
 * step on cannot act on today nor the step back on the oldest day, and
 * "Today" shows only away from today.
 */
import { useState, type JSX } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimelineDayStepper } from "./run-timeline-board";

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
