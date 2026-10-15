/**
 * The floating header of a page that lists items grouped by project: the
 * Discussions page and the Wiki page.
 */
import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { SidebarIcon } from "../../icons/sidebar";
import type { ListPaneWidth } from "./list-with-open-pane";
import "../session/floating-header.css";
import "../workflows/workflow-list.css";

/**
 * Renders the header at the list's `width`:
 *
 * - over the table, the page's `title` in a pill;
 * - over an open item, the button that hides the list in the column, or
 *   shows it when the item fills the pane, calling `onToggleList`, then the
 *   page's `title` as a tab that leads back to the table at `to`.
 */
export function ListPageHeader({
  title,
  to,
  width,
  onToggleList,
}: {
  readonly title: string;
  readonly to: "/discussions" | "/wiki";
  readonly width: ListPaneWidth;
  readonly onToggleList: () => void;
}): JSX.Element {
  if (width === "table") {
    return (
      <div className="top">
        <nav className="pill" aria-label={title}>
          <h1 className="pill-title">{title}</h1>
        </nav>
      </div>
    );
  }
  const toggleLabel = width === "column" ? "Hide the list" : "Show the list";
  return (
    <div className="top">
      <nav className="pill" aria-label={title}>
        <button
          type="button"
          className="icon-btn list-btn"
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={onToggleList}
        >
          <SidebarIcon />
        </button>
        {/* Exact, so the tab is not marked as the current page while an
            item under the page is open. */}
        <Link to={to} className="ptab pill-back" activeOptions={{ exact: true }}>
          {title}
        </Link>
      </nav>
    </div>
  );
}
