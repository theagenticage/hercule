import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ThreadBlock } from "@hercule/client-core";
import { useHasMcpLine } from "./use-has-mcp-line";

const PLAIN: ThreadBlock = {
  kind: "warning",
  key: "warning:1",
  message: "Retrying.",
  at: "2026-11-20T09:00:00.000Z",
};
const ABOUT_SERVERS: ThreadBlock = {
  ...PLAIN,
  key: "warning:2",
  mcpServers: [{ mcpServerId: "server-1", reason: "unreachable" }],
};

describe("useHasMcpLine", () => {
  it("is false for blocks with no line about servers, and true once one arrives", () => {
    const { result, rerender } = renderHook(({ blocks }) => useHasMcpLine("session-1", blocks), {
      initialProps: { blocks: [PLAIN] },
    });
    expect(result.current).toBe(false);

    rerender({ blocks: [PLAIN, ABOUT_SERVERS] });

    expect(result.current).toBe(true);
  });

  it("stays true for its thread without looking at the blocks again", () => {
    const { result, rerender } = renderHook(({ blocks }) => useHasMcpLine("session-1", blocks), {
      initialProps: { blocks: [ABOUT_SERVERS] },
    });
    expect(result.current).toBe(true);

    // The blocks are not read any more: a transcript only grows, so what they hold now is not asked.
    rerender({ blocks: [] });

    expect(result.current).toBe(true);
  });

  it("starts again for another thread, and is false for no thread", () => {
    const { result, rerender } = renderHook(
      ({ sessionId, blocks }: { sessionId: string | null; blocks: readonly ThreadBlock[] }) =>
        useHasMcpLine(sessionId, blocks),
      {
        initialProps: {
          sessionId: "session-1" as string | null,
          blocks: [ABOUT_SERVERS] as readonly ThreadBlock[],
        },
      },
    );
    expect(result.current).toBe(true);

    rerender({ sessionId: "session-2", blocks: [PLAIN] });
    expect(result.current).toBe(false);

    rerender({ sessionId: null, blocks: [ABOUT_SERVERS] });
    expect(result.current).toBe(false);
  });
});
