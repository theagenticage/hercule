/**
 * The items of the sidebar's thread list: section headers, group rows (a
 * thread, or a lead with its partners) and the lines an unfolded group opens
 * into, the waiting assistants' rows, "From runs" and the waiting runs'
 * sessions' rows, the draft's row, "more" and "Show fewer" rows, and the Done shelf's heading
 * and rows, drawn as the Bureau book's crew.js draws them.
 *
 * Each item draws itself at its kind's fixed height, with the space above it
 * as its top margin. A row takes its item (`SidebarItemOf`), what the list
 * knows live (`onScreen`, `officeOpen`) and stable callbacks. The list builds
 * its items again on every render, so a row is memoized by what its props
 * hold, not by their identity (`areSameData`): an item that only moves down,
 * because an item arrived above it, keeps every value and does not draw
 * again, and a change to one thread re-renders that thread's rows and
 * nothing else.
 *
 * Every item's root carries the class `side-item`, which the end-to-end
 * tests find the items by. Every element in an item that can take focus
 * carries `data-key`, which the list uses to keep the focused item mounted,
 * and the first of them is the one the list focuses. Rows are links or
 * buttons, a thread row holds its link and its Done button side by side, and
 * headings and the draft's row take focus from code only (`tabIndex={-1}`),
 * for when the focused item leaves the list.
 */
import {
  memo,
  useId,
  type ComponentProps,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Link } from "@tanstack/react-router";
import { describePose, type SessionDot } from "@hercule/client-core";
import { useAgeWords } from "../app/age-clock";
import { buildAssistantLook, buildLook, Face } from "../faces";
import { CheckIcon } from "../icons/check";
import { ChevronRightIcon } from "../icons/chevron-right";
import { ComposeIcon } from "../icons/compose";
import { PlusIcon } from "../icons/plus";
import { UndoIcon } from "../icons/undo";
import { Mark } from "../marks";
import { ProjectTile } from "../screens/project-tile";
import { SELECTED_LINK_PROPS } from "../screens/selected-link-props";
import { AgentLabel, StatusSlot } from "../screens/session-status";
import { ProviderLogo } from "../screens/thread/provider-logo";
import { ITEM_HEIGHTS, type SectionKey, type SidebarItemOf } from "./sidebar-items";

/**
 * Checks whether two sets of props hold the same data, comparing objects and
 * arrays by what they hold instead of by identity. A row takes its item, and
 * the list builds its items again from the session presentation on every
 * render, so a row compared by identity would draw again each time.
 *
 * A record with a `status` other than `age` is equal when everything but its
 * `activityAt` is: only the `age` status draws it, so a working session that
 * only did something must not draw its rows again. Functions are compared by
 * identity, which is why the callbacks a row takes must keep theirs.
 */
const areSameData = (before: unknown, after: unknown): boolean => {
  if (Object.is(before, after)) return true;
  if (
    typeof before !== "object" ||
    typeof after !== "object" ||
    before === null ||
    after === null
  ) {
    return false;
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    return (
      Array.isArray(before) &&
      Array.isArray(after) &&
      before.length === after.length &&
      before.every((element: unknown, index) => areSameData(element, after[index]))
    );
  }
  const previous = before as Record<string, unknown>;
  const next = after as Record<string, unknown>;
  const keys = Object.keys(previous);
  return (
    keys.length === Object.keys(next).length &&
    keys.every(
      (key) =>
        key in next &&
        ((key === "activityAt" && "status" in previous && previous.status !== "age") ||
          areSameData(previous[key], next[key])),
    )
  );
};

/** Renders the Waiting on you heading, with the count of every waiting thread. */
export const WaitingHeader = memo(function WaitingHeader({
  item,
}: {
  readonly item: SidebarItemOf<"waiting-header">;
}): JSX.Element {
  return (
    <h3
      className="side-h side-item"
      data-key={item.key}
      tabIndex={-1}
      style={{ marginTop: item.leading, height: ITEM_HEIGHTS["waiting-header"] }}
    >
      {/* The space keeps the heading's name "Waiting on you 3", not "Waiting
          on you3". The heading is a flex box, which draws no space between
          its items, so the layout is the book's. */}
      <span>Waiting on you</span> <b className="count count--you">{item.count}</b>
    </h3>
  );
}, areSameData);

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
  "className" | "style" | "aria-label" | "aria-describedby" | "children" | "title" | "onKeyDown"
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
 * Renders the words of a question a group's session asks: "<askerLabel>
 * asks · <question>", with the asker in bold, or the question alone when
 * `askerLabel` is `null` because the lead asks or the group is one session.
 */
