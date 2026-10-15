/**
 * The parts of an open wiki page (spec 19 section 8.2): the band over an older
 * revision, the lead with its title, summary and repository, and the History
 * list beside the body. Every component here is presentational: it takes
 * values, and the route reads.
 */
import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { describeUnlistedRevisions, type WikiHistory } from "@hercule/client-core/wiki-history";
import { ActorMark, ActorName } from "../actor/actor-mark";
import { BranchIcon } from "../../icons/branch";
import { ClockIcon } from "../../icons/clock";
import { useListTime } from "../workflows/list-time";
import { SELECTED_LINK_PROPS } from "../selected-link-props";
import "../session/messages.css";
import "../workflows/workflow-detail.css";
import "../list-pane/open-item.css";
import "./wiki.css";

/** The size of the clock in the old-revision band, in CSS pixels. */
const BAND_ICON_SIZE = 14;

/** The size of the repository icon in the lead's chip, in CSS pixels. */
const CHIP_ICON_SIZE = 12;

/** The size of an actor's mark in a History row, in CSS pixels. */
const HISTORY_MARK_SIZE = 16;

/**
 * Renders the band above the page while an older revision is open: which
 * revision it is, of how many, and from when, with the link back to the
 * current page. `isFull` is whether the page fills the pane, which the link
 * keeps.
 */
export function OldRevisionBand({
  pageId,
  revision,
  currentRevision,
  updatedAt,
  timezone,
  isFull,
}: {
  readonly pageId: string;
  readonly revision: number;
  readonly currentRevision: number;
  /** When the open revision was written. */
  readonly updatedAt: string;
  readonly timezone: string;
  readonly isFull: boolean;
}): JSX.Element {
  const written = useListTime(updatedAt, timezone, "past", true);
  return (
    <div className="old-rev">
      <ClockIcon size={BAND_ICON_SIZE} />
      {/* One text node, as a text split over several can measure a hair wider. */}
      <span>{`Revision ${revision} of ${currentRevision}, from ${written}. This is not the current page.`}</span>
      <Link
        to="/wiki/$pageId"
        params={{ pageId }}
        search={{ full: isFull ? true : undefined }}
        className="btn btn--sm"
      >
        Show the current page
      </Link>
    </div>
  );
}

/**
 * Renders the lead of an open page: its title as the page's heading, with the
 * id `headingId` so the page can take its name from it, then its summary, then
 * the repository it is about. `repository` is the repository's path, such as
 * `acme/storefront`.
 */
export function WikiPageLead({
  headingId,
  title,
  summary,
  repository,
}: {
  readonly headingId: string;
  readonly title: string;
  readonly summary: string;
  readonly repository: string;
}): JSX.Element {
  return (
    <>
      <div className="open-name">
        <h1 id={headingId} title={title}>
          {title}
        </h1>
      </div>
      <p className="open-gist">{summary}</p>
      <ul className="chip-row" aria-label="About this page">
        <li className="chip">
          <BranchIcon size={CHIP_ICON_SIZE} />
          {repository}
        </li>
      </ul>
    </>
  );
}

/** Renders the line under a History row's name: `at` as a list shows a time, in `timezone`. */
function RevisionTime({
  at,
  timezone,
}: {
  readonly at: string;
  readonly timezone: string;
}): JSX.Element {
  return <span className="rev-when">{useListTime(at, timezone, "past", true)}</span>;
}

/**
 * Renders the History list: one row per listed revision, newest first, each a
 * link that opens that revision, then a line with how many older revisions
 * the list leaves out. The router selects the row of the revision the
 * address names. The newest revision's link opens the current
 * page, with no `revision` in its address. `isFull` is whether the page fills
 * the pane, which every link keeps.
 */
export function WikiHistoryList({
  pageId,
  history,
  timezone,
  isFull,
}: {
  readonly pageId: string;
  readonly history: WikiHistory;
  readonly timezone: string;
  readonly isFull: boolean;
}): JSX.Element {
  return (
    <aside className="history" aria-label="History">
      <h2 className="sec-h">
        <span>History</span>
      </h2>
      <div>
        {history.rows.map((row) => (
          <Link
            key={row.revision}
            to="/wiki/$pageId"
            params={{ pageId }}
            search={{
              full: isFull ? true : undefined,
              revision: row.revision === history.currentRevision ? undefined : row.revision,
            }}
            // Exact, so the router marks no other row as current: without it the
            // row of the current revision, which names no revision, matches
            // the address of every older one.
            activeOptions={{ exact: true }}
            activeProps={SELECTED_LINK_PROPS}
            className="rev"
          >
            <span className="rev-n">{row.revision}</span>
            <ActorMark actor={row.actor} size={HISTORY_MARK_SIZE} />
            <span className="rev-text">
              <span className="rev-who">
                <ActorName actor={row.actor} />
              </span>
              <RevisionTime at={row.at} timezone={timezone} />
              {row.renamedTo === null ? null : (
                <span className="rev-when">
                  Renamed to <bdi>{row.renamedTo}</bdi>
                </span>
              )}
            </span>
          </Link>
        ))}
      </div>
      {history.unlistedCount === 0 ? null : (
        <p className="history-more">{describeUnlistedRevisions(history.unlistedCount)}</p>
      )}
    </aside>
  );
}
