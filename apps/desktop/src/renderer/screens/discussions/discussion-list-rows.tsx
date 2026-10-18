/**
 * The items of the Discussions list: a Discussion's row at each of the list's
 * two widths, with the table's column heads (spec 19 section 8.2). The
 * project and repository headings are the grouped list's
 * (`ProjectGroupedList`).
 *
 * Each row is a link to the Discussion that draws itself at the height and
 * the space above it the list gives it (`RowPlace`), and carries `data-key`,
 * by which the list keeps the focused row mounted. The rows are memoized and
 * take only strings, numbers and booleans, so when a push builds the Discussions again,
 * only the rows whose values changed draw again.
 */
import { memo, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { describePostsAndSessions, stripCodeMarks } from "@hercule/client-core/discussion-text";
import type { DiscussionKind } from "@hercule/contract";
import { useListTime } from "../workflows/list-time";
import { SELECTED_LINK_PROPS } from "../selected-link-props";
import { InlineCode } from "../inline-code";
import { OverlapMark } from "./overlap-mark";
import "./discussions.css";

/** The size of the overlap mark in a row, in CSS pixels. */
const MARK_SIZE = 14;

/**
 * Renders the column heads, in the rows' grid. They are hidden from assistive
 * technology: the rows are links, not table rows, and each row's label
 * already names what its cells hold.
 */
export function DiscussionTableHeads(): JSX.Element {
  return (
    <div className="table-heads" aria-hidden="true">
      <span></span>
      <span>Subject</span>
      <span className="table-num">Sessions</span>
      <span className="table-num">Posts</span>
      <span className="table-num">Last post</span>
    </div>
  );
}

/** The values a Discussion's row draws, at either width. */
interface DiscussionRowProps {
  readonly itemKey: string;
  readonly discussionId: string;
  readonly kind: DiscussionKind;
  readonly subject: string;
  readonly participantCount: number;
  readonly postCount: number;
  readonly lastPostAt: string;
  /** The time zone the time is shown in. */
  readonly timezone: string;
  /** Where the list puts the row, as `RowPlace` gives it. */
  readonly marginTop: number;
  readonly height: number;
  /** Whether the row is in the visible part of the list, which keeps its time current. */
  readonly onScreen: boolean;
}

/**
 * Renders a Discussion's row in the table: a link to the Discussion. Its
 * cells are the overlap mark, or an empty place for a general Discussion,
 * the subject, how many sessions took part, how many Posts it holds, and
 * when the last one was written.
 */
export const DiscussionTableRow = memo(function DiscussionTableRow({
  itemKey,
  discussionId,
  kind,
  subject,
  participantCount,
  postCount,
  lastPostAt,
  timezone,
  marginTop,
  height,
  onScreen,
}: DiscussionRowProps): JSX.Element {
  const lastPost = useListTime(lastPostAt, timezone, "past", onScreen);
  return (
    <Link
      to="/discussions/$discussionId"
      params={{ discussionId }}
      className="table-row"
      activeProps={SELECTED_LINK_PROPS}
      data-key={itemKey}
      style={{ marginTop, height }}
      aria-label={stripCodeMarks(subject)}
    >
      {kind === "overlap" ? <OverlapMark size={MARK_SIZE} /> : <span></span>}
      <span className="table-name">
        <InlineCode text={subject} />
      </span>
      <span className="table-num">{participantCount}</span>
      <span className="table-num">{postCount}</span>
      <span className="table-num">{lastPost}</span>
    </Link>
  );
});

/**
 * Renders a Discussion's row in the column beside the open Discussion: a link
 * to the Discussion, selected while it is open, drawn as the sidebar's
 * two-line row. Its parts are the overlap mark, the subject over how many
 * Posts and sessions the Discussion holds, and when its last Post was
 * written.
 */
export const DiscussionColumnRow = memo(function DiscussionColumnRow({
  itemKey,
  discussionId,
  kind,
  subject,
  participantCount,
  postCount,
  lastPostAt,
  timezone,
  marginTop,
  height,
  onScreen,
}: DiscussionRowProps): JSX.Element {
  const lastPost = useListTime(lastPostAt, timezone, "past", onScreen);
  return (
    <Link
      to="/discussions/$discussionId"
      params={{ discussionId }}
      className="column-row"
      activeProps={SELECTED_LINK_PROPS}
      data-key={itemKey}
      style={{ marginTop, height }}
      aria-label={stripCodeMarks(subject)}
    >
      <span className="column-mark">
        {kind === "overlap" ? <OverlapMark size={MARK_SIZE} /> : null}
      </span>
      <span className="column-text">
        {/* The column is narrow, so a long subject ends in an ellipsis; the
            title attribute shows the whole one on hover. */}
        <span className="column-name" title={stripCodeMarks(subject)}>
          <InlineCode text={subject} />
        </span>
        <span className="column-meta">
          {describePostsAndSessions({ participantCount, postCount })}
        </span>
      </span>
      <span className="column-time">{lastPost}</span>
    </Link>
  );
});