function AskText({
  askerLabel,
  question,
}: {
  readonly askerLabel: string | null;
  readonly question: string;
}): JSX.Element {
  return (
    <>
      {askerLabel === null ? null : (
        <>
          <b className="side-asker">{askerLabel}</b> asks ·{" "}
        </>
      )}
      {question}
    </>
  );
}

/**
 * Renders a session in Waiting on you: its waiting face, the name of its
 * group (`item.title`) and the question it asks, after the asker's name when
 * a partner of the lead asks (`item.askerLabel`, see `AskText`). The link is named
 * "<title>, waiting on you" and described by the question; the face is
 * hidden, because the name already says the state. It opens the session in
 * the Office's drawer while `officeOpen` is true, because a waiting thread
 * always has a colleague there.
 */
export const WaitingThreadRow = memo(function WaitingThreadRow({
  item,
  officeOpen,
}: {
  readonly item: SidebarItemOf<"waiting-thread-row">;
  readonly officeOpen: boolean;
}): JSX.Element {
  const questionId = useId();
  return (
    <ThreadLink
      sessionId={item.sessionId}
      seated
      officeOpen={officeOpen}
      className="side-row side-row--wait side-item"
      data-key={item.key}
      style={{ marginTop: item.leading, height: ITEM_HEIGHTS["waiting-thread-row"] }}
      aria-label={`${item.title}, ${describePose("waiting")}`}
      aria-describedby={questionId}
    >
      <Face look={buildLook(item.sessionId)} pose="waiting" size={24} />
      <span className="side-text">
        <span className="side-name">{item.title}</span>
        <span className="side-ask" id={questionId}>
          <AskText askerLabel={item.askerLabel} question={item.question} />
        </span>
      </span>
    </ThreadLink>
  );
}, areSameData);

/**
 * Renders an assistant in Waiting on you, drawn as a waiting thread's row:
 * its waiting face, its name and the question it asks. The link is named
 * "<name>, waiting on you" and described by the question. It opens the
 * assistant's Conversation, where the Request is answered: in the Office's
 * drawer while `officeOpen` is true, as `ConversationLink` describes.
 */
export const WaitingAssistantRow = memo(function WaitingAssistantRow({
  item,
  officeOpen,
}: {
  readonly item: SidebarItemOf<"waiting-assistant-row">;
  readonly officeOpen: boolean;
}): JSX.Element {
  const questionId = useId();
  return (
    <ConversationLink
      assistantId={item.assistantId}
      officeOpen={officeOpen}
      className="side-row side-row--wait side-item"
      data-key={item.key}
      style={{ marginTop: item.leading, height: ITEM_HEIGHTS["waiting-assistant-row"] }}
      aria-label={`${item.name}, ${describePose("waiting")}`}
      aria-describedby={questionId}
    >
      <Face look={buildAssistantLook(item.assistantId)} pose="waiting" size={24} />
      <span className="side-text">
        <span className="side-name">{item.name}</span>
        <span className="side-ask" id={questionId}>
          {item.question}
        </span>
      </span>
    </ConversationLink>
  );
}, areSameData);

/**
 * Renders "From runs", the book's `.side-sub` label over the runs' sessions
 * in Waiting on you. It is a heading under Waiting on you's, so a screen
 * reader lists the runs' sessions as a group of their own.
 */
export const WaitingRunsLabel = memo(function WaitingRunsLabel({
  item,
}: {
  readonly item: SidebarItemOf<"waiting-runs-label">;
}): JSX.Element {
  return (
    <h4
      className="side-sub side-item"
      data-key={item.key}
      tabIndex={-1}
      style={{ marginTop: item.leading, height: ITEM_HEIGHTS["waiting-runs-label"] }}
    >
      From runs
    </h4>
  );
}, areSameData);

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
  item,
  officeOpen,
}: {
  readonly item: SidebarItemOf<"waiting-run-row">;
  readonly officeOpen: boolean;
}): JSX.Element {
  const questionId = useId();
  // The session is waiting, so `ThreadLink` opens it in the Office's drawer
  // while the Office is open, as a waiting thread's row does.
  return (
    <ThreadLink
      sessionId={item.sessionId}
      seated
      officeOpen={officeOpen}
      className="side-row side-row--wait side-item"
      data-key={item.key}
      style={{ marginTop: item.leading, height: ITEM_HEIGHTS["waiting-run-row"] }}
      aria-label={`${item.title}, ${describePose("waiting")}`}
      aria-describedby={questionId}
    >
      <span className="side-lead">
        <Mark state="waiting" />
      </span>
      <span className="side-text">
        <span className="side-name">{item.title}</span>
        <span className="side-ask" id={questionId}>
          {item.question}
        </span>
      </span>
    </ThreadLink>
  );
}, areSameData);

