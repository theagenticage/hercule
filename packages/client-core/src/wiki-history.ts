/**
 * Reads a Wiki Page's history for the open page's History list (spec 19
 * section 8.2): which revision is current, which revisions renamed the page,
 * and how many older revisions the list leaves out.
 *
 * It is a subpath export of its own and not part of the package's index,
 * because only the Wiki screen, which loads lazily, uses it.
 */
import type { Actor, WikiRevision } from "@hercule/contract";
import { formatCount } from "./threads/work-summary";

/** One row of a page's History list. */
export interface WikiHistoryRow {
  readonly revision: number;
  readonly actor: Actor;
  readonly at: string;
  /**
   * The title this revision gave the page, when it differs from the title of
   * the revision before it. `null` when the title did not change, and for the
   * oldest revision listed, whose previous title is not known.
   */
  readonly renamedTo: string | null;
}

/** A page's history, as the History list draws it. */
export interface WikiHistory {
  /** The page's current revision: the newest one. */
  readonly currentRevision: number;
  /** One row per listed revision, newest first. */
  readonly rows: readonly WikiHistoryRow[];
  /** How many older revisions the list leaves out, 0 when it lists them all. */
  readonly unlistedCount: number;
}

/**
 * Returns the history of a page from `revisions`, its newest revisions,
 * newest first, as `wikiPage.read` returns them. Revisions are numbered from
 * 1 with no gaps, so the newest revision's number is also how many revisions
 * the page has.
 *
 * `revisions` is never empty: a page is created with its first revision, and
 * no revision is ever deleted.
 */
export const buildWikiHistory = (revisions: readonly WikiRevision[]): WikiHistory => {
  const currentRevision = revisions[0]!.revision;
  return {
    currentRevision,
    rows: revisions.map((revision, index) => {
      const before = revisions[index + 1];
      return {
        revision: revision.revision,
        actor: revision.actor,
        at: revision.at,
        renamedTo: before !== undefined && before.title !== revision.title ? revision.title : null,
      };
    }),
    unlistedCount: currentRevision - revisions.length,
  };
};

/** Returns "And 3 older revisions": the line under the History list that counts the revisions it leaves out. */
export const describeUnlistedRevisions = (unlistedCount: number): string =>
  `And ${formatCount(unlistedCount, "older revision")}`;
