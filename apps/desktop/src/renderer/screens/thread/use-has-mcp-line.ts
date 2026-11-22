/**
 * Whether a thread's transcript has shown a line about MCP servers. Part of
 * the first screen: it imports only the check on the blocks.
 */
import { useState } from "react";
import type { ThreadBlock } from "@hercule/client-core";
import { hasMcpServerBlock } from "@hercule/client-core/mcp-servers/first-screen";

/** How far one thread's blocks have been scanned, and whether a line was found. */
interface Scan {
  readonly sessionId: string;
  readonly scanned: number;
  readonly found: boolean;
}

/**
 * Returns whether the thread `sessionId` has shown a line about MCP servers.
 * Returns `false` for a `sessionId` of `null`.
 *
 * A transcript only grows, so each render looks only at the blocks added since
 * the last one, and never again after a line is found. A thread that streams
 * a long answer pays for its new rows, not for the whole transcript each time.
 * The scan names its thread, since the page that holds it is drawn again with
 * the next thread's blocks. If the blocks come back shorter than what was
 * scanned, the transcript was replaced and the scan starts again (unless a line was already found).
 */
export function useHasMcpLine(sessionId: string | null, blocks: readonly ThreadBlock[]): boolean {
  const [scan, setScan] = useState<Scan | null>(null);
  if (sessionId === null) return false;
  let current = scan;
  if (current?.sessionId !== sessionId || (!current.found && blocks.length < current.scanned)) {
    current = { sessionId, scanned: 0, found: false };
  }
  if (!current.found && current.scanned < blocks.length) {
    current = {
      sessionId,
      scanned: blocks.length,
      found: hasMcpServerBlock(blocks.slice(current.scanned)),
    };
  }
  // Written during the render, so the next render of this thread starts from here.
  if (current !== scan) setScan(current);
  return current.found;
}