/**
 * Renders a project's heading: the project's tile in its tint, its name,
 * "1 needs you" or "2 need you" when `item.waitingCount` of its threads wait
 * on the user, and a `+` that opens a new thread in the project.
 *
 * The heading of the threads in no project (`item.projectId` and `item.tint`
 * are `null`) draws an empty outline where a project's tile sits, so its name
 * lines up with the other projects' names. Its `+` opens a new thread in no
 * project.
 */
export const ProjectHeader = memo(function ProjectHeader({
  item,
}: {
  readonly item: SidebarItemOf<"project-header">;
}): JSX.Element {
  const { projectId, name, tint, waitingCount } = item;
  return (
    <h3
      className="side-h side-h--proj side-item"
      data-key={item.key}
      tabIndex={-1}
      style={{ marginTop: item.leading, height: ITEM_HEIGHTS["project-header"] }}
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
}, areSameData);

/** The size of the pencil before an unsent row's title, in CSS pixels. */
const UNSENT_ICON_SIZE = 12;

/** The size of the provider's mark that leads a row's second line, and of a row's action icon, in CSS pixels. */
const ROW_GLYPH_SIZE = 12;

/** How many characters at the end of a row's kept part always show. */
const KEEP_TAIL_LENGTH = 8;

/**
 * Renders a row's second line after the provider's mark: `clip`, which may be
 * cut short with an ellipsis, then `keep`, which never is. A branch name
 * keeps its end, a main workspace its machine. `keep` is "" when there is
 * nothing to keep.
 *
 * - `asking` draws `clip` in the colour of a question to the user.
 * - `done` draws a green check where the provider's mark goes, for a
 *   finished group.
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
  asking = false,
  done = false,
}: {
  readonly providerId: string | null;
  readonly clip: ReactNode;
  readonly keep: string;
  readonly asking?: boolean;
  readonly done?: boolean;
}): JSX.Element {
  return (
    <span className={asking ? "side-detail side-detail--ask" : "side-detail"}>
      <span className={done ? "side-glyph side-glyph--done" : "side-glyph"}>
        {done ? (
          <CheckIcon size={ROW_GLYPH_SIZE} />
        ) : providerId === null ? null : (
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

/** The least width of the dots button, which is also the width of a button with one dot. */
const MIN_DOTS_BUTTON_WIDTH = 22;

/**
 * Returns the width line 2 of a group row leaves free at its end for the
 * dots button and the chevron that shows beside it, in pixels. The button is
 * 11 for each dot and its gap, 20 for the "+n" and its gap and margin, 7 for
 * each digit of n, and 4 for its padding. Three cases:
 *
 * - 2 or more dots: exactly what the Crew Bureau drawing reserves, which is
 *   the button's width plus 6. The drawing never draws fewer than 2 dots, so
 *   it is the reference and the clip box must match it to the pixel.
 * - 1 dot: the button is never narrower than `MIN_DOTS_BUTTON_WIDTH`, and
 *   the chevron sits 14px to its left. Line 2 already ends 4px before the
 *   button's right edge, so 8 more keeps a 2px gap between the end of line 2
 *   and the chevron, with 4 more in the stylesheet.
 * - No dots: the button holds its chevron inside, so line 2 only has to end
 *   before the button itself. The button's right edge lies 4px past line 2's,
 *   so the width less 4 leaves a 4px gap, with 4 more in the stylesheet.
 */
const measureDotsWidth = (dotCount: number, hiddenCount: number): number => {
  if (dotCount === 0) return MIN_DOTS_BUTTON_WIDTH - 4;
  const buttonWidth = dotCount * 11 + (hiddenCount > 0 ? 13 + 7 * String(hiddenCount).length : 0);
  return dotCount === 1 ? Math.max(MIN_DOTS_BUTTON_WIDTH, buttonWidth + 4) + 8 : buttonWidth + 10;
};

/**
 * Renders the mark of a session in a group, in the sidebar's rows and in the
 * hover card: a dot in the state's colour (see `SessionDot`), or a green
 * check for a Thread marked Done.
 */
export function SessionMark({
  dot,
  done,
}: {
  readonly dot: SessionDot;
  readonly done: boolean;
}): JSX.Element {
  return done ? (
    <span className="side-check">
      <CheckIcon size={11} />
    </span>
  ) : (
    <span className={`side-dot side-dot--${dot}`} />
  );
}

/**
 * Renders the button on a group row's second line that shows what its
 * sessions are doing: at most three dots, most urgent first, then "+n" for
 * the rest (`hiddenCount`). Pressing it unfolds the group or, when it is
 * already unfolded, folds it: `onToggle` is called with whether to unfold.
 * A chevron shows beside the dots while the pointer is on the row or the
 * button has focus, and turns down while the group is unfolded. With no dots
 * (`dots` is empty) the button is only the chevron's target, and the chevron
 * sits inside it.
 *
 * It is named by `label`, which describes all the group's sessions, then
 * "Unfold" or "Fold", and it has `aria-expanded`. It carries the row's
 * `data-key`, as every part of a row that takes focus does. A single dot is
 * never a target of its own.
 */
function DotsButton({
  itemKey,
  dots,
  hiddenCount,
  label,
  unfolded,
  onToggle,
  onKeyDown,
}: {
  readonly itemKey: string;
  readonly dots: readonly SessionDot[];
  readonly hiddenCount: number;
  readonly label: string;
  readonly unfolded: boolean;
  readonly onToggle: (unfold: boolean) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={[
        "side-dots",
        ...(dots.length === 0 ? ["has-no-dots"] : []),
        ...(unfolded ? ["is-open"] : []),
      ].join(" ")}
      data-key={itemKey}
      aria-expanded={unfolded}
      aria-label={`${label}. ${unfolded ? "Fold" : "Unfold"}`}
      onClick={() => {
        onToggle(!unfolded);
      }}
      onKeyDown={onKeyDown}
    >
      <span className="side-dots-chevron">
        <ChevronRightIcon size={12} />
      </span>
      {/* The dots come in urgency order and never change place, so the index is a stable key. */}
      {dots.map((dot, index) => (
        <span key={index} className={`side-dot side-dot--${dot}`} />
      ))}
      {hiddenCount === 0 ? null : (
        <span className="side-dots-more">{`+${String(hiddenCount)}`}</span>
      )}
    </button>
  );
}

/**
 * Returns the key handler of a row of a group of several sessions: the right
 * arrow unfolds a folded group and the left arrow folds an unfolded one,
 * which calls `toggleGroup` with whether to unfold. A key that would do
 * nothing is left alone, so it still reaches whatever else uses it.
 */
const buildToggleOnArrow =
  (unfolded: boolean, toggleGroup: (unfold: boolean) => void) =>
  (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowRight" && !unfolded) {
      event.preventDefault();
      toggleGroup(true);
    } else if (event.key === "ArrowLeft" && unfolded) {
      event.preventDefault();
      toggleGroup(false);
    }
  };

