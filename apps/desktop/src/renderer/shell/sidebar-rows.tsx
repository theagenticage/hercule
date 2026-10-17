/**
 * The items of the sidebar's thread list: section headers, thread rows, the
 * waiting assistants' rows, "From runs" and the waiting runs' sessions' rows,
 * the draft's row, "more" rows, and the Done shelf's heading and rows, drawn
 * as the Bureau book's crew.js draws them.
 *
 * Each item draws itself at its kind's fixed height, with the space above it
 * as its top margin. The list stacks the items one under another, so an item
 * that only moves down, because an item arrived above it, keeps every prop
 * and does not draw again. Every item takes only strings, numbers and stable
 * callbacks, and is memoized, so a change to one thread re-renders that
 * thread's rows and nothing else.
 *
 * Every item's root carries the class `side-item`, which the end-to-end
 * tests find the items by. Every element in an item that can take focus
 * carries `data-key`, which the list uses to keep the focused item mounted,
 * and the first of them is the one the list focuses. Rows are links or
 * buttons, a thread row holds its link and its Done button side by side, and
 * headings and the draft's row take focus from code only (`tabIndex={-1}`),
 * for when the focused item leaves the list.
 */
import { memo, useId, type ComponentProps, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import {
  describePose,
  isThreadSeated,
  type Pose,
  type ThreadRowStatus,
} from "@hercule/client-core";
import { useAgeWords } from "../app/age-clock";
import { buildAssistantLook, buildLook, Face } from "../faces";
import { CheckIcon } from "../icons/check";
import { ChevronRightIcon } from "../icons/chevron-right";
import { ComposeIcon } from "../icons/compose";
import { PlusIcon } from "../icons/plus";
import { UndoIcon } from "../icons/undo";
import { Mark } from "../marks";
import { AgeLabel } from "../screens/age-label";
import { ProjectTile, type ProjectTint } from "../screens/project-tile";
import { SELECTED_LINK_PROPS } from "../screens/selected-link-props";
import { ProviderLogo } from "../screens/thread/provider-logo";
import { ITEM_HEIGHTS, type SectionKey } from "./sidebar-items";

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
 * Renders a link to the session `sessionId`. While `officeOpen` is true and
 * `seated` says the session has a colleague in the Office, the link opens
 * the session in the Office's drawer; otherwise it opens the session on its
 * own screen, because a session with no colleague, such as a Done thread,
 * has nobody to select. The other props are the link's own.
 * Either way the router marks the link as the current page while its
 * session is open, so a session listed twice is marked in both places.
 */
function ThreadLink({
  sessionId,
  seated,
  officeOpen,
  ...props
}: Pick<
  ComponentProps<"a">,
  "className" | "style" | "aria-label" | "aria-describedby" | "children"
> & {
  readonly sessionId: string;
  readonly seated: boolean;
  readonly officeOpen: boolean;
  readonly "data-key": string;
}): JSX.Element {
  return officeOpen && seated ? (
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
 * Renders a link to the Conversation of the assistant `assistantId`. While
 * `officeOpen` is true, the link opens the Conversation in the Office's
 * drawer, because an assistant always has a colleague there; otherwise it
 * opens the assistant's own screen. The other props are the link's own.
 * Either way the router marks the link as the current page while its
 * Conversation is open, so an assistant listed twice is marked in both
 * places.
 */
export function ConversationLink({
  assistantId,
  officeOpen,
  ...props
}: Pick<
  ComponentProps<"a">,
  "className" | "style" | "aria-label" | "aria-describedby" | "children"
> & {
  readonly assistantId: string;
  readonly officeOpen: boolean;
  readonly "data-key"?: string;
}): JSX.Element {
  return officeOpen ? (
    <Link
      to="/office"
      search={{ assistant: assistantId }}
      activeProps={SELECTED_LINK_PROPS}
      {...props}
    />
  ) : (
    <Link
      to="/assistants/$assistantId"
      params={{ assistantId }}
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
      seated
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
 * assistant's Conversation, where the Request is answered: in the Office's
 * drawer while `officeOpen` is true, as `ConversationLink` describes.
 */
export const WaitingAssistantRow = memo(function WaitingAssistantRow({
  itemKey,
  leading,
  assistantId,
  name,
  question,
  officeOpen,
}: Placement & {
  readonly assistantId: string;
  readonly name: string;
  readonly question: string;
  readonly officeOpen: boolean;
}): JSX.Element {
  const questionId = useId();
  return (
    <ConversationLink
      assistantId={assistantId}
      officeOpen={officeOpen}
      className="side-row side-row--wait side-item"
      data-key={itemKey}
      style={{ marginTop: leading, height: ITEM_HEIGHTS["waiting-assistant-row"] }}
      aria-label={`${name}, ${describePose("waiting")}`}
      aria-describedby={questionId}
    >
      <Face look={buildAssistantLook(assistantId)} pose="waiting" size={24} />
      <span className="side-text">
        <span className="side-name">{name}</span>
        <span className="side-ask" id={questionId}>
          {question}
        </span>
      </span>
    </ConversationLink>
  );
});

/**
 * Renders "From runs", the book's `.side-sub` label over the runs' sessions
 * in Waiting on you. It is a heading under Waiting on you's, so a screen
 * reader lists the runs' sessions as a group of their own.
 */
export const WaitingRunsLabel = memo(function WaitingRunsLabel({
  itemKey,
  leading,
}: Placement): JSX.Element {
  return (
    <h4
      className="side-sub side-item"
      data-key={itemKey}
      tabIndex={-1}
      style={{ marginTop: leading, height: ITEM_HEIGHTS["waiting-runs-label"] }}
    >
      From runs
    </h4>
  );
});

/**
 * Renders a run's session that waits on the user, under "From runs": the
 * waiting mark where a thread's row draws a face, because a run's agents have
 * no face, its title and the question it asks. The link is named "<title>,
 * waiting on you" and described by the question; the mark is hidden, because
 * the name already says the state. It opens the session's thread screen,
 * where the Request is answered: in the Office's drawer while `officeOpen`
 * is true, on its own screen otherwise.
 */
export const WaitingRunRow = memo(function WaitingRunRow({
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
  // The session is waiting, so `ThreadLink` opens it in the Office's drawer
  // while the Office is open, as a waiting thread's row does.
  return (
    <ThreadLink
      sessionId={sessionId}
      seated
      officeOpen={officeOpen}
      className="side-row side-row--wait side-item"
      data-key={itemKey}
      style={{ marginTop: leading, height: ITEM_HEIGHTS["waiting-run-row"] }}
      aria-label={`${title}, ${describePose("waiting")}`}
      aria-describedby={questionId}
    >
      <span className="side-lead">
        <Mark state="waiting" />
      </span>
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
 * Renders a project's heading: the project's tile in its tint, its name,
 * "1 needs you" or "2 need you" when `waitingCount` of its threads wait on
 * the user, and a
 * `+` that opens a new thread in the project.
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
  waitingCount,
}: Placement & {
  readonly projectId: string | null;
  readonly name: string;
  readonly tint: ProjectTint | null;
  readonly waitingCount: number;
}): JSX.Element {
  return (
    <h3
      className="side-h side-h--proj side-item"
      data-key={itemKey}
      tabIndex={-1}
      style={{ marginTop: leading, height: ITEM_HEIGHTS["project-header"] }}
    >
      <ProjectTile tint={tint} name={name} />
      {/* The space keeps the heading's name "webshop 2 need you", not
          "webshop2 need you". The heading is a flex box, which draws no space
          between its items. */}
      {waitingCount === 0 ? null : (
        <>
          {" "}
          <span className="side-need">{`${String(waitingCount)} ${waitingCount === 1 ? "needs" : "need"} you`}</span>
        </>
      )}
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

/** The size of the provider's mark that leads a row's second line, and of a row's action icon, in CSS pixels. */
const ROW_GLYPH_SIZE = 12;

/** The words a thread row's status slot shows for each status but `age`. */
const STATUS_WORDS: Readonly<Record<Exclude<ThreadRowStatus, "age">, string>> = {
  working: "Working",
  approval: "Approval",
  question: "Question",
  queued: "Queued",
  offline: "Offline",
};

/** How many characters at the end of a row's kept part always show. */
const KEEP_TAIL_LENGTH = 8;

/**
 * Renders a row's second line after the provider's mark: `clip`, which may be
 * cut short with an ellipsis, then `keep`, which never is. A branch name
 * keeps its end, a main workspace its machine. `keep` is "" when there is
 * nothing to keep.
 *
 * A `keep` wider than the whole line, such as a long machine name in a
 * narrow sidebar, is cut in the middle: its last `KEEP_TAIL_LENGTH`
 * characters always show, and an ellipsis takes the place of what does not
 * fit before them.
 */
function DetailLine({
  providerId,
  clip,
  keep,
}: {
  readonly providerId: string | null;
  readonly clip: string;
  readonly keep: string;
}): JSX.Element {
  return (
    <span className="side-detail">
      <span className="side-glyph">
        {providerId === null ? null : (
          <ProviderLogo providerId={providerId} size={ROW_GLYPH_SIZE} />
        )}
      </span>
      <span className="side-detail-clip">{clip}</span>
      {keep === "" ? null : (
        <span className="side-detail-keep">
          <span className="side-detail-keep-head">{keep.slice(0, -KEEP_TAIL_LENGTH)}</span>
          <span className="side-detail-keep-tail">{keep.slice(-KEEP_TAIL_LENGTH)}</span>
        </span>
      )}
    </span>
  );
}

/**
 * Renders the status slot at the end of a thread row's first line: the
 * status in words, such as "Working" or "Approval", or, for `age`, how long
 * ago `activityAt` was. `activityAt` is "" for any other status. The age's words, such as "20 minutes ago", and every
 * other status, carry the id `id`, which the row's description points at.
 */
function StatusSlot({
  id,
  status,
  activityAt,
  onScreen,
}: {
  readonly id: string;
  readonly status: ThreadRowStatus;
  readonly activityAt: string;
  readonly onScreen: boolean;
}): JSX.Element {
  return status === "age" ? (
    <span className="side-end">
      <AgeLabel
        at={activityAt}
        onScreen={onScreen}
        descriptionId={id}
        as="span"
        className="side-age"
      />
    </span>
  ) : (
    <span className={`side-end side-end--${status}`} id={id}>
      {STATUS_WORDS[status]}
    </span>
  );
}

/**
 * Renders the button that sits over a row's status slot and shows in its
 * place while the pointer is on the row or the keyboard's focus is in it:
 * Done, which marks the thread done, or Reopen, on the Done shelf. A click
 * leaves the focus in the row without showing it, so a row the user clicked
 * shows its status. It carries the row's `data-key`, so the list keeps it
 * mounted while it holds focus.
 */
function RowAction({
  itemKey,
  label,
  word,
  icon,
  onPress,
}: {
  readonly itemKey: string;
  readonly label: string;
  readonly word: string;
  readonly icon: JSX.Element;
  readonly onPress: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="side-act"
      data-key={itemKey}
      aria-label={label}
      title={label}
      onClick={onPress}
    >
      {icon}
      {word}
    </button>
  );
}

/**
 * Renders a thread in its project, in two lines. The first holds its title
 * and its status slot (`StatusSlot`); the second, the mark of its provider
 * and where it works (`placeClip` and `placeKeep`, see `DetailLine`).
 *
 * - While `receded` is true, the row recedes to 72% opacity, and comes back
 *   while the pointer is on it or focus is in it. A working thread's row
 *   recedes, unless it is the open thread's. The row's words say what it is
 *   doing; the dimming only lets the eye skip it.
 * - When `unsent` is true, the composer of the thread holds work the user has
 *   not sent: the row is tinted and a pencil sits before the title.
 * - While the pointer is on the row, or the keyboard's focus is in it, a
 *   Done button shows in the status slot's place. Pressing it calls `onMarkDone` with the
 *   thread's session id.
 *
 * The link is named "<title>, <pose words>", such as "Fix checkout,
 * working", with ", unsent message" after it when `unsent` is true. It is
 * described by the `model`, when it is known, and `placeDescription`, which
 * together name what the card shown on hover holds: the model, the project,
 * the workspace, the machine and the branch. Then by the status in words,
 * such as "Approval" or "20 minutes ago", except "Working", which the name
 * already says. While `officeOpen` is true, it opens the
 * thread in the Office's drawer if the thread has a colleague there, and on
 * its own screen if it does not.
 */
export const ThreadRow = memo(function ThreadRow({
  itemKey,
  leading,
  sessionId,
  title,
  pose,
  status,
  receded,
  activityAt,
  placeClip,
  placeKeep,
  providerId,
  model,
  placeDescription,
  unsent,
  onScreen,
  officeOpen,
  onMarkDone,
}: Placement & {
  readonly sessionId: string;
  readonly title: string;
  readonly pose: Pose;
  readonly status: ThreadRowStatus;
  readonly receded: boolean;
  readonly activityAt: string;
  readonly placeClip: string;
  readonly placeKeep: string;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly placeDescription: string;
  readonly unsent: boolean;
  readonly onScreen: boolean;
  readonly officeOpen: boolean;
  readonly onMarkDone: (sessionId: string) => void;
}): JSX.Element {
  const id = useId();
  const placeId = `${id}-place`;
  const statusId = `${id}-status`;
  return (
    <div
      className={receded ? "side-thread is-receded side-item" : "side-thread side-item"}
      style={{ marginTop: leading, height: ITEM_HEIGHTS["thread-row"] }}
    >
      <ThreadLink
        sessionId={sessionId}
        seated={isThreadSeated(pose, false)}
        officeOpen={officeOpen}
        className={unsent ? "side-row is-unsent" : "side-row"}
        data-key={itemKey}
        aria-label={`${title}, ${describePose(pose)}${unsent ? ", unsent message" : ""}`}
        aria-describedby={status === "working" ? placeId : `${placeId} ${statusId}`}
      >
        <span className="side-text">
          <span className="side-line">
            <span className="side-name">
              {unsent ? <ComposeIcon size={UNSENT_ICON_SIZE} /> : null}
              {title}
            </span>
            <StatusSlot id={statusId} status={status} activityAt={activityAt} onScreen={onScreen} />
          </span>
          <DetailLine providerId={providerId} clip={placeClip} keep={placeKeep} />
          {/* A screen reader reads the model and where the thread works
              from this text, which is never drawn: the model, the project,
              the machine and the branch show only in the card on hover. */}
          <span hidden id={placeId}>
            {model === null ? placeDescription : `${model} ${placeDescription}`}
          </span>
        </span>
      </ThreadLink>
      <RowAction
        itemKey={itemKey}
        label="Mark done"
        word="Done"
        icon={<CheckIcon size={ROW_GLYPH_SIZE} />}
        onPress={() => {
          onMarkDone(sessionId);
        }}
      />
    </div>
  );
});

/**
 * Renders the Done shelf's heading: "Done" and the count of Done threads, as
 * a button that opens and closes the shelf. Pressing it calls `onToggle`.
 */
export const DoneHeader = memo(function DoneHeader({
  itemKey,
  leading,
  count,
  open,
  onToggle,
}: Placement & {
  readonly count: number;
  readonly open: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  return (
    <h3
      className="side-h side-h--done side-item"
      style={{ marginTop: leading, height: ITEM_HEIGHTS["done-header"] }}
    >
      {/* The space keeps the button's name "Done 12", not "Done12". */}
      <button type="button" data-key={itemKey} aria-expanded={open} onClick={onToggle}>
        <ChevronRightIcon size={12} />
        <span>Done</span> <b className="count">{count}</b>
      </button>
    </h3>
  );
});

/**
 * Renders a thread marked Done, on the Done shelf, in a thread row's two
 * lines: its title, then the mark of its provider and how long ago it was
 * marked Done (`doneAt`). The row is dimmed to 60%, and comes back while the
 * pointer is on it or focus is in it. While the pointer is on it or the
 * keyboard's focus is in it, a Reopen button shows in the status slot's
 * place. Pressing it calls `onReopen` with the thread's
 * session id.
 *
 * The link is named "<title>, done", with ", unsent message" after it when
 * `unsent` is true, and opens the thread as a thread row's link does. `pose`
 * only decides where the link opens while the Office is open.
 */
export const DoneRow = memo(function DoneRow({
  itemKey,
  leading,
  sessionId,
  title,
  pose,
  doneAt,
  providerId,
  unsent,
  onScreen,
  officeOpen,
  onReopen,
}: Placement & {
  readonly sessionId: string;
  readonly title: string;
  readonly pose: Pose;
  readonly doneAt: string;
  readonly providerId: string | null;
  readonly unsent: boolean;
  readonly onScreen: boolean;
  readonly officeOpen: boolean;
  readonly onReopen: (sessionId: string) => void;
}): JSX.Element {
  const doneWords = useAgeWords(doneAt, onScreen);
  return (
    <div
      className="side-thread is-done side-item"
      style={{ marginTop: leading, height: ITEM_HEIGHTS["done-row"] }}
    >
      <ThreadLink
        sessionId={sessionId}
        seated={isThreadSeated(pose, true)}
        officeOpen={officeOpen}
        className={unsent ? "side-row is-unsent" : "side-row"}
        data-key={itemKey}
        aria-label={`${title}, done${unsent ? ", unsent message" : ""}`}
      >
        <span className="side-text">
          <span className="side-line">
            <span className="side-name">
              {unsent ? <ComposeIcon size={UNSENT_ICON_SIZE} /> : null}
              {title}
            </span>
            <span className="side-end" />
          </span>
          <DetailLine providerId={providerId} clip={`Done ${doneWords}`} keep="" />
        </span>
      </ThreadLink>
      <RowAction
        itemKey={itemKey}
        label="Reopen"
        word="Reopen"
        icon={<UndoIcon size={ROW_GLYPH_SIZE} />}
        onPress={() => {
          onReopen(sessionId);
        }}
      />
    </div>
  );
});

/**
 * Renders the row of the Draft Thread open in the main pane, drawn as a
 * thread row: "New thread" after a pencil and "draft" in the status slot,
 * then where it will work (`placeClip` and `placeKeep`, see
 * `DetailLine`), as the thread's row will say once it starts. It is tinted as a row with unsent work
 * is, because a draft is unsent work, and marked as the open screen, like
 * the open thread's row. It is not a link, because it leads to the screen it
 * marks.
 */
export const DraftRow = memo(function DraftRow({
  itemKey,
  leading,
  placeClip,
  placeKeep,
}: Placement & {
  readonly placeClip: string;
  readonly placeKeep: string;
}): JSX.Element {
  return (
    <div
      className="side-thread side-item"
      style={{ marginTop: leading, height: ITEM_HEIGHTS["draft-row"] }}
    >
      <div
        className="side-row is-unsent is-on"
        data-key={itemKey}
        tabIndex={-1}
        aria-current="page"
      >
        <span className="side-text">
          <span className="side-line">
            <span className="side-name">
              <ComposeIcon size={UNSENT_ICON_SIZE} />
              New thread
            </span>
            <span className="side-end">draft</span>
          </span>
          <DetailLine providerId={null} clip={placeClip} keep={placeKeep} />
        </span>
      </div>
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
