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
 * A new Post is mentioned to every other participant through its Discussion
 * Input, in the same transaction. The sessions domain decides whether a
 * participant can receive one, and writes nothing for one that cannot.
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
import {
  namesRepository,
  resolveRepository,
  SessionService,
  type RepositoryRef,
} from "../sessions";
import { discussionRepository, type DiscussionSortField } from "./repository";

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
  const sessions = yield* SessionService;

  const readDiscussionOrFail = (id: string): Effect.Effect<Discussion, NotFound | SqlError> =>
    Effect.flatMap(
      discussions.one(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_DISCUSSION)),
        onSome: Effect.succeed,
      }),
    );

  /**
   * Writes a Post and its audit entry, and mentions the Post to every
   * participant but the ones in `exceptSessionIds`. Runs in the caller's transaction.
   */
  const writePost = (
    discussionId: string,
    actor: string,
    text: string,
    exceptSessionIds: ReadonlyArray<string>,
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
      for (const participant of yield* discussions.listParticipants(discussionId)) {
        if (exceptSessionIds.includes(participant)) continue;
        yield* sessions.mentionDiscussions(participant, {
          entries: [],
          newPosts: [{ discussionId, firstPostId: post.id }],
        });
      }
      return post;
    });

  /**
   * Adds the sessions to a Discussion as participants, in the given order,
   * while it has fewer than `MAX_PARTICIPANTS`. Skips the sessions that take
   * part already. Returns the sessions that joined. Runs in the caller's
   * transaction.
   */
  const join = (
    discussionId: string,
    sessionIds: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
    Effect.gen(function* () {
      const participants = yield* discussions.listParticipants(discussionId);
      const at = yield* nowIso;
      const joined: Array<string> = [];
      for (const sessionId of sessionIds) {
        if (participants.length + joined.length >= MAX_PARTICIPANTS) break;
        if (participants.includes(sessionId) || joined.includes(sessionId)) continue;
        yield* discussions.insertParticipant(discussionId, sessionId, at);
        joined.push(sessionId);
      }
      if (joined.length > 0) {
        yield* announce({ _tag: "record", topic: "discussion", id: discussionId, kind: "updated" });
      }
      return joined;
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
        if (
          filter.resourceId !== undefined &&
          !(yield* Effect.provideService(
            namesRepository(filter.resourceId),
            SqlClient.SqlClient,
            sql,
          ))
        ) {
          return { items: [] };
        }
        const listing = yield* refuseCursor(
          discussions.list(filter, {
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            sort: resolveSortKeys(sort, DEFAULT_SORT),
          }),
        );
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
     * becomes the Discussion's first participant. Nothing is sent to anyone,
     * because a new Discussion has no other participant.
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
            const sessionId = readCallerSessionId(caller);
            if (sessionId !== undefined) yield* discussions.insertParticipant(id, sessionId, at);
            const post = yield* writePost(
              id,
              actor,
              text,
              sessionId === undefined ? [] : [sessionId],
            );
            return { discussion: yield* readDiscussionOrFail(id), post };
          }),
        );
      }),

    /**
     * Writes a Post in a Discussion and returns it. A calling session becomes
     * a participant if it is not one, unless the Discussion already has
     * `MAX_PARTICIPANTS`: then its Post is still accepted. Every other
     * participant is told about the Post through its Discussion Input.
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
            const sessionId = readCallerSessionId(caller);
            if (sessionId !== undefined) yield* join(id, [sessionId]);
            return yield* writePost(
              id,
              buildActorStamp(caller),
              decoded.text,
              sessionId === undefined ? [] : [sessionId],
            );
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

    join,

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
     * Writes a system Post in a Discussion and returns it, and mentions it to
     * every participant not in `exceptSessionIds`. Writes nothing and returns none when
     * the Discussion already holds `MAX_SYSTEM_POSTS` system Posts: a report
     * never fails because of a cap. Runs in the caller's transaction.
     */
    writeSystemPost: (
      discussionId: string,
      text: string,
      exceptSessionIds: ReadonlyArray<string>,
    ): Effect.Effect<Option.Option<Post>, SqlError> =>
      Effect.gen(function* () {
        const { system } = yield* discussions.countPosts(discussionId);
        if (system >= MAX_SYSTEM_POSTS) return Option.none();
        return Option.some(yield* writePost(discussionId, SYSTEM_ACTOR, text, exceptSessionIds));
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
  SqlClient.SqlClient | AuditLog | SessionService
> = Layer.effect(DiscussionService)(make);
