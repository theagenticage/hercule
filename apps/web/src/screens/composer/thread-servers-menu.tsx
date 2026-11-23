import { useState, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { PluginDetail } from "@hercule/contract";
import {
  buildThreadServerMenu,
  describeThreadStartFoot,
  orderMenuNames,
  type McpListChoice,
  type McpServerView,
  type RememberedAccounts,
  type ServerMenuRow,
  type ThreadStartDecision,
} from "@hercule/client-core/mcp-servers";
import { Button, buildButtonClassName, Select, Switch } from "@hercule/ui";
import { McpServerMark } from "../mcp-server-mark";
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
 *   Connection's Reconnect, or "Sign in…" for a server added by URL.
 * - While `writing` the switches and selects ignore clicks, so one list never
 *   has two writes in flight. A refusal shows under the rows.
 *
 * The component writes nothing itself: `onChoose` reports what the user
 * chose, and the caller decides how the list is stored.
 */
export function ThreadServersMenu({
  views,
  plugins,
  mcpServerIds,
  start,
  writing,
  refusal,
  onChoose,
  onOpenPicker,
  onSignIn,
}: {
  readonly views: readonly McpServerView[];
  readonly plugins: readonly PluginDetail[];
  /** The thread's list. */
  readonly mcpServerIds: readonly string[];
  /** Where the list started. The switches work whatever it says. */
  readonly start: ThreadStartDecision;
  readonly writing: boolean;
  /** Why the last write was refused, or `null`. */
  readonly refusal: string | null;
  /** The user chose: a switch, a swap of account, or going back to the start list. */
  readonly onChoose: (choice: McpListChoice) => void;
  readonly onOpenPicker: () => void;
  /** The user pressed "Sign in…" of a server added by URL: the caller opens its token dialog. */
  readonly onSignIn: (mcpServerId: string) => void;
}): JSX.Element {
  const [order] = useState(() => orderMenuNames(views, mcpServerIds));
  // The account each name last showed, so a name switched off offers the account the user chose.
  const [remembered, setRemembered] = useState<RememberedAccounts>({});
  const menu = buildThreadServerMenu({
    views,
    mcpServerIds,
    order,
    rememberedAccounts: remembered,
  });
  const { foot, reset } = describeThreadStartFoot(start, mcpServerIds);

  const choose = (row: ServerMenuRow, serverId: string | null, shownId: string): void => {
    if (writing) return;
    setRemembered({ ...remembered, [row.name]: serverId ?? shownId });
    onChoose({ kind: "name", name: row.name, serverId, shownServerId: row.shown.server.id });
  };

  return (
    <>
      <MenuHeader label="Servers of this thread" />
      <ul className="flex flex-col">
        {menu.rows.map((row) => (
          <li key={row.name} className="flex items-center gap-2 rounded-[6px] px-2 py-1.5">
            <McpServerMark view={row.shown} plugins={plugins} className="size-[14px] text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ink">
                <b className="font-emph">{row.name}</b>
                {/* A row with a choice of account shows the name alone: the choice names the account. A server added by URL shows its name alone too: its account is its address. */}
                {row.accounts.length === 1 &&
                row.shown.account !== undefined &&
                row.shown.server.source.kind === "plugin" ? (
                  <span className="ml-1.5 text-[11px] text-faint">{row.shown.account}</span>
                ) : null}
              </span>
              {row.note === null ? null : (
                <span className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-fail">
                  {row.note}
                  {row.signIn === null ? null : row.signIn.kind === "reconnect" ? (
                    <Link
                      to="/connections"
                      search={{ reconnect: row.signIn.connectionId }}
                      className={buildButtonClassName("quiet", "px-1 py-0.5 text-[11px]")}
                    >
                      {row.signIn.label}
                    </Link>
                  ) : (
                    <Button
                      className="px-1 py-0.5 text-[11px]"
                      onClick={() => {
                        onSignIn(row.shown.server.id);
                      }}
                    >
                      {row.signIn.label}
                    </Button>
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
                    choose(row, event.target.value, event.target.value);
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
                choose(row, on ? row.shown.server.id : null, row.shown.server.id);
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
        <p>{foot}</p>
        <div className="mt-1 flex items-center gap-1 text-fine">
          {reset === null ? null : (
            <Button
              aria-disabled={writing}
              className="-ml-2 px-2 py-0.5 text-fine"
              onClick={() => {
                if (!writing) onChoose({ kind: "reset" });
              }}
            >
              {reset.label}
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
