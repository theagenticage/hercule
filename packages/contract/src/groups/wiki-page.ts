/**
 * The Wiki: per repository, pages that agents write for the agents after them
 * (spec 19 section 2.3).
 *
 * A Wiki is the set of Wiki Pages of one Resource of kind `repo`; it has no id
 * and no settings of its own. A page is named in its Wiki by a slug that never
 * changes. Every write of a page's content stores a new revision holding the whole page, stamped
 * with its actor and time. Nothing is ever deleted: a wrong page is rewritten,
 * and its history shows what it said before. A page that no longer helps is
 * archived: it leaves the listing, and it and every one of its revisions
 * stay readable by its id. Restoring it puts it back in the listing.
 *
 * Every page carries the Resource's canonical remote as `repository`, copied
 * when the page is created. A caller without `resource.read` can still see
 * which repository a page is about, and the name stays after the Resource is
 * deleted.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { closedStruct } from "../closed";
import {
  CapExceeded,
  Conflict,
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Actor, Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { nonBlankLine, nonBlankText } from "../strings";

/** The longest slug. */
export const MAX_WIKI_SLUG_LENGTH = 64;

/** The longest page title, in characters. */
export const MAX_WIKI_TITLE_LENGTH = 120;

/** The longest page summary, in characters. */
export const MAX_WIKI_SUMMARY_LENGTH = 200;

/** The longest page body, in characters. */
export const MAX_WIKI_PAGE_LENGTH = 64_000;

/** The longest reason for archiving a page, in characters. */
export const MAX_WIKI_ARCHIVE_REASON_LENGTH = 200;

/** The most pages one Wiki holds, not counting archived pages. */
export const MAX_WIKI_PAGES = 500;

/** How many revisions `wikiPage.read` lists, newest first. */
export const MAX_WIKI_REVISIONS_LISTED = 50;

/**
 * What belongs in a Wiki and what does not, as every agent that may write
 * pages is told it. The start-up paragraph of a session, the `hercule` skill
 * and the help of `wiki-page create` and `wiki-page update` all quote this
 * one text, so the rule cannot read differently in two places (spec 19
 * section 7.1).
 *
 * It exists because a session sees only its own task and a few page titles.
 * Told only to write down what it learned, each session wrote a page about
 * its ticket, and the next session copied it. So the text opens with what
 * the Wiki is not, and sets the bar by how many would need a lesson: many
 * other agents on many other tasks, not the next agent on the same work.
 */
export const WIKI_WRITING_RULES =
  "The wiki is not a worklog, and nothing in it is about one ticket, pull request or thread. " +
  "It holds only general lessons that many other agents are likely to need on many other tasks: how something is run or checked, a trap in a tool, a fact about a machine or an outside service. " +
  "What you learned on a ticket belongs here only when it holds beyond that ticket. A recap, a handoff note or a dated entry never does. " +
  "List the pages before you write. Add to the page on the subject, and create a page only when there is none. Name a page for its subject. " +
  "A decision or a rule belongs in the repository's own docs, not in the wiki. " +
  "When a human allows an exception to a rule of the repository, record what was allowed, by whom and when. " +
  "Correct a page that is wrong, and archive one that no longer helps.";

/**
 * A page's stable name in its Wiki: lowercase letters and digits in groups
 * joined by single hyphens, such as `release-process`.
 */
export const WikiPageSlug = Schema.String.check(
  Schema.isMaxLength(MAX_WIKI_SLUG_LENGTH),
  Schema.isPattern(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    expected: "lowercase letters and digits, in groups joined by single hyphens",
  }),
);

const WikiPageTitle = nonBlankLine(MAX_WIKI_TITLE_LENGTH);
const WikiPageSummaryText = nonBlankLine(MAX_WIKI_SUMMARY_LENGTH);
const WikiPageBody = nonBlankText(MAX_WIKI_PAGE_LENGTH);
const WikiArchiveReason = nonBlankLine(MAX_WIKI_ARCHIVE_REASON_LENGTH);

/** A revision number. Revision 1 is the page as it was created. */
export const WikiRevisionNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * The mark of an archived page: when it was archived, by whom and why. The
 * reason is one line, and names the page that took over the subject when
 * there is one. An archived page is not listed, is not counted, and takes no
 * update. `wikiPage.restore` clears the mark.
 */
export const WikiPageArchived = Schema.Struct({
  at: Timestamp,
  by: Actor,
  reason: Schema.String,
});

export type WikiPageArchived = Schema.Schema.Type<typeof WikiPageArchived>;

/** A row of `wikiPage.query`: a page without its body. */
export const WikiPageSummary = Schema.Struct({
  id: Id,
  resourceId: Id,
  /** The repository's canonical remote, such as `github.com/acme/web`. */
  repository: Schema.String,
  slug: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  /** The current revision. */
  revision: WikiRevisionNumber,
  /** The current revision's time. */
  updatedAt: Timestamp,
  /** The current revision's actor. */
  updatedBy: Actor,
  createdAt: Timestamp,
  /** Set while the page is archived (`wikiPage.archive`); absent otherwise. */
  archived: Schema.optionalKey(WikiPageArchived),
});

