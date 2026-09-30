import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { buildThreadBlocks, type Pose } from "@hercule/client-core";
import {
  buildNextRows,
  RUNNING_ITEM_ID,
  setVisibility,
  stubElementSize,
  THREAD_FIXTURES,
} from "../../app/testing";
import { Transcript } from "./transcript";

const THREAD = THREAD_FIXTURES.running;

/**
 * The running thread once its agent has finished the message and runs a
 * command: a stretch of work that is still going, whose label counts.
 */
const ROWS = [
  ...THREAD.transcript,
  ...buildNextRows(
    THREAD,
    {
      _tag: "item.completed",
      turnId: "turn-1",
      itemId: RUNNING_ITEM_ID,
      kind: "assistant_message",
      status: "completed",
    },
    {
      _tag: "item.started",
      turnId: "turn-1",
      itemId: "turn-1-fix-test",
      kind: "command_execution",
      detail: { command: "bun test test/webhooks" },
    },
  ),
];

/** When the command started: `buildNextRows` gives the new rows the last row's time. */
const COMMAND_STARTED_AT = Date.parse(THREAD.transcript.at(-1)!.at);

beforeEach(() => {
  vi.useFakeTimers({
    now: COMMAND_STARTED_AT + 12_000,
    toFake: ["setTimeout", "clearTimeout", "Date"],
  });
  stubElementSize(800, 800);
});

afterEach(() => {
  setVisibility("visible");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Transcript", () => {
  it("counts a live stretch on the one shared timer, and on none while the window is hidden", () => {
    render(
      <Transcript
        sessionId={THREAD.session.id}
        blocks={buildThreadBlocks(ROWS, THREAD.session)}
        pose="working"
        describeAgent={() => "Claude Code · Claude Sonnet 5"}
        attachOpenParagraph={() => undefined}
        composerStack={null}
        onBottomChange={() => {}}
      />,
    );
    const divider = screen.getByRole("button", { name: /^Working for/ });
    expect(divider.getAttribute("aria-label")).toBe("Working for 12s, ran 1 command");
    // The stretch's label and the transcript's watch for midnight, after which
    // a message's time also shows its date, share the age clock's one timer.
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(divider.getAttribute("aria-label")).toBe("Working for 13s, ran 1 command");
    expect(vi.getTimerCount()).toBe(1);

    setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(COMMAND_STARTED_AT + 73_000);
    // Shown again, the label catches up at once, and counts on.
    setVisibility("visible");
    expect(divider.getAttribute("aria-label")).toBe("Working for 1m 13s, ran 1 command");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("animates the live row's face only while the thread works", () => {
    const blocks = buildThreadBlocks(ROWS, THREAD.session);
    // No message holds the face while the command runs, so the live row does.
    expect(blocks.at(-1)?.kind).toBe("live");
    const renderTranscript = (pose: Pose) => (
      <Transcript
        sessionId={THREAD.session.id}
        blocks={blocks}
        pose={pose}
        describeAgent={() => "Claude Code · Claude Sonnet 5"}
        attachOpenParagraph={() => undefined}
        composerStack={null}
        onBottomChange={() => {}}
      />
    );
    const { container, rerender } = render(renderTranscript("working"));
    const animated = [...container.querySelectorAll(".cr--animated")];
    expect(animated.map((face) => face.closest(".msg")?.textContent)).toEqual([
      "Claude Code · Claude Sonnet 5",
    ]);

    rerender(renderTranscript("waiting"));
    expect(container.querySelector(".cr--animated")).toBeNull();
  });
});
