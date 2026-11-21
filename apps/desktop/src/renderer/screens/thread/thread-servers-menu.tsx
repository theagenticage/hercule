/**
 * The submenu of the composer's `+` menu: the servers of the thread, one
 * switch each. This file and its stylesheet load the first time the menu's
 * "MCP servers" row opens, so the first screen holds only the menu's two rows
 * (spec 17 §What MCP servers cost). Nothing outside the lazy file may import it.
 */
import { useState, type JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  buildThreadServerMenu,
  chooseNamedServer,
  decideThreadStartList,
  orderMenuNames,
  type McpServerView,
  type RememberedAccounts,
  type ServerMenuRow,
} from "@hercule/client-core/mcp-servers";
import { useMcpServerViews } from "../../app/mcp-server-views";
import { pluginsQuery, projectsQuery, settingsQuery } from "../../app/queries";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { PluginMark } from "../../marks/plugin-mark";
import { ServerName, ServerSwitch } from "../settings/mcp-servers/server-parts";
import type { ThreadServers } from "./use-thread-servers";
import "./thread-servers.css";

/**
 * Renders the submenu "Servers of this thread" for `servers`: the servers
 * are read when it opens (the cache first), and while it is open the
 * `mcpServer` topic is held. `onOpenPicker` and `onReconnect` are called with
 * the menu still open: the caller closes it and opens the dialog. `onClose`
 * closes the menu, for the link to Settings.
 */
export default function ThreadServersMenu({
  servers,
  onOpenPicker,
  onReconnect,
  onClose,
}: {
  readonly servers: ThreadServers;
  readonly onOpenPicker: () => void;
  readonly onReconnect: (connectionId: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { views, failure } = useMcpServerViews("read");
  const settings = useQuery(settingsQuery(client));
  // The foot names where the list started, which needs the default list when the thread has no project.
  if (views === undefined || settings.isPending) {
    return (
      <div className="pop plus-sub" role="group" aria-label="Servers of this thread">
        <div className="q-h plus-sub-top">Servers of this thread</div>
        <p className="menu-note plus-sub-note" role={failure === null ? "status" : "alert"}>
          {failure === null ? "Reading the servers…" : `Could not read the servers: ${failure}`}
        </p>
      </div>
    );
  }
  return (
    <SubmenuRows
      views={views}
      defaultIds={settings.data?.user["thread.mcpServerIds"] ?? []}
      servers={servers}
      onOpenPicker={onOpenPicker}
      onReconnect={onReconnect}
      onClose={onClose}
    />
  );
}

/**
 * Renders the rows once the servers and the default list are read. The order
 * of the names is taken when it first renders and kept, so no row jumps while
 * the user switches them.
 */
function SubmenuRows({
  views,
  defaultIds,
  servers,
  onOpenPicker,
  onReconnect,
  onClose,
}: {
  readonly views: readonly McpServerView[];
  readonly defaultIds: readonly string[];
  readonly servers: ThreadServers;
  readonly onOpenPicker: () => void;
  readonly onReconnect: (connectionId: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const navigate = useNavigate();
  const [order] = useState(() => orderMenuNames(views, servers.ids));
  // The account each name last showed, so switching a name back on picks it again.
  const [rememberedAccounts, setRememberedAccounts] = useState<RememberedAccounts>({});
  const menu = buildThreadServerMenu({
    views,
    mcpServerIds: servers.ids,
    order,
    rememberedAccounts,
    start: decideThreadStartList(servers.projectId, projects, defaultIds, views),
  });

  const choose = (row: ServerMenuRow, serverId: string | null, shownId: string): void => {
    if (servers.busy) return;
    setRememberedAccounts({ ...rememberedAccounts, [row.name]: shownId });
    servers.change((current) => chooseNamedServer(current, views, row.name, serverId));
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
                  aria-disabled={servers.busy}
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
              busy={servers.busy}
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
      {servers.refusal !== null && (
        <p className="plus-error" role="alert">
          {servers.refusal}
        </p>
      )}
      <div className="plus-foot">
        <p className="menu-note">
          {menu.foot}
          {menu.reset !== null && (
            <>
              {" "}
              <button
                type="button"
                className="link"
                aria-disabled={servers.busy}
                onClick={() => {
                  if (servers.busy) return;
                  const { mcpServerIds } = menu.reset!;
                  servers.change(() => mcpServerIds);
                }}
              >
                {menu.reset.label}
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
