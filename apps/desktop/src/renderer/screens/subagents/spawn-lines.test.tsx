/**
 * Tests the spawn lines under a work stretch: what one line draws, where it
 * links, that only a running subagent's duration counts, and that they draw
 * again only when something they draw changes.
 */
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { queryKeys, type ThreadItem } from "@hercule/client-core";
import type { Session } from "@hercule/contract";
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

  it("draw again when a request opens, but not when only the session's usage changes", async () => {
    let commits = 0;
    const { queryClient } = await renderThreadPart(
      ({ sessionId }) => (
        <Profiler id="spawn-lines" onRender={() => (commits += 1)}>
          <SpawnLines
            sessionId={sessionId}
            agentSubagentId={undefined}
            items={[SPAWN_ITEM]}
            onScreen
          />
        </Profiler>
      ),
      { thread: THREAD },
    );
    const sessionKey = queryKeys.session(THREAD.session.id);
    const state = () => document.querySelector(".spawn-line-state")!.textContent;
    expect(state()).toMatch(/^working/);
    const commitsAfterMount = commits;
    // Query tells its readers on a timer, so the write waits one turn of it.
    const writeSession = (change: (session: Session) => Session) =>
      act(async () => {
        queryClient.setQueryData<Session>(sessionKey, (session) => change(session!));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

    // The controller reads the session again about once a second while a turn
    // runs, and each read is a new object. Only the counters differ here.
    await writeSession((session) => ({
      ...session,
      toolCalls: session.toolCalls + 1,
      usage: { inputTokens: 1200, outputTokens: 300 },
    }));
    expect(commits).toBe(commitsAfterMount);

    await writeSession((session) => ({
      ...session,
      openRequests: [
        {
          requestId: "req-sub",
          itemId: "tool-sub",
          kind: "command_approval",
          decisions: ["allow", "deny"],
          detail: { command: "git push" },
          subagentId: FIXTURE_SUBAGENT.id,
        },
      ],
    }));
    await waitFor(() => expect(state()).toMatch(/^waiting/));
    // One redraw across both writes: the usage-only write caused none.
    expect(commits).toBe(commitsAfterMount + 1);
  });
});