/**
 * Renders what a group's row in a project and a group's row on the Done shelf
 * share: the tall row's frame, its link to the session `item.openId` with the
 * group's title (after a pencil while `item.unsent` is true), the dots button
 * of a group of several sessions and its arrow keys. `onToggleGroup` is called
 * with the group's key and whether to unfold it.
 *
 * - `modifier` is the class that sets the row's look, or `null`.
 * - `label` and `describedBy` are the link's accessible name and the ids of
 *   the text that describes it, or `undefined` for none.
 * - `status` ends the first line, `secondLine` is the second, and `action` is
 *   the button that takes the status's place while the pointer is on the row,
 *   or `null`.
 */
function GroupRowFrame({
  item,
  modifier,
  label,
  describedBy,
  status,
  secondLine,
  action,
  officeOpen,
  onToggleGroup,
}: {
  readonly item: SidebarItemOf<"group-row" | "done-group-row">;
  readonly modifier: "is-receded" | "is-done" | null;
  readonly label: string;
  readonly describedBy: string | undefined;
  readonly status: ReactNode;
  readonly secondLine: ReactNode;
  readonly action: ReactNode;
  readonly officeOpen: boolean;
  readonly onToggleGroup: (groupKey: string, unfold: boolean) => void;
}): JSX.Element {
  const { row, unsent, unfolded } = item;
  const { summary } = row;
  const toggleGroup = (unfold: boolean): void => {
    onToggleGroup(row.key, unfold);
  };
  const handleArrow = buildToggleOnArrow(unfolded, toggleGroup);
  const classNames = [
    "side-thread",
    ...(modifier === null ? [] : [modifier]),
    "side-item",
    ...(summary === null ? [] : ["has-crew"]),
    ...(unfolded ? ["is-unfolded"] : []),
  ];
  return (
    <div
      className={classNames.join(" ")}
      style={{
        marginTop: item.leading,
        height: ITEM_HEIGHTS[item.kind],
        ...(summary === null
          ? {}
          : {
              "--dots": `${String(measureDotsWidth(summary.dots.length, summary.hiddenCount))}px`,
            }),
      }}
    >
      <ThreadLink
        sessionId={item.openId}
        seated={item.seated}
        officeOpen={officeOpen}
        className={unsent ? "side-row is-unsent" : "side-row"}
        data-key={item.key}
        aria-label={label}
        aria-describedby={describedBy}
        onKeyDown={summary === null ? undefined : handleArrow}
      >
        <span className="side-text">
          <span className="side-line">
            <span className="side-name">
              {unsent ? <ComposeIcon size={UNSENT_ICON_SIZE} /> : null}
              {row.title}
            </span>
            {status}
          </span>
          {secondLine}
        </span>
      </ThreadLink>
      {action}
      {summary === null ? null : (
        <DotsButton
          itemKey={item.key}
          dots={summary.dots}
          hiddenCount={summary.hiddenCount}
          label={summary.label}
          unfolded={unfolded}
          onToggle={toggleGroup}
          onKeyDown={handleArrow}
        />
      )}
    </div>
  );
}

