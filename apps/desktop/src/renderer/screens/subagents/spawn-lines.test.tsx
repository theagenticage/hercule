/**
 * Tests the spawn lines under a work stretch: what one line draws, where it
 * links, and that only a running subagent's duration counts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import type { ThreadItem } from "@hercule/client-core";
import { FIXTURE_SUBAGENT, THREAD_FIXTURES, type ThreadRecords } from "../../app/testing";
import { renderThreadPart } from "../thread/testing";
import { SpawnLines } from "./spawn-lines";

afterEach(() => {
  vi.useRealTimers();
});

const THREAD = THREAD_FIXTURES.delegating;

/** The work stretch's item that started `FIXTURE_SUBAGENT`. */
const SPAWN_ITEM: ThreadItem = {
  itemId: "turn-1-delegate",
  kind: "subagent",
  verb: "Started",
  target: "Find the flaky webhook test",
  result: "running",
};

/** Renders the spawn lines of a stretch holding `items`, on screen, on `thread`. */
const renderLines = (items: readonly ThreadItem[], thread: ThreadRecords = THREAD) =>
  renderThreadPart(
    ({ sessionId }) => (
      <SpawnLines sessionId={sessionId} agentSubagentId={undefined} items={items} onScreen />
    ),
    { thread },
  );

describe("the spawn lines", () => {
  it("draw a started subagent's face, name and state, linking to its page, and count its duration", async () => {
    vi.useFakeTimers({
      now: new Date("2026-09-10T09:04:00.000Z"),
      toFake: ["Date", "setTimeout", "clearTimeout"],
    });
    await renderLines([SPAWN_ITEM]);

    const list = screen.getByRole("list", { name: "Subagents started here" });
    const link = within(list).getByRole("link");
    expect(link.getAttribute("href")).toBe(
      `/threads/${THREAD.session.id}/subagents/${FIXTURE_SUBAGENT.id}`,
    );
    expect(link.querySelector(".cr")).not.toBeNull();
    // A spawn line's face is still: only the open page's running face moves.
    expect(link.querySelector(".cr--animated")).toBeNull();
    expect(link.querySelector(".spawn-line-name")!.textContent).toBe("Find the flaky webhook test");
    const state = link.querySelector(".spawn-line-state")!;
    expect(state.textContent).toMatch(/^working · 20s$/);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(state.textContent).toMatch(/^working · 21s$/);
  });

  it("do not count an ended subagent's duration", async () => {
    vi.useFakeTimers({
      now: new Date("2026-09-10T09:10:00.000Z"),
      toFake: ["Date", "setTimeout", "clearTimeout"],
    });
    await renderLines([{ ...SPAWN_ITEM, result: "completed" }], {
      ...THREAD,
      subagents: [
        { ...FIXTURE_SUBAGENT, status: "completed", endedAt: "2026-09-10T09:04:00.000Z" },
      ],
    });
    const state = document.querySelector(".spawn-line-state")!;
    const before = state.textContent;
    expect(before).toMatch(/· 20s/);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(state.textContent).toBe(before);
  });

  it("draw nothing for a stretch that started no subagent", async () => {
    await renderLines([{ ...SPAWN_ITEM, itemId: "turn-1-command", kind: "command_execution" }]);

    expect(screen.queryByRole("list", { name: "Subagents started here" })).toBeNull();
  });
});
