/**
 * The kinds of Signal GitHub's events raise: a review requested from the
 * user, a review requested from one of the user's teams, and a comment that
 * mentions the user. Spec 08 §5.1 lists them.
 *
 * Everything but `build` is CEL the core evaluates over the stored event.
 * Every kind's thread is the issue or pull request the event is about: an
 * item event's first ref is the item's own (`github:pr:acme/webshop#1293`).
 *
 * `build` reads GitHub to lay out the signal's body, cut to the limits the
 * core checks.
 */
import { Effect, Schema } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import {
  MAX_BLOCK_NAME_LENGTH,
  MAX_BLOCK_URL_LENGTH,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_SIGNAL_TITLE_LENGTH,
  PluginError,
  type SignalBuildContext,
  type SignalDraft,
  type SignalDraftAction,
  type SignalEndDeclaration,
  type SignalKindDeclaration,
  type StoredEvent,
} from "@hercule/plugin-host";
import { readToken } from "./api";
import { GithubAccount } from "./github-objects";
import { ListedComment } from "./ingest/feed-objects";
import {
  decodeGithubValue,
  fetchFeedResponse,
  fetchNewestItems,
  type FeedError,
} from "./ingest/requests";
import { buildItemPlace, parseItemRef, type GithubItem } from "./subject";
import { cutText } from "./text";

/** How many comments before the one that mentions the user a `mentioned` signal shows. */
const COMMENTS_BEFORE_MENTION = 3;

/**
 * The most requests `build` sends for an item's comments, 100 a page, to
 * find the comment that mentions the user and the comments before it. The
 * comments are read newest first, so only a mention with more than about
 * 900 comments after it is not found, and the core writes the signal from
 * the event instead.
 */
const MAX_COMMENT_PAGES = 10;

/** The thread of every kind: the issue or pull request, by its External Ref. */
const THREAD_REF = "event.refs[0]";

/** The match field for the repository, as lowercase `owner/repo`. */
const REPO_MATCH_FIELD = { name: "repo", label: "Repository", path: "event.payload.subject.repo" };

/** The match field for who asked: who requested the review, or who wrote the comment. */
const AUTHOR_MATCH_FIELD = { name: "author", label: "Author", path: "event.author" };

/**
 * Returns the ends of a review request: the user's own review decides it,
 * and the request taken back, a merge or a close withdraws it. `reviewer` is
 * `you` or `team`: only a removal of the same kind of request ends it. A
 * teammate's review does not end a team request, because the request still
 * asks the user's team, and GitHub lets every member answer it.
 *
 * A pull request has one team signal for all of the user's teams, because
 * the user's review, which ends it, names no team. So a team's removal ends
 * the signal only when the pull request asks none of the user's teams any
 * more. A removal event from before `teamStillRequested` existed has no such
 * field, and ends the signal as it always did.
 */
const buildReviewRequestEnds = (reviewer: "you" | "team"): ReadonlyArray<SignalEndDeclaration> => [
  {
    eventKind: "github.pr.review-submitted",
    condition: 'event.payload.byYou && event.payload.verdict == "approved"',
    resolution: "decided",
    outcome: '"Approved on GitHub"',
    actionId: "approve",
  },
  {
    eventKind: "github.pr.review-submitted",
    condition: 'event.payload.byYou && event.payload.verdict == "changes-requested"',
    resolution: "decided",
    outcome: '"Requested changes on GitHub"',
    actionId: "request-changes",
  },
  {
    eventKind: "github.pr.review-submitted",
    condition: 'event.payload.byYou && event.payload.verdict == "commented"',
    resolution: "decided",
    outcome: '"Reviewed on GitHub"',
    actionId: "comment",
  },
  {
    eventKind: "github.pr.review-request-removed",
    condition:
      reviewer === "you"
        ? 'event.payload.reviewer == "you"'
        : 'event.payload.reviewer == "team" && !(has(event.payload.teamStillRequested) && event.payload.teamStillRequested)',
    resolution: "withdrawn",
    outcome:
      'event.author == null ? "Review request removed" : "Review request removed by " + event.author',
  },
  {
    eventKind: "github.pr.merged",
    resolution: "withdrawn",
    outcome: 'event.author == null ? "Merged" : "Merged by " + event.author',
  },
  {
    eventKind: "github.pr.closed",
    resolution: "withdrawn",
    outcome: 'event.author == null ? "Closed" : "Closed by " + event.author',
  },
];

