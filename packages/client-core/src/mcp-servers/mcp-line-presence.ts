/**
 * Whether a thread's transcript holds a line about MCP Servers. The desktop
 * app's first screen asks it before anything else about servers has loaded, so
 * this file imports only types: nothing that joins servers with their
 * Connections (`views.ts`), builds a line's buttons (`fix.ts`) or edits a list
 * (`list-edits.ts`).
 */
import type { ThreadBlock } from "../threads/blocks";
import type { RuntimeNote } from "../threads/turns";

/**
 * Checks whether a thread's transcript holds a line about MCP Servers, that
 * is, a `runtime.warning` that names servers, in a turn or outside every turn.
 * Such a line draws its buttons from the servers as they are now, so a page
 * that holds one must read the servers and follow their changes.
 */
export const hasMcpServerLine = ({
  turns,
  outsideRuntimeNotes,
}: {
  readonly turns: readonly { readonly runtimeNotes: readonly RuntimeNote[] }[];
  readonly outsideRuntimeNotes: readonly RuntimeNote[];
}): boolean =>
  [...turns.flatMap((turn) => turn.runtimeNotes), ...outsideRuntimeNotes].some(
    (note) => note.mcpServers !== undefined,
  );

/**
 * Checks whether a thread's blocks hold a warning that names MCP Servers. It
 * is the desktop app's form of `hasMcpServerLine`, which reads the turns the
 * web app builds: the desktop builds blocks, where a warning is a block of
 * its own.
 */
export const hasMcpServerBlock = (blocks: readonly ThreadBlock[]): boolean =>
  blocks.some((block) => block.kind === "warning" && block.mcpServers !== undefined);