export type WikiPageSummary = Schema.Schema.Type<typeof WikiPageSummary>;

/** A whole page, as of one revision. */
export const WikiPage = Schema.Struct({
  ...WikiPageSummary.fields,
  body: Schema.String,
});

export type WikiPage = Schema.Schema.Type<typeof WikiPage>;

/** One entry of a page's history. The body is read with `wikiPage.read` and `revision`. */
export const WikiRevision = Schema.Struct({
  revision: WikiRevisionNumber,
  title: Schema.String,
  summary: Schema.String,
  at: Timestamp,
  actor: Actor,
});

export type WikiRevision = Schema.Schema.Type<typeof WikiRevision>;

/** What a page listing may be sorted by. */
export const WIKI_PAGE_SORT_FIELDS = ["updatedAt", "title", "createdAt"] as const;

/**
 * Which pages a listing holds, by whether they are archived: `only` the
 * archived pages, or `include` them beside the pages that are not archived.
 */
export const WikiPageArchivedFilter = Schema.Literals(["only", "include"]);

export type WikiPageArchivedFilter = Schema.Schema.Type<typeof WikiPageArchivedFilter>;

/** The filter of `wikiPage.query`. */
export const WikiPageFilter = Schema.Struct({
  /** Only this repository's pages. Without it, every repository's pages are listed. */
  resourceId: Schema.optionalKey(Id),
  /**
   * Left out, only the pages that are not archived are listed, which is what
   * archiving a page is for. `only` lists the archived pages, and `include`
   * lists every page.
   */
  archived: Schema.optionalKey(WikiPageArchivedFilter),
});

/**
 * The payload of `wikiPage.create`. Without `resourceId`, a session's call
 * takes the one repository checked out in its workspace.
 */
export const WikiPageCreateInput = closedStruct({
  resourceId: Schema.optionalKey(Id),
  slug: WikiPageSlug,
  title: WikiPageTitle,
  summary: WikiPageSummaryText,
  body: WikiPageBody,
});

export type WikiPageCreateInput = Schema.Schema.Type<typeof WikiPageCreateInput>;

/**
 * The fields of `wikiPage.update`'s payload. The body is always given whole;
 * a title or a summary left out keeps its value.
 */
export const WIKI_PAGE_UPDATE_FIELDS = {
  /** The revision the caller read. The update is refused when the page has moved past it. */
  expectedRevision: WikiRevisionNumber,
  title: Schema.optionalKey(WikiPageTitle),
  summary: Schema.optionalKey(WikiPageSummaryText),
  body: WikiPageBody,
} as const;

/** The payload of `wikiPage.update`. */
export const WikiPageUpdateInput = closedStruct(WIKI_PAGE_UPDATE_FIELDS);

export type WikiPageUpdateInput = Schema.Schema.Type<typeof WikiPageUpdateInput>;

/** The fields of `wikiPage.archive`'s payload. */
export const WIKI_PAGE_ARCHIVE_FIELDS = {
  /**
   * The revision the caller read. The archive is refused when the page has
   * moved past it, so nobody archives a page for what it no longer says.
   */
  expectedRevision: WikiRevisionNumber,
  /** Why the page is archived, in one line. */
  reason: WikiArchiveReason,
} as const;

/** The payload of `wikiPage.archive`. */
export const WikiPageArchiveInput = closedStruct(WIKI_PAGE_ARCHIVE_FIELDS);

export type WikiPageArchiveInput = Schema.Schema.Type<typeof WikiPageArchiveInput>;

/** What `wikiPage.read` returns: the page, and its newest revisions, newest first. */
export const WikiPageWithRevisions = Schema.Struct({
  page: WikiPage,
  revisions: Schema.Array(WikiRevision),
});

export type WikiPageWithRevisions = Schema.Schema.Type<typeof WikiPageWithRevisions>;

export const wikiPage = HttpApiGroup.make("wikiPage")
  .add(
    HttpApiEndpoint.get("query", "/wiki-pages", {
      query: Schema.Struct({
        ...WikiPageFilter.fields,
        ...pageParams(WIKI_PAGE_SORT_FIELDS).fields,
      }),
      success: page(WikiPageSummary),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/wiki-pages/:id", {
      params: { id: Id },
      query: Schema.Struct({ revision: Schema.optionalKey(WikiRevisionNumber) }),
      success: WikiPageWithRevisions,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/wiki-pages", {
      payload: WikiPageCreateInput,
      success: WikiPage,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Conflict, CapExceeded, Internal],
    }),
    HttpApiEndpoint.patch("update", "/wiki-pages/:id", {
      params: { id: Id },
      payload: WikiPageUpdateInput,
      success: WikiPage,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Conflict, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("archive", "/wiki-pages/:id/archive", {
      params: { id: Id },
      payload: WikiPageArchiveInput,
      success: WikiPageSummary,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Conflict, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("restore", "/wiki-pages/:id/restore", {
      params: { id: Id },
      success: WikiPageSummary,
      error: [
        Unauthenticated,
        Forbidden,
        Validation,
        NotFound,
        InvalidState,
        CapExceeded,
        Internal,
      ],
    }),
  )
  .middleware(Authenticated);
