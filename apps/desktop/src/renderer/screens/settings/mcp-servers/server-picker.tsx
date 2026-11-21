/**
 * The picker of MCP servers: one glass dialog for every list of servers, so
 * far the default list of Settings > MCP servers, and later a thread's own
 * list under the composer's `+`. It knows nothing about where the list is
 * kept: it shows the list it is given and reports each change as a new list.
 */
import { useRef, useState, type JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import {
  buildServerPicker,
  chooseNamedServer,
  orderMenuNames,
  type McpServerView,
  type RememberedAccounts,
  type ServerPickerRow,
} from "@hercule/client-core/mcp-servers";
import { CheckIcon } from "../../../icons/check";
import { PluginMark } from "../../../marks/plugin-mark";
import { GlassDialog } from "../../glass-dialog";
import { ServerName, ServerStatus } from "./server-parts";
import "./mcp-servers.css";

/**
 * Renders the picker dialog for the list `mcpServerIds` of `views`, the
 * servers there are.
 *
 * - The head holds `title` and "<n> chosen"; a filter field shows when the
 *   list has more than eight names.
 * - One row for each server name: a checkbox, the mark, the name, a second
 *   line, the status word when the server is not ready, and the choice of
 *   account for a name that two accounts share. The rows keep the order the
 *   dialog opened with, so no row jumps while it is used.
 * - The foot holds `foot`, the quiet button `reset` that goes back to the
 *   list the list started from (left out with `null`; `readIds` returns that
 *   list when the button is pressed), and Done.
 * - Each change calls `onChange` with a function that returns the new list
 *   for the list as it is when the change is written. The result never holds
 *   two servers of one name, so the caller applies the choice to its current
 *   list, never to the one this dialog last drew. While `busy`, a write of the
 *   list is running and the controls ignore changes. `error` is the reason for a write the
 *   controller refused, shown under the rows.
 *
 * `onClose` is called whenever the dialog closes, and the caller then
 * unmounts it.
 */
export function ServerPickerDialog({
  views,
  plugins,
  mcpServerIds,
  title,
  foot,
  reset,
  busy,
  error,
  onChange,
  onClose,
}: {
  readonly views: readonly McpServerView[];
  readonly plugins: readonly PluginIdentity[];
  readonly mcpServerIds: readonly string[];
  readonly title: string;
  readonly foot: string;
  readonly reset: {
    readonly label: string;
    /** Returns the list to go back to, read when the user presses the button. */
    readonly readIds: () => readonly string[];
  } | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onChange: (update: (current: readonly string[]) => readonly string[]) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [filter, setFilter] = useState("");
  // The names as the list was when the dialog opened, the chosen ones first.
  const [order] = useState(() => orderMenuNames(views, mcpServerIds));
  const [rememberedAccounts, setRememberedAccounts] = useState<RememberedAccounts>({});
  const picker = buildServerPicker({ views, mcpServerIds, order, rememberedAccounts, filter });

  const choose = (row: ServerPickerRow, serverId: string | null, shownId: string): void => {
    if (busy) return;
    setRememberedAccounts({ ...rememberedAccounts, [row.name]: shownId });
    onChange((current) => chooseNamedServer(current, views, row.name, serverId));
  };

  return (
    <GlassDialog dialogRef={dialogRef} className="mcp-picker" label={title} onClose={onClose}>
      <div className="pop-h">
        <b>{title}</b>
        <span>{`${String(picker.chosenCount)} chosen`}</span>
      </div>
      {picker.showsFilter && (
        <div className="pop-sec mcp-picker-filter">
          <input
            className="field menu-filter"
            placeholder="Filter servers"
            aria-label="Filter servers"
            autoFocus
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        </div>
      )}
      <div className="pop-sec mcp-picker-list">
        {picker.rows.map((row) => (
          <label key={row.name} className="mcp-pick-row">
            <span className="choice-box">
              <input
                type="checkbox"
                checked={row.chosen}
                aria-disabled={busy}
                onChange={(event) => {
                  choose(
                    row,
                    event.target.checked ? row.shown.server.id : null,
                    row.shown.server.id,
                  );
                }}
              />
              <CheckIcon size={11} />
            </span>
            <span className="mcp-pick-mark">
              <PluginMark pluginId={row.shown.pluginId} plugins={plugins} size={15} />
            </span>
            <span className="mcp-pick-name">
              {/* A name with a choice of account shows the name alone: the choice names the account. */}
              <ServerName
                name={row.name}
                account={row.accounts.length > 1 ? undefined : row.shown.account}
              />
              <small>{row.secondLine}</small>
            </span>
            {row.statusWord !== null && (
              <ServerStatus
                displayStatus={row.shown.displayStatus}
                word={row.statusWord}
                failing={row.shown.failing}
                detail={row.shown.statusDetail}
              />
            )}
            {row.accounts.length > 1 && (
              <span className="mcp-pick-account">
                account
                <span className="field field--select mcp-account-select">
                  <select
                    aria-label={`Account of ${row.name}`}
                    value={row.shown.server.id}
                    disabled={!row.chosen}
                    aria-disabled={busy}
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
              </span>
            )}
          </label>
        ))}
        {picker.rows.length === 0 && (
          <p className="menu-note">
            {filter.trim() === "" ? "No servers yet." : `No server matches "${filter}".`}
          </p>
        )}
      </div>
      {error !== null && (
        <p className="mcp-picker-error" role="alert">
          {error}
        </p>
      )}
      <div className="mcp-picker-foot">
        <span className="time">{foot}</span>
        {reset !== null && (
          <button
            type="button"
            className="btn btn--quiet"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onChange(reset.readIds);
            }}
          >
            {reset.label}
          </button>
        )}
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
