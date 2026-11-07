import { useId, type JSX } from "react";
import { namePlugin, type PluginIdentity } from "@hercule/client-core";
import { formatTargetDate, readEntityPluginId } from "@hercule/client-core/desk";
import {
  isMarkShownByHead,
  listSurfaceAboveWords,
  nameSurface,
  type InboxSurface,
  type SurfaceHead,
} from "@hercule/client-core/inbox";
import { LockIcon } from "../../icons/lock";
import { PluginMark } from "../../marks";
import { ProgressBar } from "../desk";
import { CardRow } from "./card-row";
import { CardStatus } from "./card-parts";
import { PointerRow } from "./pointer-row";
import "../desk/card.css";

/**
 * Renders the head of a place's surface: its mark and name at 18px, how it
 * stands, how far along the source says it is (never worked out from the
 * cards on the page) with its target date, and under them everything the
 * place is itself part of.
 *
 * - A place the user cannot open is a lock and the words "A Sentry issue you
 *   cannot open", with no title.
 * - A surface named for a plugin shows its mark and name. One named for a
 *   status, or for "No project", is its words alone.
 */
function PlaceHead({
  head,
  headingId,
  plugins,
}: {
  readonly head: SurfaceHead;
  readonly headingId: string;
  readonly plugins: readonly PluginIdentity[];
}): JSX.Element {
  if (head._tag === "plain") {
    return (
      <header className="inbox-place-head is-plain">
        <h3 id={headingId} className="inbox-place-title">
          {head.title}
        </h3>
      </header>
    );
  }
  if (head._tag === "source") {
    return (
      <header className="inbox-place-head">
        <div className="inbox-place-open">
          <span className="place-mark">
            <PluginMark pluginId={head.pluginId} plugins={plugins} size={16} />
          </span>
          <h3 id={headingId} className="inbox-place-title">
            {namePlugin(head.pluginId, plugins)}
          </h3>
        </div>
      </header>
    );
  }
  const { row } = head;
  if (row.isLocked) {
    return (
      <header className="inbox-place-head">
        <div className="inbox-place-open is-locked">
          <span className="place-mark">
            <LockIcon size={14} />
          </span>
          <h3 id={headingId} className="inbox-place-title">
            {nameSurface(head, plugins)}
          </h3>
        </div>
      </header>
    );
  }
  const above = listSurfaceAboveWords(head, plugins);
  const hasEnd = row.progress !== undefined || row.targetDate !== undefined;
  return (
    <header className="inbox-place-head">
      <div className="inbox-place-open" data-place-ref={row.ref}>
        <span className="place-mark">
          <PluginMark pluginId={row.pluginId} plugins={plugins} size={16} />
        </span>
        <h3 id={headingId} className="inbox-place-title">
          {row.title}
        </h3>
      </div>
      {row.status !== undefined && <CardStatus status={row.status} size={15} />}
      {hasEnd && (
        <span className="inbox-place-end">
          {row.progress !== undefined && (
            <ProgressBar fraction={row.progress.fraction} words={row.progress.words} wide />
          )}
          {row.targetDate !== undefined && <span>{formatTargetDate(row.targetDate)}</span>}
        </span>
      )}
      {above.length > 0 && (
        <p className="inbox-place-above">
          {above.map((words, index) => (
            <span key={index}>{words}</span>
          ))}
        </p>
      )}
    </header>
  );
}

/**
 * Renders one place as one raised surface (12px corner, `--h-rest`): its head,
 * then its cards as rows, in the order the visit holds (new ones at the end),
 * split by a hairline, then the cards that lie here only as a pointer to the
 * surface they are drawn in full on.
 *
 * - `showStatus` is false when the page is grouped by status, whose heads say
 *   it already.
 * - `monogram` is the user's, for the rows that a Task holds.
 * - `block` is the surface's place on the page, which sets when its words
 *   arrive after the first read.
 *
 * It stands as one stable element, `.inbox-place[data-place]`, with its sheet
 * (`.card-stock`), its head and its list of rows as children.
 */
export function PlaceSurface({
  surface,
  plugins,
  showStatus,
  monogram,
  block,
}: {
  readonly surface: InboxSurface;
  readonly plugins: readonly PluginIdentity[];
  readonly showStatus: boolean;
  readonly monogram: string;
  readonly block: number;
}): JSX.Element {
  const headingId = useId();
  const { head, rows } = surface;
  return (
    <section
      className="inbox-place"
      data-place={head.id}
      data-by-status={showStatus ? undefined : ""}
      aria-labelledby={headingId}
      style={{ "--arrive-block": block }}
    >
      <i className="card-stock" />
      <PlaceHead head={head} headingId={headingId} plugins={plugins} />
      <div className="inbox-place-rows" role="list">
        {rows.map((row, index) =>
          row.alsoIn === undefined ? (
            <CardRow
              key={row.card.id}
              card={row.card}
              near={row.near}
              plugins={plugins}
              showMark={!isMarkShownByHead(head, readEntityPluginId(row.card.kind))}
              showStatus={showStatus}
              monogram={monogram}
              step={index}
            />
          ) : (
            <PointerRow
              key={row.card.id}
              card={row.card}
              alsoInName={nameSurface(row.alsoIn, plugins)}
              showStatus={showStatus}
            />
          ),
        )}
      </div>
    </section>
  );
}
