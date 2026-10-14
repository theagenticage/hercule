/**
 * Reads and writes Wiki Pages and their revisions. Nothing here decides
 * policy: who may write, what a write must expect, what gets logged.
 *
 * A page row holds the page's identity and its current revision's title,
 * summary, time and actor, so a listing never reads a body. Each revision row
 * holds the whole page as it was written, the body included. The current
 * body is read from the current revision's row.
 */
import type * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Fragment } from "effect/unstable/sql/Statement";
import type { WikiPage, WikiPageSummary, WikiRevision } from "@hercule/contract";
import {
  buildPage,
  mintUuid,
  prepareKeysetListing,
  uuidFromString,
  uuidToString,
  type CursorError,
  type Page,
  type ResolvedSortKey,
  type SortColumn,
} from "../db";

/** A field a page listing can be sorted by. */
export type WikiPageSortField = "updatedAt" | "title";

/** The filter, page size, cursor and sort keys of a page listing. */
export interface WikiPageListRequest {
  readonly resourceId: string | undefined;
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly sort: Arr.NonEmptyReadonlyArray<ResolvedSortKey<WikiPageSortField>>;
}

/** What one write of a page stores: the whole page, with its actor and time. */
export interface WikiPageContent {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly actor: string;
  readonly at: string;
}

/** Everything a new page holds besides its first revision. */
export interface NewWikiPage {
  readonly resourceId: string;
  readonly repository: string;
  readonly slug: string;
}

/** What the prompt line of one repository shows about its Wiki. */
export interface WikiDigest {
  readonly pageCount: number;
  /** The titles of the most recently changed pages, newest first. */
  readonly recentTitles: ReadonlyArray<string>;
}

interface WikiPageRow {
  readonly id: Uint8Array;
  readonly resource_id: Uint8Array;
  readonly repository: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly revision: number;
  readonly updated_at: string;
  readonly updated_by: string;
  readonly created_at: string;
}

interface WikiRevisionRow {
  readonly revision: number;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly actor: string;
  readonly at: string;
}

const PAGE_COLUMNS =
  "id, resource_id, repository, slug, title, summary, revision, updated_at, updated_by, created_at";

const PAGE_SORT_COLUMNS: Record<WikiPageSortField, SortColumn<WikiPageSummary>> = {
  updatedAt: { column: "updated_at", valueType: "string", readValue: (page) => page.updatedAt },
  title: { column: "title", valueType: "string", readValue: (page) => page.title },
};

const toSummary = (row: WikiPageRow): WikiPageSummary => ({
  id: uuidToString(row.id),
  resourceId: uuidToString(row.resource_id),
  repository: row.repository,
  slug: row.slug,
  title: row.title,
  summary: row.summary,
  revision: row.revision,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
  createdAt: row.created_at,
});

/**
 * Returns the page as one revision wrote it: the page's identity, with the
 * revision's title, summary, body, time and actor.
 */