/** Converts a failure to read GitHub into the `PluginError` a `build` fails with. */
const convertToBuildError = (error: FeedError): PluginError =>
  error instanceof PluginError
    ? error
    : new PluginError({
        message:
          error._tag === "GithubRateLimited"
            ? `GitHub rate limited the Connection; it asked to wait ${String(error.retryAfterSeconds)} seconds.`
            : error.message,
      });

/**
 * Returns the issue or pull request a stored event is about, from its first
 * ref. Fails with a `PluginError` when the event is not about one: every
 * event the signal kinds read is.
 */
const readEventItem = (
  event: StoredEvent,
): Effect.Effect<Pick<GithubItem, "repo" | "kind" | "number">, PluginError> => {
  const item = event.refs[0] === undefined ? undefined : parseItemRef(event.refs[0]);
  return item === undefined
    ? Effect.fail(
        new PluginError({
          message: `The event ${String(event.id)} names no GitHub issue or pull request in its first ref.`,
        }),
      )
    : Effect.succeed(item);
};

/** Returns the Connection's token. Fails with a `PluginError` when it cannot be read or holds none. */
const readBuildToken = (context: SignalBuildContext): Effect.Effect<string, PluginError> =>
  Effect.flatMap(
    Effect.mapError(context.credentials(), (error) => new PluginError({ message: error.message })),
    (credentials) => {
      const token = readToken(credentials);
      return token === undefined
        ? Effect.fail(new PluginError({ message: "The GitHub Connection has no token." }))
        : Effect.succeed(token);
    },
  );

/**
 * Returns the person a block shows for a GitHub account. A deleted account,
 * which GitHub sends as null, is shown as GitHub shows it: `ghost`.
 */
const buildPerson = (account: GithubAccount | null) => {
  const avatarUrl = account?.avatar_url;
  return {
    name: cutText(account?.login ?? "ghost", MAX_BLOCK_NAME_LENGTH),
    ...(avatarUrl !== undefined &&
    avatarUrl.startsWith("https://") &&
    avatarUrl.length <= MAX_BLOCK_URL_LENGTH
      ? { avatarUrl }
      : {}),
  };
};

/**
 * Converts a GitHub timestamp, such as `2026-10-11T09:14:03Z`, into the form
 * a block's timestamp takes, with milliseconds: `2026-10-11T09:14:03.000Z`.
 * A value that is not a date is returned as it is, and the core then refuses
 * the draft.
 */
const convertGithubTimestamp = (at: string): string => {
  const time = Date.parse(at);
  return Number.isNaN(time) ? at : new Date(time).toISOString();
};

/** Returns one message of a `messages` block, its text cut to the block's limit and marked when cut. */
const buildMessage = (
  author: GithubAccount | null,
  at: string,
  text: string,
  url: string,
  mentionsYou: boolean,
) => ({
  author: buildPerson(author),
  at: convertGithubTimestamp(at),
  text: cutText(text, MAX_MESSAGE_TEXT_LENGTH),
  ...(text.length > MAX_MESSAGE_TEXT_LENGTH ? { truncated: true as const } : {}),
  ...(url.length <= MAX_BLOCK_URL_LENGTH ? { url } : {}),
  ...(mentionsYou ? { mentionsYou: true as const } : {}),
});

