/**
 * Reads and writes Discussions, their Posts, their participants and their
 * shared files. Nothing here decides policy: who may write, which caps apply
 * and what gets logged are the service's.
 *
 * A Discussion's counts are computed in SQL from its rows, never stored, so
 * they cannot drift from the rows they count. `last_post_at` is the one
 * derived value that is stored, because a listing sorts by it.
 */
import type * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  Discussion,
  DiscussionFilter,
  DiscussionKind,
  DiscussionSummary,
  Post,
  SharedFile,
} from "@hercule/contract";
import { SYSTEM_ACTOR } from "../actor";
import {
  buildPage,
  prepareKeysetListing,
  uuidFromString,
  uuidToString,
  type CursorError,
  type Page,
  type ResolvedSortKey,
  type SortColumn,
} from "../db";

/** A field a Discussion listing can be sorted by. */
export type DiscussionSortField = "lastPostAt" | "createdAt";

/** The page size, cursor and sort keys of a Discussion listing. */
export interface DiscussionPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly sort: Arr.NonEmptyReadonlyArray<ResolvedSortKey<DiscussionSortField>>;
}

/** Everything a new Discussion row holds. Its first Post, if any, is written separately. */
export interface NewDiscussion {
  readonly id: string;
  readonly resourceId: string;
  readonly repository: string;
  readonly kind: DiscussionKind;
  readonly subject: string;
  readonly at: string;
}

/** How many Posts a Discussion holds, split the way its two caps count them. */
export interface PostCounts {
  /** Every Post but the system Posts: the ones `MAX_DISCUSSION_POSTS` caps. */
  readonly counted: number;
  /** The system Posts: the ones `MAX_SYSTEM_POSTS` caps. */
  readonly system: number;
}

interface DiscussionRow {
  readonly id: Uint8Array;
  readonly resource_id: Uint8Array;
  readonly repository: string;
  readonly kind: DiscussionKind;
  readonly subject: string;
  readonly last_post_at: string;
  readonly created_at: string;
  readonly post_count: number;
  readonly shared_file_count: number;
  readonly participant_count: number;
}

interface PostRow {
  readonly id: Uint8Array;
  readonly discussion_id: Uint8Array;
  readonly actor: string;
  readonly text: string;
  readonly created_at: string;
}

interface SharedFileRow {
  readonly path: string;
  readonly session_ids: string;
  readonly shared_at: string;
}

/** The columns of a summary, with its three counts computed from their rows. */
const SUMMARY_COLUMNS = `d.id, d.resource_id, d.repository, d.kind, d.subject, d.last_post_at, d.created_at,
  (SELECT COUNT(*) FROM discussion_posts p
     WHERE p.discussion_id = d.id AND p.actor <> '${SYSTEM_ACTOR}') AS post_count,
  (SELECT COUNT(*) FROM discussion_shared_files f WHERE f.discussion_id = d.id) AS shared_file_count,
  (SELECT COUNT(*) FROM discussion_participants pa WHERE pa.discussion_id = d.id) AS participant_count`;

/** How a Discussion listing sorts by each of its sortable fields. */
const DISCUSSION_SORT_COLUMNS: Record<DiscussionSortField, SortColumn<DiscussionSummary>> = {
  lastPostAt: {
    column: "d.last_post_at",
    valueType: "string",
    readValue: (discussion) => discussion.lastPostAt,
  },
  createdAt: {
    column: "d.created_at",
    valueType: "string",
    readValue: (discussion) => discussion.createdAt,
  },
};

const parseSummaryRow = (row: DiscussionRow): DiscussionSummary => ({
  id: uuidToString(row.id),
  resourceId: uuidToString(row.resource_id),
  repository: row.repository,
  kind: row.kind,
  subject: row.subject,
  postCount: row.post_count,
  sharedFileCount: row.shared_file_count,
  participantCount: row.participant_count,
  lastPostAt: row.last_post_at,
  createdAt: row.created_at,
});

