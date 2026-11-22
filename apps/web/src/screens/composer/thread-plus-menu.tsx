import { useState, type JSX } from "react";
import type { HerculeClient, Live, Thread, ThreadChoice, ThreadPicks } from "@hercule/client-core";
import type { PluginDetail, Project } from "@hercule/contract";
import { PlusMenu } from "./plus-menu";
import { ThreadServerPicker } from "./thread-server-picker";
import { ThreadServersMenu } from "./thread-servers-menu";
import { useThreadServers } from "./use-thread-servers";

/**
 * The composer's `+` menu wired to the thread's MCP servers: the `PlusMenu`
 * with the submenu "Servers of this thread" and the picker that opens from it.
 * This is the one place the composer touches MCP servers. The composer owns
 * whether the menu is open, so opening one of its selectors closes this menu.
 *
 * The servers are read when the MCP row opens its submenu or the picker
 * opens, not when the `+` menu does: the menu is also how an image is
 * attached.
 *
 * Opening "N more servers…" closes the menu and opens the picker, which is
 * drawn until the user is done. A refusal of a write belongs to the thread's
 * list, not to the control that started the write, so it shows under the
 * submenu or in the picker, whichever is open when it arrives. It is
 * forgotten when the user closes the menu or the picker having seen it, or
 * when the next write starts.
 */
export function ThreadPlusMenu({
  client,
  live,
  thread,
  projectId,
  projects,
  defaultIds,
  picks,
  recordThreadChoice,
  plugins,
  open,
  onOpenChange,
  attachDisabledReason,
  serversOffReason,
  onFiles,
}: {
  readonly client: HerculeClient;
  readonly live: Live;
  readonly thread: Thread;
  /** The project the thread is in (`null` for none), as the composer resolved it. */
  readonly projectId: string | null;
  readonly projects: readonly Project[];
  /** The ids of the setting `thread.mcpServerIds`. */
  readonly defaultIds: readonly string[];
  readonly picks: ThreadPicks;
  readonly recordThreadChoice: (choice: ThreadChoice) => void;
  readonly plugins: readonly PluginDetail[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Why no image can be attached, or `null` when one can. */
  readonly attachDisabledReason: string | null;
  /** Why the MCP servers row is off, or `null` when it works. */
  readonly serversOffReason: string | null;
  readonly onFiles: (files: readonly File[]) => void;
}): JSX.Element {
  // Whether the picker is open. It opens from the `+` menu, which closes.
  const [picking, setPicking] = useState(false);
  // Whether the MCP row has opened its submenu. It closes with the menu,
  // however the menu closes: the composer closes it when one of its selectors opens.
  const [showsServers, setShowsServers] = useState(false);
  if (!open && showsServers) setShowsServers(false);
  const servers = useThreadServers({
    client,
    live,
    thread,
    projectId,
    projects,
    defaultIds,
    picks,
    recordThreadChoice,
    wanted: showsServers || picking,
  });

  // A refusal is forgotten once the user has seen it and closes the control.
  // While a write runs, its refusal has not arrived yet, so it is kept.
  const forgetSeenRefusal = (): void => {
    if (!servers.writing) servers.clearRefusal();
  };
  const handleOpenChange = (next: boolean): void => {
    if (!next) forgetSeenRefusal();
    onOpenChange(next);
  };

  return (
    <>
      <PlusMenu
        open={open}
        onOpenChange={handleOpenChange}
        attachDisabledReason={attachDisabledReason}
        serversOffReason={serversOffReason}
        onFiles={onFiles}
        serversRow={servers.row}
        serversOpen={showsServers}
        onServersOpenChange={setShowsServers}
        submenu={
          servers.views !== undefined && servers.start !== undefined ? (
            <ThreadServersMenu
              views={servers.views}
              plugins={plugins}
              mcpServerIds={servers.mcpServerIds}
              start={servers.start}
              writing={servers.writing}
              refusal={servers.refusal}
              onChoose={servers.apply}
              onOpenPicker={() => {
                setPicking(true);
                onOpenChange(false);
              }}
            />
          ) : (
            <p
              className={
                servers.readFailure === null ? "px-2 py-1.5 text-faint" : "px-2 py-1.5 text-fail"
              }
              role={servers.readFailure === null ? "status" : "alert"}
            >
              {servers.readFailure ?? "Reading servers…"}
            </p>
          )
        }
      />
      {picking && servers.views !== undefined && servers.start !== undefined ? (
        <ThreadServerPicker
          views={servers.views}
          plugins={plugins}
          mcpServerIds={servers.mcpServerIds}
          start={servers.start}
          writing={servers.writing}
          refusal={servers.refusal}
          onChoose={servers.apply}
          onClose={() => {
            setPicking(false);
            forgetSeenRefusal();
          }}
        />
      ) : null}
    </>
  );
}