/** A pull request, as `GET /repos/{owner}/{repo}/pulls/{number}` returns it: the fields a review signal shows. */
const ReviewedPull = Schema.Struct({
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  created_at: Schema.String,
  user: Schema.NullOr(GithubAccount),
  head: Schema.Struct({ ref: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
  changed_files: Schema.Int,
  additions: Schema.Int,
  deletions: Schema.Int,
  commits: Schema.Int,
});

/**
 * Returns the answers to a review request: Approve, Request changes and
 * Comment. None is primary, because a one-click approval must never be the
 * suggested answer.
 */
const buildReviewActions = (
  item: Pick<GithubItem, "repo" | "number">,
): ReadonlyArray<SignalDraftAction> => {
  const address = { repo: item.repo, number: item.number };
  return [
    {
      id: "approve",
      label: "Approve",
      action: "pr.review",
      input: { ...address, verdict: "approve" },
    },
    {
      id: "request-changes",
      label: "Request changes",
      action: "pr.review",
      input: { ...address, verdict: "request-changes" },
      field: { name: "body", placeholder: "What needs to change?" },
    },
    {
      id: "comment",
      label: "Comment",
      action: "pr.comment",
      input: address,
      field: { name: "body", placeholder: "Write a comment" },
    },
  ];
};

/**
 * Builds the signal of a review request: the pull request's title, who
 * asked, a `change` block with the pull request's totals, then a `messages`
 * block with its description when it has one, and the three review answers.
 * Reads the pull request from GitHub. Fails with a `PluginError` when the
 * event names no pull request, the Connection has no token, or GitHub
 * refuses or cannot be reached.
 */
export const buildReviewRequestSignal = (
  event: StoredEvent,
  context: SignalBuildContext,
): Effect.Effect<SignalDraft, PluginError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const item = yield* readEventItem(event);
    const token = yield* readBuildToken(context);
    const response = yield* Effect.mapError(
      fetchFeedResponse({
        method: "GET",
        path: `/repos/${item.repo}/pulls/${String(item.number)}`,
        token,
      }),
      convertToBuildError,
    );
    const pull = yield* decodeGithubValue(ReviewedPull, response.body, "a pull request");
    const description = pull.body?.trim() ?? "";
    return {
      title: cutText(pull.title, MAX_SIGNAL_TITLE_LENGTH),
      ...(event.author === null ? {} : { asker: event.author }),
      place: buildItemPlace(item),
      blocks: [
        {
          type: "change",
          from: cutText(pull.head.ref, MAX_BLOCK_NAME_LENGTH),
          to: cutText(pull.base.ref, MAX_BLOCK_NAME_LENGTH),
          files: pull.changed_files,
          additions: pull.additions,
          deletions: pull.deletions,
          commits: pull.commits,
        },
        ...(description === ""
          ? []
          : [
              {
                type: "messages",
                messages: [
                  buildMessage(pull.user, pull.created_at, description, pull.html_url, false),
                ],
                omitted: 0,
              },
            ]),
      ],
      actions: buildReviewActions(item),
    };
  });

/** The fields of a `github.mentioned` payload that `build` reads. */
const MentionPayload = Schema.Struct({
  subject: Schema.Struct({ title: Schema.optionalKey(Schema.String) }),
  commentId: Schema.Int,
});

/**
 * Builds the signal of a mention: the item's title, who mentioned the user,
 * a `messages` block with the comment that mentions the user and up to three
 * comments before it, and a Reply answer that comments on the item. Reads
 * the item's comments from GitHub, newest first. Fails with a `PluginError`
 * when the event names no item, the comment is not among the comments read
 * (it was deleted, or too many came after it), the Connection has no token,
 * or GitHub refuses or cannot be reached.
 */
