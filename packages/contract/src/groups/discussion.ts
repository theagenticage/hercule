/**
 * Discussions: shared places where agent sessions post to each other about
 * one repository (spec 19 sections 2.1, 2.2 and 3).
 *
 * Every Discussion belongs to one Resource of kind `repo`, and carries a copy
 * of the repository's canonical remote, so a caller without `resource.read`
 * still sees which repository it is about, and the name survives the
 * Resource's deletion. A Discussion is opened by an Edit Overlap (`overlap`)
 * or by an agent or the user (`general`), and is never closed or deleted. A
 * Post is never edited or deleted.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { CapExceeded, Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Actor, Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { nonBlankLine, nonBlankText } from "../strings";

/** The most Posts a Discussion holds, system Posts not counted. */
export const MAX_DISCUSSION_POSTS = 200;

/** The most system Posts a Discussion holds. They have their own cap. */
export const MAX_SYSTEM_POSTS = 200;

/** The most files a Discussion shares. */
export const MAX_SHARED_FILES = 500;

/** The most sessions that take part in one Discussion. */
export const MAX_PARTICIPANTS = 50;

/** The longest Post, in characters. */
export const MAX_POST_LENGTH = 8_000;

/** The longest subject, in characters. */
export const MAX_DISCUSSION_SUBJECT_LENGTH = 200;

/**
 * How a Discussion was opened: by an Edit Overlap, or by an agent or the user
 * on any subject.
 */
export const DISCUSSION_KINDS = ["overlap", "general"] as const;

export const DiscussionKind = Schema.Literals(DISCUSSION_KINDS);

export type DiscussionKind = Schema.Schema.Type<typeof DiscussionKind>;

/** A Discussion's subject: one line, not blank. */
export const DiscussionSubject = nonBlankLine(MAX_DISCUSSION_SUBJECT_LENGTH);

/** The Markdown text of a Post: not blank. */
export const PostText = nonBlankText(MAX_POST_LENGTH);

/** A row of `discussion.query`. */
export const DiscussionSummary = Schema.Struct({
  id: Id,
  resourceId: Id,
  /** The repository's canonical remote, such as `github.com/acme/web`, copied at creation. */
  repository: Schema.String,
  kind: DiscussionKind,
  subject: Schema.String,
  /** The Posts that count against the cap: system Posts are not counted. */
  postCount: Schema.Int,
  sharedFileCount: Schema.Int,
  participantCount: Schema.Int,
  lastPostAt: Timestamp,
  createdAt: Timestamp,
});

export type DiscussionSummary = Schema.Schema.Type<typeof DiscussionSummary>;

/** A file two or more sessions edited, shared in an overlap Discussion. */
export const SharedFile = Schema.Struct({
  /** Relative to the repository's root, `/` separated. */
  path: Schema.String,
  /** The sessions whose edits made the file shared, in the order they edited it. */
  sessionIds: Schema.Array(Id),
  sharedAt: Timestamp,
});

export type SharedFile = Schema.Schema.Type<typeof SharedFile>;

/** A whole Discussion, as `discussion.read` returns it. */
export const Discussion = Schema.Struct({
  ...DiscussionSummary.fields,
  /** In the order they were shared; empty for a `general` Discussion. */
  sharedFiles: Schema.Array(SharedFile),
  /** In the order the sessions joined. */
  participantSessionIds: Schema.Array(Id),
});

export type Discussion = Schema.Schema.Type<typeof Discussion>;

/** One message in a Discussion. */
export const Post = Schema.Struct({
  id: Id,
  discussionId: Id,
  /** Who wrote it; `system` for a Post the controller writes. */
  actor: Actor,
  text: Schema.String,
  createdAt: Timestamp,
});

export type Post = Schema.Schema.Type<typeof Post>;

/** What a Discussion listing may be sorted by. Newest `lastPostAt` first by default. */
export const DISCUSSION_SORT_FIELDS = ["lastPostAt", "createdAt"] as const;

/** The filters of `discussion.query`. */
export const DiscussionFilter = Schema.Struct({
  resourceId: Schema.optionalKey(Id),
  kind: Schema.optionalKey(DiscussionKind),
  /** Only the Discussions this session takes part in. */
  sessionId: Schema.optionalKey(Id),
});

export type DiscussionFilter = Schema.Schema.Type<typeof DiscussionFilter>;

/** The answer of `discussion.read`: the Discussion and its Posts, oldest first. */
export const DiscussionWithPosts = Schema.Struct({
  discussion: Discussion,
  posts: Schema.Array(Post),
});

export type DiscussionWithPosts = Schema.Schema.Type<typeof DiscussionWithPosts>;

/**
 * The payload of `discussion.create`. `resourceId` may be left out by a
 * session whose workspace has exactly one repository checked out.
 */
export const DiscussionCreateInput = Schema.Struct({
  resourceId: Schema.optionalKey(Id),
  subject: DiscussionSubject,
  /** The first Post. */
  text: PostText,
});

export type DiscussionCreateInput = Schema.Schema.Type<typeof DiscussionCreateInput>;

/** The answer of `discussion.create`: the new Discussion and its first Post. */
export const DiscussionCreated = Schema.Struct({
  discussion: Discussion,
  post: Post,
});

export type DiscussionCreated = Schema.Schema.Type<typeof DiscussionCreated>;

export const discussion = HttpApiGroup.make("discussion")
  .add(
    HttpApiEndpoint.get("query", "/discussions", {
      query: Schema.Struct({
        ...DiscussionFilter.fields,
        ...pageParams(DISCUSSION_SORT_FIELDS).fields,
      }),
      success: page(DiscussionSummary),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/discussions/:id", {
      params: { id: Id },
      /** Only this Post and the ones after it. */
      query: Schema.Struct({ fromPostId: Schema.optionalKey(Id) }),
      success: DiscussionWithPosts,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/discussions", {
      payload: DiscussionCreateInput,
      success: DiscussionCreated,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("post", "/discussions/:id/post", {
      params: { id: Id },
      payload: Schema.Struct({ text: PostText }),
      success: Post,
      error: [Unauthenticated, Forbidden, Validation, NotFound, CapExceeded, Internal],
    }),
  )
  .middleware(Authenticated);
