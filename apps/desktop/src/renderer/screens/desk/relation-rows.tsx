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
import { ExternalIcon } from "../../icons/external";
import { LinkIcon } from "../../icons/link";
import { LockIcon } from "../../icons/lock";
import { PluginMark } from "../../marks";
import { ProgressBar } from "./progress-bar";
import { EntityStatusIcon } from "./status-shape";
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
 * Returns the class names of a row's `<li>`: `base`, and `has-claim` when the
 * row has words that say who linked its thing.
 */
const buildRowClass = (row: PlaceRow, base: string): string =>
  row.link !== undefined && row.link.kind !== "own" ? `${base} has-claim` : base;

/**
 * Renders the words of who says a row's thing is linked, which stand over the
 * row's end while the row is hovered or has the focus. A link nobody's words
 * explain, such as one the Task holds itself, has no words.
 */
function Claim({ row }: { readonly row: PlaceRow }): JSX.Element | null {
  if (row.link === undefined || row.link.kind === "own") return null;
  return <small className="relation-claim">{row.link.claimWords}</small>;
}

/**
 * Renders the button that removes a link the user made, or nothing for a row
 * whose link the user cannot remove. It takes no room until the row is
 * hovered or has the focus, so the row's end sits against the right edge at
 * rest. The button ignores the second click of a double click, so a double
 * click on a Link button cannot undo itself.
 */
function UnlinkButton({
  row,
  onUnlink,
}: {
  readonly row: PlaceRow;
  readonly onUnlink?: ((row: PlaceRow) => void) | undefined;
}): JSX.Element | null {
  if (row.link?.canUnlink !== true || onUnlink === undefined) return null;
  return (
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
    <li className={buildRowClass(row, "relation-row is-locked")}>
      <div className="relation-go">
        <LockIcon size={13} />
        <span className="relation-title">
          {describeLockedRow(row, namePlugin(row.pluginId, plugins))}
        </span>
        <span className="relation-tail">
          <Claim row={row} />
        </span>
      </div>
      <UnlinkButton row={row} onUnlink={onUnlink} />
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
        <small className="relation-why">
          {row.link?.kind === "hint" ? row.link.claimWords : ""}
        </small>
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
 *   a place inside a sheet can be walked to. `canWalk` narrows that to the
 *   rows it accepts.
 * - A row of a linked thing (`row.link`) that cannot be walked to and has a
 *   URL is a link that opens the thing at its source in the browser. While the row is hovered or has the
 *   focus, its end moves left to make room for the external icon. Any other
 *   row is plain.
 * - `isKindShown` is false where the title already says what kind of thing the
 *   row is, such as a linked issue that starts with its identifier.
 * - A place no Connection can read is a locked row: a lock and the words "A
 *   Sentry issue you cannot open", never a title, and never a button.
 * - A row that draws a linked thing (`row.link`) shows its status icon and
 *   word in place of its kind. A source's or a person's link has the words of
 *   who says it is linked over that end while the row is hovered. A link the
 *   user can remove has a button that removes it, which also takes its room
 *   only while the row is hovered or has the focus.
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
  const isWalkable = onWalk !== undefined && canWalk?.(row) !== false;
  // Only a linked thing opens at its source. A place above it stays plain, as Part of draws it.
  const url = isWalkable || row.link === undefined ? undefined : row.url;
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
      <span className="relation-tail">
        {row.link !== undefined && row.status !== undefined ? (
          <span className="relation-end is-status">
            <EntityStatusIcon status={row.status} size={13} />
            {row.status.label}
          </span>
        ) : (
          row.link?.kind !== "confirmed" && (
            <span className="relation-end">
              <span className="relation-facts">{describePlace(row, isKindShown)}</span>
              {row.progress !== undefined && (
                <ProgressBar fraction={row.progress.fraction} words={row.progress.words} />
              )}
            </span>
          )
        )}
        <Claim row={row} />
      </span>
      {url !== undefined && (
        <span className="relation-external">
          <ExternalIcon size={13} />
        </span>
      )}
    </>
  );
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
  ) : url !== undefined ? (
    <a
      className="relation-go"
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`Open in ${namePlugin(row.pluginId, plugins)}`}
    >
      {words}
    </a>
  ) : (
    <div className="relation-go">{words}</div>
  );
  return (
    <li className={buildRowClass(row, "relation-row")}>
      {go}
      <UnlinkButton row={row} onUnlink={onUnlink} />
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
