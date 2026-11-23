import { useEffect, useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HerculeClient, Thread, ThreadChoice } from "@hercule/client-core";
import type { McpServer } from "@hercule/contract";
import { decideDraftServersPick, type McpListChoice } from "@hercule/client-core/mcp-servers";
import { buildMcpListCache, useMcpListEdit } from "../../app/mcp-list-edits";
import { TokenDialog } from "../mcp-url-server/token-dialog";
import { useThreadServers } from "../thread-servers";
import { PlusMenu } from "./plus-menu";
import { ThreadServerPicker } from "./thread-server-picker";
import { ThreadServersMenu } from "./thread-servers-menu";

/**
 * The composer's `+` menu wired to the thread's MCP servers: the `PlusMenu`
 * with the submenu "Servers of this thread" and the picker that opens from it.
 * This is the one place the composer touches MCP servers. The composer owns
 * whether the menu is open, so opening one of its selectors closes this menu.
 *
 * What the thread knows of its servers comes from the open thread's provider
 * (see `ThreadServersProvider`). This component tells it when the MCP row or
 * the picker is open, which is when the servers are read, not when the `+`
 * menu opens: the menu is also how an image is attached. It stays open from
 * the submenu to the picker.
 *
 * How a change is made depends on the thread. A Draft Thread keeps its list
 * as a pick, recorded with `recordThreadChoice` after the rules decided it. A
 * started thread edits its list at once (see `useMcpListEdit`). Each change is
 * a choice, resolved against the session in the cache when the edit runs, so
 * two quick changes never overwrite each other. One edit runs at a time for
 * the session, whichever menu or picker started it, and the guard survives
 * closing and opening them: `writing` stays true until the session has been
 * read again, and, when that read fails, until a read succeeds. A refusal is
 * `refusal`, and the list stays as the controller holds it.
 *
 * Opening "N more servers…" closes the menu and opens the picker, which is
 * drawn until the user is done. A refusal of a write belongs to the thread's
 * list, not to the control that started the write, so it shows under the
 * submenu or in the picker, whichever is open when it arrives. It stays
 * through closing, opening again and the handoff from the submenu to the
 * picker, and is forgotten when the next write starts.
 */
export function ThreadPlusMenu({
  client,
  thread,
  projectId,
  recordThreadChoice,
  open,
  onOpenChange,
  attachDisabledReason,
  serversOffReason,
  onFiles,
}: {
  readonly client: HerculeClient;
  readonly thread: Thread;
  /** The project the thread is in (`null` for none), as the composer resolved it. */
  readonly projectId: string | null;
  readonly recordThreadChoice: (choice: ThreadChoice) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Why no image can be attached, or `null` when one can. */
  readonly attachDisabledReason: string | null;
  /** Why the MCP servers row is off, or `null` when it works. */
  readonly serversOffReason: string | null;
  readonly onFiles: (files: readonly File[]) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { described, start, views, plugins, readFailure, setEditing } = useThreadServers();
  // Whether the picker is open. It opens from the `+` menu, which closes.
  const [picking, setPicking] = useState(false);
  // Whether the MCP row was pressed since the menu last opened. The submenu
  // shows only while the menu does, which is how it closes with the menu,
  // however the menu closes: the composer closes it when one of its selectors
  // opens. Opening the menu forgets the press.
  const [serversPressed, setServersPressed] = useState(false);
  const showsServers = open && serversPressed;
  const changeOpen = (next: boolean): void => {
    if (next) setServersPressed(false);
    onOpenChange(next);
  };
  // The server added by URL whose token dialog is open, as the submenu showed it. It opens from
  // the submenu, which closes. The dialog is kept by the id until the user closes it, also when a
  // live change deletes the server or moves it onto a Connection: the dialog then says so.
  const [signingIn, setSigningIn] = useState<McpServer | null>(null);
  // One state for the submenu and the picker, so the handoff from one to the other never drops it.
  // The open sign-in dialog needs the live topic as well, which follows the server it signs in to.
  const editing = showsServers || picking || signingIn !== null;
  useEffect(() => {
    setEditing(editing);
    return () => {
      setEditing(false);
    };
  }, [editing, setEditing]);

  const session = thread.kind === "active" ? thread.session : null;
  const edit = useMcpListEdit(client, {
    kind: "thread",
    sessionId: session?.id ?? "",
    projectId,
  });
  // A Draft Thread writes nothing: its choice is decided by the same rules and recorded with the
  // draft's other picks.
  const applyToDraft = (choice: McpListChoice): void => {
    const cache = buildMcpListCache(queryClient, client);
    const servers = cache.readServers();
    if (servers === undefined) return;
    const picked = decideDraftServersPick({
      projectId,
      ids: described.mcpServerIds,
      servers,
      ...cache.readStartRecords(projectId),
      choice,
    });
    if (picked !== undefined) recordThreadChoice(picked);
  };
  const apply = session === null ? applyToDraft : edit.apply;
  // The newest record of the server the dialog was opened for, or the one it opened with once the list lost it.
  const signingInServer =
    signingIn === null
      ? null
      : (views?.find((view) => view.server.id === signingIn.id)?.server ?? signingIn);
  const refusal = edit.problem();

  return (
    <>
      <PlusMenu
        open={open}
        onOpenChange={changeOpen}
        attachDisabledReason={attachDisabledReason}
        serversOffReason={serversOffReason}
        onFiles={onFiles}
        serversRow={described.row}
        serversOpen={showsServers}
        onServersOpenChange={setServersPressed}
        submenu={
          views !== undefined && plugins !== undefined && start !== undefined ? (
            <ThreadServersMenu
              views={views}
              plugins={plugins}
              mcpServerIds={described.mcpServerIds}
              start={start}
              writing={edit.blocked}
              refusal={refusal}
              onChoose={apply}
              onOpenPicker={() => {
                setPicking(true);
                onOpenChange(false);
              }}
              onSignIn={(mcpServerId) => {
                setSigningIn(views.find((view) => view.server.id === mcpServerId)?.server ?? null);
                onOpenChange(false);
              }}
            />
          ) : (
            <p
              className={readFailure === null ? "px-2 py-1.5 text-faint" : "px-2 py-1.5 text-fail"}
              role={readFailure === null ? "status" : "alert"}
            >
              {readFailure ?? "Reading servers…"}
            </p>
          )
        }
      />
      {signingInServer === null ? null : (
        <TokenDialog
          client={client}
          server={signingInServer}
          openedOn="elsewhere"
          entry="sign-in"
          onClose={() => {
            setSigningIn(null);
          }}
        />
      )}
      {picking && views !== undefined && plugins !== undefined && start !== undefined ? (
        <ThreadServerPicker
          views={views}
          plugins={plugins}
          mcpServerIds={described.mcpServerIds}
          start={start}
          writing={edit.blocked}
          refusal={refusal}
          onChoose={apply}
          onClose={() => {
            setPicking(false);
          }}
        />
      ) : null}
    </>
  );
}
