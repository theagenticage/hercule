import { useState, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { PluginDetail } from "@hercule/contract";
import {
  buildThreadServerMenu,
  orderMenuNames,
  type McpServerView,
  type RememberedAccounts,
  type ThreadStartList,
} from "@hercule/client-core/mcp-servers";
import { Button, buildButtonClassName, Select, Switch } from "@hercule/ui";
import { ProviderMark } from "../provider-mark";
import { MenuFoot, MenuHeader, MenuRow } from "./menu";

/**
 * The submenu "Servers of this thread" of the composer's `+` menu: one row for
 * each server name with a switch, and the foot that says where the list
 * started.
 *
 * - The order of the names is taken when the submenu opens, the thread's own
 *   servers first, so no row jumps while the user switches things. The
 *   submenu mounts when it opens, so the order is the one state the component
 *   creates for it (`orderMenuNames`), beside the account each name last
 *   showed. Every row is built again from the current servers on each render.
 * - Two accounts of one name are one row. Its select is disabled while the
 *   name is off, and choosing another account swaps them in one write.
 * - A server that needs sign-in stays on. Its row says so and offers the
 *   Connection's Reconnect.
 * - While `writing` the switches and selects ignore clicks, so one list never
 *   has two writes in flight. A refusal shows under the rows.
 *
 * The component writes nothing itself: `onChoose` and `onReset` report what
 * the user asked, and the caller decides how the list is stored.
 */
export function ThreadServersMenu({
  views,
  plugins,
  mcpServerIds,
  start,
  writing,
  refusal,
  onChoose,
  onReset,
  onOpenPicker,
}: {
  readonly views: readonly McpServerView[];
  readonly plugins: readonly PluginDetail[];
  /** The thread's list. */
  readonly mcpServerIds: readonly string[];
  readonly start: ThreadStartList;
  readonly writing: boolean;
  /** Why the last write was refused, or `null`. */
  readonly refusal: string | null;
  /** The user switched the server of `name`: `serverId` on, `null` off. */
  readonly onChoose: (name: string, serverId: string | null) => void;
  /** The user asked to go back to `mcpServerIds`, the list the thread started from. */
  readonly onReset: (mcpServerIds: readonly string[]) => void;
  readonly onOpenPicker: () => void;
}): JSX.Element {
  const [order] = useState(() => orderMenuNames(views, mcpServerIds));
  // The account each name last showed, so a name switched off offers the account the user chose.
  const [remembered, setRemembered] = useState<RememberedAccounts>({});
  const menu = buildThreadServerMenu({
    views,
    mcpServerIds,
    order,
    rememberedAccounts: remembered,
    start,
  });

  const choose = (name: string, serverId: string | null, shownId: string): void => {
    if (writing) return;
    setRemembered({ ...remembered, [name]: serverId ?? shownId });
    onChoose(name, serverId);
  };

  return (
    <>
      <MenuHeader label="Servers of this thread" />
      <ul className="flex flex-col">
        {menu.rows.map((row) => (
          <li key={row.name} className="flex items-center gap-2 rounded-[6px] px-2 py-1.5">
            <ProviderMark
              pluginId={row.shown.pluginId}
              plugins={plugins}
              className="size-[14px] text-muted"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ink">
                <b className="font-emph">{row.name}</b>
                {/* A row with a choice of account shows the name alone: the choice names the account. */}
                {row.accounts.length === 1 && row.shown.account !== undefined ? (
                  <span className="ml-1.5 text-[11px] text-faint">{row.shown.account}</span>
                ) : null}
              </span>
              {row.note === null ? null : (
                <span className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-fail">
                  {row.note}
                  {row.reconnect === null ? null : (
                    <Link
                      to="/connections"
                      search={{ reconnect: row.reconnect.connectionId }}
                      className={buildButtonClassName("quiet", "px-1 py-0.5 text-[11px]")}
                    >
                      {row.reconnect.label}
                    </Link>
                  )}
                </span>
              )}
            </span>
            {row.accounts.length > 1 ? (
              <span className="w-[116px] shrink-0">
                <Select
                  aria-label={`Account of ${row.name}`}
                  aria-disabled={writing}
                  disabled={!row.on}
                  value={row.shown.server.id}
                  className="py-0.5 text-fine"
                  onChange={(event) => {
                    choose(row.name, event.target.value, event.target.value);
                  }}
                >
                  {row.accounts.map((view) => (
                    <option key={view.server.id} value={view.server.id}>
                      {view.account ?? view.server.id}
                    </option>
                  ))}
                </Select>
              </span>
            ) : null}
            <Switch
              aria-label={`${row.name} in this thread`}
              aria-disabled={writing}
              checked={row.on}
              onCheckedChange={(on) => {
                choose(row.name, on ? row.shown.server.id : null, row.shown.server.id);
              }}
            />
          </li>
        ))}
      </ul>
      {menu.moreCount === 0 ? null : (
        <MenuRow
          name={`${String(menu.moreCount)} more ${menu.moreCount === 1 ? "server" : "servers"}…`}
          note={
            <span aria-hidden="true" className="text-fine">
              ›
            </span>
          }
          onPick={onOpenPicker}
        />
      )}
      {refusal === null ? null : (
        <p className="px-2 pt-1.5 text-fine text-fail" role="alert">
          {refusal}
        </p>
      )}
      <MenuFoot>
        <p>{menu.foot}</p>
        <div className="mt-1 flex items-center gap-1 text-fine">
          {menu.reset === null ? null : (
            <Button
              aria-disabled={writing}
              className="-ml-2 px-2 py-0.5 text-fine"
              onClick={() => {
                if (menu.reset !== null) onReset(menu.reset.mcpServerIds);
              }}
            >
              {menu.reset.label}
            </Button>
          )}
          <Link
            to="/settings/mcp-servers"
            className={buildButtonClassName("quiet", "ml-auto px-2 py-0.5 text-fine")}
          >
            Open MCP settings
          </Link>
        </div>
      </MenuFoot>
    </>
  );
}
