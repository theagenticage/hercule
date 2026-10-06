/**
 * Tests the tally pill: what it counts, and that a click shows the
 * subagents in the thread's side pane and a second click hides the pane.
 */
import { afterEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FIXTURE_SUBAGENT, THREAD_FIXTURES, type ThreadRecords } from "../../app/testing";
import { renderThreadPart } from "../thread/testing";
import { TallyPill } from "./tally-pill";
import { forgetSidePaneLayouts, useSidePaneLayout } from "./use-side-pane";

afterEach(() => {
  forgetSidePaneLayouts();
});

const THREAD = THREAD_FIXTURES.delegating;

/** Renders the pill, and beside it the surface the thread's side pane shows, or "closed". */
const renderPill = (thread: ThreadRecords = THREAD) =>
  renderThreadPart(
    function PillAndPane({ sessionId }) {
      const { layout } = useSidePaneLayout(sessionId);
      return (
        <>
          <TallyPill sessionId={sessionId} />
          <output>{layout.open ? layout.shown : "closed"}</output>
        </>
      );
    },
    { thread },
  );

describe("the tally pill", () => {
  it("counts the running subagents, and opens the side pane on the Subagents surface", async () => {
    const user = userEvent.setup();
    await renderPill();
    const pill = screen.getByRole("button", { name: /^Subagents/ });
    expect(pill.textContent).toBe("Subagents1 of 1 running");
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    expect(pill.title).toBe("Show the subagents in the side pane");
    expect(screen.getByRole("status").textContent).toBe("closed");

    await user.click(pill);

    expect(screen.getByRole("status").textContent).toBe("subagents");
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    expect(pill.title).toBe("Hide the side pane");

    await user.click(pill);

    expect(screen.getByRole("status").textContent).toBe("closed");
  });

  it("counts every subagent once none runs", async () => {
    await renderPill({
      ...THREAD,
      subagents: [
        { ...FIXTURE_SUBAGENT, status: "completed", endedAt: "2026-09-10T09:04:00.000Z" },
      ],
    });

    expect(screen.getByRole("button", { name: /^Subagents/ }).textContent).toBe("Subagents1");
  });

  it("draws nothing while the thread has no subagent", async () => {
    await renderPill(THREAD_FIXTURES.running);

    expect(screen.queryByRole("button", { name: /^Subagents/ })).toBeNull();
  });
});
