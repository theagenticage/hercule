/**
 * Whether a thread has shown a line about MCP servers. It reads no server, so
 * the first screen can use it.
 */
import { useState } from "react";
import type { ThreadBlock } from "@hercule/client-core";
import { hasMcpServerBlock } from "@hercule/client-core/mcp-servers";

/**
 * Checks whether the thread's blocks hold a runtime warning about MCP
 * servers, the line that carries the buttons. Such a thread reads the servers
 * when it opens, even with an empty list, because the line names servers.
 *
 * The answer only goes from false to true, because a transcript only grows.
 * So the blocks are scanned until a line is found, and never again after
 * that: a thread that streams a long answer does not pay a scan for every row
 * the stream delivers. The latch names its thread, since the page that
 * holds it is drawn again with the next thread's blocks.
 */
export function useHasMcpServerLine(sessionId: string, blocks: readonly ThreadBlock[]): boolean {
  const [foundIn, setFoundIn] = useState<string | null>(null);
  if (foundIn === sessionId) return true;
  const found = hasMcpServerBlock(blocks);
  // Written during the render, so the latch holds from the next one.
  if (found) setFoundIn(sessionId);
  return found;
}
