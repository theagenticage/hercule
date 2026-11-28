import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RuntimeNote } from "@hercule/client-core";
import { useHasMcpLine } from "./use-has-mcp-line";

const PLAIN: RuntimeNote = {
  key: "note-1",
  severity: "warning",
  message: "Retrying.",
  at: "2026-11-20T09:00:00.000Z",
};
const ABOUT_SERVERS: RuntimeNote = {
  ...PLAIN,
  key: "note-2",
  mcpServers: [{ mcpServerId: "server-1", reason: "unreachable" }],
};

const transcriptWith = (...outsideRuntimeNotes: RuntimeNote[]) => ({
  turns: [],
  outsideRuntimeNotes,
});

describe("useHasMcpLine", () => {
  it("is false for notes with no line about servers, and true once one arrives", () => {
    const { result, rerender } = renderHook(
      ({ transcript }) => useHasMcpLine("session-1/", transcript),
      { initialProps: { transcript: transcriptWith(PLAIN) } },
    );
    expect(result.current).toBe(false);

    rerender({ transcript: transcriptWith(PLAIN, ABOUT_SERVERS) });

    expect(result.current).toBe(true);
  });

  it("stays true for its page without looking at the notes again", () => {
    const { result, rerender } = renderHook(
      ({ transcript }) => useHasMcpLine("session-1/", transcript),
      { initialProps: { transcript: transcriptWith(ABOUT_SERVERS) } },
    );
    expect(result.current).toBe(true);

    // The notes are not read any more: a transcript only grows, so what they hold now is not asked.
    rerender({ transcript: transcriptWith() });

    expect(result.current).toBe(true);
  });

  it("starts again for another page", () => {
    const { result, rerender } = renderHook(
      ({ pageKey, transcript }) => useHasMcpLine(pageKey, transcript),
      { initialProps: { pageKey: "session-1/", transcript: transcriptWith(ABOUT_SERVERS) } },
    );
    expect(result.current).toBe(true);

    rerender({ pageKey: "session-1/subagent-1", transcript: transcriptWith(PLAIN) });

    expect(result.current).toBe(false);
  });
});
