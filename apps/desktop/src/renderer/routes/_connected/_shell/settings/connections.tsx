import { useState, type JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  describeConnectionTypeName,
  listConnectionTypes,
  readErrorMessage,
  type ConnectionType,
} from "@hercule/client-core";
import type { Connection } from "@hercule/contract";
import { rememberSettingsSection } from "../../../../app/last-settings-section";
import {
  connectionsQuery,
  eventCountsQuery,
  pluginsQuery,
  readOnOpen,
} from "../../../../app/queries";
import { AddConnectionMenu, ConnectionTable } from "../../../../screens/settings/connections";
import { SettingsHeaderActions } from "../../../../screens/settings/settings-frame";
import { ConfigureConnectionDialog } from "./-configure-connection-dialog";
import { ConnectionSetupDialog } from "./-connection-setup-dialog";
import { DeleteConnectionDialog } from "./-delete-connection-dialog";

/**
 * The dialog open over the Connections table, if any:
 *
 * - `setup`: sets up a new Connection of `type`, or, with `connectionId`,
 *   gives that Connection a fresh credential (Reconnect).
 * - `configure`: edits the Connection's name, topic, settings and polling.
 * - `delete`: asks before the Connection is removed.
 *
 * A dialog holds its Connection's id, not the Connection, so it always
 * shows the Connection as the live list holds it now. `connectionName` is
 * the Connection's name as its row showed it when the dialog opened, kept
 * to say which Connection went if it is removed while the dialog is open.
 */
type ConnectionsDialog =
  | {
      readonly kind: "setup";
      readonly type: ConnectionType;
      readonly connectionId?: string;
      readonly connectionName?: string;
    }
  | {
      readonly kind: "configure" | "delete";
      readonly connectionId: string;
      readonly connectionName: string;
    };

/**
 * Settings > Connections: a strip of counts, then one table of every
 * Connection, with its type, its account, its events of the last 24 hours
 * and its health, and a ⋯ menu to reconnect, configure or delete it. The
 * header's Add a Connection button lists the Connection types the plugins
 * declare and opens the chosen type's setup (spec 17 §Settings, Connections).
 *
 * The Connections and the plugins are the shell's reads, which the live
 * connection keeps current on the `connection` and `plugin` topics, so a
 * Connection added, changed or removed anywhere shows here at once. The
 * event counts are read each time the section opens and are not kept
 * current while it is open. A failed read of the counts leaves the table
 * usable, without them, and a line above it says why: Reconnect, Configure
 * and Delete must not depend on a summary. When
 * the Connection a dialog is open for is removed elsewhere, the dialog
 * closes and a line above the table says why.
 */
export const Route = createFileRoute("/_connected/_shell/settings/connections")({
  staticData: { title: "Connections" },
  loader: async ({ context: { controller, queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(connectionsQuery(controller.client)),
      queryClient.ensureQueryData(pluginsQuery(controller.client)),
      // A failure shows in the section, which reads the counts again
      // itself, so it must not fail the route.
      readOnOpen(queryClient, eventCountsQuery(controller.client)).catch(() => undefined),
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
  const countsRead = useQuery(eventCountsQuery(client));
  const types = listConnectionTypes(plugins);
  const [dialog, setDialog] = useState<ConnectionsDialog | null>(null);
  // A dialog closes only itself: a reply that lands after the user closed a
  // dialog, such as a late Delete, must not close the one opened since.
  const closeDialog = (closing: ConnectionsDialog): void => {
    setDialog((current) => (current === closing ? null : current));
  };
  const findType = (connection: Connection): ConnectionType | undefined =>
    types.find((type) => type.type === connection.type);
  const nameConnection = (connection: Connection): string =>
    `${describeConnectionTypeName(connection, findType(connection))} · ${connection.label}`;
  const connection =
    dialog?.connectionId === undefined
      ? undefined
      : connections.find(({ id }) => id === dialog.connectionId);
  const removedName =
    dialog?.connectionId !== undefined && connection === undefined
      ? dialog.connectionName
      : undefined;

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
      {countsRead.error !== null && (
        <p className="set-err" role="alert">
          {`Could not read the event counts: ${readErrorMessage(countsRead.error)}`}
        </p>
      )}
      {removedName !== undefined && (
        <p className="set-note" role="status">
          {`${removedName} was deleted elsewhere, so its dialog closed.`}
        </p>
      )}
      <ConnectionTable
        connections={connections}
        counts={countsRead.data}
        types={types}
        plugins={plugins}
        onReconnect={(picked, type) => {
          setDialog({
            kind: "setup",
            type,
            connectionId: picked.id,
            connectionName: nameConnection(picked),
          });
        }}
        onConfigure={(picked) => {
          setDialog({
            kind: "configure",
            connectionId: picked.id,
            connectionName: nameConnection(picked),
          });
        }}
        onDelete={(picked) => {
          setDialog({
            kind: "delete",
            connectionId: picked.id,
            connectionName: nameConnection(picked),
          });
        }}
      />
      {dialog?.kind === "setup" && removedName === undefined && (
        <ConnectionSetupDialog
          type={dialog.type}
          {...(connection === undefined ? {} : { connection })}
          onClose={() => {
            closeDialog(dialog);
          }}
        />
      )}
      {dialog?.kind === "configure" && connection !== undefined && (
        <ConfigureConnectionDialog
          connection={connection}
          type={findType(connection)}
          onClose={() => {
            closeDialog(dialog);
          }}
        />
      )}
      {dialog?.kind === "delete" && connection !== undefined && (
        <DeleteConnectionDialog
          connection={connection}
          type={findType(connection)}
          onClose={() => {
            closeDialog(dialog);
          }}
        />
      )}
    </>
  );
}
