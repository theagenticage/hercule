import type { JSX, ReactNode } from "react";
import { Sidebar } from "./sidebar";
import "./shell.css";

/**
 * Renders the shell: the sidebar on the left, and beside it the main pane,
 * which holds the open screen (`children`). The shell fills the window and
 * never scrolls itself.
 *
 * The shell owns the main pane's drag strip, so every screen can be dragged by
 * its top edge without drawing anything for it. The strip comes first, so a
 * screen's controls that sit over it come later in the document, and their
 * `no-drag` takes precedence over the strip's `drag`.
 */
export function Shell({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <div className="drag-strip" />
        {children}
      </main>
    </div>
  );
}
