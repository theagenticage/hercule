import type { JSX, ReactNode } from "react";
import type { SettingsState } from "@hydra/contract";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

/** The frame every in-shell screen sits in: the sidebar, the top bar, the screen. */
export function Shell({
  settings,
  children,
}: {
  readonly settings: SettingsState;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-dvh">
      <Sidebar settings={settings} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar settings={settings} />
        <main className="flex flex-1 flex-col px-8 pt-4 pb-28">{children}</main>
      </div>
    </div>
  );
}
