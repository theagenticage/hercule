/**
 * Tests what a Tracking row lets the user do: which states have Mark done, and
 * what a press on the row and on Mark done hand back.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { TrackingState } from "@hercule/client-core";
import { TrackingRowItem, type TrackingRowFacts } from "./tracking-row";

/** Builds the facts of a row of Tracking in `state`. */
const buildFacts = (state: TrackingState): TrackingRowFacts => ({
  taskId: "task-1",
  title: "Rate-limit the public API",
  state,
  faceSeed: "workflow-1",
  workflowName: "Review PR",
  lineText: "finished",
  since: "2026-09-29T09:20:00.000Z",
  handoffSignalIds: [],
});

const renderRow = (state: TrackingState) => {
  const onOpen = vi.fn();
  const onMarkDone = vi.fn();
  render(
    <TrackingRowItem
      facts={buildFacts(state)}
      selected={false}
      onOpen={onOpen}
      onMarkDone={onMarkDone}
    />,
  );
  return { onOpen, onMarkDone };
};

describe("TrackingRowItem", () => {
  it.each<[TrackingState, boolean]>([
    ["failed", true],
    ["finished", true],
    ["stopped", true],
    ["working", false],
  ])("%s: Mark done is drawn: %s", (state, drawn) => {
    renderRow(state);
    expect(screen.queryByRole("button", { name: "Mark done" }) !== null).toBe(drawn);
  });

  it("hands the Task's id back on a press on the row and on Mark done", async () => {
    const { onOpen, onMarkDone } = renderRow("finished");
    await userEvent.click(screen.getByRole("button", { name: /Rate-limit the public API/ }));
    await userEvent.click(screen.getByRole("button", { name: "Mark done" }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("task-1");
    expect(onMarkDone).toHaveBeenCalledExactlyOnceWith("task-1");
  });
});