/**
 * Renders a group in its project, in two lines: a thread, or a lead with its
 * partners. The first line holds its title and its status slot
 * (`StatusSlot`); the second, the mark of its provider and, while a session
 * of the group asks something (`item.row.ask`, see `AskText`), the question,
 * else where the lead works (`item.row.placeLabel`, see `DetailLine`).
 *
 * - While `item.receded` is true, the row recedes to 72% opacity, and comes
 *   back while the pointer is on it or focus is in it. A working group's row
 *   recedes, unless it holds the open session. The row's words say what it
 *   is doing; the dimming only lets the eye skip it.
 * - When `item.unsent` is true, a composer of the group holds work the user
 *   has not sent: the row is tinted and a pencil sits before the title.
 * - While the pointer is on the row, or the keyboard's focus is in it, a
 *   Done button shows in the status slot's place. Pressing it calls
 *   `onMarkDone` with `item.row.doneIds`, the Threads of the group not yet
 *   Done. It is not drawn when there are none.
 * - A group of two or more sessions has a dots button at the end of the
 *   second line (`GroupRowFrame`), which calls `onToggleGroup`. While the row
 *   or the button has the focus, the arrow keys do the same: right unfolds,
 *   left folds. `item.unfolded` says whether the group's lines are drawn
 *   below the row. A group of one session has no dots and draws a thread's
 *   row.
 *
 * The link is named "<title>, <pose words>", such as "Fix checkout,
 * working", with ", unsent message" after it when `item.unsent` is true. It
 * is described by the question, when one is asked, the lead's model
 * (`item.details.model`), when it is known, and `row.placeDescription`, which
 * together name what the card shown on hover holds: the model, the project,
 * the workspace, the machine and the branch. Then by the status in words,
 * such as "Approval" or "20 minutes ago", except "Working", which the name
 * already says. It opens the session `item.openId`: in the Office's drawer
 * while `officeOpen` is true and the session has a colleague there
 * (`item.seated`), on its own screen if not.
 */
