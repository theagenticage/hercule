import type { PluginIdentity } from "@hercule/client-core";
import type { InboxGroupRowView } from "@hercule/client-core/inbox";
import { memo, type JSX, type MouseEvent } from "react";
import { ArchiveIcon } from "../../icons/archive";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { CheckIcon } from "../../icons/check";
import { LinkIcon } from "../../icons/link";
import { MinusIcon } from "../../icons/minus";
import { TasksIcon } from "../../icons/tasks";
import { PluginMark } from "../../marks";
import { ReasonLine, TimeFigure, type InboxClickModifiers } from "./inbox-row";
import "./inbox-list.css";
import "./inbox-group-row.css";

/** Returns how a group says that `count` of its members are not read yet. */
export const describeUnloaded = (count: number): string => `${String(count)} not loaded yet`;

/** The size of the link glyph in the first line's lead, and of the chevron on the second line. */
const GLYPH_SIZE = 14;

/** The size of a source's mark on the right of the second line. */
const SOURCE_MARK_SIZE = 12;

/**
 * Renders the head row of a group of linked things, 52px and two lines:
 *
 * - the first line's lead is a link glyph that turns into the tick under the
 *   pointer, as every row's mark does; the title is the group's label and the
 *   time is that of the member that placed the group;
 * - the second line starts with the chevron, in the glyph column, which
 *   unfolds the group and turns a quarter turn when it is open; then the most
 *   pressing ask, then the marks of the group's sources and "4 things".
 *
 * Selecting (the lead) and unfolding (the chevron) are two separate targets,
 * 24px tall each, one above the other. The tick draws the selection of the
 * group: `some` draws a dash and `all` a check. A tick pressed with Shift down
 * calls `onToggleSelect` with `whole` true: the group's members that do not
 * answer the query too. A click on the row itself calls `onPick` with the
 * modifier keys down, so Shift extends the selection and Command or Control
 * toggles the group in it, as on a thing's row.
 *
 * Under the pointer the head offers Take on and "Dismiss all N", which act
 * on the group (or on the selection, when the group is in it). There is no
 * thread button yet: starting a thread on a group waits for the thread slice.
 *
 * The head is a tree item at level 1 whose `aria-expanded` is `isOpen`, and
 * it is selected when the selection holds all of the group. Its key is its
 * `data-ref`. The row is memoized: it draws again only when its props change,
 * which holds while the callbacks keep their identity.
 */
export const InboxGroupRow = memo(function InboxGroupRow({
  view,
  plugins,
  isCurrent,
  isOpen,
  tick,
  unloadedCount,
  onPick,
  onToggleSelect,
  onToggleOpen,
  onTakeOn,
  onDismiss,
}: {
  readonly view: InboxGroupRowView;
  /** The plugins the sources' marks are drawn from. */
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly isCurrent: boolean;
  readonly isOpen: boolean;
  /** Whether the selection holds none, some or all of the group. */
  readonly tick: "none" | "some" | "all";
  /** How many of the group's members the list holds no row for yet: the head says so apart from its count. */
  readonly unloadedCount: number;
  /** The row was clicked outside its buttons: it becomes current, or the selection changes by `modifiers`. */
  readonly onPick: (key: string, modifiers: InboxClickModifiers) => void;
  /** The tick was pressed. `whole` is true with Shift down. */
  readonly onToggleSelect: (key: string, whole: boolean) => void;
  readonly onToggleOpen: (key: string) => void;
  /** Take on was pressed on the row. */
  readonly onTakeOn: (key: string) => void;
  /** "Dismiss all" was pressed on the row. */
  readonly onDismiss: (key: string) => void;
}): JSX.Element {
  const { key, reason } = view;
  const pick = (event: MouseEvent<HTMLDivElement>): void => {
    // A press on one of the row's own buttons is that button's.
    if (event.target instanceof Element && event.target.closest("button") !== null) return;
    onPick(key, {
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
    });
  };
  const classes = ["ib-row", "ib-row--group"];
  if (isCurrent) classes.push("is-current");
  if (isOpen) classes.push("is-open");
  if (tick !== "none") classes.push("is-picked");
  if (reason.quiet) classes.push("is-quiet");
  const selectLabel = tick === "all" ? "Unselect" : "Select";
  return (
    // The list owns the keyboard (J, K and the other keys of the screen). A click is the pointer's way to the same row.
    <div
      className={classes.join(" ")}
      role="treeitem"
      aria-level={1}
      aria-expanded={isOpen ? "true" : "false"}
      aria-selected={tick === "all"}
      aria-label={
        unloadedCount > 0 ? `${view.label}. ${describeUnloaded(unloadedCount)}` : view.label
      }
      tabIndex={isCurrent ? 0 : -1}
      data-ref={key}
      onClick={pick}
    >
      <span className="ib-row-lead">
        <span className="ib-mark ib-mark--link">
          <LinkIcon size={GLYPH_SIZE} />
        </span>
        <button
          type="button"
          className={tick === "none" ? "ib-row-tick" : "ib-row-tick is-on"}
          tabIndex={-1}
          aria-label={`${selectLabel} the group`}
          aria-keyshortcuts="X"
          onClick={(event) => {
            onToggleSelect(key, event.shiftKey);
          }}
        >
          {tick === "some" ? <MinusIcon size={12} /> : <CheckIcon size={12} />}
        </button>
      </span>
      <span className="ib-row-l1">
        <span className="ib-row-title">{view.title}</span>
        <TimeFigure time={view.time} />
      </span>
      <span className="ib-row-glyph">
        <button
          type="button"
          className="ib-group-fold"
          tabIndex={-1}
          title={isOpen ? "Fold the group (←)" : "Unfold the group (→)"}
          aria-label={isOpen ? "Fold the group" : "Unfold the group"}
          aria-keyshortcuts={isOpen ? "ArrowLeft" : "ArrowRight"}
          onClick={() => {
            onToggleOpen(key);
          }}
        >
          <ChevronRightIcon size={GLYPH_SIZE} />
        </button>
      </span>
      <span className="ib-row-l2">
        <ReasonLine reason={reason} />
        <span className="ib-row-where ib-row-where--group">
          <span className="ib-row-marks">
            {view.sources.map((source) => (
              <PluginMark
                key={source}
                pluginId={source}
                plugins={plugins}
                size={SOURCE_MARK_SIZE}
              />
            ))}
          </span>
          <span
            className="ib-row-id"
            title={unloadedCount > 0 ? describeUnloaded(unloadedCount) : undefined}
          >
            {view.count}
          </span>
        </span>
      </span>
      <span className="ib-row-acts">
        <button
          type="button"
          className="ib-row-act"
          tabIndex={-1}
          title="Take on (T)"
          aria-label="Take on"
          aria-keyshortcuts="T"
          onClick={() => {
            onTakeOn(key);
          }}
        >
          <TasksIcon size={14} />
        </button>
        <button
          type="button"
          className="ib-row-act"
          tabIndex={-1}
          title={`Dismiss all ${view.count} (E)`}
          aria-label={`Dismiss all ${view.count}`}
          aria-keyshortcuts="E"
          onClick={() => {
            onDismiss(key);
          }}
        >
          <ArchiveIcon size={14} />
        </button>
      </span>
    </div>
  );
});
