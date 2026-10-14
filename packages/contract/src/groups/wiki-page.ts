/**
 * The Wiki: per repository, pages that agents write for the agents after them
 * (spec 19 section 2.3).
 *
 * A Wiki is the set of Wiki Pages of one Resource of kind `repo`; it has no id
 * and no settings of its own. A page is named in its Wiki by a slug that never
 * changes. Every write stores a new revision holding the whole page, stamped
 * with its actor and time. Nothing is ever deleted: a wrong page is rewritten,
 * and its history shows what it said before.
 *
 * Every page carries the Resource's canonical remote as `repository`, copied
 * when the page is created. A caller without `resource.read` can still see
 * which repository a page is about, and the name stays after the Resource is
 * deleted.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { closedStruct } from "../closed";
import {
  CapExceeded,
  Conflict,
  Forbidden,
  Internal,
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

/** The most pages one Wiki holds. */
export const MAX_WIKI_PAGES = 500;

/** How many revisions `wikiPage.read` lists, newest first. */
export const MAX_WIKI_REVISIONS_LISTED = 50;

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

/** A revision number. Revision 1 is the page as it was created. */
export const WikiRevisionNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

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
export const WIKI_PAGE_SORT_FIELDS = ["updatedAt", "title"] as const;

/** The filter of `wikiPage.query`. */
export const WikiPageFilter = Schema.Struct({
  /** Only this repository's pages. Without it, every repository's pages are listed. */
  resourceId: Schema.optionalKey(Id),
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
      error: [Unauthenticated, Forbidden, Validation, NotFound, Conflict, Internal],
    }),
  )
  .middleware(Authenticated);
