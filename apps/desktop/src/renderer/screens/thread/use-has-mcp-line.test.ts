import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ThreadBlock } from "@hercule/client-core";
import { useHasMcpLine } from "./use-has-mcp-line";

// Counts the blocks the hook examines, by wrapping the check it calls.
const examined = vi.hoisted(() => ({ blocks: 0 }));
vi.mock("@hercule/client-core/mcp-servers/first-screen", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@hercule/client-core/mcp-servers/first-screen")>();
  return {
    ...original,
    hasMcpServerBlock: (blocks: readonly ThreadBlock[]) => {
      examined.blocks += blocks.length;
      return original.hasMcpServerBlock(blocks);
    },
  };
});

beforeEach(() => {
  examined.blocks = 0;
});

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

  it("examines each block once across renders of a thread with no line about servers", () => {
    const plain = (n: number): ThreadBlock => ({ ...PLAIN, key: `warning:plain-${n}` });
    const { rerender } = renderHook(({ blocks }) => useHasMcpLine("session-1", blocks), {
      initialProps: { blocks: [plain(1), plain(2)] },
    });
    expect(examined.blocks).toBe(2);

    rerender({ blocks: [plain(1), plain(2)] });
    expect(examined.blocks).toBe(2);

    rerender({ blocks: [plain(1), plain(2), plain(3), plain(4), plain(5)] });
    expect(examined.blocks).toBe(5);

    rerender({ blocks: [plain(1), plain(2), plain(3), plain(4), plain(5)] });
    expect(examined.blocks).toBe(5);
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
    const { result, rerender } = renderHook<
      boolean,
      { sessionId: string | null; blocks: readonly ThreadBlock[] }
    >(({ sessionId, blocks }) => useHasMcpLine(sessionId, blocks), {
      initialProps: { sessionId: "session-1", blocks: [ABOUT_SERVERS] },
    });
    expect(result.current).toBe(true);

    rerender({ sessionId: "session-2", blocks: [PLAIN] });
    expect(result.current).toBe(false);

    rerender({ sessionId: null, blocks: [ABOUT_SERVERS] });
    expect(result.current).toBe(false);
  });
});
