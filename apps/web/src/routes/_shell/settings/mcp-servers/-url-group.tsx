import { useState, type JSX } from "react";
import type { HerculeClient } from "@hercule/client-core";
import type { PluginDetail } from "@hercule/contract";
import type { UrlServerSettingsRow } from "@hercule/client-core/mcp-servers";
import { Button, Group, LaneLabel } from "@hercule/ui";
import { AddByUrlDialog } from "../../../../screens/mcp-url-server/add-dialog";
import { UrlServerRow } from "./-url-server-row";

/**
 * The group "Added by URL" of the MCP servers list: one row for each server
 * the user added by its address, with the button "Add by URL" at the right of
 * the heading. With none, an empty block says so. The group owns whether the
 * Add dialog is open.
 *
 * `onShowOfferRow` shows the row of a plugin's offer in the list above, for
 * the Add dialog's refusal of an address a plugin already offers.
 */
export function UrlGroup({
  client,
  rows,
  plugins,
  onShowOfferRow,
}: {
  readonly client: HerculeClient;
  readonly rows: readonly UrlServerSettingsRow[];
  readonly plugins: readonly PluginDetail[];
  readonly onShowOfferRow: (contributionId: string, connectionId: string) => void;
}): JSX.Element {
  const [adding, setAdding] = useState(false);
  return (
    <section>
      <div className="flex max-w-[568px] items-start">
        <LaneLabel className="flex-1">
          Added by URL
          <span className="ml-2.5 font-normal tracking-normal text-faint normal-case">
            Any remote MCP server, signed in once on the controller
          </span>
        </LaneLabel>
        <Button
          variant="form"
          className="-mt-1.5 shrink-0"
          onClick={() => {
            setAdding(true);
          }}
        >
          Add by URL
        </Button>
      </div>
      {rows.length === 0 ? (
        <div className="flex max-w-[568px] flex-col gap-0.5 rounded-card border border-line-soft bg-surface px-3 py-3">
          <b className="text-row font-emph text-ink">None added</b>
          <span className="text-fine text-faint">Add any remote MCP server by its address.</span>
        </div>
      ) : (
        <Group>
          <ul className="flex flex-col">
            {rows.map((row) => (
              <UrlServerRow key={row.view.server.id} client={client} row={row} plugins={plugins} />
            ))}
          </ul>
        </Group>
      )}
      {adding ? (
        <AddByUrlDialog
          client={client}
          onClose={() => {
            setAdding(false);
          }}
          onShowOfferRow={onShowOfferRow}
        />
      ) : null}
    </section>
  );
}
