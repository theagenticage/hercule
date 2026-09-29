import type { JSX } from "react";
import "./sidebar.css";

/**
 * Renders the sidebar. For now it holds only its top strip, where macOS draws
 * the window's traffic lights. The shell's drag strip covers it, so dragging
 * it moves the window, as a title bar does.
 */
export function Sidebar(): JSX.Element {
  return (
    <aside className="side">
      <div className="side-top" />
    </aside>
  );
}
