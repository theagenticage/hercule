/**
 * Tests how a runtime note draws: the command in its message keeps each word
 * whole, except a word too long to always fit a line, which is left as plain
 * text so it can break anywhere; and the text for a screen reader names the
 * severity.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { TranscriptRow } from "@hercule/contract";
import { buildTurns, type RuntimeNote } from "@hercule/client-core";
import { RuntimeNoteLine } from "./runtime-note-line";

afterEach(cleanup);

const buildRuntimeNote = (
  message: string,
  severity: RuntimeNote["severity"] = "error",
): RuntimeNote => ({
  key: `runtime.${severity}:0`,
  severity,
  message,
  at: "2026-09-08T10:00:00.000Z",
});

describe("RuntimeNoteLine", () => {
  it("keeps the words of a command whole, except a word too long to always fit a line", () => {
    const path = `/home/${"very-long-directory-name-".repeat(7)}file.ts`;
    const { container } = render(
      <RuntimeNoteLine note={buildRuntimeNote(`Could not read \`cat ${path}\`.`)} />,
    );

    const code = container.querySelector("code")!;
    expect(code.textContent).toBe(`cat ${path}`);
    expect([...code.querySelectorAll("span")].map((word) => word.textContent)).toEqual(["cat"]);
  });

  it("draws no code for an unknown event whose type holds backticks", () => {
    const at = "2026-09-08T10:00:00.000Z";
    const row: TranscriptRow = {
      position: 1,
      at,
      event: {
        _tag: "unknown",
        eventId: "n1",
        sessionId: "session-1",
        at,
        originalType: "turn.`plan`.updated",
        payload: {},
      },
    };
    const { outsideRuntimeNotes } = buildTurns([row], {
      working: false,
      mayBeRunningTurn: false,
      openRequests: [],
      model: "claude-sonnet-5",
      isSubagent: false,
    });

    const { container } = render(<RuntimeNoteLine note={outsideRuntimeNotes[0]!} />);

    expect(container.querySelector("code")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe(
      "Notice: Unknown event: turn.plan.updated",
    );
  });

  it.each([
    ["error", "Error: "],
    ["warning", "Warning: "],
    ["notice", "Notice: "],
  ] as const)("tells a screen reader a %s note is a %s", (severity, label) => {
    const { container } = render(
      <RuntimeNoteLine note={buildRuntimeNote("Unknown event: turn.plan.updated", severity)} />,
    );

    expect(container.querySelector(".sr-only")?.textContent).toBe(label);
    expect(container.querySelector("p")?.textContent).toBe(
      `${label}Unknown event: turn.plan.updated`,
    );
  });
});

describe("RuntimeNoteLine: tone", () => {
  it("draws a warning in the failure colour when its tone is fail, and a screen reader still hears a warning", () => {
    const { container } = render(
      <RuntimeNoteLine
        note={buildRuntimeNote("MCP servers were left out.", "warning")}
        tone="fail"
      />,
    );

    expect(container.firstElementChild?.className).toContain("text-fail");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Warning: ");
  });

  it("keeps a warning quiet by default, and an error in the failure colour", () => {
    const quiet = render(<RuntimeNoteLine note={buildRuntimeNote("Retrying.", "warning")} />);
    expect(quiet.container.firstElementChild?.className).toContain("text-muted");
    cleanup();

    const failed = render(<RuntimeNoteLine note={buildRuntimeNote("It broke.", "error")} />);
    expect(failed.container.firstElementChild?.className).toContain("text-fail");
  });
});