const buildPageAsOf = (page: WikiPageSummary, revision: WikiRevisionRow): WikiPage => ({
  ...page,
  title: revision.title,
  summary: revision.summary,
  revision: revision.revision,
  updatedAt: revision.at,
  updatedBy: revision.actor,
  body: revision.body,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRevision = (pageId: Uint8Array, revision: number, content: WikiPageContent) =>
    sql`
      INSERT INTO wiki_revisions (page_id, revision, title, summary, body, actor, at)
      VALUES (${pageId}, ${revision}, ${content.title}, ${content.summary}, ${content.body},
              ${content.actor}, ${content.at})
    `;

  const readSummary = (id: string): Effect.Effect<Option.Option<WikiPageSummary>, SqlError> =>
    Effect.map(
      sql<WikiPageRow>`SELECT ${sql.literal(PAGE_COLUMNS)} FROM wiki_pages
                       WHERE id = ${uuidFromString(id)}`,
      (rows) => Option.map(Option.fromNullishOr(rows[0]), toSummary),
    );

  /** Returns how many pages this repository's Wiki holds. */
  const countPages = (resourceId: string): Effect.Effect<number, SqlError> =>
    Effect.map(
      sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM wiki_pages WHERE resource_id = ${uuidFromString(resourceId)}
      `,
      (rows) => rows[0]?.count ?? 0,
    );

  return {
    readSummary,
    countPages,

    /** Returns the id of the page with this slug in this repository's Wiki, if there is one. */
    findIdBySlug: (
      resourceId: string,
      slug: string,
    ): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM wiki_pages
          WHERE resource_id = ${uuidFromString(resourceId)} AND slug = ${slug}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => uuidToString(row.id)),
      ),

    /**
     * Returns the page as of a revision, or `None` when the page has no such
     * revision. `page` is the page's current summary, as `readSummary` reads it.
     */
    readAsOf: (
      page: WikiPageSummary,
      revision: number,
    ): Effect.Effect<Option.Option<WikiPage>, SqlError> =>
      Effect.map(
        sql<WikiRevisionRow>`
          SELECT revision, title, summary, body, actor, at FROM wiki_revisions
          WHERE page_id = ${uuidFromString(page.id)} AND revision = ${revision}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => buildPageAsOf(page, row)),
      ),

    /** Returns a page's newest revisions, newest first, at most `limit` of them. */
    listRevisions: (
      pageId: string,
      limit: number,
    ): Effect.Effect<ReadonlyArray<WikiRevision>, SqlError> =>
      Effect.map(
        sql<Omit<WikiRevisionRow, "body">>`
          SELECT revision, title, summary, actor, at FROM wiki_revisions
          WHERE page_id = ${uuidFromString(pageId)}
          ORDER BY revision DESC LIMIT ${limit}
        `,
        (rows) =>
          rows.map((row) => ({
            revision: row.revision,
            title: row.title,
            summary: row.summary,
            at: row.at,
            actor: row.actor,
          })),
      ),

    /** Inserts a new page with its first revision, and returns the page. */
    insert: (page: NewWikiPage, content: WikiPageContent): Effect.Effect<WikiPage, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO wiki_pages (id, resource_id, repository, slug, title, summary, revision,
                                  updated_at, updated_by, created_at)
          VALUES (${id}, ${uuidFromString(page.resourceId)}, ${page.repository}, ${page.slug},
                  ${content.title}, ${content.summary}, 1, ${content.at}, ${content.actor},
                  ${content.at})
        `;
        yield* insertRevision(id, 1, content);
        return {
          id: uuidToString(id),
          resourceId: page.resourceId,
          repository: page.repository,
          slug: page.slug,
          title: content.title,
          summary: content.summary,
          revision: 1,
          updatedAt: content.at,
          updatedBy: content.actor,
          createdAt: content.at,
          body: content.body,
        };
      }),

    /**
     * Stores the next revision of a page and makes it the current one.
     * `page` is the page's current summary; the new revision is one above it.
     * Returns the page as written.
     */
    appendRevision: (
      page: WikiPageSummary,
      content: WikiPageContent,
    ): Effect.Effect<WikiPage, SqlError> =>
      Effect.gen(function* () {
        const id = uuidFromString(page.id);
        const revision = page.revision + 1;
        yield* sql`
          UPDATE wiki_pages
          SET title = ${content.title}, summary = ${content.summary}, revision = ${revision},
              updated_at = ${content.at}, updated_by = ${content.actor}
          WHERE id = ${id}
        `;
        yield* insertRevision(id, revision, content);
        return buildPageAsOf(page, { ...content, revision });
      }),

    /**
     * Returns one page of page summaries, of one repository or of all, in the
     * requested order. Fails with a `CursorError` if the cursor is invalid.
     */
    list: (
      request: WikiPageListRequest,
    ): Effect.Effect<Page<WikiPageSummary>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const { keyset, order, encodeNextCursor } = yield* prepareKeysetListing(
          sql,
          "wikiPage.query",
          request.sort,
          PAGE_SORT_COLUMNS,
          "id",
          request.cursor,
        );
        const clauses: Array<Fragment> = [keyset];
        if (request.resourceId !== undefined) {
          clauses.push(sql`resource_id = ${uuidFromString(request.resourceId)}`);
        }
        const rows = yield* sql<WikiPageRow>`
          SELECT ${sql.literal(PAGE_COLUMNS)} FROM wiki_pages
          WHERE ${sql.and(clauses)} ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (found) => Effect.succeed(found.map(toSummary)),
          encodeNextCursor,
        );
      }),

    /**
     * Returns what the prompt line shows about each of these repositories'
     * Wikis: the number of pages and the titles of the `titleCount` most
     * recently changed. A repository with no pages is in the map with a count
     * of 0. Runs two indexed queries per repository.
     */
    digest: (
      resourceIds: ReadonlyArray<string>,
      titleCount: number,
    ): Effect.Effect<ReadonlyMap<string, WikiDigest>, SqlError> =>
      Effect.gen(function* () {
        const digests = new Map<string, WikiDigest>();
        for (const resourceId of resourceIds) {
          const titles = yield* sql<{ readonly title: string }>`
            SELECT title FROM wiki_pages WHERE resource_id = ${uuidFromString(resourceId)}
            ORDER BY updated_at DESC, id DESC LIMIT ${titleCount}
          `;
          digests.set(resourceId, {
            pageCount: yield* countPages(resourceId),
            recentTitles: titles.map((row) => row.title),
          });
        }
        return digests;
      }),
  };
});

/** The repository for Wiki Pages and their revisions, used by the wiki service and the prompt. */
export const wikiPageRepository = make;
