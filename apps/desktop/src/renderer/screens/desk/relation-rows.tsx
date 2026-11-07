import { namePlugin, type PluginIdentity } from "@hercule/client-core";
import {
  describeLockedRow,
  formatTargetDate,
  type LockedPlaceRow,
  type OpenPlaceRow,
  type PlaceRow,
} from "@hercule/client-core/desk";
import { useId, type JSX } from "react";
import { LockIcon } from "../../icons/lock";
import { PluginMark } from "../../marks";
import { ProgressBar } from "./progress-bar";
import "./relation-rows.css";

/**
 * Renders who claims a link, such as "GitHub reports this" or "Noa linked
 * this". It stays quiet until the row it sits in is hovered or has focus, then
 * fades in over `--m-quick` at the end of the row. `id` lets the row name it
 * as the description of its button, so assistive technology reads it too.
 */
export function ClaimHint({
  words,
  id,
}: {
  readonly words: string;
  readonly id?: string;
}): JSX.Element {
  return (
    <small id={id} className="relation-claim">
      {words}
    </small>
  );
}

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
  claim,
}: {
  readonly row: LockedPlaceRow;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly claim?: string | undefined;
}): JSX.Element {
  return (
    <li className="relation-row is-locked">
      <div className="relation-go">
        <LockIcon size={13} />
        <span className="relation-title">
          {describeLockedRow(row, namePlugin(row.pluginId, plugins))}
        </span>
      </div>
      {claim !== undefined && <ClaimHint words={claim} />}
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
 * - `claim` is who claims the link. It shows on hover or focus, in place of
 *   the words on the right.
 * - `plugins` is what `plugin.query` returns, for the marks and the names.
 */
export function RelationRow({
  row,
  plugins,
  onWalk,
  claim,
}: {
  readonly row: PlaceRow;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onWalk?: ((ref: string) => void) | undefined;
  readonly claim?: string | undefined;
}): JSX.Element {
  const claimId = useId();
  if (row.isLocked) return <LockedRow row={row} plugins={plugins} claim={claim} />;
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
    <li className="relation-row" data-claimed={claim === undefined ? undefined : ""}>
      {onWalk === undefined ? (
        <div className="relation-go">{words}</div>
      ) : (
        <button
          type="button"
          className="relation-go"
          aria-describedby={claim === undefined ? undefined : claimId}
          onClick={() => {
            onWalk(row.ref);
          }}
        >
          {words}
        </button>
      )}
      {claim !== undefined && <ClaimHint words={claim} id={claimId} />}
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
