import type { JSX, ReactNode } from "react";
import { useMatches } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient, Live } from "@hercule/client-core";
import type { SettingsState } from "@hercule/contract";
import { cn } from "@hercule/ui";
import { prototypeHooks } from "../screens/thread/prototype-hooks";
import { Sidebar } from "./sidebar";
import { TopBar, ownsItsTopBar } from "./top-bar";

/**
 * Renders the frame every in-shell screen sits in: the sidebar, the top bar,
 * the screen.
 *
 * The frame is exactly one window high, and only `main` scrolls. The sidebar
 * and the top bar therefore never move, and a screen that draws its own header
 * keeps it in view with `sticky`. The router scrolls `main` back to the top on
 * every navigation (see `createAppRouter`).
 */
export function Shell({
  settings,
  client,
  queryClient,
  live,
  children,
}: {
  readonly settings: SettingsState;
  readonly client: HerculeClient;
  readonly queryClient: QueryClient;
  readonly live: Live;
  readonly children: ReactNode;
}): JSX.Element {
  // A screen that draws its own top bar also sets its own padding. The
  // shell's padding would otherwise sit between that header and the window edge.
  const bare = ownsItsTopBar(useMatches());

  return (
    <div className="flex h-dvh">
      <Sidebar settings={settings} client={client} queryClient={queryClient} live={live} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar settings={settings} />
        <main
          className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", !bare && "px-8 pt-4 pb-28")}
        >
          {children}
        </main>
      </div>
      {/* PROTOTYPE (#354): the side pane. */}
      {prototypeHooks.renderSidePane?.()}
    </div>
  );
}
