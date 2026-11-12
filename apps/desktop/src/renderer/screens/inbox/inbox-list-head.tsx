import type { PluginIdentity } from "@hercule/client-core";
import type { JSX, Ref } from "react";
import { FilterIcon } from "../../icons/filter";
import { PluginMark } from "../../marks";
import { InboxCountSkeleton } from "./inbox-states";
import "./inbox-list.css";

/** Writes a count with grouped digits: 1,204. */
const COUNT_FORMAT = new Intl.NumberFormat("en-GB");

/**
 * Renders the head of the Inbox list, 48px high:
 *
 * - what the list is: `title` is a saved query's name, a Browse value, or
 *   "Search". A Browse value also gives the `mark` of its source and, when the
 *   source has several accounts, the `account`;
 * - how many things it holds, `count`, in grouped tabular figures (a still bar while it is `null`);
 * - the order in words (`orderWords`, "Longest waiting first"). While
 *   `newCount` is above 0, the "N new" pill takes the words' place: it
 *   calls `onShowNew`, and the list below does not move;
 * - Narrow, which calls `onNarrow` when pressed. `narrowOpen` is whether its menu is open,
 *   and `narrowRef` receives its button, which the menu anchors to.
 *
 * An `empty` list hides the order, the pill and Narrow, because there is
 * nothing to order or narrow. Under 400px of width the order words hide too.
 */
export function InboxListHead({
  title,
  mark,
  plugins,
  account,
  count,
  orderWords,
  newCount,
  empty,
  narrowOpen,
  narrowRef,
  onShowNew,
  onNarrow,
}: {
  readonly title: string;
  /** The plugin id of the Browse value's source. */
  readonly mark?: string | undefined;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly account?: string | undefined;
  /** How many things the list holds, or `null` while that is being read: a still bar draws instead. */
  readonly count: number | null;
  readonly orderWords: string;
  readonly newCount: number;
  readonly empty: boolean;
  readonly narrowOpen: boolean;
  readonly onShowNew: () => void;
  /** Receives the Narrow button while it is drawn. */
  readonly narrowRef: Ref<HTMLButtonElement>;
  readonly onNarrow: () => void;
}): JSX.Element {
  return (
    <div className="ib-head">
      <div className="ib-head-title">
        {mark === undefined ? null : (
          <span className="ib-head-mark">
            <PluginMark pluginId={mark} plugins={plugins} size={14} />
          </span>
        )}
        <h2>{title}</h2>
        {account === undefined ? null : <span className="ib-head-account">{account}</span>}
        <span className="ib-head-count">
          {count === null ? <InboxCountSkeleton /> : COUNT_FORMAT.format(count)}
        </span>
      </div>
      {empty ? null : (
        <div className="ib-head-tools">
          {newCount > 0 ? (
            <button
              type="button"
              className="ib-newbar"
              title="Show what is new (.)"
              aria-keyshortcuts="."
              onClick={onShowNew}
            >
              <span className="ib-newbar-count">{newCount} new</span>
              <span className="ib-newbar-show">
                Show<kbd aria-hidden="true">.</kbd>
              </span>
            </button>
          ) : (
            <span className="ib-head-order">{orderWords}</span>
          )}
          <button
            type="button"
            ref={narrowRef}
            className="ib-narrow"
            aria-haspopup="menu"
            aria-expanded={narrowOpen ? "true" : "false"}
            aria-keyshortcuts="F"
            onClick={onNarrow}
          >
            <FilterIcon size={14} />
            <b>Narrow</b>
          </button>
        </div>
      )}
    </div>
  );
}
