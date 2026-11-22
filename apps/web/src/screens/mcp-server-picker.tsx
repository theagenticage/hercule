import { useEffect, useRef, useState, type JSX } from "react";
import type { PluginDetail } from "@hercule/contract";
import {
  buildServerPicker,
  orderMenuNames,
  type McpListChoice,
  type McpServerView,
  type RememberedAccounts,
  type ServerPickerRow,
} from "@hercule/client-core/mcp-servers";
import { Button, ChoiceInput, Input, Select } from "@hercule/ui";
import { McpServerStatusWord } from "./mcp-server-status";
import { ProviderMark } from "./provider-mark";

/**
 * The picker of MCP Servers: one dialog that edits any list of servers, a
 * project's, the default list, or one thread's. It draws a row for each server
 * name with a checkbox, and a choice of account for a name that two
 * Connections share, so a list can never hold both. It sits over a scrim like
 * the New project dialog.
 *
 * The component is presentational. It knows nothing of where the list lives:
 * `onChoose` receives what the user chose with each click, and the caller
 * resolves it against its list as it is when the edit runs. The list the
 * dialog draws can be older than the list the caller holds, so a click never
 * sends the drawn list back. While `pending` is true the caller's edit is
 * running, and the controls ignore clicks, so one list never has two edits in
 * flight.
 *
 * The order of the names is fixed when the dialog opens (the servers on the
 * list first), so a row never jumps away under the pointer.
 */
export function McpServerPicker({
  title,
  views,
  plugins,
  mcpServerIds,
  foot,
  reset,
  pending,
  failure,
  onChoose,
  onClose,
}: {
  readonly title: string;
  readonly views: readonly McpServerView[];
  readonly plugins: readonly PluginDetail[];
  /** The list being edited. */
  readonly mcpServerIds: readonly string[];
  /** The line at the foot: what a change reaches. */
  readonly foot: string;
  /**
   * The button that goes back to the list this one started from, or `null`
   * when there is none or the list equals it. The caller resolves that list
   * when the button is pressed, not when the dialog was drawn.
   */
  readonly reset: { readonly label: string } | null;
  readonly pending: boolean;
  /** Why the last write was refused, or `null`. */
  readonly failure: string | null;
  /** The user chose: a switch, a swap of account, or going back to the start list. */
  readonly onChoose: (choice: McpListChoice) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [order] = useState(() => orderMenuNames(views, mcpServerIds));
  // The account each name last showed, so a name switched off keeps offering the account the user chose.
  const [remembered, setRemembered] = useState<RememberedAccounts>({});
  const picker = buildServerPicker({
    views,
    mcpServerIds,
    order,
    rememberedAccounts: remembered,
    filter,
  });

  // Focus starts inside the dialog, so Escape reaches it. With a filter field,
  // that field has already taken focus.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.contains(document.activeElement)) dialog.focus();
  }, []);

  const choose = (row: ServerPickerRow, serverId: string | null, shownId: string): void => {
    if (pending) return;
    setRemembered({ ...remembered, [row.name]: serverId ?? shownId });
    onChoose({ kind: "name", name: row.name, serverId, shownServerId: row.shown.server.id });
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-center overflow-y-auto bg-scrim pt-[12vh] pb-8"
      // Clicking the page behind closes the dialog, as on every other overlay in the app.
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-server-picker-heading"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
        }}
        className="flex h-fit w-[520px] max-w-[92vw] flex-col gap-3 rounded-card outline-none border border-line bg-raised p-3.5 shadow-lift"
      >
        <div className="flex items-baseline gap-2">
          <span
            id="mcp-server-picker-heading"
            className="text-label font-emph tracking-[0.1em] text-faint uppercase"
          >
            {title}
          </span>
          <span className="ml-auto font-mono text-[10.5px] text-faint">
            {String(picker.chosenCount)} chosen
          </span>
        </div>

        {picker.showsFilter ? (
          <Input
            autoFocus
            aria-label="Filter servers"
            placeholder="Filter servers"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        ) : null}

        <ul className="flex max-h-[50vh] flex-col overflow-y-auto">
          {picker.rows.map((row) => (
            <li key={row.name}>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-control px-1.5 py-1.5 text-row hover:bg-line-soft">
                <ChoiceInput
                  type="checkbox"
                  aria-label={row.name}
                  aria-disabled={pending}
                  checked={row.chosen}
                  onChange={(event) => {
                    choose(
                      row,
                      event.target.checked ? row.shown.server.id : null,
                      row.shown.server.id,
                    );
                  }}
                />
                <ProviderMark pluginId={row.shown.pluginId} plugins={plugins} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    <b className="font-emph text-ink">{row.name}</b>
                    {/* A row with a choice of account shows the name alone: the choice names the account. */}
                    {row.accounts.length === 1 && row.shown.account !== undefined ? (
                      <>
                        {" "}
                        <span className="text-muted">{row.shown.account}</span>
                      </>
                    ) : null}
                  </span>
                  <small className="block truncate text-fine text-muted">{row.secondLine}</small>
                </span>
                {row.statusWord === null ? null : <McpServerStatusWord view={row.shown} />}
                {row.accounts.length > 1 ? (
                  <span className="w-[120px] shrink-0">
                    <Select
                      aria-label={`Account of ${row.name}`}
                      aria-disabled={pending}
                      disabled={!row.chosen}
                      value={row.shown.server.id}
                      className="py-1 text-fine"
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
              </label>
            </li>
          ))}
          {picker.rows.length === 0 ? (
            <li className="px-1.5 py-1.5 text-fine text-faint">
              {filter.trim() === "" ? "No server yet." : `No server matches "${filter}".`}
            </li>
          ) : null}
        </ul>

        {failure === null ? null : (
          <p className="text-fine text-fail" role="alert">
            {failure}
          </p>
        )}
        <div className="flex items-center gap-1.5 border-t border-line-soft pt-3">
          <span className="min-w-0 flex-1 text-fine text-faint">{foot}</span>
          {reset === null ? null : (
            <Button
              aria-disabled={pending}
              onClick={() => {
                if (!pending) onChoose({ kind: "reset" });
              }}
            >
              {reset.label}
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
