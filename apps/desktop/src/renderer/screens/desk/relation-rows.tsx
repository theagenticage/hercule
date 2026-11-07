import { namePlugin, type PluginIdentity } from "@hercule/client-core";
import {
  describeLockedRow,
  formatTargetDate,
  type LockedPlaceRow,
  type OpenPlaceRow,
  type PlaceRow,
} from "@hercule/client-core/desk";
import type { JSX } from "react";
import { LockIcon } from "../../icons/lock";
import { PluginMark } from "../../marks";
import { ProgressBar } from "./progress-bar";
import "./relation-rows.css";

/** Returns what a place says about itself in one line: "Project · At risk · 14 Nov". */
const describePlace = (row: OpenPlaceRow): string =>
  [
    row.noun,
    row.status?.label,
    row.targetDate === undefined ? undefined : formatTargetDate(row.targetDate),
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

/** Renders a place the user cannot open: its lock and the words, with no title. */
function LockedRow({
  row,
  plugins,
}: {
  readonly row: LockedPlaceRow;
  readonly plugins: ReadonlyArray<PluginIdentity>;
}): JSX.Element {
  return (
    <li className="relation-row is-locked">
      <div className="relation-go">
        <LockIcon size={13} />
        <span className="relation-title">
          {describeLockedRow(row, namePlugin(row.pluginId, plugins))}
        </span>
      </div>
    </li>
  );
}

/**
 * Renders one place, or one linked thing, as a row: the source's mark, its
 * title, and what it says about itself on the right: its kind, its status
 * word and target date, and its progress only when the source reports it.
 *
 * - With `onWalk`, the row is a button that calls it with the place's ref, so
 *   a place inside a sheet can be walked to. Without it, the row is plain.
 * - A place no Connection can read is a locked row: a lock and the words "A
 *   Sentry issue you cannot open", never a title, and never a button.
 * - `plugins` is what `plugin.query` returns, for the marks and the names.
 */
function RelationRow({
  row,
  plugins,
  onWalk,
}: {
  readonly row: PlaceRow;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onWalk?: ((ref: string) => void) | undefined;
}): JSX.Element {
  if (row.isLocked) return <LockedRow row={row} plugins={plugins} />;
  const words = (
    <>
      <span className="relation-mark">
        <PluginMark pluginId={row.pluginId} plugins={plugins} size={14} />
      </span>
      <span className="relation-title">{row.title}</span>
      <span className="relation-end">
        <span className="relation-facts">{describePlace(row)}</span>
        {row.progress !== undefined && (
          <ProgressBar fraction={row.progress.fraction} words={row.progress.words} />
        )}
      </span>
    </>
  );
  return (
    <li className="relation-row">
      {onWalk === undefined ? (
        <div className="relation-go">{words}</div>
      ) : (
        <button
          type="button"
          className="relation-go"
          onClick={() => {
            onWalk(row.ref);
          }}
        >
          {words}
        </button>
      )}
    </li>
  );
}

/**
 * Renders the rows of the places above a thing, as `readAncestorRows`
 * returns them: every place on every path, each once, nearest first. The list
 * is flat, because a place with two parents is not a step on one ladder.
 */
export function RelationRows({
  rows,
  plugins,
  onWalk,
}: {
  readonly rows: ReadonlyArray<PlaceRow>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onWalk?: ((ref: string) => void) | undefined;
}): JSX.Element {
  return (
    <ul className="relation-rows">
      {rows.map((row) => (
        <RelationRow key={row.ref} row={row} plugins={plugins} onWalk={onWalk} />
      ))}
    </ul>
  );
}
