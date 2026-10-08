/**
 * The items of the sidebar's thread list: section headers, thread rows, the
 * waiting assistants' rows, the draft's row and "more" rows,
 * drawn as the Bureau book's crew.js draws them.
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
import { memo, useId, type ComponentProps, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { describePose, isSeatedPose, type Pose } from "@hercule/client-core";
import { buildLook, Face } from "../faces";
import { ComposeIcon } from "../icons/compose";
import { PlusIcon } from "../icons/plus";
import { Mark } from "../marks";
import { AgeLabel } from "../screens/age-label";
import { ProjectTile, type ProjectTint } from "../screens/project-tile";
import { SELECTED_LINK_PROPS } from "../screens/selected-link-props";
import { ITEM_HEIGHTS, type RowEnd, type SectionKey } from "./sidebar-items";

/** What every item takes from the list: its key in the list, and the space above it. */
interface Placement {
  readonly itemKey: string;
  /** The space between this item and the one above it, in pixels. */
  readonly leading: number;
}

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
 * Renders a link to the thread of `sessionId`, whose pose is `pose`. While
 * `officeOpen` is true and the thread has a colleague in the Office, the link
 * opens the thread in the Office's drawer; otherwise it opens the thread on
 * its own screen, because an asleep or away thread has no colleague to
 * select. The other props are the link's own. Either way the router marks the
 * link as the current page while its thread is open, so a thread listed
 * twice is marked in both places.
 */
function ThreadLink({
  sessionId,
  pose,
  officeOpen,
  ...props
}: Pick<
  ComponentProps<"a">,
  "className" | "style" | "aria-label" | "aria-describedby" | "children"
> & {
  readonly sessionId: string;
  readonly pose: Pose;
  readonly officeOpen: boolean;
  readonly "data-key": string;
}): JSX.Element {
  return officeOpen && isSeatedPose(pose) ? (
    <Link
      to="/office"
      search={{ session: sessionId }}
      activeProps={SELECTED_LINK_PROPS}
      {...props}
    />
  ) : (
    <Link
      to="/threads/$sessionId"
      params={{ sessionId }}
      activeProps={SELECTED_LINK_PROPS}
      {...props}
    />
  );
}

/**
 * Renders a thread in Waiting on you: its waiting face, its title and the
 * question it asks. The link is named "<title>, waiting on you" and described
 * by the question; the face is hidden, because the name already says the
 * state. It opens the thread in the Office's drawer while `officeOpen` is
 * true, because a waiting thread always has a colleague there.
 */
export const WaitingThreadRow = memo(function WaitingThreadRow({
  itemKey,
  leading,
  sessionId,
  title,
  question,
  officeOpen,
}: Placement & {
  readonly sessionId: string;
  readonly title: string;
  readonly question: string;
  readonly officeOpen: boolean;
}): JSX.Element {
  const questionId = useId();
  return (
    <ThreadLink
      sessionId={sessionId}
      pose="waiting"
      officeOpen={officeOpen}
      className="side-row side-row--wait side-item"
      data-key={itemKey}
      style={{ marginTop: leading, height: ITEM_HEIGHTS["waiting-thread-row"] }}
      aria-label={`${title}, ${describePose("waiting")}`}
      aria-describedby={questionId}
    >
      <Face look={buildLook(sessionId)} pose="waiting" size={24} />
      <span className="side-text">
        <span className="side-name">{title}</span>
        <span className="side-ask" id={questionId}>
          {question}
        </span>
      </span>
    </ThreadLink>
  );
});

/**
 * Renders an assistant in Waiting on you, drawn as a waiting thread's row:
 * its waiting face, its name and the question it asks. The link is named
 * "<name>, waiting on you" and described by the question. It opens the
 * assistant's Conversation, where the Request is answered, also while the
 * Office is open, because an assistant has no colleague there.
 */
