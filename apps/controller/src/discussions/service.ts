/**
 * The Discussion operations: `discussion.query`, `read`, `create` and `post`
 * (spec 19 section 3), and the methods an Edit Overlap writes through (spec 19
 * sections 4.3 and 5.5).
 *
 * The checks of an operation run in the order spec 11 section 1.5 fixes:
 * `forbidden`, then `validation`, then `not_found`, then `cap_exceeded`.
 *
 * Every change writes its audit entry in its transaction. An entry holds ids
 * only, never a Post's text: Posts quote what users told their sessions, and
 * every actor holding `event.read` reads the log.
 *
 * Writing a Post tells no one. Each participant row records what its session
 * has been told, and the controller daemon drafts a Discussion Input from
 * that record when it is time to tell the session (spec 19 section 5):
 * `draftDiscussionInput` builds it, and `markTold` records it once the
 * runner has taken it.
 */
import type * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createCapExceededError,
  createDecodeValidationError,
  createNotFoundError,
  createValidationError,
  DEFAULT_PAGE_LIMIT,
  DISCUSSION_SORT_FIELDS,
  DiscussionCreateInput,
  DiscussionFilter,
  MAX_DISCUSSION_POSTS,
  MAX_PARTICIPANTS,
  MAX_SHARED_FILES,
  MAX_SYSTEM_POSTS,
  PostText,
  cutKeepingEnd,
  type CapExceeded,
  type Discussion,
  type DiscussionCreated,
  type DiscussionSummary,
  type DiscussionWithPosts,
  type Forbidden,
  type NotFound,
  type Post,
  type Validation,
} from "@hercule/contract";
import { buildActorStamp, requireActor, requireGrant, SYSTEM_ACTOR, type Actor } from "../actor";
import {
  announce,
  buildPageInputFields,
  mintUuid,
  nowIso,
  refuseCursor,
  resolveSortKeys,
  uuidToString,
  withTransaction,
  type ResolvedSortKey,
} from "../db";
import { AuditLog } from "../events";
import { permissionRequestRepository } from "../permissions";
import {
  namesRepository,
  resolveRepository,
  sessionRepository,
  type RepositoryRef,
} from "../sessions";
import {
  buildDiscussionInputText,
  MAX_NAMED_ENTRIES,
  MAX_NAMED_FILES_PER_ENTRY,
  MAX_NAMED_NEW_POSTS,
  type DiscussionEntry,
  type DiscussionInputRefusal,
} from "./discussion-input-text";
import { discussionRepository, type DiscussionSortField, type NewParticipant } from "./repository";

