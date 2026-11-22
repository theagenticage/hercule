/**
 * Whether a thread's transcript has shown a line about MCP servers. Part of
 * the first screen: it imports only the check on the blocks.
 */
import { useState } from "react";
import type { ThreadBlock } from "@hercule/client-core";
import { hasMcpServerBlock } from "@hercule/client-core/mcp-servers/first-screen";

/**
 * Returns whether the thread `sessionId` has shown a line about MCP servers.
 * Returns `false` for a `sessionId` of `null`.
 *
 * The answer only goes from false to true, because a transcript only grows.
 * So the blocks are scanned until a line is found, and never again after
 * that: a thread that streams a long answer does not pay a scan for every row
 * the stream delivers. The latch names its thread, since the page that holds
 * it is drawn again with the next thread's blocks.
 */
export function useHasMcpLine(sessionId: string | null, blocks: readonly ThreadBlock[]): boolean {
  const [foundIn, setFoundIn] = useState<string | null>(null);
  if (sessionId === null) return false;
  if (foundIn === sessionId) return true;
  const found = hasMcpServerBlock(blocks);
  // Written during the render, so the latch holds from the next one.
  if (found) setFoundIn(sessionId);
  return found;
}
