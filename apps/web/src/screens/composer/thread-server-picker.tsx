import type { JSX } from "react";
import { createPortal } from "react-dom";
import type { PluginDetail } from "@hercule/contract";
import {
  buildThreadServerMenu,
  type McpServerView,
  type ThreadStartList,
} from "@hercule/client-core/mcp-servers";
import { McpServerPicker, type ListUpdate } from "../mcp-server-picker";

/**
 * The picker of the thread's MCP Servers, titled "MCP servers of this
 * thread": the dialog that opens from "N more servers…" in the `+` menu. Its
 * foot and its button that goes back to the start list are the submenu's, so
 * the two never say different things.
 *
 * The dialog is drawn on the page body, not inside the composer: the thread
 * page's foot is a sticky element, which would keep the dialog's scrim under
 * the page's own header.
 */
export function ThreadServerPicker({
  views,
  plugins,
  mcpServerIds,
  start,
  writing,
  refusal,
  onChange,
  onReset,
  onClose,
}: {
  readonly views: readonly McpServerView[];
  readonly plugins: readonly PluginDetail[];
  /** The thread's list. */
  readonly mcpServerIds: readonly string[];
  readonly start: ThreadStartList;
  readonly writing: boolean;
  /** Why the last write was refused, or `null`. */
  readonly refusal: string | null;
  readonly onChange: (update: ListUpdate) => void;
  /** The user asked to go back to the start list. The caller resolves that list when this is called. */
  readonly onReset: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  // The submenu's model gives the foot and the reset button. Its rows are not
  // used here, so it is built with no order and offers none.
  const { foot, reset } = buildThreadServerMenu({
    views,
    mcpServerIds,
    order: [],
    rememberedAccounts: {},
    start,
  });
  return createPortal(
    <McpServerPicker
      title="MCP servers of this thread"
      views={views}
      plugins={plugins}
      mcpServerIds={mcpServerIds}
      foot={foot}
      reset={reset === null ? null : { label: reset.label, onPress: onReset }}
      pending={writing}
      failure={refusal}
      onChange={onChange}
      onClose={onClose}
    />,
    document.body,
  );
}