/** The input of `discussion.query`: the filter, plus the page size, cursor and sort. */
const QueryInput = Schema.Struct({
  ...DiscussionFilter.fields,
  ...buildPageInputFields(DISCUSSION_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(DiscussionCreateInput);
const decodePost = Schema.decodeUnknownEffect(Schema.Struct({ text: PostText }));

/** One page of Discussions, in the contract's shape. */
export interface DiscussionPage {
  readonly items: ReadonlyArray<DiscussionSummary>;
  readonly nextCursor?: string;
}

/** The file whose overlap opens a Discussion, and the repository it is in. */
export interface OverlapFile extends RepositoryRef {
  /** Relative to the repository's root, `/` separated. */
  readonly path: string;
}

/**
 * What a Discussion Input marks as told once the runner has taken it. It
 * covers only what the text names, not what it only counts, so whatever is
 * left out is told by a later Discussion Input.
 */
export interface ToldMark {
  /** The Discussions whose entry the text tells. */
  readonly entryDiscussionIds: ReadonlyArray<string>;
  /** For each Discussion the text names, its newest Post when the text was drafted. */
  readonly toldThrough: ReadonlyArray<{ readonly discussionId: string; readonly postId: string }>;
}

/** What a Discussion Input tells a session, and what it marks as told once the runner takes it. */
export interface DiscussionInputDraft {
  /** The text, built as spec 19 section 5.4 says, at most 8,000 characters. */
  readonly text: string;
  /** Whether the text tells at least one entry. */
  readonly holdsEntry: boolean;
  /** What to pass to `markTold` once the runner has taken the input. */
  readonly told: ToldMark;
}

/** The newest activity first, because an old Discussion stays and matters less. */
const DEFAULT_SORT: Arr.NonEmptyReadonlyArray<ResolvedSortKey<DiscussionSortField>> = [
  { field: "lastPostAt", direction: "desc" },
];

/** The refusal of the 201st counted Post. It sends the agent to its user, so agents stop answering each other. */
const DISCUSSION_FULL = `This discussion is full (${String(MAX_DISCUSSION_POSTS)} posts). Ask your user how to continue.`;

const NO_SUCH_DISCUSSION =
  "no such discussion; list the discussions with `hercule discussion list`";

/** The longest path an overlap Discussion's subject holds, in characters. */
const MAX_SUBJECT_PATH_LENGTH = 160;

/** Returns the subject an overlap Discussion opens with, naming its first shared file. */
const buildOverlapSubject = (path: string): string =>
  `Edits overlap in \`${cutKeepingEnd(path, MAX_SUBJECT_PATH_LENGTH)}\``;

/** Returns the session an actor is, or undefined for any other actor. */
const readCallerSessionId = (actor: Actor): string | undefined =>
  actor._tag === "session" ? actor.sessionId : undefined;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const discussions = yield* discussionRepository;
  const audit = yield* AuditLog;
  const sessions = yield* sessionRepository;
  const permissionRequests = yield* permissionRequestRepository;

  const readDiscussionOrFail = (id: string): Effect.Effect<Discussion, NotFound | SqlError> =>
    Effect.flatMap(
      discussions.one(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_DISCUSSION)),
        onSome: Effect.succeed,
      }),
    );

  /** Writes a Post and its audit entry. Runs in the caller's transaction. */
  const writePost = (
    discussionId: string,
    actor: string,
    text: string,
  ): Effect.Effect<Post, SqlError> =>
    Effect.gen(function* () {
      const post: Post = {
        id: uuidToString(mintUuid()),
        discussionId,
        actor,
        text,
        createdAt: yield* nowIso,
      };
      yield* discussions.insertPost(post);
      yield* audit.append({
        kind: "discussion.posted",
        actor,
        record: { topic: "discussion", id: discussionId },
        payload: { discussionId, postId: post.id },
        at: post.createdAt,
      });
      return post;
    });

  /**
   * Adds the sessions to a Discussion as participants, in the given order,
   * while it has fewer than `MAX_PARTICIPANTS`. Skips the sessions that take
   * part already. Each session that joins counts as told about the Posts up
   * to `told.toldThroughPostId`, and is still to be told its entry when
   * `told.entryPending` is true. Returns the sessions that joined. Runs in
   * the caller's transaction.
   */
  const addParticipants = (
    discussionId: string,
    sessionIds: ReadonlyArray<string>,
    told: Pick<NewParticipant, "toldThroughPostId" | "entryPending">,
  ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
    Effect.gen(function* () {
      const participants = yield* discussions.listParticipants(discussionId);
      const at = yield* nowIso;
      const joined: Array<string> = [];
      for (const sessionId of sessionIds) {
        if (participants.length + joined.length >= MAX_PARTICIPANTS) break;
        if (participants.includes(sessionId) || joined.includes(sessionId)) continue;
        yield* discussions.insertParticipant({ discussionId, sessionId, at, ...told });
        joined.push(sessionId);
      }
      if (joined.length > 0) {
        yield* announce({ _tag: "record", topic: "discussion", id: discussionId, kind: "updated" });
      }
      return joined;
    });

  /**
   * Returns why the session cannot receive a Discussion Input now, or
   * `undefined` when it can (spec 19 section 5.1). The checks run in this
   * order, and the first that fails is returned:
   *
   * - `not_running`: its status is not `queued`, `starting`, `idle` or `busy`;
   * - `done`: it is a Thread marked Done, which any input would reopen;
   * - `conversation`: it answers an assistant's conversation, whose inputs
   *   are the owner's messages and whose replies go to the owner's chat;
   * - `lacks_grants`: it lacks `discussion.read` or `discussion.write`,
   *   from its profile and from every approved Permission Request.
   *
   * The grants are read only for a session that passes the other checks.
   * The caller passes the id of a stored session; sessions are never deleted.
   */
  const findDiscussionInputRefusal = (
    sessionId: string,
  ): Effect.Effect<DiscussionInputRefusal | undefined, SqlError> =>
    Effect.gen(function* () {
      const session = Option.getOrThrow(yield* sessions.readDiscussionReceivability(sessionId));
      if (session.status === "exited") return "not_running";
      if (session.done) return "done";
      if (session.inConversation) return "conversation";
      const grants = yield* permissionRequests.listHeldGrants(sessionId);
      if (!grants.includes("discussion.read") || !grants.includes("discussion.write")) {
        return "lacks_grants";
      }
      return undefined;
    });

  return {
    /**
     * Returns one page of the Discussions that match the filter, newest
     * `lastPostAt` first unless the input sorts otherwise.
     *
     * A `resourceId` that names no Resource matches nothing, even the
     * Discussions of a deleted repository that keep its id; they stay
     * readable unfiltered and by their own id. Fails with `Validation` when
     * it names a Resource that is not a repo, which never has Discussions.
     */
    query: (input: QueryInput): Effect.Effect<DiscussionPage, Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("discussion.query");
        const { limit, cursor, sort, ...filter } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
        );
        const namesNoResource =
          filter.resourceId !== undefined &&
          !(yield* Effect.provideService(
            namesRepository(filter.resourceId),
            SqlClient.SqlClient,
            sql,
          ));
        // The listing runs even when the filter names no Resource, so a bad
        // cursor fails as it does for any filter; only its rows are dropped.
        const listing = yield* refuseCursor(
          discussions.list(filter, {
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            sort: resolveSortKeys(sort, DEFAULT_SORT),
          }),
        );
        if (namesNoResource) return { items: [] };
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /**
     * Returns a Discussion and its Posts, oldest first. With `fromPostId`,
     * returns only that Post and the ones after it. Fails with `NotFound`
     * when there is no such Discussion, and with `Validation` when
     * `fromPostId` is not a Post of this Discussion.
     */
    read: (
      id: string,
      fromPostId?: string,
    ): Effect.Effect<DiscussionWithPosts, Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("discussion.read");
        const discussion = yield* readDiscussionOrFail(id);
        const posts = yield* discussions.listPosts(id);
        if (fromPostId === undefined) return { discussion, posts };
        const start = posts.findIndex((post) => post.id === fromPostId);
        if (start === -1) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["fromPostId"],
                message: `post ${fromPostId} is not a post of discussion ${id}`,
              },
            ]),
          );
        }
        return { discussion, posts: posts.slice(start) };
      }),

    /**
     * Opens a general Discussion with its first Post, and returns both. The
     * repository is resolved as `resolveRepository` does. A calling session
     * becomes the Discussion's first participant, told through the first
     * Post, which it wrote.
     *
     * Fails with `Validation` for a subject or text the contract refuses, or
     * a repository that cannot be resolved, and with `NotFound` when
     * `resourceId` names no Resource.
     */
    create: (
      input: DiscussionCreateInput,
    ): Effect.Effect<DiscussionCreated, Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        const caller = yield* requireActor("discussion.create");
        const { resourceId, subject, text } = yield* Effect.mapError(
          decodeCreate(input),
          createDecodeValidationError,
        );
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const repository = yield* Effect.provideService(
              resolveRepository(resourceId),
              SqlClient.SqlClient,
              sql,
            );
            const id = uuidToString(mintUuid());
            const at = yield* nowIso;
            const actor = buildActorStamp(caller);
            yield* discussions.insert({ id, ...repository, kind: "general", subject, at });
            yield* audit.append({
              kind: "discussion.created",
              actor,
              record: { topic: "discussion", id },
              payload: { discussionId: id, resourceId: repository.resourceId },
              at,
            });
            const post = yield* writePost(id, actor, text);
            const sessionId = readCallerSessionId(caller);
            if (sessionId !== undefined) {
              yield* discussions.insertParticipant({
                discussionId: id,
                sessionId,
                at,
                toldThroughPostId: post.id,
                entryPending: false,
              });
            }
            return { discussion: yield* readDiscussionOrFail(id), post };
          }),
        );
      }),

    /**
     * Writes a Post in a Discussion and returns it. A calling session becomes
     * a participant if it is not one, unless the Discussion already has
     * `MAX_PARTICIPANTS`: then its Post is still accepted. A session that
     * joins by posting knows the Discussion, so it is told no entry, and
     * counts as told through its own Post.
     *
     * Fails with `Validation` for a text the contract refuses, with
     * `NotFound` when there is no such Discussion, and with `CapExceeded`
     * when the Discussion holds `MAX_DISCUSSION_POSTS` counted Posts.
     */
    post: (
      id: string,
      text: string,
    ): Effect.Effect<Post, Forbidden | Validation | NotFound | CapExceeded | SqlError> =>
      Effect.gen(function* () {
        const caller = yield* requireActor("discussion.post");
        const decoded = yield* Effect.mapError(decodePost({ text }), createDecodeValidationError);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            if (!(yield* discussions.exists(id))) {
              return yield* Effect.fail(createNotFoundError(NO_SUCH_DISCUSSION));
            }
            const { counted } = yield* discussions.countPosts(id);
            if (counted >= MAX_DISCUSSION_POSTS) {
              return yield* Effect.fail(
                createCapExceededError(
                  { count: counted, cap: MAX_DISCUSSION_POSTS },
                  DISCUSSION_FULL,
                ),
              );
            }
            const post = yield* writePost(id, buildActorStamp(caller), decoded.text);
            const sessionId = readCallerSessionId(caller);
            if (sessionId !== undefined) {
              yield* addParticipants(id, [sessionId], {
                toldThroughPostId: post.id,
                entryPending: false,
              });
            }
            return post;
          }),
        );
      }),

    /**
     * Opens an overlap Discussion of a repository, with no Posts, participants
     * or shared files yet, and returns it. Its subject names the file. The
     * Discussion is stamped as opened by `system`. Runs in the caller's
     * transaction, and checks no grant: only the controller opens one.
     */
    openOverlapDiscussion: (file: OverlapFile): Effect.Effect<Discussion, SqlError> =>
      Effect.gen(function* () {
        const id = uuidToString(mintUuid());
        const at = yield* nowIso;
        yield* discussions.insert({
          id,
          resourceId: file.resourceId,
          repository: file.repository,
          kind: "overlap",
          subject: buildOverlapSubject(file.path),
          at,
        });
        yield* audit.append({
          kind: "discussion.created",
          actor: SYSTEM_ACTOR,
          record: { topic: "discussion", id },
          payload: { discussionId: id, resourceId: file.resourceId },
          at,
        });
        return yield* Effect.orDie(readDiscussionOrFail(id));
      }),

    /**
     * Adds the sessions to a Discussion as participants, as an Edit Overlap
     * puts them in: in the given order, while it has fewer than
     * `MAX_PARTICIPANTS`, skipping the sessions that take part already.
     * Returns the sessions that joined. Runs in the caller's transaction.
     *
     * Each session that joins is still to be told its entry, and counts as
     * told about every Post written before it joined: the entry tells it to
     * read the whole Discussion.
     */
    join: (
      discussionId: string,
      sessionIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.gen(function* () {
        const newest = yield* discussions.readNewestPostId(discussionId);
        return yield* addParticipants(discussionId, sessionIds, {
          toldThroughPostId: Option.getOrUndefined(newest),
          entryPending: true,
        });
      }),

    /**
     * Shares a file in a Discussion, listing the sessions in the given order.
     * When the file is shared there already, only the sessions it does not
     * list yet are added after the others. Returns the sessions newly listed.
     *
     * A new file is not shared when the Discussion already shares
     * `MAX_SHARED_FILES`; then nothing is written and the list is empty. Runs
     * in the caller's transaction.
     */
    shareFile: (
      discussionId: string,
      path: string,
      sessionIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.gen(function* () {
        const files = yield* discussions.listSharedFiles(discussionId);
        const shared = files.find((file) => file.path === path);
        const listed = shared?.sessionIds ?? [];
        const added = [...new Set(sessionIds)].filter((sessionId) => !listed.includes(sessionId));
        if (added.length === 0) return [];
        if (shared !== undefined) {
          yield* discussions.updateSharedFileSessions(discussionId, path, [...listed, ...added]);
        } else if (files.length >= MAX_SHARED_FILES) {
          return [];
        } else {
          yield* discussions.insertSharedFile(discussionId, {
            path,
            sessionIds: added,
            sharedAt: yield* nowIso,
          });
        }
        yield* announce({ _tag: "record", topic: "discussion", id: discussionId, kind: "updated" });
        return added;
      }),

    /**
     * Writes a system Post in a Discussion and returns it. Writes nothing and
     * returns none when the Discussion already holds `MAX_SYSTEM_POSTS`
     * system Posts: a report never fails because of a cap. Runs in the
     * caller's transaction.
     */
    writeSystemPost: (
      discussionId: string,
      text: string,
    ): Effect.Effect<Option.Option<Post>, SqlError> =>
      Effect.gen(function* () {
        const { system } = yield* discussions.countPosts(discussionId);
        if (system >= MAX_SYSTEM_POSTS) return Option.none();
        return Option.some(yield* writePost(discussionId, SYSTEM_ACTOR, text));
      }),

    findDiscussionInputRefusal,

    /**
     * Drafts the Discussion Input that tells the session what it has not
     * been told yet (spec 19 section 5.4), and returns it, or none when there
     * is nothing to tell. The draft holds:
     *
     * - the session's pending entries, in the order it joined their
     *   Discussions, each with the files shared there that list it and the
     *   other sessions that edited them. Whether each other session can be
     *   told is checked once per session, for every session that shares a
     *   file with this one in an entry's Discussion;
     * - the Discussions with Posts it has not been told about, newest
     *   activity first, each with the first such Post. A Discussion with a
     *   pending entry is left out, because the entry already tells the
     *   session to read the whole Discussion.
     *
     * Only what the text can name is read: the first entries, the first
     * files of each, and the first Discussions with new Posts. The rest is
     * only counted, in SQL.
     *
     * Reads only, and checks no grant: only the controller drafts one. It
     * does not check whether this session can receive the input; the caller
     * does that with `findDiscussionInputRefusal`.
     */
    draftDiscussionInput: (
      sessionId: string,
    ): Effect.Effect<Option.Option<DiscussionInputDraft>, SqlError> =>
      Effect.gen(function* () {
        const pending = yield* discussions.listPendingEntries(sessionId, MAX_NAMED_ENTRIES);
        const untold = yield* discussions.listUntoldPosts(sessionId, MAX_NAMED_NEW_POSTS);
        if (pending.count === 0 && untold.count === 0) return Option.none();
        const entries = yield* Effect.forEach(
          pending.items,
          (entry): Effect.Effect<DiscussionEntry, SqlError> =>
            Effect.gen(function* () {
              const files = yield* discussions.listFilesSharedWith(
                entry.discussionId,
                sessionId,
                MAX_NAMED_FILES_PER_ENTRY,
              );
              return {
                discussionId: entry.discussionId,
                repository: entry.repository,
                files: files.items.map((file) => ({
                  path: file.path,
                  sessionIds: file.sessionIds.filter((id) => id !== sessionId),
                })),
                fileCount: files.count,
                otherSessionIds: yield* discussions.listSessionsSharingFilesWith(
                  entry.discussionId,
                  sessionId,
                ),
              };
            }),
        );
        const sessionsNotTold = new Set<string>();
        for (const other of new Set(entries.flatMap((entry) => entry.otherSessionIds))) {
          if ((yield* findDiscussionInputRefusal(other)) !== undefined) sessionsNotTold.add(other);
        }
        const built = buildDiscussionInputText(
          {
            entries,
            entryCount: pending.count,
            newPosts: untold.items,
            newPostCount: untold.count,
            sessionsNotTold,
          },
          sessionId,
        );
        const namedEntries = new Set(built.namedEntries.map((entry) => entry.discussionId));
        const namedNewPosts = new Set(built.namedNewPosts.map((mention) => mention.discussionId));
        return Option.some({
          text: built.text,
          holdsEntry: namedEntries.size > 0,
          told: {
            entryDiscussionIds: [...namedEntries],
            toldThrough: [
              ...pending.items.flatMap((entry) =>
                namedEntries.has(entry.discussionId) && entry.newestPostId !== undefined
                  ? [{ discussionId: entry.discussionId, postId: entry.newestPostId }]
                  : [],
              ),
              ...untold.items
                .filter((posts) => namedNewPosts.has(posts.discussionId))
                .map((posts) => ({ discussionId: posts.discussionId, postId: posts.newestPostId })),
            ],
          },
        });
      }),

    /**
     * Records what a Discussion Input told the session, once the runner has
     * taken it: the entries it told are no longer pending, and the session
     * counts as told about every Post up to the one the draft recorded. A
     * Post written after the draft stays untold. The mark never moves back
     * to an older Post. Runs in the caller's transaction.
     */
    markTold: (sessionId: string, told: ToldMark): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        for (const discussionId of told.entryDiscussionIds) {
          yield* discussions.clearPendingEntry(discussionId, sessionId);
        }
        for (const { discussionId, postId } of told.toldThrough) {
          yield* discussions.advanceToldThrough(discussionId, sessionId, postId);
        }
      }),
  };
});

/** The Discussion service. */
export class DiscussionService extends Context.Service<
  DiscussionService,
  Effect.Success<typeof make>
>()("hercule/controller/discussions/DiscussionService") {}

export const DiscussionServiceLayer: Layer.Layer<
  DiscussionService,
  never,
  SqlClient.SqlClient | AuditLog
> = Layer.effect(DiscussionService)(make);