const parsePostRow = (row: PostRow): Post => ({
  id: uuidToString(row.id),
  discussionId: uuidToString(row.discussion_id),
  actor: row.actor,
  text: row.text,
  createdAt: row.created_at,
});

const parseSharedFileRow = (row: SharedFileRow): SharedFile => ({
  path: row.path,
  sessionIds: JSON.parse(row.session_ids) as ReadonlyArray<string>,
  sharedAt: row.shared_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Returns the sessions that take part in a Discussion, in the order they joined. */
  const listParticipants = (discussionId: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
    Effect.map(
      sql<{ readonly session_id: Uint8Array }>`
        SELECT session_id FROM discussion_participants
        WHERE discussion_id = ${uuidFromString(discussionId)} ORDER BY position
      `,
      (rows) => rows.map((row) => uuidToString(row.session_id)),
    );

  /** Returns a Discussion's shared files, in the order they were shared. */
  const listSharedFiles = (
    discussionId: string,
  ): Effect.Effect<ReadonlyArray<SharedFile>, SqlError> =>
    Effect.map(
      sql<SharedFileRow>`
        SELECT path, session_ids, shared_at FROM discussion_shared_files
        WHERE discussion_id = ${uuidFromString(discussionId)} ORDER BY position
      `,
      (rows) => rows.map(parseSharedFileRow),
    );

  return {
    /** Writes a new Discussion with no Posts, participants or shared files. */
    insert: (discussion: NewDiscussion): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO discussions (id, resource_id, repository, kind, subject, last_post_at, created_at)
        VALUES (${uuidFromString(discussion.id)}, ${uuidFromString(discussion.resourceId)},
                ${discussion.repository}, ${discussion.kind}, ${discussion.subject},
                ${discussion.at}, ${discussion.at})
      `),

    /** Checks whether a Discussion with that id exists. */
    exists: (id: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{
          readonly found: number;
        }>`SELECT 1 AS found FROM discussions WHERE id = ${uuidFromString(id)}`,
        (rows) => rows.length > 0,
      ),

    /**
     * Returns the Discussion with that id, with its shared files and
     * participants in the order they were added, or none when there is no
     * such Discussion.
     */
    one: (id: string): Effect.Effect<Option.Option<Discussion>, SqlError> =>
      Effect.gen(function* () {
        const rows = yield* sql<DiscussionRow>`
          SELECT ${sql.literal(SUMMARY_COLUMNS)} FROM discussions d WHERE d.id = ${uuidFromString(id)}
        `;
        const row = rows[0];
        if (row === undefined) return Option.none();
        const sharedFiles = yield* listSharedFiles(id);
        const participantSessionIds = yield* listParticipants(id);
        return Option.some({
          ...parseSummaryRow(row),
          sharedFiles,
          participantSessionIds,
        });
      }),

    /**
     * Returns one page of the Discussions that match the filter, in the
     * requested order. A `sessionId` keeps the Discussions that session takes
     * part in. Fails with a `CursorError` if the cursor is invalid.
     */
    list: (
      filter: DiscussionFilter,
      request: DiscussionPageRequest,
    ): Effect.Effect<Page<DiscussionSummary>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const { keyset, order, encodeNextCursor } = yield* prepareKeysetListing(
          sql,
          "discussion.query",
          request.sort,
          DISCUSSION_SORT_COLUMNS,
          "d.id",
          request.cursor,
        );
        const conditions = [keyset];
        if (filter.resourceId !== undefined) {
          conditions.push(sql`d.resource_id = ${uuidFromString(filter.resourceId)}`);
        }
        if (filter.kind !== undefined) conditions.push(sql`d.kind = ${filter.kind}`);
        if (filter.sessionId !== undefined) {
          // A subquery that does not depend on the row runs once, through the
          // participants' session index, where EXISTS would run once per row.
          conditions.push(sql`d.id IN (
            SELECT discussion_id FROM discussion_participants
            WHERE session_id = ${uuidFromString(filter.sessionId)}
          )`);
        }
        const rows = yield* sql<DiscussionRow>`
          SELECT ${sql.literal(SUMMARY_COLUMNS)} FROM discussions d
          WHERE ${sql.and(conditions)} ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(parseSummaryRow)),
          encodeNextCursor,
        );
      }),

    /**
     * Writes a Post and moves its Discussion's `last_post_at` to the Post's
     * time. The caller mints the id.
     */
    insertPost: (post: Post): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const discussion = uuidFromString(post.discussionId);
        yield* sql`
          INSERT INTO discussion_posts (id, discussion_id, actor, text, created_at)
          VALUES (${uuidFromString(post.id)}, ${discussion}, ${post.actor}, ${post.text},
                  ${post.createdAt})
        `;
        yield* sql`UPDATE discussions SET last_post_at = ${post.createdAt} WHERE id = ${discussion}`;
      }),

    /** Returns a Discussion's Posts, oldest first. */
    listPosts: (discussionId: string): Effect.Effect<ReadonlyArray<Post>, SqlError> =>
      Effect.map(
        sql<PostRow>`
          SELECT id, discussion_id, actor, text, created_at FROM discussion_posts
          WHERE discussion_id = ${uuidFromString(discussionId)} ORDER BY id
        `,
        (rows) => rows.map(parsePostRow),
      ),

    /** Counts a Discussion's Posts, the system Posts apart from the rest. */
    countPosts: (discussionId: string): Effect.Effect<PostCounts, SqlError> =>
      Effect.map(
        sql<{ readonly counted: number; readonly system: number }>`
          SELECT COALESCE(SUM(actor <> ${SYSTEM_ACTOR}), 0) AS counted,
                 COALESCE(SUM(actor = ${SYSTEM_ACTOR}), 0) AS system
          FROM discussion_posts WHERE discussion_id = ${uuidFromString(discussionId)}
        `,
        (rows) => rows[0] ?? { counted: 0, system: 0 },
      ),

    listParticipants,

    /**
     * Adds a session as a Discussion's newest participant. The caller checks
     * that it is not one already.
     */
    insertParticipant: (
      discussionId: string,
      sessionId: string,
      at: string,
    ): Effect.Effect<void, SqlError> => {
      const discussion = uuidFromString(discussionId);
      return Effect.asVoid(sql`
        INSERT INTO discussion_participants (discussion_id, session_id, position, joined_at)
        VALUES (${discussion}, ${uuidFromString(sessionId)},
                (SELECT COALESCE(MAX(position) + 1, 0) FROM discussion_participants
                 WHERE discussion_id = ${discussion}),
                ${at})
      `);
    },

    listSharedFiles,

    /** Shares a file in a Discussion, after the files it already shares. */
    insertSharedFile: (discussionId: string, file: SharedFile): Effect.Effect<void, SqlError> => {
      const discussion = uuidFromString(discussionId);
      return Effect.asVoid(sql`
        INSERT INTO discussion_shared_files (discussion_id, path, position, session_ids, shared_at)
        VALUES (${discussion}, ${file.path},
                (SELECT COALESCE(MAX(position) + 1, 0) FROM discussion_shared_files
                 WHERE discussion_id = ${discussion}),
                ${JSON.stringify(file.sessionIds)}, ${file.sharedAt})
      `);
    },

    /** Replaces the sessions listed for a file a Discussion already shares. */
    updateSharedFileSessions: (
      discussionId: string,
      path: string,
      sessionIds: ReadonlyArray<string>,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE discussion_shared_files SET session_ids = ${JSON.stringify(sessionIds)}
        WHERE discussion_id = ${uuidFromString(discussionId)} AND path = ${path}
      `),
  };
});

/** The repository for Discussions and their Posts, used by the Discussion service. */
export const discussionRepository = make;
