/**
 * The submenu of the composer's `+` menu: the servers of the thread, one
 * switch each. This file and its stylesheet load the first time the menu's
 * "MCP servers" row opens, so the first screen holds only the menu's two rows
 * (spec 17 §What MCP servers cost). Nothing outside the lazy file may import it.
 */
import { useState, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  buildThreadServerMenu,
  describeThreadStartFoot,
  orderMenuNames,
  type McpServerView,
  type RememberedAccounts,
  type ServerMenuRow,
} from "@hercule/client-core/mcp-servers";
import type { PluginDetail } from "@hercule/contract";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { PluginMark } from "../../marks/plugin-mark";
import { ServerName, ServerSwitch } from "../settings/mcp-servers/server-parts";
import { useThreadServers, useThreadViews } from "./thread-servers";
import { WithThreadServerEdits, type ThreadServersTarget } from "./thread-server-edits";
import type { ThreadServerEdits } from "./use-thread-edits";
import "./thread-servers.css";

/**
 * Renders the submenu "Servers of this thread" for the open thread's servers:
 * they are read when it opens (the cache first), and while it is open the
 * `mcpServer` topic is held (see `ThreadServersProvider`). Changes are made
 * through the edits of `target`. `onOpenPicker` and `onReconnect` are called with
 * the menu still open: the caller closes it and opens the dialog. `onClose`
 * closes the menu, for the link to Settings.
 */
export default function ThreadServersMenu({
  target,
  onOpenPicker,
  onReconnect,
  onClose,
}: {
  readonly target: ThreadServersTarget;
  readonly onOpenPicker: () => void;
  readonly onReconnect: (connectionId: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <WithThreadServerEdits target={target}>
      {(edits) => (
        <ServersOfThread
          edits={edits}
          onOpenPicker={onOpenPicker}
          onReconnect={onReconnect}
          onClose={onClose}
        />
      )}
    </WithThreadServerEdits>
  );
}

/** Renders the submenu's panel: a note while the servers are read, the rows after. */
function ServersOfThread({
  edits,
  onOpenPicker,
  onReconnect,
  onClose,
}: {
  readonly edits: ThreadServerEdits;
  readonly onOpenPicker: () => void;
  readonly onReconnect: (connectionId: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const views = useThreadViews();
  const { plugins, readFailure } = useThreadServers();
  if (views === undefined || plugins === undefined) {
    return (
      <div className="pop plus-sub" role="group" aria-label="Servers of this thread">
        <div className="q-h plus-sub-top">Servers of this thread</div>
        <p className="menu-note plus-sub-note" role={readFailure === null ? "status" : "alert"}>
          {readFailure === null
            ? "Reading the servers…"
            : `Could not read the servers: ${readFailure}`}
        </p>
      </div>
    );
  }
  return (
    <SubmenuRows
      views={views}
      plugins={plugins}
      edits={edits}
      onOpenPicker={onOpenPicker}
      onReconnect={onReconnect}
      onClose={onClose}
    />
  );
}

/**
 * Renders the rows once the servers are read. The foot says where the list
 * started, or why that is not known yet: only its way back is lost then. The
 * order of the names is taken when it first renders and kept, so no row jumps
 * while the user switches them.
 */
function SubmenuRows({
  views,
  plugins,
  edits,
  onOpenPicker,
  onReconnect,
  onClose,
}: {
  readonly views: readonly McpServerView[];
  readonly plugins: readonly PluginDetail[];
  readonly edits: ThreadServerEdits;
  readonly onOpenPicker: () => void;
  readonly onReconnect: (connectionId: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { described, start } = useThreadServers();
  const ids = described.mcpServerIds;
  const [order] = useState(() => orderMenuNames(views, ids));
  // The account each name last showed, so switching a name back on picks it again.
  const [rememberedAccounts, setRememberedAccounts] = useState<RememberedAccounts>({});
  const menu = buildThreadServerMenu({
    views,
    mcpServerIds: ids,
    order,
    rememberedAccounts,
  });
  const { foot, reset } = describeThreadStartFoot(start ?? { kind: "pending" }, ids);

  const choose = (row: ServerMenuRow, serverId: string | null, shownId: string): void => {
    if (edits.busy) return;
    setRememberedAccounts({ ...rememberedAccounts, [row.name]: shownId });
    edits.apply({
      kind: "name",
      name: row.name,
      serverId,
      shownServerId: row.shown.server.id,
    });
  };

  return (
    <div className="pop plus-sub" role="group" aria-label="Servers of this thread">
      <div className="q-h plus-sub-top">Servers of this thread</div>
      <div className="plus-list">
        {menu.rows.map((row) => (
          <div key={row.name} className="plus-row">
            <span className="plus-row-mark">
              <PluginMark pluginId={row.shown.pluginId} plugins={plugins} size={15} />
            </span>
            <span className="plus-row-name">
              {/* A name with a choice of account shows the name alone: the choice names the account. */}
              <ServerName
                name={row.name}
                account={row.accounts.length > 1 ? undefined : row.shown.account}
              />
              {row.note !== null && (
                <small>
                  {row.note}
                  {row.reconnect !== null && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        onReconnect(row.reconnect!.connectionId);
                      }}
                    >
                      {row.reconnect.label}
                    </button>
                  )}
                </small>
              )}
            </span>
            {row.accounts.length > 1 && (
              <span className="field field--select mcp-account-select">
                <select
                  aria-label={`Account of ${row.name}`}
                  value={row.shown.server.id}
                  disabled={!row.on}
                  aria-disabled={edits.busy}
                  onChange={(event) => {
                    choose(row, event.target.value, event.target.value);
                  }}
                >
                  {row.accounts.map((view) => (
                    <option key={view.server.id} value={view.server.id}>
                      {view.account}
                    </option>
                  ))}
                </select>
              </span>
            )}
            <ServerSwitch
              on={row.on}
              label={`${row.name} in this thread`}
              busy={edits.busy}
              onFlip={() => {
                choose(row, row.on ? null : row.shown.server.id, row.shown.server.id);
              }}
            />
          </div>
        ))}
      </div>
      {menu.moreCount > 0 && (
        <div className="popover-menu plus-more">
          <button type="button" role="menuitem" onClick={onOpenPicker}>
            <span className="plus-more-label">
              {`${String(menu.moreCount)} more ${menu.moreCount === 1 ? "server" : "servers"}…`}
            </span>
            <ChevronRightIcon size={13} />
          </button>
        </div>
      )}
      {edits.refusal !== null && (
        <p className="plus-error" role="alert">
          {edits.refusal}
        </p>
      )}
      <div className="plus-foot">
        <p className="menu-note">
          {foot}
          {reset !== null && (
            <>
              {" "}
              <button
                type="button"
                className="link"
                aria-disabled={edits.busy}
                onClick={() => {
                  if (edits.busy) return;
                  // The start list is read when the user presses, not when the menu drew it.
                  edits.apply({ kind: "reset" });
                }}
              >
                {reset.label}
              </button>
            </>
          )}
        </p>
        <button
          type="button"
          className="link"
          onClick={() => {
            onClose();
            void navigate({ to: "/settings/mcp-servers" });
          }}
        >
          Open MCP settings
        </button>
      </div>
    </div>
  );
}
