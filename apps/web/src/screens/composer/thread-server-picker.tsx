import type { JSX } from "react";
import { createPortal } from "react-dom";
import type { PluginDetail } from "@hercule/contract";
import {
  describeThreadStartFoot,
  type McpListChoice,
  type McpServerView,
  type ThreadStartDecision,
} from "@hercule/client-core/mcp-servers";
import { McpServerPicker } from "../mcp-server-picker";

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
  onChoose,
  onClose,
}: {
  readonly views: readonly McpServerView[];
  readonly plugins: readonly PluginDetail[];
  /** The thread's list. */
  readonly mcpServerIds: readonly string[];
  /** Where the list started. The checkboxes work whatever it says. */
  readonly start: ThreadStartDecision;
  readonly writing: boolean;
  /** Why the last write was refused, or `null`. */
  readonly refusal: string | null;
  readonly onChoose: (choice: McpListChoice) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { foot, reset } = describeThreadStartFoot(start, mcpServerIds);
  return createPortal(
    <McpServerPicker
      title="MCP servers of this thread"
      views={views}
      plugins={plugins}
      mcpServerIds={mcpServerIds}
      foot={foot}
      reset={reset}
      pending={writing}
      failure={refusal}
      onChoose={onChoose}
      onClose={onClose}
    />,
    document.body,
  );
}
