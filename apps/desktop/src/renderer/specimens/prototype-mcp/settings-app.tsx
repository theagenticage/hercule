/**
 * PROTOTYPE, throwaway. The Settings side of the MCP prototype: MCP servers
 * and Connections in a copy of the Settings frame, with the dialogs they
 * open. Which page and which server are open is in the page's URL.
 */
import { useState, type JSX } from "react";
import { PlusIcon } from "../../icons/plus";
import { ConnectionsPage } from "./connections";
import { AddServerDialog, ReconnectDialog, RemoveDialog, ReplaceDialog } from "./dialogs";
import { isFailing, useParam, writeParams } from "./parts";
import { ServerPickerDialog, type PickerTarget } from "./picker";
import { ServerPage, ServersPage, type ServerActions } from "./servers";
import { SettingsFrame, type SettingsPage } from "./settings-frame";
import {
  describeServerName,
  findConnectionServer,
  findHandAddedTwin,
  findServerConnection,
  finishCheck,
  setDefaultServerIds,
  switchOnConnectionServer,
  useWorld,
  type Conn,
  type Server,
} from "./world";

type Dialog =
  | { readonly kind: "add" }
  | { readonly kind: "resume"; readonly serverId: string }
  | { readonly kind: "replace"; readonly connectionId: string; readonly serverId: string }
  | { readonly kind: "remove"; readonly serverId: string }
  | { readonly kind: "reconnect"; readonly serverId: string }
  /** The picker of the servers a thread with no project starts with. */
  | { readonly kind: "picker" };

export function SettingsApp(): JSX.Element {
  const w = useWorld();
  const scene = useParam("scene", "servers");
  const page = useParam(
    "page",
    scene === "connections" ? "connections" : "servers",
  ) as SettingsPage;
  const openId = useParam("open", "");
  const keepsDefaultList = useParam("np", "default") === "default";
  const [dialog, setDialog] = useState<Dialog | null>(scene === "add" ? { kind: "add" } : null);

  const open = page === "servers" ? w.servers.find((server) => server.id === openId) : undefined;
  const openServer = (serverId: string): void => {
    writeParams({ page: "servers", open: serverId });
  };
  const findServer = (id: string): Server | undefined => w.servers.find((each) => each.id === id);
  const findConn = (id: string): Conn | undefined => w.connections.find((each) => each.id === id);

  const actions: ServerActions = {
    onOpen: openServer,
    onAdd: () => {
      setDialog({ kind: "add" });
    },
    onSwitchOn: (connection) => {
      const twin = findHandAddedTwin(w, connection);
      if (twin !== undefined) {
        setDialog({ kind: "replace", connectionId: connection.id, serverId: twin.id });
      } else switchOnConnectionServer(connection.id);
    },
    onFix: (server) => {
      if (server.status === "unreachable") finishCheck(server.id);
      else if (findServerConnection(w, server) !== undefined) {
        setDialog({ kind: "reconnect", serverId: server.id });
      } else setDialog({ kind: "resume", serverId: server.id });
    },
    onRemove: (server) => {
      setDialog({ kind: "remove", serverId: server.id });
    },
    onOpenConnections: () => {
      writeParams({ page: "connections", open: null });
    },
    onChangeDefault: () => {
      setDialog({ kind: "picker" });
    },
  };

  const dots = new Set<SettingsPage>();
  if (w.connections.some((connection) => connection.failing !== null)) dots.add("connections");
  if (w.servers.some((server) => isFailing(server.status))) dots.add("servers");

  const closeDialog = (): void => {
    setDialog(null);
  };
  const dialogServer =
    dialog !== null && "serverId" in dialog ? findServer(dialog.serverId) : undefined;
  const dialogConnection =
    dialog !== null && "connectionId" in dialog ? findConn(dialog.connectionId) : undefined;

  const pickerTarget: PickerTarget | undefined =
    dialog?.kind !== "picker"
      ? undefined
      : {
          title: "MCP servers of threads without a project",
          ids: w.defaultServerIds,
          onChange: setDefaultServerIds,
          foot: "Threads started in no project from now on. A thread can still change its own.",
        };

  return (
    <>
      <SettingsFrame
        page={page}
        title={
          open === undefined
            ? page === "servers"
              ? "MCP servers"
              : "Connections"
            : describeServerName(w, open)
        }
        parent={
          open === undefined
            ? undefined
            : {
                title: "MCP servers",
                onOpen: () => {
                  writeParams({ open: null });
                },
              }
        }
        dots={dots}
        onPage={(next) => {
          writeParams({ page: next, open: null });
        }}
        actions={
          page === "connections" ? (
            <button type="button" className="btn btn--sm add-conn">
              <PlusIcon size={14} />
              Add a Connection
            </button>
          ) : null
        }
      >
        {page === "connections" ? (
          <ConnectionsPage
            w={w}
            onOpenTools={(connection) => {
              const server = findConnectionServer(w, connection.id);
              writeParams({ page: "servers", open: server?.id ?? null });
            }}
          />
        ) : open !== undefined ? (
          <ServerPage
            key={open.id}
            w={w}
            server={open}
            keepsDefaultList={keepsDefaultList}
            opensOnProjects={scene === "project"}
            actions={actions}
          />
        ) : (
          <ServersPage w={w} keepsDefaultList={keepsDefaultList} actions={actions} />
        )}
      </SettingsFrame>

      {dialog?.kind === "add" && (
        <AddServerDialog
          w={w}
          onClose={closeDialog}
          onOpenServer={openServer}
          onOpenConnections={actions.onOpenConnections}
        />
      )}
      {dialog?.kind === "resume" && dialogServer !== undefined && (
        <AddServerDialog
          w={w}
          resume={dialogServer}
          onClose={closeDialog}
          onOpenServer={openServer}
          onOpenConnections={actions.onOpenConnections}
        />
      )}
      {dialog?.kind === "replace" &&
        dialogServer !== undefined &&
        dialogConnection !== undefined && (
          <ReplaceDialog
            w={w}
            connection={dialogConnection}
            server={dialogServer}
            onClose={closeDialog}
          />
        )}
      {dialog?.kind === "remove" && dialogServer !== undefined && (
        <RemoveDialog
          w={w}
          server={dialogServer}
          onClose={closeDialog}
          onRemoved={() => {
            writeParams({ open: null });
          }}
        />
      )}
      {dialog?.kind === "reconnect" && dialogServer !== undefined && (
        <ReconnectDialog
          connection={findServerConnection(w, dialogServer)!}
          server={dialogServer}
          onClose={closeDialog}
        />
      )}
      {pickerTarget !== undefined && (
        <ServerPickerDialog w={w} target={pickerTarget} onClose={closeDialog} />
      )}
    </>
  );
}