export const buildMentionSignal = (
  event: StoredEvent,
  context: SignalBuildContext,
): Effect.Effect<SignalDraft, PluginError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const item = yield* readEventItem(event);
    const payload = yield* Effect.mapError(
      Schema.decodeUnknownEffect(MentionPayload)(event.payload),
      (error) =>
        new PluginError({
          message: `The mention event has an unexpected payload: ${error.message}`,
        }),
    );
    const token = yield* readBuildToken(context);
    const listing = yield* Effect.mapError(
      fetchNewestItems(
        {
          method: "GET",
          path: `/repos/${item.repo}/issues/${String(item.number)}/comments`,
          token,
          query: { per_page: "100" },
        },
        MAX_COMMENT_PAGES,
        // Older pages are needed until the mention and the comments shown before it are read.
        (items) =>
          items.findIndex((comment) => comment["id"] === payload.commentId) <
          COMMENTS_BEFORE_MENTION,
      ),
      convertToBuildError,
    );
    const comments = yield* decodeGithubValue(
      Schema.Array(ListedComment),
      listing.items,
      "comments",
    );
    const at = comments.findIndex((comment) => comment.id === payload.commentId);
    const place = buildItemPlace(item);
    if (at === -1) {
      return yield* new PluginError({
        message: `The comment ${String(payload.commentId)} that mentions you is not among the newest comments on ${place}: it was deleted, or more than ${String((MAX_COMMENT_PAGES - 1) * 100)} comments came after it.`,
      });
    }
    const first = Math.max(0, at - COMMENTS_BEFORE_MENTION);
    return {
      title: cutText(payload.subject.title ?? event.title ?? place, MAX_SIGNAL_TITLE_LENGTH),
      ...(event.author === null ? {} : { asker: event.author }),
      place,
      blocks: [
        {
          type: "messages",
          messages: comments
            .slice(first, at + 1)
            .map((comment, index) =>
              buildMessage(
                comment.user,
                comment.created_at,
                comment.body ?? "",
                comment.html_url,
                first + index === at,
              ),
            ),
          omitted: listing.itemsBefore + first,
        },
      ],
      actions: [
        {
          id: "reply",
          label: "Reply",
          action: item.kind === "pr" ? "pr.comment" : "issue.comment",
          input: { repo: item.repo, number: item.number },
          primary: true,
          field: { name: "body", placeholder: "Write a reply" },
        },
      ],
    };
  });

/** Runs a `build` with the fetch client, where the host calls in. */
const provideFetchClient =
  (
    build: (
      event: StoredEvent,
      context: SignalBuildContext,
    ) => Effect.Effect<SignalDraft, PluginError, HttpClient.HttpClient>,
  ): SignalKindDeclaration["build"] =>
  (event, context) =>
    Effect.provide(build(event, context), FetchHttpClient.layer);

/** The signal kinds of the GitHub event source. */
export const GITHUB_SIGNAL_KINDS: ReadonlyArray<SignalKindDeclaration> = [
  {
    word: "review-requested",
    label: "Review requested",
    description: "Someone asked you to review a pull request.",
    from: ["github.pr.review-requested"],
    rule: 'event.payload.reviewer == "you" ? "yes" : "no"',
    guidance: "A review was requested from the user by name. It is always a signal.",
    threadRef: THREAD_REF,
    namesYou: true,
    priority: "high",
    matchFields: [REPO_MATCH_FIELD, AUTHOR_MATCH_FIELD],
    ends: buildReviewRequestEnds("you"),
    build: provideFetchClient(buildReviewRequestSignal),
  },
  {
    word: "team-review-requested",
    label: "Team review requested",
    description: "Someone asked a team you are on to review a pull request.",
    from: ["github.pr.review-requested"],
    rule: 'event.payload.reviewer == "team" ? "yes" : "no"',
    guidance:
      "A review was requested from one of the user's teams. Any member of the team may answer it.",
    threadRef: THREAD_REF,
    namesYou: false,
    priority: "normal",
    matchFields: [
      REPO_MATCH_FIELD,
      { name: "team", label: "Team", path: "event.payload.team" },
      AUTHOR_MATCH_FIELD,
    ],
    ends: buildReviewRequestEnds("team"),
    build: provideFetchClient(buildReviewRequestSignal),
  },
  {
    word: "mentioned",
    label: "Mentioned",
    description: "Someone mentioned you by name in a comment on an issue or a pull request.",
    from: ["github.mentioned"],
    rule: 'event.payload.byYou ? "no" : "yes"',
    guidance: "A comment names the user with @login. A comment the user wrote is never a signal.",
    threadRef: THREAD_REF,
    namesYou: true,
    priority: "normal",
    matchFields: [REPO_MATCH_FIELD, AUTHOR_MATCH_FIELD],
    ends: [
      {
        eventKind: "github.issue.commented",
        condition: "event.payload.byYou",
        resolution: "decided",
        outcome: '"Replied on GitHub"',
        actionId: "reply",
      },
      {
        eventKind: "github.pr.commented",
        condition: "event.payload.byYou",
        resolution: "decided",
        outcome: '"Replied on GitHub"',
        actionId: "reply",
      },
    ],
    build: provideFetchClient(buildMentionSignal),
  },
];
