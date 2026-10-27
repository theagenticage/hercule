/**
 * The items of the Wiki list: a page's row at each of the list's two widths,
 * with the table's column heads (spec 19 section 8.2). The project and
 * repository headings are the grouped list's (`ProjectGroupedList`).
 *
 * Each row is a link to the page that draws itself the space above it the
 * list gives it (`RowPlace`) under the item above, at the height its CSS gives
 * it, and carries `data-key`, by which the list keeps the focused row
 * mounted. The rows are memoized and take only strings, numbers and booleans,
 * so when a push builds the pages again, only the rows whose values changed
 * draw again.
 */
import { memo, useId, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { Actor } from "@hercule/contract";
import { ActorMark, ActorName } from "../actor/actor-mark";
import { useListTime } from "../workflows/list-time";
import { SELECTED_LINK_PROPS } from "../selected-link-props";
import "./wiki.css";

/** The size of a mark in the table's "Changed by" cell, in CSS pixels. */
const TABLE_MARK_SIZE = 18;

/** The size of a mark in the column's rows, in CSS pixels: the slot a thread's face takes in the sidebar. */
const COLUMN_MARK_SIZE = 24;

/**
 * Renders the column heads, in the rows' grid. They are hidden from assistive
 * technology: the rows are links, not table rows, and each row's title and
 * summary already name what its cells hold.
 */
export function WikiTableHeads(): JSX.Element {
  return (
    <div className="table-heads" aria-hidden="true">
      <span>Page</span>
      <span>Changed by</span>
      <span className="table-num">Changed</span>
    </div>
  );
}

/** The values a page's row draws, at either width. */
interface WikiRowProps {
  readonly itemKey: string;
  readonly pageId: string;
  readonly title: string;
  readonly summary: string;
  /** The actor of the page's current revision. */
  readonly updatedBy: Actor;
  /** When the page's current revision was written. */
  readonly updatedAt: string;
  /** The time zone the time is shown in. */
  readonly timezone: string;
  /** Where the list puts the row, as `RowPlace` gives it. */
  readonly marginTop: number;
  /** Whether the row is in the visible part of the list, which keeps its time current. */
  readonly onScreen: boolean;
}

/**
 * Renders a page's row in the table: a link to the page. Its cells are the
 * title over the summary, who changed the page with their mark, and when.
 */
export const WikiTableRow = memo(function WikiTableRow({
  itemKey,
  pageId,
  title,
  summary,
  updatedBy,
  updatedAt,
  timezone,
  marginTop,
  onScreen,
}: WikiRowProps): JSX.Element {
  const summaryId = useId();
  const changed = useListTime(updatedAt, timezone, "past", onScreen);
  return (
    <Link
      to="/wiki/$pageId"
      params={{ pageId }}
      className="table-row"
      activeProps={SELECTED_LINK_PROPS}
      data-key={itemKey}
      style={{ marginTop }}
      aria-label={title}
      aria-describedby={summaryId}
    >
      <span className="table-name table-two">
        <span>{title}</span>
        <small id={summaryId}>{summary}</small>
      </span>
      <span className="who">
        <ActorMark actor={updatedBy} size={TABLE_MARK_SIZE} />
        <span>
          <ActorName actor={updatedBy} />
        </span>
      </span>
      <span className="table-num">{changed}</span>
    </Link>
  );
});

/**
 * Renders a page's row in the column beside the open page: a link to the page,
 * selected while the page is open, drawn as the sidebar's two-line row. Its
 * parts are the mark of who changed the page, its title over its summary, and
 * when.
 */
export const WikiColumnRow = memo(function WikiColumnRow({
  itemKey,
  pageId,
  title,
  summary,
  updatedBy,
  updatedAt,
  timezone,
  marginTop,
  onScreen,
}: WikiRowProps): JSX.Element {
  const summaryId = useId();
  const changed = useListTime(updatedAt, timezone, "past", onScreen);
  return (
    <Link
      to="/wiki/$pageId"
      params={{ pageId }}
      className="column-row"
      activeProps={SELECTED_LINK_PROPS}
      data-key={itemKey}
      style={{ marginTop }}
      aria-label={title}
      aria-describedby={summaryId}
    >
      <span className="column-mark">
        <ActorMark actor={updatedBy} size={COLUMN_MARK_SIZE} />
      </span>
      <span className="column-text">
        {/* The column is narrow, so a long title ends in an ellipsis; the
            title attribute shows the whole one on hover. */}
        <span className="column-name" title={title}>
          {title}
        </span>
        <span className="column-meta" id={summaryId}>
          {summary}
        </span>
      </span>
      <span className="column-time">{changed}</span>
    </Link>
  );
});
