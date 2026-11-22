/**
 * The picker dialog for the servers of one thread, opened by "N more
 * servers…" in the `+` menu. Loaded the first time it opens (see
 * `lazy-thread-servers.ts`).
 */
import { useRef, type JSX } from "react";
import { describeThreadStartFoot, type McpServerView } from "@hercule/client-core/mcp-servers";
import type { PluginDetail } from "@hercule/contract";
import { GlassDialog } from "../glass-dialog";
import { ServerPickerDialog } from "../settings/mcp-servers/server-picker";
import { useThreadServers, useThreadViews } from "./thread-servers";
import { WithThreadServerEdits, type ThreadServersTarget } from "./thread-server-edits";
import type { ThreadServerEdits } from "./use-thread-edits";

/**
 * Renders the picker "MCP servers of this thread" for the open thread's
 * servers, once they are read: the cache first, and the topic held while the
 * dialog is open (see `ThreadServersProvider`). Changes are made through
 * the edits of `target`. When the servers cannot be read, a dialog says
 * why instead. `onClose` is called whenever the dialog closes, and the
 * caller then unmounts it.
 */
export default function ThreadServerPicker({
  target,
  onClose,
}: {
  readonly target: ThreadServersTarget;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <WithThreadServerEdits target={target}>
      {(edits) => <ServersPicker edits={edits} onClose={onClose} />}
    </WithThreadServerEdits>
  );
}

/** Renders the dialog for the thread's servers, or why they could not be read. */
function ServersPicker({
  edits,
  onClose,
}: {
  readonly edits: ThreadServerEdits;
  readonly onClose: () => void;
}): JSX.Element | null {
  const views = useThreadViews();
  const { plugins, readFailure } = useThreadServers();
  const dialogRef = useRef<HTMLDialogElement>(null);
  if (readFailure !== null) {
    return (
      <GlassDialog
        dialogRef={dialogRef}
        className="mcp-picker"
        label="MCP servers of this thread"
        onClose={onClose}
      >
        <p className="mcp-picker-error" role="alert">
          {`Could not read the servers: ${readFailure}`}
        </p>
        <div className="mcp-picker-foot">
          <button
            type="button"
            className="btn btn--accent"
            onClick={() => dialogRef.current?.close()}
          >
            Done
          </button>
        </div>
      </GlassDialog>
    );
  }
  if (views === undefined || plugins === undefined) return null;
  return <ThreadPickerDialog views={views} plugins={plugins} edits={edits} onClose={onClose} />;
}

/** Renders the dialog once the servers are read. Its foot says where the list started, or why that is not known yet. */
function ThreadPickerDialog({
  views,
  plugins,
  edits,
  onClose,
}: {
  readonly views: readonly McpServerView[];
  readonly plugins: readonly PluginDetail[];
  readonly edits: ThreadServerEdits;
  readonly onClose: () => void;
}): JSX.Element {
  const { described } = useThreadServers();
  const { foot, reset } = describeThreadStartFoot(
    described.start ?? { kind: "pending" },
    described.mcpServerIds,
  );
  return (
    <ServerPickerDialog
      views={views}
      plugins={plugins}
      mcpServerIds={described.mcpServerIds}
      title="MCP servers of this thread"
      foot={foot}
      reset={reset}
      busy={edits.busy}
      error={edits.refusal}
      onChoose={edits.apply}
      onClose={onClose}
    />
  );
}
