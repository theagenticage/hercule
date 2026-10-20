/**
 * Tests the words folded and opened Tracking show: the counts, how many wait
 * on the user, and the line of an empty Tracking.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { stubElementSize } from "../../app/testing";
import { TrackingFold } from "./tracking-fold";
import type { TrackingRowFacts } from "./tracking-row";
import { TrackingSheet } from "./tracking-sheet";

const ROW: TrackingRowFacts = {
  taskId: "task-1",
  title: "Rate-limit the public API",
  state: "finished",
  faceSeed: "workflow-1",
  workflowName: "Review PR",
  lineText: "finished",
  since: "2026-09-29T09:20:00.000Z",
  handoffSignalIds: [],
};

const nothing = (): void => undefined;

// jsdom lays nothing out, and the sheet's virtual list draws only what fits its height.
beforeEach(() => {
  stubElementSize(400, 800);
});

describe("TrackingFold", () => {
  it("says what Tracking is for when nothing is handed off, and offers no way to open it", () => {
    render(
      <TrackingFold
        total={0}
        waitingCount={0}
        rows={[]}
        selectedTaskId={null}
        onOpen={nothing}
        onOpenRow={nothing}
        onMarkDone={nothing}
      />,
    );
    expect(
      screen.getByText("Hand a signal to an agent, and follow it here until you mark it done."),
    ).toBeTruthy();
    expect(screen.queryByText("Show all")).toBeNull();
  });

  it("shows how many rows there are and how many wait on the user", () => {
    render(
      <TrackingFold
        total={7}
        waitingCount={1}
        rows={[ROW]}
        selectedTaskId={null}
        onOpen={nothing}
        onOpenRow={nothing}
        onMarkDone={nothing}
      />,
    );
    expect(screen.getByRole("heading", { name: /Tracking\s*7/ })).toBeTruthy();
    expect(screen.getByText("1 waits on you")).toBeTruthy();
  });
});

describe("TrackingSheet", () => {
  it("heads each state's rows with its word and count, and says how many wait", () => {
    render(
      <TrackingSheet
        total={3}
        waitingCount={3}
        groups={[{ state: "finished", rows: [ROW, { ...ROW, taskId: "task-2" }] }]}
        selectedTaskId={null}
        signalCount={5}
        signalMarks={null}
        onClose={nothing}
        onOpenRow={nothing}
        onMarkDone={nothing}
      />,
    );
    expect(screen.getByRole("heading", { name: /Finished\s*2/ })).toBeTruthy();
    expect(screen.getByText("3 wait on you")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Signals\s*5/ })).toBeTruthy();
  });
});
