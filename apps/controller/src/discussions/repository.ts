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
import { buildSessionStamp, SYSTEM_ACTOR } from "../actor";
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

/** Everything a new participant row holds. */
export interface NewParticipant {
  readonly discussionId: string;
  readonly sessionId: string;
  readonly at: string;
  /** The newest Post the session has been told about, or undefined for none. */
  readonly toldThroughPostId: string | undefined;
  /** Whether an Edit Overlap put the session in, so it is still to be told its entry. */
  readonly entryPending: boolean;
}

/** A Discussion a session is still to be told its entry of, with the files it shares there. */
export interface PendingEntry {
  readonly discussionId: string;
  readonly repository: string;
  /** The Discussion's newest Post now, or undefined when it has none. */
  readonly newestPostId: string | undefined;
  /** The files shared there that list the session, in the order they were shared. */
  readonly files: ReadonlyArray<SharedFile>;
}

/** A Discussion with Posts a session has not been told about. */
export interface UntoldPosts {
  readonly discussionId: string;
  /** The oldest Post the session has not been told about. */
  readonly firstPostId: string;
  /** The Discussion's newest Post now. */
  readonly newestPostId: string;
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

    /** Returns the id of a Discussion's newest Post, or none when it has no Posts. */
    readNewestPostId: (discussionId: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array | null }>`
          SELECT MAX(id) AS id FROM discussion_posts
          WHERE discussion_id = ${uuidFromString(discussionId)}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]?.id), uuidToString),
      ),

    listParticipants,

    /**
     * Adds a session as a Discussion's newest participant. The caller checks
     * that it is not one already.
     */
    insertParticipant: (participant: NewParticipant): Effect.Effect<void, SqlError> => {
      const discussion = uuidFromString(participant.discussionId);
      const toldThrough =
        participant.toldThroughPostId === undefined
          ? null
          : uuidFromString(participant.toldThroughPostId);
      return Effect.asVoid(sql`
        INSERT INTO discussion_participants
          (discussion_id, session_id, position, joined_at, told_through_post_id, entry_pending)
        VALUES (${discussion}, ${uuidFromString(participant.sessionId)},
                (SELECT COALESCE(MAX(position) + 1, 0) FROM discussion_participants
                 WHERE discussion_id = ${discussion}),
                ${participant.at}, ${toldThrough}, ${participant.entryPending ? 1 : 0})
      `);
    },

    /**
     * Returns the Discussions the session is still to be told its entry of,
     * in the order it joined them, each with the files shared there that list
     * the session. A Discussion with no such file is returned with none.
     */
    listPendingEntries: (sessionId: string): Effect.Effect<ReadonlyArray<PendingEntry>, SqlError> =>
      Effect.map(
        sql<{
          readonly discussion_id: Uint8Array;
          readonly repository: string;
          readonly newest_post_id: Uint8Array | null;
          readonly path: string | null;
          readonly session_ids: string | null;
          readonly shared_at: string | null;
        }>`
          SELECT pa.discussion_id, d.repository,
            (SELECT MAX(p.id) FROM discussion_posts p
             WHERE p.discussion_id = pa.discussion_id) AS newest_post_id,
            f.path, f.session_ids, f.shared_at
          FROM discussion_participants pa
          JOIN discussions d ON d.id = pa.discussion_id
          LEFT JOIN discussion_shared_files f ON f.discussion_id = pa.discussion_id
            AND EXISTS (SELECT 1 FROM json_each(f.session_ids) j WHERE j.value = ${sessionId})
          WHERE pa.session_id = ${uuidFromString(sessionId)} AND pa.entry_pending = 1
          ORDER BY pa.joined_at, pa.discussion_id, f.position
        `,
        (rows) => {
          // One row per shared file, so a Discussion's rows are grouped into one entry.
          const entries = new Map<string, PendingEntry & { readonly files: Array<SharedFile> }>();
          for (const row of rows) {
            const discussionId = uuidToString(row.discussion_id);
            const entry = entries.get(discussionId) ?? {
              discussionId,
              repository: row.repository,
              newestPostId:
                row.newest_post_id === null ? undefined : uuidToString(row.newest_post_id),
              files: [],
            };
            entries.set(discussionId, entry);
            if (row.path !== null && row.session_ids !== null && row.shared_at !== null) {
              entry.files.push(
                parseSharedFileRow({
                  path: row.path,
                  session_ids: row.session_ids,
                  shared_at: row.shared_at,
                }),
              );
            }
          }
          return [...entries.values()];
        },
      ),

    /**
     * Returns the Discussions with Posts the session has not been told about,
     * newest activity first. A Post is one the session has not been told
     * about when it is newer than the participant's `told_through_post_id`
     * and another actor wrote it. Post ids are UUIDv7, so a greater id is a
     * newer Post. Discussions the session is still to be told its entry of
     * are left out: the entry tells it to read the whole Discussion.
     */
    listUntoldPosts: (sessionId: string): Effect.Effect<ReadonlyArray<UntoldPosts>, SqlError> =>
      Effect.map(
        sql<{
          readonly discussion_id: Uint8Array;
          readonly first_post_id: Uint8Array;
          readonly newest_post_id: Uint8Array;
        }>`
          SELECT discussion_id, first_post_id, newest_post_id FROM (
            SELECT pa.discussion_id, d.last_post_at,
              (SELECT MIN(p.id) FROM discussion_posts p
               WHERE p.discussion_id = pa.discussion_id
                 AND (pa.told_through_post_id IS NULL OR p.id > pa.told_through_post_id)
                 AND p.actor <> ${buildSessionStamp(sessionId)}) AS first_post_id,
              (SELECT MAX(p.id) FROM discussion_posts p
               WHERE p.discussion_id = pa.discussion_id) AS newest_post_id
            FROM discussion_participants pa
            JOIN discussions d ON d.id = pa.discussion_id
            WHERE pa.session_id = ${uuidFromString(sessionId)} AND pa.entry_pending = 0
          )
          WHERE first_post_id IS NOT NULL
          ORDER BY last_post_at DESC, discussion_id DESC
        `,
        (rows) =>
          rows.map((row) => ({
            discussionId: uuidToString(row.discussion_id),
            firstPostId: uuidToString(row.first_post_id),
            newestPostId: uuidToString(row.newest_post_id),
          })),
      ),

    /** Records that the session has been told its entry of a Discussion. */
    clearPendingEntry: (discussionId: string, sessionId: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE discussion_participants SET entry_pending = 0
        WHERE discussion_id = ${uuidFromString(discussionId)}
          AND session_id = ${uuidFromString(sessionId)}
      `),

    /**
     * Records that the session has been told about every Post of a
     * Discussion up to `postId`. Never moves the mark back to an older Post.
     */
    advanceToldThrough: (
      discussionId: string,
      sessionId: string,
      postId: string,
    ): Effect.Effect<void, SqlError> => {
      const post = uuidFromString(postId);
      return Effect.asVoid(sql`
        UPDATE discussion_participants SET told_through_post_id = ${post}
        WHERE discussion_id = ${uuidFromString(discussionId)}
          AND session_id = ${uuidFromString(sessionId)}
          AND (told_through_post_id IS NULL OR told_through_post_id < ${post})
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
