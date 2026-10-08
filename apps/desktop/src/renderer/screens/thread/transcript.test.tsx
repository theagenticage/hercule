import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { buildSessionAgentState, buildThreadBlocks, type Pose } from "@hercule/client-core";
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
    THREAD.session.id,
    THREAD.transcript,
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
        faceSeed={THREAD.session.id}
        blocks={buildThreadBlocks(ROWS, buildSessionAgentState(THREAD.session))}
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
    // The turn has started and no step or message has followed the user's
    // message yet: no message holds the face and no divider shows, so the
    // live row does.
    const rowsBeforeFirstStep = THREAD.transcript.slice(
      0,
      THREAD.transcript.findIndex(
        (row) => "itemId" in row.event && row.event.itemId === "turn-1-rerun",
      ),
    );
    const blocks = buildThreadBlocks(rowsBeforeFirstStep, buildSessionAgentState(THREAD.session));
    expect(blocks.at(-1)?.kind).toBe("live");
    const renderTranscript = (pose: Pose) => (
      <Transcript
        faceSeed={THREAD.session.id}
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

  it("draws the lead first, as the column's first item, so it scrolls with the blocks", () => {
    const blocks = buildThreadBlocks(ROWS, buildSessionAgentState(THREAD.session));
    const { container } = render(
      <Transcript
        faceSeed={THREAD.session.id}
        blocks={blocks}
        lead={<p className="test-lead">The brief</p>}
        pose="working"
        describeAgent={() => "Claude Code · Claude Sonnet 5"}
        attachOpenParagraph={() => undefined}
        composerStack={null}
        onBottomChange={() => {}}
      />,
    );
    const items = [...container.querySelectorAll(".column.tx > .tx-item")];
    expect(items[0]!.getAttribute("data-index")).toBe("0");
    expect(items[0]!.textContent).toBe("The brief");
    // The first block follows the lead in the same scrolling column.
    expect(items[1]!.getAttribute("data-index")).toBe("1");
    expect(items[1]!.querySelector(".test-lead")).toBeNull();
    expect(items).toHaveLength(blocks.length + 1);
  });

  it("draws what renderSpawnLines returns under a stretch of work, given its items", () => {
    const seen: string[][] = [];
    render(
      <Transcript
        faceSeed={THREAD.session.id}
        blocks={buildThreadBlocks(ROWS, buildSessionAgentState(THREAD.session))}
        pose="working"
        describeAgent={() => "Claude Code · Claude Sonnet 5"}
        attachOpenParagraph={() => undefined}
        composerStack={null}
        onBottomChange={() => {}}
        renderSpawnLines={(items, onScreen) => {
          seen.push(items.map((item) => item.itemId));
          return <p>Spawn lines {onScreen ? "on screen" : "off screen"}</p>;
        }}
      />,
    );
    // The live stretch gets its own lines, drawn after its divider.
    const divider = screen.getByRole("button", { name: /^Working for/ });
    const lines = within(divider.closest(".tx-item")!).getByText(/^Spawn lines/);
    expect(lines.textContent).toBe("Spawn lines on screen");
    expect(divider.compareDocumentPosition(lines) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(seen).toContainEqual(["turn-1-fix-test"]);
  });
});
