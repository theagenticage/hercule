import type { JSX, ReactNode } from "react";
import { Sidebar } from "./sidebar";
import "./shell.css";

/**
 * Renders the shell: the sidebar on the left, and beside it the main pane,
 * which holds the open screen (`children`). The shell fills the window and
 * never scrolls itself. The sidebar's New thread calls `onNewThread`.
 *
 * The shell owns the window's drag strip, the band along the top of the
 * window by which it is dragged, as by a title bar. No other element in the
 * shell is a drag region, so the sidebar and every screen can be dragged by
 * their top edge without drawing anything for it. The strip comes first in
 * the document, so a control that sits over it comes later, and its
 * `no-drag` takes precedence over the strip's `drag`.
 */
export function Shell({
  onNewThread,
  children,
  assistants,
}: {
  readonly onNewThread: () => void;
  readonly children: ReactNode;
  /** PROTOTYPE (#448): the sidebar's Assistants section. */
  readonly assistants?: ReactNode;
}): JSX.Element {
  return (
    <div className="app">
      <div className="drag-strip" />
      <Sidebar onNewThread={onNewThread} assistants={assistants} />
      <main className="main">{children}</main>
    </div>
  );
}
