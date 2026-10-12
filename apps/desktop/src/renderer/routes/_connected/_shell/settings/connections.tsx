import { useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { listConnectionTypes, type ConnectionType } from "@hercule/client-core";
import type { Connection } from "@hercule/contract";
import { rememberSettingsSection } from "../../../../app/last-settings-section";
import { connectionsQuery, pluginsQuery } from "../../../../app/queries";
import { AddConnectionMenu, ConnectionTable } from "../../../../screens/settings/connections";
import { SettingsHeaderActions } from "../../../../screens/settings/settings-frame";
import { ConfigureConnectionDialog } from "./-configure-connection-dialog";
import { ConnectionSetupDialog } from "./-connection-setup-dialog";
import { DeleteConnectionDialog } from "./-delete-connection-dialog";

/**
 * The dialog open over the Connections table, if any:
 *
 * - `setup`: sets up a new Connection of `type`, or, with `connection`,
 *   gives that Connection a fresh credential (Reconnect).
 * - `configure`: edits the Connection's name, topic, settings and polling.
 * - `delete`: asks before the Connection is removed.
 */
type ConnectionsDialog =
  | {
      readonly kind: "setup";
      readonly type: ConnectionType;
      readonly connection?: Connection;
    }
  | { readonly kind: "configure"; readonly connection: Connection }
  | { readonly kind: "delete"; readonly connection: Connection };

/**
 * Settings > Connections: one table of every Connection, with its type, its
 * account and its health, and a ⋯ menu to reconnect, configure or delete it.
 * The header's Add a Connection button lists the Connection types the
 * plugins declare and opens the chosen type's setup (spec 17 §Settings,
 * Connections).
 *
 * The Connections and the plugins are the shell's reads, which the live
 * connection keeps current on the `connection` and `plugin` topics, so a
 * Connection added, changed or removed anywhere shows here at once.
 */
export const Route = createFileRoute("/_connected/_shell/settings/connections")({
  staticData: { title: "Connections" },
  loader: async ({ context: { controller, queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(connectionsQuery(controller.client)),
      queryClient.ensureQueryData(pluginsQuery(controller.client)),
    ]);
  },
  onEnter: () => {
    rememberSettingsSection("/settings/connections");
  },
  component: Connections,
});

function Connections(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const types = listConnectionTypes(plugins);
  const [dialog, setDialog] = useState<ConnectionsDialog | null>(null);
  const closeDialog = (): void => {
    setDialog(null);
  };
  const findType = (connection: Connection): ConnectionType | undefined =>
    types.find((type) => type.type === connection.type);

  return (
    <>
      <SettingsHeaderActions>
        <AddConnectionMenu
          types={types}
          plugins={plugins}
          onPick={(type) => {
            setDialog({ kind: "setup", type });
          }}
        />
      </SettingsHeaderActions>
      <ConnectionTable
        connections={connections}
        types={types}
        plugins={plugins}
        onReconnect={(connection, type) => {
          setDialog({ kind: "setup", type, connection });
        }}
        onConfigure={(connection) => {
          setDialog({ kind: "configure", connection });
        }}
        onDelete={(connection) => {
          setDialog({ kind: "delete", connection });
        }}
      />
      {dialog?.kind === "setup" && (
        <ConnectionSetupDialog
          type={dialog.type}
          {...(dialog.connection === undefined ? {} : { connection: dialog.connection })}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "configure" && (
        <ConfigureConnectionDialog
          connection={dialog.connection}
          type={findType(dialog.connection)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteConnectionDialog
          connection={dialog.connection}
          type={findType(dialog.connection)}
          onClose={closeDialog}
        />
      )}
    </>
  );
}