export const GroupRow = memo(function GroupRow({
  item,
  onScreen,
  officeOpen,
  onMarkDone,
  onToggleGroup,
}: {
  readonly item: SidebarItemOf<"group-row">;
  readonly onScreen: boolean;
  readonly officeOpen: boolean;
  readonly onMarkDone: (sessionIds: readonly string[]) => void;
  readonly onToggleGroup: (groupKey: string, unfold: boolean) => void;
}): JSX.Element {
  const { row, unsent } = item;
  const { ask } = row;
  const id = useId();
  const askId = `${id}-ask`;
  const placeId = `${id}-place`;
  const statusId = `${id}-status`;
  const describedBy = [
    ...(ask === null ? [] : [askId]),
    placeId,
    ...(row.status === "working" ? [] : [statusId]),
  ].join(" ");
  const { model } = item.details;
  return (
    <GroupRowFrame
      item={item}
      modifier={item.receded ? "is-receded" : null}
      label={`${row.title}, ${describePose(row.pose)}${unsent ? ", unsent message" : ""}`}
      describedBy={describedBy}
      status={
        <StatusSlot
          id={statusId}
          status={row.status}
          activityAt={row.activityAt}
          onScreen={onScreen}
        />
      }
      secondLine={
        <>
          <DetailLine
            providerId={row.providerId}
            clip={
              ask === null ? (
                row.placeLabel.clip
              ) : (
                <span id={askId}>
                  <AskText askerLabel={ask.askerLabel} question={ask.question} />
                </span>
              )
            }
            keep={ask === null ? row.placeLabel.keep : ""}
            asking={ask !== null}
          />
          {/* A screen reader reads the model and where the thread works
              from this text, which is never drawn: the model, the project,
              the machine and the branch show only in the card on hover. */}
          <span hidden id={placeId}>
            {model === null ? row.placeDescription : `${model} ${row.placeDescription}`}
          </span>
        </>
      }
      action={
        row.doneIds.length === 0 ? null : (
          <RowAction
            itemKey={item.key}
            label="Mark done"
            word="Done"
            icon={<CheckIcon size={ROW_GLYPH_SIZE} />}
            onPress={() => {
              onMarkDone(row.doneIds);
            }}
          />
        )
      }
      officeOpen={officeOpen}
      onToggleGroup={onToggleGroup}
    />
  );
}, areSameData);

/**
 * Returns the key handler of a line of an unfolded group: the left arrow
 * folds the group, which calls `onToggleGroup` with `groupKey`. Other keys,
 * and the left arrow with a modifier, are left alone.
 */
