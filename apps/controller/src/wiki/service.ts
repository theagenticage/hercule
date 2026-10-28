/**
 * The Wiki operations: `wikiPage.query`, `read`, `create` and `update`
 * (spec 19 sections 2.3 and 3).
 *
 * The checks run in the order the API promises, and the first check that fails
 * decides the error: the grant (`Forbidden`), the input (`Validation`), the page or
 * the repository (`NotFound`), then the slug, the revision and the page cap
 * (`Conflict`, `CapExceeded`).
 *
 * Every write stores a whole revision and writes one `wikiPage.written` audit
 * entry in the same transaction. The entry holds ids only, never a title or a
 * body: every actor holding `event.read` reads the log. The entry also
 * announces the page on the `wikiPage` live topic after the commit.
 */
import type * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createCapExceededError,
  createConflictError,
  createDecodeValidationError,
  createNotFoundError,
  DEFAULT_PAGE_LIMIT,
  Id,
  MAX_WIKI_PAGES,
  MAX_WIKI_REVISIONS_LISTED,
  WIKI_PAGE_SORT_FIELDS,
  WIKI_PAGE_UPDATE_FIELDS,
  WikiPageCreateInput,
  WikiPageFilter,
  WikiRevisionNumber,
  type CapExceeded,
  type Conflict,
  type Forbidden,
  type NotFound,
  type Validation,
  type WikiPage,
  type WikiPageSummary,
  type WikiPageWithRevisions,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import {
  buildPageInputFields,
  nowIso,
  refuseCursor,
  resolveSortKeys,
  withTransaction,
  type ResolvedSortKey,
} from "../db";
import { AuditLog } from "../events";
import { namesRepository, resolveRepository } from "../workspaces";
import { wikiPageRepository, type WikiPageSortField } from "./repository";

const QueryInput = Schema.Struct({
  ...WikiPageFilter.fields,
  ...buildPageInputFields(WIKI_PAGE_SORT_FIELDS),
});
const ReadInput = Schema.Struct({ id: Id, revision: Schema.optionalKey(WikiRevisionNumber) });
const UpdateInput = Schema.Struct({ id: Id, ...WIKI_PAGE_UPDATE_FIELDS });

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;
export type ReadInput = Schema.Schema.Type<typeof ReadInput>;
export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeRead = Schema.decodeUnknownEffect(ReadInput);
const decodeCreate = Schema.decodeUnknownEffect(WikiPageCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);

/** One page of page summaries, in the contract's shape. */
export interface WikiPageListing {
  readonly items: ReadonlyArray<WikiPageSummary>;
  readonly nextCursor?: string;
}

/** The most recently changed pages first, as a reader catching up wants them. */
const DEFAULT_SORT: Arr.NonEmptyReadonlyArray<ResolvedSortKey<WikiPageSortField>> = [
  { field: "updatedAt", direction: "desc" },
];

