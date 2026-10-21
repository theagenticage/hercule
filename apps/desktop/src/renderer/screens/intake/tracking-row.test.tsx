/**
 * Tests what a Tracking row lets the user do: which states have Mark done, and
 * what a press on the row and on Mark done hand back.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { TrackingState } from "@hercule/client-core";
import { TrackingRowItem, type TrackingRowFacts } from "./tracking-row";

// The row draws its time through `AgeLabel`, which draws once each time the row does.
const { ageLabelDrawn } = vi.hoisted(() => ({ ageLabelDrawn: vi.fn() }));
vi.mock("../age-label", () => ({
  AgeLabel: () => {
    ageLabelDrawn();
    return null;
  },
}));

/** Builds the facts of a row of Tracking in `state`, with a Mark done control when `canMarkDone`. */
const buildFacts = (state: TrackingState, canMarkDone: boolean): TrackingRowFacts => ({
  taskId: "task-1",
  title: "Rate-limit the public API",
  state,
  canMarkDone,
  faceSeed: "workflow-1",
  workflowName: "Review PR",
  lineText: "finished",
  since: "2026-09-29T09:20:00.000Z",
});

const renderRow = (state: TrackingState, canMarkDone: boolean) => {
  const onOpen = vi.fn();
  const onMarkDone = vi.fn();
  render(
    <TrackingRowItem
      {...buildFacts(state, canMarkDone)}
      selected={false}
      onScreen
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
    ["needs-you", true],
    ["working", false],
    ["needs-you", false],
  ])(
    "%s with canMarkDone %s: Mark done is drawn only when it can be marked done",
    (state, canMarkDone) => {
      renderRow(state, canMarkDone);
      expect(screen.queryByRole("button", { name: "Mark done" }) !== null).toBe(canMarkDone);
    },
  );

  it("hands the Task's id back on a press on the row and on Mark done", async () => {
    const { onOpen, onMarkDone } = renderRow("finished", true);
    await userEvent.click(screen.getByRole("button", { name: /Rate-limit the public API/ }));
    await userEvent.click(screen.getByRole("button", { name: "Mark done" }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("task-1");
    expect(onMarkDone).toHaveBeenCalledExactlyOnceWith("task-1");
  });

  it("is not drawn again when its list is built again with the same facts", () => {
    const props = { selected: false, onScreen: true, onOpen: vi.fn(), onMarkDone: vi.fn() };
    const drawRow = (title: string) => (
      <TrackingRowItem {...buildFacts("finished", true)} title={title} {...props} />
    );
    ageLabelDrawn.mockClear();
    const { rerender } = render(drawRow("Rate-limit the public API"));
    rerender(drawRow("Rate-limit the public API"));
    expect(ageLabelDrawn).toHaveBeenCalledTimes(1);
    rerender(drawRow("Rate-limit the admin API"));
    expect(ageLabelDrawn).toHaveBeenCalledTimes(2);
  });
});
