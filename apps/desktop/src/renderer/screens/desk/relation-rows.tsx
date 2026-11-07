import { namePlugin, type PluginIdentity } from "@hercule/client-core";
import {
  describeLockedRow,
  formatTargetDate,
  type LockedPlaceRow,
  type OpenPlaceRow,
  type PlaceRow,
} from "@hercule/client-core/desk";
import type { JSX } from "react";
import { CloseIcon } from "../../icons/close";
import { LinkIcon } from "../../icons/link";
import { LockIcon } from "../../icons/lock";
import { PluginMark } from "../../marks";
import { ProgressBar } from "./progress-bar";
import { StatusShape } from "./status-shape";
import "./relation-rows.css";

/**
 * Returns what a place says about itself in one line: "Project · At risk · 14
 * Nov". The kind's noun is left out when `isKindShown` is false.
 */
const describePlace = (row: OpenPlaceRow, isKindShown: boolean): string =>
  [
    isKindShown ? row.noun : undefined,
    row.status?.label,
    row.targetDate === undefined ? undefined : formatTargetDate(row.targetDate),
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

/**
 * Renders the words of who says a row's thing is linked, which stand over the
 * row's end while the row is hovered or has the focus, and the button that
 * removes the link when the user made it. The button ignores the second click
 * of a double click, so a double click on a Link button cannot undo itself.
 */
function ClaimAndUnlink({
  row,
  onUnlink,
}: {
  readonly row: PlaceRow;
  readonly onUnlink?: ((row: PlaceRow) => void) | undefined;
}): JSX.Element | null {
  const { link } = row;
  if (link === undefined) return null;
  return (
    <>
      <small className="relation-claim">{link.claimWords}</small>
      {link.canUnlink && onUnlink !== undefined && (
        <button
          type="button"
          className="relation-unlink"
          title="Remove this link. The source is not told."
          aria-label={`Remove the link to ${row.isLocked ? row.noun : row.title}`}
          onClick={(event) => {
            // The second click of a double click may land here: the first one linked a thing, and this button took its place under the pointer.
            if (event.detail > 1) return;
            onUnlink(row);
          }}
        >
          <CloseIcon size={12} />
        </button>
      )}
    </>
  );
}

/** Renders a place the user cannot open: its lock and the words, with no title. */
function LockedRow({
  row,
  plugins,
  onUnlink,
}: {
  readonly row: LockedPlaceRow;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onUnlink?: ((row: PlaceRow) => void) | undefined;
}): JSX.Element {
  return (
    <li
      className={
        row.link === undefined ? "relation-row is-locked" : "relation-row is-locked has-claim"
      }
    >
      <div className="relation-go">
        <LockIcon size={13} />
        <span className="relation-title">
          {describeLockedRow(row, namePlugin(row.pluginId, plugins))}
        </span>
      </div>
      <ClaimAndUnlink row={row} onUnlink={onUnlink} />
    </li>
  );
}

/**
 * Renders a reference found in text, which proves nothing: a link icon, the
 * title, the words of where it was found, and a button that links the two.
 */
function HintRow({
  row,
  onLink,
}: {
  readonly row: OpenPlaceRow;
  readonly onLink?: ((row: OpenPlaceRow) => void) | undefined;
}): JSX.Element {
  return (
    <li className="relation-row is-hint">
      <div className="relation-go">
        <LinkIcon size={13} />
        <span className="relation-title">{row.title}</span>
        <small className="relation-why">{row.link?.claimWords}</small>
      </div>
      {onLink !== undefined && (
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            onLink(row);
          }}
        >
          Link
        </button>
      )}
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
 *   `canWalk` narrows that to the rows it accepts, so a row it refuses stays plain.
 * - `isKindShown` is false where the title already says what kind of thing the
 *   row is, such as a linked issue that starts with its identifier.
 * - A place no Connection can read is a locked row: a lock and the words "A
 *   Sentry issue you cannot open", never a title, and never a button.
 * - A row that draws a linked thing (`row.link`) shows its status shape and
 *   word in place of its kind, and the words of who says it is linked over
 *   that end while the row is hovered. A link the user made has a button that
 *   removes it, and a hint has a button that links the two.
 * - A thing that changed at its source shows the change under its title.
 * - `plugins` is what `plugin.query` returns, for the marks and the names.
 */
function RelationRow({
  row,
  plugins,
  onWalk,
  canWalk,
  isKindShown,
  onUnlink,
}: {
  readonly row: PlaceRow;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onWalk?: ((ref: string) => void) | undefined;
  readonly canWalk?: ((row: OpenPlaceRow) => boolean) | undefined;
  readonly isKindShown: boolean;
  readonly onUnlink?: ((row: PlaceRow) => void) | undefined;
}): JSX.Element {
  if (row.isLocked) return <LockedRow row={row} plugins={plugins} onUnlink={onUnlink} />;
  const isLinked = row.link !== undefined;
  const title = <span className="relation-title">{row.title}</span>;
  const words = (
    <>
      <span className="relation-mark">
        <PluginMark pluginId={row.pluginId} plugins={plugins} size={14} />
      </span>
      {row.latestChange === undefined ? (
        title
      ) : (
        <span className="relation-text">
          {title}
          <span className="relation-change" data-tone={row.latestChange.tone}>
            {row.latestChange.say}
          </span>
        </span>
      )}
      {isLinked ? (
        row.status !== undefined && (
          <span className="relation-end is-status">
            <StatusShape shape={row.status.shape} tone={row.status.tone} size={13} />
            {row.status.label}
          </span>
        )
      ) : (
        <span className="relation-end">
          <span className="relation-facts">{describePlace(row, isKindShown)}</span>
          {row.progress !== undefined && (
            <ProgressBar fraction={row.progress.fraction} words={row.progress.words} />
          )}
        </span>
      )}
    </>
  );
  const isWalkable = onWalk !== undefined && canWalk?.(row) !== false;
  const go = isWalkable ? (
    <button
      type="button"
      className="relation-go"
      onClick={() => {
        onWalk(row.ref);
      }}
    >
      {words}
    </button>
  ) : (
    <div className="relation-go">{words}</div>
  );
  return (
    <li className={isLinked ? "relation-row has-claim" : "relation-row"}>
      {go}
      <ClaimAndUnlink row={row} onUnlink={onUnlink} />
    </li>
  );
}

/**
 * Renders the rows of the places above a thing, as `readAncestorRows`
 * returns them: every place on every path, each once, nearest first. The list
 * is flat, because a place with two parents is not a step on one ladder.
 * `onWalk`, `canWalk` and `isKindShown` apply to every row (see `RelationRow`).
 *
 * The same rows draw the things linked to a thing (`buildLinkedRows`).
 * `onUnlink` is called with a row whose link the user made, when its button is
 * pressed. `onLink` is called with a hint's row, when its Link button is
 * pressed. A row is plain when its handler is left out.
 */
export function RelationRows({
  rows,
  plugins,
  onWalk,
  canWalk,
  isKindShown,
  onUnlink,
  onLink,
}: {
  readonly rows: ReadonlyArray<PlaceRow>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onWalk?: ((ref: string) => void) | undefined;
  readonly canWalk?: ((row: OpenPlaceRow) => boolean) | undefined;
  readonly isKindShown?: boolean;
  readonly onUnlink?: ((row: PlaceRow) => void) | undefined;
  readonly onLink?: ((row: OpenPlaceRow) => void) | undefined;
}): JSX.Element {
  return (
    <ul className="relation-rows">
      {rows.map((row) =>
        row.link?.kind === "hint" && !row.isLocked ? (
          <HintRow key={row.ref} row={row} onLink={onLink} />
        ) : (
          <RelationRow
            key={row.ref}
            row={row}
            plugins={plugins}
            onWalk={onWalk}
            canWalk={canWalk}
            isKindShown={isKindShown !== false}
            onUnlink={onUnlink}
          />
        ),
      )}
    </ul>
  );
}
