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
 * Opening "N more servers…" closes the menu and opens the picker, which is
 * drawn until the user is done. A refusal of a write is shown under the
 * submenu, or in the picker, whichever made it, and does not outlive that
 * menu.
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
  readonly onFiles: (files: readonly File[]) => void;
}): JSX.Element {
  // Whether the picker is open. It opens from the `+` menu, which closes.
  const [picking, setPicking] = useState(false);
  const servers = useThreadServers({
    client,
    live,
    thread,
    projectId,
    projects,
    defaultIds,
    picks,
    recordThreadChoice,
    wanted: open || picking,
  });

  const handleOpenChange = (next: boolean): void => {
    // A refusal belongs to the menu that made it, so it does not outlive that menu.
    if (!next) servers.clearRefusal();
    onOpenChange(next);
  };

  return (
    <>
      <PlusMenu
        open={open}
        onOpenChange={handleOpenChange}
        attachDisabledReason={attachDisabledReason}
        onFiles={onFiles}
        serversRow={servers.row}
        submenu={
          servers.views !== undefined && servers.start !== undefined ? (
            <ThreadServersMenu
              views={servers.views}
              plugins={plugins}
              mcpServerIds={servers.mcpServerIds}
              start={servers.start}
              writing={servers.writing}
              refusal={servers.refusal}
              onChoose={servers.chooseServer}
              onReset={servers.setList}
              onOpenPicker={() => {
                setPicking(true);
                handleOpenChange(false);
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
          onChange={servers.setList}
          onClose={() => {
            setPicking(false);
          }}
        />
      ) : null}
    </>
  );
}
