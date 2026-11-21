/**
 * The picker dialog for the servers of one thread, opened by "N more
 * servers…" in the `+` menu. Loaded the first time it opens (see
 * `lazy-thread-servers.ts`).
 */
import { useRef, type JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildThreadServerMenu, decideThreadStartList } from "@hercule/client-core/mcp-servers";
import { useMcpServerViews } from "../../app/mcp-server-views";
import { pluginsQuery, projectsQuery, settingsQuery } from "../../app/queries";
import { GlassDialog } from "../glass-dialog";
import { ServerPickerDialog } from "../settings/mcp-servers/server-picker";
import type { ThreadServers } from "./use-thread-servers";

/**
 * Renders the picker "MCP servers of this thread" for `servers`, once the
 * servers and the default list are read: the cache first, and the topic held
 * while the dialog is open. When the servers cannot be read, a dialog says
 * why instead. `onClose` is called whenever the dialog closes, and the
 * caller then unmounts it.
 */
export default function ThreadServerPicker({
  servers,
  onClose,
}: {
  readonly servers: ThreadServers;
  readonly onClose: () => void;
}): JSX.Element | null {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { views, failure } = useMcpServerViews("read");
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const settings = useQuery(settingsQuery(client));
  const dialogRef = useRef<HTMLDialogElement>(null);
  if (failure !== null) {
    return (
      <GlassDialog
        dialogRef={dialogRef}
        className="mcp-picker"
        label="MCP servers of this thread"
        onClose={onClose}
      >
        <p className="mcp-picker-error" role="alert">
          {`Could not read the servers: ${failure}`}
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
  if (views === undefined || settings.isPending) return null;
  // The menu model words the foot and the way back to the start list, which the picker shows too.
  const { foot, reset } = buildThreadServerMenu({
    views,
    mcpServerIds: servers.ids,
    order: [],
    rememberedAccounts: {},
    start: decideThreadStartList(
      servers.projectId,
      projects,
      settings.data?.user["thread.mcpServerIds"] ?? [],
      views,
    ),
  });
  return (
    <ServerPickerDialog
      views={views}
      plugins={plugins}
      mcpServerIds={servers.ids}
      title="MCP servers of this thread"
      foot={foot}
      reset={reset === null ? null : { label: reset.label, readIds: servers.readStartIds }}
      busy={servers.busy}
      error={servers.refusal}
      onChange={servers.change}
      onClose={onClose}
    />
  );
}
