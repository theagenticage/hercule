import {
  buildThreadServerMenu,
  type ThreadServerMenu,
  type ThreadStartList,
} from "@hercule/client-core/mcp-servers";

/** What the menu builds from while the start list is unknown: it holds no ids and offers no reset. */
const UNKNOWN_START: ThreadStartList = {
  mcpServerIds: [],
  source: { kind: "none" },
  complete: false,
};

/**
 * Builds the model of the submenu and the picker of a thread's MCP servers.
 * `start` is `undefined` when the list the thread started from is not known:
 * its project is still being read, or could not be read. The model then has
 * no reset button, and its foot says why instead of where the list started,
 * so the thread's own switches keep working. `startFailure` is the reason the
 * read failed, or `null` while it is running.
 */
export const buildThreadMenuModel = ({
  start,
  startFailure,
  ...rest
}: Omit<Parameters<typeof buildThreadServerMenu>[0], "start"> & {
  readonly start: ThreadStartList | undefined;
  readonly startFailure: string | null;
}): ThreadServerMenu => {
  const menu = buildThreadServerMenu({ ...rest, start: start ?? UNKNOWN_START });
  if (start !== undefined) return menu;
  return {
    ...menu,
    foot:
      startFailure === null
        ? "Reading where this list started…"
        : `Where this list started could not be read (${startFailure}). Changes are for this thread only.`,
  };
};
