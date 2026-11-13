import { memo, type JSX } from "react";
import { PlusIcon } from "../../icons/plus";
import { describeUnloaded } from "./inbox-group-row";
import "./inbox-list.css";
import "./inbox-group-row.css";

/**
 * Renders the line "Show 9 more in this group" at the foot of an open group of
 * more than seven things, which shows five until it is pressed. It is
 * indented like a member and sits on the group's hairline, which ends in it.
 * It is a tree item at level 2; its `data-ref` is the key of its entry in
 * the list (`lineKey`), which a press hands to `onShowMore`.
 */
export const InboxGroupMore = memo(function InboxGroupMore({
  lineKey,
  hiddenCount,
  unloadedCount,
  isCurrent,
  onShowMore,
}: {
  readonly lineKey: string;
  /** How many members of the group are not drawn. */
  readonly hiddenCount: number;
  /** How many members the group has that the list holds no row for yet: the line says so, quietly. */
  readonly unloadedCount: number;
  readonly isCurrent: boolean;
  readonly onShowMore: (lineKey: string) => void;
}): JSX.Element {
  const label = `Show ${String(hiddenCount)} more in this group`;
  return (
    // The list owns the keyboard. A click is the pointer's way to the same line.
    <div
      className={isCurrent ? "ib-row ib-group-more is-current" : "ib-row ib-group-more"}
      role="treeitem"
      aria-level={2}
      aria-label={label}
      tabIndex={isCurrent ? 0 : -1}
      data-ref={lineKey}
      onClick={() => {
        onShowMore(lineKey);
      }}
    >
      <span className="ib-group-more-in">
        <span className="ib-group-more-icon">
          <PlusIcon size={12} />
        </span>
        {label}
        {unloadedCount > 0 && (
          <span className="ib-group-more-unloaded">{`· ${describeUnloaded(unloadedCount)}`}</span>
        )}
      </span>
    </div>
  );
});