const buildFoldOnLeftArrow =
  (groupKey: string, onToggleGroup: (groupKey: string, unfold: boolean) => void) =>
  (event: KeyboardEvent<HTMLElement>): void => {
    if (
      event.key !== "ArrowLeft" ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    event.preventDefault();
    onToggleGroup(groupKey, false);
  };

/**
 * Renders one session of an unfolded group, as a line under the group's row:
 * its mark (`SessionMark`), its label in its group, its agent and its
 * status slot. The line has no Done button: Done belongs to the row.
 *
 * The line is the session's link, marked as the current page while the
 * session is open, and carries the session's full title as its tooltip. It
 * is named `member.accessibleName`. A
 * screen reader reads "In <group title>" after the name, and then the status
 * in words except "Working", because a flat, virtualized list cannot wrap
 * the lines in a group. It opens the session in the Office's drawer while
 * `officeOpen` is true and the session has a colleague there
 * (`item.member.seated`). While the line has focus, the left arrow folds the
 * group, which calls `onToggleGroup`.
 *
 * Each line draws its part of the guide line that joins the lines of one
 * group. `item.last` ends the guide above the line's bottom edge, instead of
 * running on to the next item.
 */
export const GroupLine = memo(function GroupLine({
  item,
  onScreen,
  officeOpen,
  onToggleGroup,
}: {
  readonly item: SidebarItemOf<"group-line">;
  readonly onScreen: boolean;
  readonly officeOpen: boolean;
  readonly onToggleGroup: (groupKey: string, unfold: boolean) => void;
}): JSX.Element {
  const { member } = item;
  const id = useId();
  const groupId = `${id}-group`;
  const statusId = `${id}-status`;
  return (
    <div
      className={item.last ? "side-member is-last side-item" : "side-member side-item"}
      style={{ marginTop: item.leading, height: ITEM_HEIGHTS["group-line"] }}
    >
      <ThreadLink
        sessionId={member.sessionId}
        seated={member.seated}
        officeOpen={officeOpen}
        className="side-m"
        data-key={item.key}
        title={member.title}
        aria-label={member.accessibleName}
        aria-describedby={member.status === "working" ? groupId : `${groupId} ${statusId}`}
        onKeyDown={buildFoldOnLeftArrow(item.groupKey, onToggleGroup)}
      >
        <SessionMark dot={member.dot} done={member.done} />
        <span className="side-m-name">{member.label}</span>
        <AgentLabel providerId={member.providerId} model={member.model} />
        <StatusSlot
          id={statusId}
          status={member.status}
          activityAt={member.activityAt}
          onScreen={onScreen}
        />
      </ThreadLink>
      <span hidden id={groupId}>{`In ${item.groupTitle}`}</span>
    </div>
  );
}, areSameData);

/**
 * Renders the "n quiet" line of an unfolded group: a button that stands for
 * `item.count` quiet sessions the group folded away. Pressing it calls
 * `onShowQuiet` with the group's key, and the group then draws a line for
 * each. `item.last` is as for `GroupLine`. While it has focus, the left arrow
 * folds the group, as on the lines it stands for.
 */
export const QuietLine = memo(function QuietLine({
  item,
  onShowQuiet,
  onToggleGroup,
}: {
  readonly item: SidebarItemOf<"quiet-line">;
  readonly onShowQuiet: (groupKey: string) => void;
  readonly onToggleGroup: (groupKey: string, unfold: boolean) => void;
}): JSX.Element {
  const groupId = useId();
  return (
    <div
      className={item.last ? "side-member is-last side-item" : "side-member side-item"}
      style={{ marginTop: item.leading, height: ITEM_HEIGHTS["quiet-line"] }}
    >
      <button
        type="button"
        className="side-m side-m--quiet"
        data-key={item.key}
        aria-describedby={groupId}
        onClick={() => {
          onShowQuiet(item.groupKey);
        }}
        onKeyDown={buildFoldOnLeftArrow(item.groupKey, onToggleGroup)}
      >
        <span className="side-dot side-dot--quiet" />
        <span className="side-m-name">{`${String(item.count)} quiet`}</span>
        <ChevronRightIcon size={12} />
      </button>
      <span hidden id={groupId}>{`In ${item.groupTitle}`}</span>
    </div>
  );
}, areSameData);

/**
 * Renders the Done shelf's heading: "Done" and the count of Done groups, as
 * a button that opens and closes the shelf. Pressing it calls `onToggle`.
 */
export const DoneHeader = memo(function DoneHeader({
  item,
  onToggle,
}: {
  readonly item: SidebarItemOf<"done-header">;
  readonly onToggle: () => void;
}): JSX.Element {
  return (
    <h3
      className="side-h side-h--done side-item"
      style={{ marginTop: item.leading, height: ITEM_HEIGHTS["done-header"] }}
    >
      {/* The space keeps the button's name "Done 12", not "Done12". */}
      <button type="button" data-key={item.key} aria-expanded={item.open} onClick={onToggle}>
        <ChevronRightIcon size={12} />
        <span>Done</span> <b className="count">{item.count}</b>
      </button>
    </h3>
  );
}, areSameData);

/**
 * Renders a group whose Threads are all Done, on the Done shelf, in a thread
 * row's two lines: its title, then how long ago it was marked Done
 * (`item.doneAt`). The row is dimmed to 60%, and comes back while the pointer
 * is on it or focus is in it. While the pointer is on it or the keyboard's
 * focus is in it, a Reopen button shows in the status slot's place. Pressing
 * it calls `onReopen` with `item.row.threadIds`, every Thread of the group.
 *
 * - A group of one Thread is a Done thread's row: the second line starts with
 *   the mark of its provider and reads "Done 2 hours ago".
 * - A group of several starts it with a green check and reads "3 threads ·
 *   done 2 hours ago".
 * - A group of several sessions has a dots button, as a group's row in a
 *   project has (`GroupRowFrame`), which unfolds its lines so an ended Agent
 *   session can still be opened. Nothing on the shelf is counted, so the
 *   button draws no dot, only its chevron. A group of one session does not
 *   unfold. The arrow keys work as they do on a group's row.
 *
 * The link is named "<title>, done", with the thread count before "done" for
 * several threads and ", unsent message" after it when `item.unsent` is true.
 * It opens the session `item.openId` as a thread row's link does: in the
 * Office's drawer while `officeOpen` is true and the session has a colleague
 * there (`item.seated`), on its own screen if not.
 */
export const DoneGroupRow = memo(function DoneGroupRow({
  item,
  onScreen,
  officeOpen,
  onReopen,
  onToggleGroup,
}: {
  readonly item: SidebarItemOf<"done-group-row">;
  readonly onScreen: boolean;
  readonly officeOpen: boolean;
  readonly onReopen: (sessionIds: readonly string[]) => void;
  readonly onToggleGroup: (groupKey: string, unfold: boolean) => void;
}): JSX.Element {
  const { row } = item;
  const doneWords = useAgeWords(item.doneAt, onScreen);
  const threadCount = row.threadIds.length;
  const several = threadCount > 1;
  return (
    <GroupRowFrame
      item={item}
      modifier="is-done"
      label={`${row.title}, ${several ? `${String(threadCount)} threads, ` : ""}done${item.unsent ? ", unsent message" : ""}`}
      describedBy={undefined}
      status={<span className="side-end" />}
      secondLine={
        <DetailLine
          providerId={row.providerId}
          clip={
            several ? `${String(threadCount)} threads · done ${doneWords}` : `Done ${doneWords}`
          }
          keep=""
          done={several}
        />
      }
      action={
        <RowAction
          itemKey={item.key}
          label="Reopen"
          word="Reopen"
          icon={<UndoIcon size={ROW_GLYPH_SIZE} />}
          onPress={() => {
            onReopen(row.threadIds);
          }}
        />
      }
      officeOpen={officeOpen}
      onToggleGroup={onToggleGroup}
    />
  );
}, areSameData);

/**
 * Renders the row of the Draft Thread open in the main pane, drawn as a
 * thread row: "New thread" after a pencil and "draft" in the status slot,
 * then where it will work (`item.placeClip` and `item.placeKeep`, see
 * `DetailLine`), as the thread's row will say once it starts. It is tinted
 * as a row with unsent work is, because a draft is unsent work, and marked
 * as the open screen, like the open thread's row. It is not a link, because
 * it leads to the screen it marks.
 */
export const DraftRow = memo(function DraftRow({
  item,
}: {
  readonly item: SidebarItemOf<"draft-row">;
}): JSX.Element {
  return (
    <div
      className="side-thread side-item"
      style={{ marginTop: item.leading, height: ITEM_HEIGHTS["draft-row"] }}
    >
      <div
        className="side-row is-unsent is-on"
        data-key={item.key}
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
          <DetailLine providerId={null} clip={item.placeClip} keep={item.placeKeep} />
        </span>
      </div>
    </div>
  );
}, areSameData);

/**
 * Renders a section's "more" row, such as "3 more". Pressing it shows the
 * section's hidden rows in place: `onExpand` is called with the section's
 * key (`item.section`). It is a button, not a link, because it goes nowhere.
 */
export const MoreRow = memo(function MoreRow({
  item,
  onExpand,
}: {
  readonly item: SidebarItemOf<"more">;
  readonly onExpand: (section: SectionKey) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="side-row side-row--more side-item"
      data-key={item.key}
      style={{ marginTop: item.leading, height: ITEM_HEIGHTS.more }}
      // The Done shelf's row adds more rows rather than expanding the section.
      aria-expanded={item.section === "done" ? undefined : false}
      onClick={() => {
        onExpand(item.section);
      }}
    >
      {item.label}
    </button>
  );
}, areSameData);

/**
 * Renders the "Show fewer" row at the end of an expanded section. Pressing it
 * shows the section's capped list again: `onCollapse` is called with the
 * section's key (`item.section`). Its accessible name says which section it
 * collapses, because every expanded section has one.
 */
export const FewerRow = memo(function FewerRow({
  item,
  onCollapse,
}: {
  readonly item: SidebarItemOf<"fewer">;
  readonly onCollapse: (section: SectionKey) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="side-row side-row--fewer side-item"
      data-key={item.key}
      style={{ marginTop: item.leading, height: ITEM_HEIGHTS.fewer }}
      aria-label={item.name}
      aria-expanded
      onClick={() => {
        onCollapse(item.section);
      }}
    >
      {item.label}
    </button>
  );
}, areSameData);
