/**
 * The items of the sidebar's thread list: section headers, workspace labels,
 * thread rows, the draft's row and "more" rows, drawn as the Bureau book's
 * crew.js draws them.
 *
 * Each item draws itself at its kind's fixed height, with the space above it
 * as its top margin. The list stacks the items one under another, so an item
 * that only moves down, because an item arrived above it, keeps every prop
 * and does not draw again. Every item takes only strings, numbers and stable
 * callbacks, and is memoized, so a change to one thread re-renders that
 * thread's rows and nothing else.
 *
 * Every item's root carries `data-key`, which the list uses to keep the
 * focused item mounted, and the class `side-item`, which the end-to-end tests
 * find the items by. Every item's root can take focus: rows are links or
 * buttons, and headings and the draft's row take focus from code only
 * (`tabIndex={-1}`), for when the focused item leaves the list.
 */
import { memo, useId, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { describePose, joinLabelText, type Pose } from "@hercule/client-core";
import { useAgeLabel, useAgeWords } from "../app/age-clock";
import { buildLook, Face } from "../faces";
import { PlusIcon } from "../icons";
import { Mark } from "../marks";
import { ProjectTile, type ProjectTint } from "../screens/project-tile";
import { ITEM_HEIGHTS, type RowEnd, type SectionKey } from "./sidebar-items";

/** What every item takes from the list: its key in the list, and the space above it. */
interface Placement {
  readonly itemKey: string;
  /** The space between this item and the one above it, in pixels. */
  readonly leading: number;
}

/**
 * The classes a thread's link adds while its thread is open. The router also
 * sets `aria-current="page"` on it then, so a thread listed twice is marked
 * in both places.
 */
const SELECTED = { className: "is-on" } as const;

/** Renders the Waiting on you heading, with the count of every waiting thread. */
export const WaitingHeader = memo(function WaitingHeader({
  itemKey,
  leading,
  count,
}: Placement & { readonly count: number }): JSX.Element {
  return (
    <h3
      className="side-h side-item"
      data-key={itemKey}
      tabIndex={-1}
      style={{ marginTop: leading, height: ITEM_HEIGHTS["waiting-header"] }}
    >
      {/* The space keeps the heading's name "Waiting on you 3", not "Waiting
          on you3". The heading is a flex box, which draws no space between
          its items, so the layout is the book's. */}
      <span>Waiting on you</span> <b className="count count--you">{count}</b>
    </h3>
  );
});

/**
 * Renders a thread in Waiting on you: its waiting face, its title and the
 * question it asks. The link is named "<title>, waiting on you" and described
 * by the question; the face is hidden, because the name already says the
 * state.
 */
export const WaitingRow = memo(function WaitingRow({
  itemKey,
  leading,
  sessionId,
  title,
  question,
}: Placement & {
  readonly sessionId: string;
  readonly title: string;
  readonly question: string;
}): JSX.Element {
  const questionId = useId();
  return (
    <Link
      to="/threads/$sessionId"
      params={{ sessionId }}
      className="side-row side-row--wait side-item"
      activeProps={SELECTED}
      data-key={itemKey}
      style={{ marginTop: leading, height: ITEM_HEIGHTS["waiting-row"] }}
      aria-label={`${title}, ${describePose("waiting")}`}
      aria-describedby={questionId}
    >
      <Face look={buildLook(sessionId)} pose="waiting" size={24} decorative />
      <span className="side-text">
        <span className="side-name">{title}</span>
        <span className="side-ask" id={questionId}>
          {question}
        </span>
      </span>
    </Link>
  );
});

/**
 * Renders a project's heading: the project's tile in its tint, its name, and
 * a `+` that opens a new thread in the project.
 *
 * The heading of the threads in no project (`projectId` and `tint` are
 * `null`) draws an empty outline where a project's tile sits, so its name
 * lines up with the other projects' names. Its `+` opens a new thread in no
 * project.
 */
export const ProjectHeader = memo(function ProjectHeader({
  itemKey,
  leading,
  projectId,
  name,
  tint,
}: Placement & {
  readonly projectId: string | null;
  readonly name: string;
  readonly tint: ProjectTint | null;
}): JSX.Element {
  return (
    <h3
      className="side-h side-h--proj side-item"
      data-key={itemKey}
      tabIndex={-1}
      style={{ marginTop: leading, height: ITEM_HEIGHTS["project-header"] }}
    >
      <ProjectTile tint={tint} name={name} />
      <Link
        to="/"
        search={projectId === null ? {} : { project: projectId }}
        // Marked as the current page only on its own draft. By default the
        // router also marks it on any draft whose search holds its own, so
        // the no-project + would be marked on every draft.
        activeOptions={{ exact: true }}
        className="icon-btn icon-btn--sm"
        title={projectId === null ? "New thread in no project" : `New thread in ${name}`}
      >
        <PlusIcon size={14} />
      </Link>
    </h3>
  );
});

/**
 * Renders a workspace group's label under its project's heading. `clip` may
 * be cut short with an ellipsis; `keep`, the machine's name, never is. When
 * `joinableWorkspaceId` is set, the label has a `+`, shown on hover and on
 * focus, that opens a new thread in `projectId` joining that workspace. The
 * threads with no workspace, and a workspace that is not ready, have no `+`:
 * there is no workspace a new thread could join.
 */
export const WorkspaceLabel = memo(function WorkspaceLabel({
  itemKey,
  leading,
  projectId,
  joinableWorkspaceId,
  clip,
  keep,
}: Placement & {
  readonly projectId: string;
  readonly joinableWorkspaceId: string | null;
  readonly clip: string;
  readonly keep: string;
}): JSX.Element {
  return (
    <h4
      className="side-ws side-item"
      data-key={itemKey}
      tabIndex={-1}
      style={{ marginTop: leading, height: ITEM_HEIGHTS["workspace-label"] }}
    >
      <span className="side-ws-name">
        <span className="side-ws-clip">{clip}</span>
        {keep === "" ? null : <span className="side-ws-keep">{keep}</span>}
      </span>
      {joinableWorkspaceId === null ? null : (
        <Link
          to="/"
          search={{ project: projectId, workspace: joinableWorkspaceId }}
          activeOptions={{ exact: true }}
          className="icon-btn icon-btn--sm"
          title={`New thread in ${joinLabelText({ clip, keep })}`}
        >
          <PlusIcon size={14} />
        </Link>
      )}
    </h4>
  );
});

/**
 * Renders how long ago a thread was last active: "20m" on screen, and "20
 * minutes ago" in a hidden element with the id `descriptionId`, which the
 * row's description points at. `onScreen` says whether the row is in the
 * list's visible part, where the age is kept current.
 */
function AgeLabel({
  at,
  onScreen,
  descriptionId,
}: {
  readonly at: string;
  readonly onScreen: boolean;
  readonly descriptionId: string;
}): JSX.Element {
  const label = useAgeLabel(at, onScreen);
  const words = useAgeWords(at, onScreen);
  return (
    <>
      <span className="side-age">{label}</span>
      <span id={descriptionId} hidden>
        {words}
      </span>
    </>
  );
}

/**
 * Renders a thread in its project: its title, its second line (the model's
 * name), and its end: the working or the waiting mark, a word, or its age.
 *
 * The link is named "<title>, <pose words>", such as "Fix checkout, working",
 * and described by the second line and, when the end is not a mark, the end
 * in words, such as "offline" or "20 minutes ago". A mark says the pose,
 * which the name already holds, so it is hidden.
 */
export const ThreadRow = memo(function ThreadRow({
  itemKey,
  leading,
  sessionId,
  title,
  secondLine,
  pose,
  end,
  activityAt,
  onScreen,
}: Placement & {
  readonly sessionId: string;
  readonly title: string;
  readonly secondLine: string | null;
  readonly pose: Pose;
  readonly end: RowEnd;
  readonly activityAt: string;
  readonly onScreen: boolean;
}): JSX.Element {
  const id = useId();
  const secondLineId = `${id}-second-line`;
  const endId = `${id}-end`;
  const endIsMark = end === "working" || end === "waiting";
  const describedBy = [secondLine === null ? null : secondLineId, endIsMark ? null : endId]
    .filter((each) => each !== null)
    .join(" ");
  return (
    <Link
      to="/threads/$sessionId"
      params={{ sessionId }}
      className="side-row side-item"
      activeProps={SELECTED}
      data-key={itemKey}
      style={{ marginTop: leading, height: ITEM_HEIGHTS["thread-row"] }}
      aria-label={`${title}, ${describePose(pose)}`}
      aria-describedby={describedBy === "" ? undefined : describedBy}
    >
      <span className="side-text">
        <span className="side-name">{title}</span>
        {secondLine === null ? null : (
          <span className="side-meta" id={secondLineId}>
            {secondLine}
          </span>
        )}
      </span>
      {endIsMark ? (
        <span className="side-end">
          <Mark state={end} decorative />
        </span>
      ) : end === "age" ? (
        <span className="side-end">
          <AgeLabel at={activityAt} onScreen={onScreen} descriptionId={endId} />
        </span>
      ) : (
        <span className="side-end" id={endId}>
          {end}
        </span>
      )}
    </Link>
  );
});

/**
 * Renders the row of the Draft Thread open in the main pane: "New thread",
 * where it will work and on which machine (`meta`), and "draft" at its end.
 * It is marked as the open screen, like the open thread's row. It is not a
 * link, because it leads to the screen it marks.
 */
export const DraftRow = memo(function DraftRow({
  itemKey,
  leading,
  meta,
}: Placement & { readonly meta: string }): JSX.Element {
  return (
    <div
      className="side-row is-on side-item"
      data-key={itemKey}
      tabIndex={-1}
      aria-current="page"
      style={{ marginTop: leading, height: ITEM_HEIGHTS["draft-row"] }}
    >
      <span className="side-text">
        <span className="side-name">New thread</span>
        <span className="side-meta">{meta}</span>
      </span>
      <span className="side-end">draft</span>
    </div>
  );
});

/**
 * Renders a section's "more" row, such as "3 more threads". Pressing it shows
 * the section's hidden threads in place: `onExpand` is called with the
 * section's key. It is a button, not a link, because it goes nowhere.
 */
export const MoreRow = memo(function MoreRow({
  itemKey,
  leading,
  section,
  label,
  onExpand,
}: Placement & {
  readonly section: SectionKey;
  readonly label: string;
  readonly onExpand: (section: SectionKey) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="side-row side-row--more side-item"
      data-key={itemKey}
      style={{ marginTop: leading, height: ITEM_HEIGHTS.more }}
      onClick={() => {
        onExpand(section);
      }}
    >
      {label}
    </button>
  );
});
