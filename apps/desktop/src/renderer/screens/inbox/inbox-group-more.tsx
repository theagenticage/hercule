import { memo, type JSX } from "react";
import { PlusIcon } from "../../icons/plus";
import "./inbox-list.css";
import "./inbox-group-row.css";

/**
 * Renders the line "Show 9 more in this group" at the foot of an open group of
 * more than seven things, which shows five until it is pressed. It is
 * indented like a member and sits on the group's hairline, which ends in it.
 * It is a tree item at level 2; its `data-ref` is the group's key with
 * ":more", the key of its entry in the list.
 */
export const InboxGroupMore = memo(function InboxGroupMore({
  groupKey,
  hiddenCount,
  isCurrent,
  onShowMore,
}: {
  readonly groupKey: string;
  /** How many members of the group are not drawn. */
  readonly hiddenCount: number;
  readonly isCurrent: boolean;
  readonly onShowMore: (groupKey: string) => void;
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
      data-ref={`${groupKey}:more`}
      onClick={() => {
        onShowMore(groupKey);
      }}
    >
      <span className="ib-group-more-in">
        <span className="ib-group-more-icon">
          <PlusIcon size={12} />
        </span>
        {label}
      </span>
    </div>
  );
});
