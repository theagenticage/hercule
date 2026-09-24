import type { JSX, ReactNode } from "react";
import { useMatches } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient, Live } from "@hercule/client-core";
import type { SettingsState } from "@hercule/contract";
import { Sidebar } from "./sidebar";
import { TopBar, ownsItsTopBar } from "./top-bar";

/** The frame every in-shell screen sits in: the sidebar, the top bar, the screen. */
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
    <div className="flex min-h-dvh">
      <Sidebar settings={settings} client={client} queryClient={queryClient} live={live} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar settings={settings} />
        <main className={bare ? "flex flex-1 flex-col" : "flex flex-1 flex-col px-8 pt-4 pb-28"}>
          {children}
        </main>
      </div>
    </div>
  );
}