export const WaitingAssistantRow = memo(function WaitingAssistantRow({
  itemKey,
  leading,
  assistantId,
  name,
  question,
}: Placement & {
  readonly assistantId: string;
  readonly name: string;
  readonly question: string;
}): JSX.Element {
  const questionId = useId();
  return (
    <Link
      to="/assistants/$assistantId"
      params={{ assistantId }}
      activeProps={SELECTED_LINK_PROPS}
      className="side-row side-row--wait side-item"
      data-key={itemKey}
      style={{ marginTop: leading, height: ITEM_HEIGHTS["waiting-assistant-row"] }}
      aria-label={`${name}, ${describePose("waiting")}`}
      aria-describedby={questionId}
    >
      <Face look={buildLook(assistantId)} pose="waiting" size={24} />
      <span className="side-text">
        <span className="side-name">{name}</span>
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

/** The size of the pencil before an unsent row's title, in CSS pixels. */
const UNSENT_ICON_SIZE = 12;

/**
 * Renders a row's third line: its workspace, as `clip`, which may be cut
 * short with an ellipsis, then `keep`, the machine's name, which never is.
 * `keep` is "" when there is nothing to keep.
 */
function WorkspaceLine({
  clip,
  keep,
}: {
  readonly clip: string;
  readonly keep: string;
}): JSX.Element {
  return (
    <span className="side-ws-line">
      <span className="side-ws-clip">{clip}</span>
      {keep === "" ? null : <span className="side-ws-keep">{keep}</span>}
    </span>
  );
}

/**
 * Renders a thread in its project, in three lines: its title, the model's
 * name (`secondLine`), and its workspace (`workspaceClip` and
 * `workspaceKeep`, see `WorkspaceLine`). Its end is the working or the
 * waiting mark, a word, or its age. When `unsent` is true, the composer of
 * the thread holds work the user has not sent: the row is tinted and a pencil
 * sits before the title.
 *
 * The link is named "<title>, <pose words>", such as "Fix checkout,
 * working", with ", unsent message" after it when `unsent` is true. It is
 * described by the model, then `placeDescription`, which names the project,
 * the workspace, the machine and the branch the card shown on hover holds,
 * and, when the end is not a mark, the end in words, such as "offline" or
 * "20 minutes ago". A mark says the pose, which
 * the name already holds, so it is hidden. While `officeOpen` is true, it
 * opens the thread in the Office's drawer if the thread has a colleague
 * there, and on its own screen if it does not.
 */
export const ThreadRow = memo(function ThreadRow({
  itemKey,
  leading,
  sessionId,
  title,
  secondLine,
  pose,
  end,
  createdAt,
  workspaceClip,
  workspaceKeep,
  placeDescription,
  unsent,
  onScreen,
  officeOpen,
}: Placement & {
  readonly sessionId: string;
  readonly title: string;
  readonly secondLine: string | null;
  readonly pose: Pose;
  readonly end: RowEnd;
  readonly createdAt: string;
  readonly workspaceClip: string;
  readonly workspaceKeep: string;
  readonly placeDescription: string;
  readonly unsent: boolean;
  readonly onScreen: boolean;
  readonly officeOpen: boolean;
}): JSX.Element {
  const id = useId();
  const secondLineId = `${id}-second-line`;
  const placeId = `${id}-place`;
  const endId = `${id}-end`;
  const endIsMark = end === "working" || end === "waiting";
  const describedBy = [secondLine === null ? null : secondLineId, placeId, endIsMark ? null : endId]
    .filter((each) => each !== null)
    .join(" ");
  return (
    <ThreadLink
      sessionId={sessionId}
      pose={pose}
      officeOpen={officeOpen}
      className={unsent ? "side-row is-unsent side-item" : "side-row side-item"}
      data-key={itemKey}
      style={{ marginTop: leading, height: ITEM_HEIGHTS["thread-row"] }}
      aria-label={`${title}, ${describePose(pose)}${unsent ? ", unsent message" : ""}`}
      aria-describedby={describedBy}
    >
      <span className="side-text">
        <span className="side-name">
          {unsent ? <ComposeIcon size={UNSENT_ICON_SIZE} /> : null}
          {title}
        </span>
        {secondLine === null ? null : (
          <span className="side-meta" id={secondLineId}>
            {secondLine}
          </span>
        )}
        <WorkspaceLine clip={workspaceClip} keep={workspaceKeep} />
        {/* A screen reader reads where the thread works from this text,
            which is never drawn: the project, the machine and the branch
            show only in the card on hover, and the workspace line's two
            parts would be read without the space between them. */}
        <span hidden id={placeId}>
          {placeDescription}
        </span>
      </span>
      {endIsMark ? (
        <span className="side-end">
          <Mark state={end} />
        </span>
      ) : end === "age" ? (
        <span className="side-end">
          <AgeLabel
            at={createdAt}
            onScreen={onScreen}
            descriptionId={endId}
            as="span"
            className="side-age"
          />
        </span>
      ) : (
        <span className="side-end" id={endId}>
          {end}
        </span>
      )}
    </ThreadLink>
  );
});

/**
 * Renders the row of the Draft Thread open in the main pane, drawn as a
 * thread row: "New thread" after a pencil, the model's name (`model`) when
 * the draft has one, where it will work and on which machine
 * (`workspaceClip` and `workspaceKeep`, see `WorkspaceLine`), and "draft" at
 * its end. It is tinted as a row with unsent work is, because a
 * draft is unsent work, and marked as the open screen, like the open
 * thread's row. It is not a link, because it leads to the screen it marks.
 */
export const DraftRow = memo(function DraftRow({
  itemKey,
  leading,
  model,
  workspaceClip,
  workspaceKeep,
}: Placement & {
  readonly model: string | null;
  readonly workspaceClip: string;
  readonly workspaceKeep: string;
}): JSX.Element {
  return (
    <div
      className="side-row is-unsent is-on side-item"
      data-key={itemKey}
      tabIndex={-1}
      aria-current="page"
      style={{ marginTop: leading, height: ITEM_HEIGHTS["draft-row"] }}
    >
      <span className="side-text">
        <span className="side-name">
          <ComposeIcon size={UNSENT_ICON_SIZE} />
          New thread
        </span>
        {model === null ? null : <span className="side-meta">{model}</span>}
        <WorkspaceLine clip={workspaceClip} keep={workspaceKeep} />
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