const NO_SUCH_PAGE = "no such wiki page; `hercule wiki-page list` shows the pages there are";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pages = yield* wikiPageRepository;
  const audit = yield* AuditLog;

  const readSummaryOrFail = (id: string): Effect.Effect<WikiPageSummary, NotFound | SqlError> =>
    Effect.flatMap(
      pages.readSummary(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_PAGE)),
        onSome: Effect.succeed,
      }),
    );

  /** Records a write in the audit log, which also announces the page on its live topic. */
  const recordWrite = (page: WikiPage): Effect.Effect<void, SqlError> =>
    audit.append({
      kind: "wikiPage.written",
      actor: page.updatedBy,
      record: { topic: "wikiPage", id: page.id },
      payload: { pageId: page.id, resourceId: page.resourceId, revision: page.revision },
      at: page.updatedAt,
    });

  return {
    /**
     * Returns one page of page summaries, of one repository or of every
     * repository. Fails with `Validation` when `resourceId` names a Resource
     * that is not a repo. An id that names no Resource, a deleted one
     * included, matches nothing.
     */
    query: (input: QueryInput): Effect.Effect<WikiPageListing, Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("wikiPage.query");
        const { resourceId, limit, cursor, sort } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
        );
        // A filter on an id that names no repo matches nothing, but the
        // listing still runs, so a malformed cursor is refused all the same.
        const listed =
          resourceId === undefined ||
          (yield* namesRepository(resourceId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ));
        const listing = yield* refuseCursor(
          pages.list({
            resourceId,
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            sort: resolveSortKeys(sort, DEFAULT_SORT),
          }),
        );
        if (!listed) return { items: [] };
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /**
     * Returns a page as of `revision`, or its current revision when none is
     * given, with the page's 50 newest revisions, newest first. Fails with
     * `NotFound` when there is no such page or the page has no such revision.
     */
    read: (
      input: ReadInput,
    ): Effect.Effect<WikiPageWithRevisions, Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("wikiPage.read");
        const { id, revision } = yield* Effect.mapError(
          decodeRead(input),
          createDecodeValidationError,
        );
        // One transaction, so the page and its revision list are read as of
        // the same write: an update in between would otherwise make the
        // current revision look like an older one.
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const summary = yield* readSummaryOrFail(id);
            const page = yield* pages.readRevision(summary, revision ?? summary.revision);
            if (Option.isNone(page)) {
              return yield* Effect.fail(
                createNotFoundError(
                  `this page has no revision ${String(revision)}; its current revision is ${String(summary.revision)}`,
                ),
              );
            }
            const revisions = yield* pages.listRevisions(id, MAX_WIKI_REVISIONS_LISTED);
            return { page: page.value, revisions };
          }),
        );
      }),

    /**
     * Creates a page in a repository's Wiki and returns it at revision 1.
     * Without `resourceId`, a session's call takes the one repository checked
     * out in its workspace. Fails with:
     *
     * - `Validation` when the repository cannot be chosen, or the Resource
     *   is not a repo;
     * - `NotFound` when `resourceId` names no Resource;
     * - `Conflict` when the Wiki already has a page with this slug;
     * - `CapExceeded` when the Wiki already holds 500 pages.
     */
    create: (
      input: WikiPageCreateInput,
    ): Effect.Effect<
      WikiPage,
      Forbidden | Validation | NotFound | Conflict | CapExceeded | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("wikiPage.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const { resourceId, repository } = yield* resolveRepository(decoded.resourceId).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
            const taken = yield* pages.findIdBySlug(resourceId, decoded.slug);
            if (Option.isSome(taken)) {
              return yield* Effect.fail(
                createConflictError(
                  `A page with this slug already exists: ${taken.value}. Read it with \`hercule wiki-page read ${taken.value}\`, then change it with \`hercule wiki-page update\`.`,
                ),
              );
            }
            const count = yield* pages.countPages(resourceId);
            if (count >= MAX_WIKI_PAGES) {
              return yield* Effect.fail(
                createCapExceededError(
                  { count: count + 1, cap: MAX_WIKI_PAGES },
                  `This wiki has ${String(MAX_WIKI_PAGES)} pages, the most it can hold. Update an existing page instead.`,
                ),
              );
            }
            const page = yield* pages.insert(
              { resourceId, repository, slug: decoded.slug },
              {
                title: decoded.title,
                summary: decoded.summary,
                body: decoded.body,
                actor: yield* currentStamp,
                at: yield* nowIso,
              },
            );
            yield* recordWrite(page);
            return page;
          }),
        );
      }),

    /**
     * Writes the next revision of a page and returns the page as written. The
     * body is always given whole; a title or a summary left out keeps its
     * value. Fails with `NotFound` when there is no such page, and with
     * `Conflict` when the page is no longer at `expectedRevision`. Nothing is
     * merged for the caller: it reads the page again and merges its change.
     */
    update: (
      input: UpdateInput,
    ): Effect.Effect<WikiPage, Forbidden | Validation | NotFound | Conflict | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("wikiPage.update");
        const decoded = yield* Effect.mapError(decodeUpdate(input), createDecodeValidationError);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const current = yield* readSummaryOrFail(decoded.id);
            if (current.revision !== decoded.expectedRevision) {
              const now = String(current.revision);
              return yield* Effect.fail(
                createConflictError(
                  `The page changed since you read it (now revision ${now}). Read it again, merge your change into it, and update with \`--expected-revision ${now}\`.`,
                ),
              );
            }
            const page = yield* pages.appendRevision(current, {
              title: decoded.title ?? current.title,
              summary: decoded.summary ?? current.summary,
              body: decoded.body,
              actor: yield* currentStamp,
              at: yield* nowIso,
            });
            yield* recordWrite(page);
            return page;
          }),
        );
      }),
  };
});

/** The Wiki operations. */
export class WikiPageService extends Context.Service<
  WikiPageService,
  Effect.Success<typeof make>
>()("hercule/controller/wiki/WikiPageService") {}

export const WikiPageServiceLayer = Layer.effect(WikiPageService)(make);
