import type { PluginIdentity } from "@hercule/client-core";
import type { InboxGroupRowView } from "@hercule/client-core/inbox";
import { memo, type JSX, type MouseEvent } from "react";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { CheckIcon } from "../../icons/check";
import { LinkIcon } from "../../icons/link";
import { MinusIcon } from "../../icons/minus";
import { PluginMark } from "../../marks";
import { ReasonLine, TimeFigure } from "./inbox-row";
import "./inbox-list.css";
import "./inbox-group-row.css";

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
 * answer the query too.
 *
 * The head is a tree item at level 1 whose `aria-expanded` is `isOpen`, and
 * it is selected when the selection holds all of the group. Its key is its
 * `data-ref`. The row is memoized: it draws again only when its props change,
 * which holds while the three callbacks keep their identity.
 */
export const InboxGroupRow = memo(function InboxGroupRow({
  view,
  plugins,
  isCurrent,
  isOpen,
  tick,
  onPick,
  onToggleSelect,
  onToggleOpen,
}: {
  readonly view: InboxGroupRowView;
  /** The plugins the sources' marks are drawn from. */
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly isCurrent: boolean;
  readonly isOpen: boolean;
  /** Whether the selection holds none, some or all of the group. */
  readonly tick: "none" | "some" | "all";
  /** The row was clicked outside its two buttons: it becomes current. */
  readonly onPick: (key: string) => void;
  /** The tick was pressed. `whole` is true with Shift down. */
  readonly onToggleSelect: (key: string, whole: boolean) => void;
  readonly onToggleOpen: (key: string) => void;
}): JSX.Element {
  const { key, reason } = view;
  const pick = (event: MouseEvent<HTMLDivElement>): void => {
    // A press on one of the row's own buttons is that button's.
    if (event.target instanceof Element && event.target.closest("button") !== null) return;
    onPick(key);
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
      aria-label={view.label}
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
          <span className="ib-row-id">{view.count}</span>
        </span>
      </span>
    </div>
  );
});
