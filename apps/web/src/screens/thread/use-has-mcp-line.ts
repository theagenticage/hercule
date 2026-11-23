import { useState } from "react";
import type { RuntimeNote } from "@hercule/client-core";
import { hasMcpServerLine } from "@hercule/client-core/mcp-servers/first-screen";

/**
 * Returns whether the agent page `pageKey` has shown a line about MCP servers
 * in its turns' runtime notes or in the notes outside every turn.
 *
 * The answer only goes from false to true, because a transcript only grows.
 * So the notes are scanned until a line is found, and never again after
 * that: a thread that streams a long answer does not pay a scan for every row
 * the stream delivers. The latch names its page, since the component that
 * holds it is drawn again with the next page's turns.
 */
export function useHasMcpLine(
  pageKey: string,
  transcript: {
    readonly turns: readonly { readonly runtimeNotes: readonly RuntimeNote[] }[];
    readonly outsideRuntimeNotes: readonly RuntimeNote[];
  },
): boolean {
  const [foundIn, setFoundIn] = useState<string | null>(null);
  if (foundIn === pageKey) return true;
  const found = hasMcpServerLine(transcript);
  // Written during the render, so the latch holds from the next one.
  if (found) setFoundIn(pageKey);
  return found;
}
