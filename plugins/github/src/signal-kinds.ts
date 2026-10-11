/**
 * The kinds of Signal GitHub's events raise: a review requested from the
 * user, a review requested from one of the user's teams, a comment that
 * mentions the user, an issue or pull request assigned to the user, changes
 * requested on the user's pull request, and failed checks on it. Spec 08
 * §5.1 lists them.
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
  MAX_BLOCK_MESSAGES,
  MAX_BLOCK_NAME_LENGTH,
  MAX_BLOCK_URL_LENGTH,
  MAX_CHECK_LOG_LENGTH,
  MAX_CHECK_LOG_LINES,
  MAX_CHECK_ROWS,
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
import { PASSING_CONCLUSIONS } from "./ingest/checks";
import { ListedCheckRun, ListedComment } from "./ingest/feed-objects";
import {
  decodeGithubValue,
  fetchFeedResponse,
  fetchListing,
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

/**
 * The most requests `build` sends for a review's comments, 100 a page: the
 * first page, which says how many there are, then the last page and the one
 * before it. The newest `MAX_BLOCK_MESSAGES - 1` are shown, and they fit in
 * those two.
 */
const MAX_REVIEW_COMMENT_PAGES = 3;

/** The most pages of check runs `build` reads for a commit, 100 each. */
const MAX_CHECK_RUN_PAGES = 3;

/** For how many failed checks `build` reads what the check reported, one request each. */
const MAX_LOGGED_CHECKS = 5;

/** The thread of every kind: the issue or pull request, by its External Ref. */
const THREAD_REF = "event.refs[0]";

/** The match field for the repository, as lowercase `owner/repo`. */
const REPO_MATCH_FIELD = { name: "repo", label: "Repository", path: "event.payload.subject.repo" };

/** The match field for who asked: who requested the review, or who wrote the comment. */
const AUTHOR_MATCH_FIELD = { name: "author", label: "Author", path: "event.author" };

/**
 * Returns the end of a signal when an issue or pull request is finished
 * (`verb` is "Merged" or "Closed"): no move is asked of the user any more.
 * The outcome names who did it when GitHub said.
 */
const buildFinishedEnd = (eventKind: string, verb: "Merged" | "Closed"): SignalEndDeclaration => ({
  eventKind,
  resolution: "withdrawn",
  outcome: `event.author == null ? "${verb}" : "${verb} by " + event.author`,
});

/** The ends every kind about a pull request has: it was merged, or closed unmerged. */
const PULL_REQUEST_FINISHED_ENDS: ReadonlyArray<SignalEndDeclaration> = [
  buildFinishedEnd("github.pr.merged", "Merged"),
  buildFinishedEnd("github.pr.closed", "Closed"),
];

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
  ...PULL_REQUEST_FINISHED_ENDS,
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

/** The fields of an issue or a pull request that make up its description. */
interface ItemDescription {
  readonly body: string | null;
  readonly html_url: string;
  readonly created_at: string;
  readonly user: GithubAccount | null;
}

/**
 * Returns the blocks that show an item's description: one `messages` block
 * with the description as a message by the item's author, or none when the
 * description is empty.
 */
const buildDescriptionBlocks = (item: ItemDescription) => {
  const description = item.body?.trim() ?? "";
  return description === ""
    ? []
    : [
        {
          type: "messages",
          messages: [buildMessage(item.user, item.created_at, description, item.html_url, false)],
          omitted: 0,
        },
      ];
};

/**
 * Returns the Reply answer: a comment on the item, typed by the user.
 * Whether it is primary is the kind's choice, so a kind that suggests it
 * adds `primary`.
 */
const buildReplyAction = (
  item: Pick<GithubItem, "repo" | "kind" | "number">,
): SignalDraftAction => ({
  id: "reply",
  label: "Reply",
  action: item.kind === "pr" ? "pr.comment" : "issue.comment",
  input: { repo: item.repo, number: item.number },
  field: { name: "body", placeholder: "Write a reply" },
});

/**
 * Returns the fields of an event's payload that `build` reads, decoded with
 * `schema`. Fails with a `PluginError` when the payload lacks them, which
 * means the event was not ingested by this plugin's version of the kind.
 */
const decodeEventPayload = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  event: StoredEvent,
): Effect.Effect<S["Type"], PluginError> =>
  Effect.mapError(
    Schema.decodeUnknownEffect(schema)(event.payload),
    (error) =>
      new PluginError({
        message: `The ${event.kind} event ${String(event.id)} has an unexpected payload: ${error.message}`,
      }),
  );

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
        ...buildDescriptionBlocks(pull),
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
    const payload = yield* decodeEventPayload(MentionPayload, event);
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
      actions: [{ ...buildReplyAction(item), primary: true }],
    };
  });

/**
 * An issue or a pull request, as `GET /repos/{owner}/{repo}/issues/{number}`
 * returns it, which GitHub answers for both: the fields an assignment
 * signal shows.
 */
const AssignedItem = Schema.Struct({
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  created_at: Schema.String,
  user: Schema.NullOr(GithubAccount),
});

/**
 * Builds the signal of an assignment: the item's title, who assigned the
 * user, a `messages` block with its description when it has one, and a Reply
 * answer that comments on it. Reads the item from GitHub. Fails with a
 * `PluginError` when the event names no item, the Connection has no token,
 * or GitHub refuses or cannot be reached.
 */
export const buildAssignedSignal = (
  event: StoredEvent,
  context: SignalBuildContext,
): Effect.Effect<SignalDraft, PluginError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const item = yield* readEventItem(event);
    const token = yield* readBuildToken(context);
    const response = yield* Effect.mapError(
      fetchFeedResponse({
        method: "GET",
        path: `/repos/${item.repo}/issues/${String(item.number)}`,
        token,
      }),
      convertToBuildError,
    );
    const assigned = yield* decodeGithubValue(AssignedItem, response.body, "an issue");
    return {
      title: cutText(assigned.title, MAX_SIGNAL_TITLE_LENGTH),
      ...(event.author === null ? {} : { asker: event.author }),
      place: buildItemPlace(item),
      blocks: buildDescriptionBlocks(assigned),
      actions: [buildReplyAction(item)],
    };
  });

/** The fields of a `github.pr.review-submitted` payload that `build` reads. */
const ReviewPayload = Schema.Struct({
  subject: Schema.Struct({ title: Schema.optionalKey(Schema.String) }),
  reviewId: Schema.Int,
});

/** A review, as `GET /repos/{owner}/{repo}/pulls/{number}/reviews/{id}` returns it. */
const SubmittedReview = Schema.Struct({
  user: Schema.NullOr(GithubAccount),
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  submitted_at: Schema.NullOr(Schema.String),
});

/**
 * A comment of a review, as `GET .../reviews/{id}/comments` returns it.
 * `line` is the line in the pull request's current diff, and GitHub sends
 * null when later commits moved the comment off the diff. `original_line`
 * is then the line the reviewer commented on.
 */
const ReviewComment = Schema.Struct({
  user: Schema.NullOr(GithubAccount),
  body: Schema.String,
  html_url: Schema.String,
  created_at: Schema.String,
  path: Schema.String,
  line: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  original_line: Schema.optionalKey(Schema.NullOr(Schema.Int)),
});

/** The text of a review that has no body, which is how GitHub lets a reviewer request changes. */
const EMPTY_REVIEW_TEXT = "Requested changes";

/**
 * Builds the signal of requested changes: the pull request's title, who
 * requested the changes, a `messages` block with the review and then its
 * comments, each with the file and line it is on, and a Reply answer that
 * comments on the pull request. Reads the review and its comments from
 * GitHub.
 *
 * A messages block shows the review (its first message) and at most
 * `MAX_BLOCK_MESSAGES - 1` comments. When the review has more, the newest
 * are kept and `omitted` counts the older ones left out, because the block
 * can only record omitted messages that come before the ones shown.
 *
 * Fails with a `PluginError` when the event names no pull request or has no
 * review id, the Connection has no token, or GitHub refuses or cannot be
 * reached.
 */
export const buildChangesRequestedSignal = (
  event: StoredEvent,
  context: SignalBuildContext,
): Effect.Effect<SignalDraft, PluginError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const item = yield* readEventItem(event);
    const payload = yield* decodeEventPayload(ReviewPayload, event);
    const token = yield* readBuildToken(context);
    const reviewPath = `/repos/${item.repo}/pulls/${String(item.number)}/reviews/${String(payload.reviewId)}`;
    const reviewResponse = yield* Effect.mapError(
      fetchFeedResponse({ method: "GET", path: reviewPath, token }),
      convertToBuildError,
    );
    const review = yield* decodeGithubValue(SubmittedReview, reviewResponse.body, "a review");
    const listing = yield* Effect.mapError(
      fetchNewestItems(
        { method: "GET", path: `${reviewPath}/comments`, token, query: { per_page: "100" } },
        MAX_REVIEW_COMMENT_PAGES,
        (items) => items.length < MAX_BLOCK_MESSAGES - 1,
      ),
      convertToBuildError,
    );
    const comments = yield* decodeGithubValue(
      Schema.Array(ReviewComment),
      listing.items,
      "review comments",
    );
    const shown = comments.slice(-(MAX_BLOCK_MESSAGES - 1));
    const body = review.body ?? "";
    const place = buildItemPlace(item);
    return {
      title: cutText(payload.subject.title ?? place, MAX_SIGNAL_TITLE_LENGTH),
      ...(event.author === null ? {} : { asker: event.author }),
      place,
      blocks: [
        {
          type: "messages",
          messages: [
            buildMessage(
              review.user,
              review.submitted_at ?? event.occurredAt,
              body.trim() === "" ? EMPTY_REVIEW_TEXT : body,
              review.html_url,
              false,
            ),
            ...shown.map((comment) => {
              const line = comment.line ?? comment.original_line ?? undefined;
              return {
                ...buildMessage(
                  comment.user,
                  comment.created_at,
                  comment.body,
                  comment.html_url,
                  false,
                ),
                location: {
                  path: cutText(comment.path, MAX_BLOCK_NAME_LENGTH),
                  ...(line === undefined ? {} : { line }),
                },
              };
            }),
          ],
          omitted: listing.itemsBefore + comments.length - shown.length,
        },
      ],
      actions: [buildReplyAction(item)],
    };
  });

/** The fields of a `github.pr.checks-completed` payload that `build` reads. */
const ChecksPayload = Schema.Struct({
  subject: Schema.Struct({ title: Schema.optionalKey(Schema.String) }),
  headSha: Schema.String,
});

/** One annotation of a check run, as `GET .../check-runs/{id}/annotations` returns it. */
const CheckAnnotation = Schema.Struct({
  path: Schema.String,
  start_line: Schema.Int,
  message: Schema.String,
});

/** The ANSI escape sequences a terminal log holds for colors and cursor moves. */
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/**
 * Cuts the output of a check to the end of it that fits a checks row's log.
 * Returns the last `MAX_CHECK_LOG_LINES` lines of `output` without ANSI
 * escape codes and trailing blank lines, and, when those are still longer
 * than `MAX_CHECK_LOG_LENGTH` characters, the last characters of them.
 * Returns `undefined` when nothing is left, because a row's log is not
 * allowed to be empty. The end is kept because that is where a failing
 * command says why it failed.
 */
export const cutCheckLog = (output: string): string | undefined => {
  const lines = output.replace(ANSI_ESCAPE_PATTERN, "").split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const log = lines.slice(-MAX_CHECK_LOG_LINES).join("\n");
  if (log === "") return undefined;
  return log.length > MAX_CHECK_LOG_LENGTH ? log.slice(-MAX_CHECK_LOG_LENGTH) : log;
};

/**
 * Reads what a failed check reported and returns the end of it as a row's
 * log, or `undefined` when it reported nothing. The check's annotations
 * (up to 50, one line each as `path:line message`) are read when it has
 * any, and otherwise its `text`, or its `summary` when the `text` holds no
 * log. Fails with a `PluginError` when GitHub refuses or cannot be reached.
 */
const readFailedCheckLog = (
  item: Pick<GithubItem, "repo">,
  token: string,
  run: ListedCheckRun,
): Effect.Effect<string | undefined, PluginError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (run.output.annotations_count === 0) {
      return cutCheckLog(run.output.text ?? "") ?? cutCheckLog(run.output.summary ?? "");
    }
    const response = yield* Effect.mapError(
      fetchFeedResponse({
        method: "GET",
        path: `/repos/${item.repo}/check-runs/${String(run.id)}/annotations`,
        token,
        query: { per_page: "50" },
      }),
      convertToBuildError,
    );
    const annotations = yield* decodeGithubValue(
      Schema.Array(CheckAnnotation),
      response.body,
      "check annotations",
    );
    return cutCheckLog(
      annotations
        .map(
          (annotation) =>
            `${annotation.path}:${String(annotation.start_line)} ${annotation.message}`,
        )
        .join("\n"),
    );
  });

/**
 * Returns one row of a checks block. A check that has not completed is
 * pending, and every other row is a failed check.
 */
const buildCheckRow = (run: ListedCheckRun, log: string | undefined) => {
  const url = run.html_url;
  return {
    name: cutText(run.name, MAX_BLOCK_NAME_LENGTH),
    state: run.status === "completed" ? ("failed" as const) : ("pending" as const),
    ...(url !== null && url.startsWith("https://") && url.length <= MAX_BLOCK_URL_LENGTH
      ? { url }
      : {}),
    ...(log === undefined ? {} : { log }),
  };
};

/**
 * Builds the signal of failed checks: the pull request's title, the app of
 * the first failed check as the asker, a `checks` block with the failed
 * checks and then the pending ones (at most `MAX_CHECK_ROWS`; `omitted`
 * counts the rest) and the number that passed, and a Re-run failed checks
 * answer for the head commit. The first five failed checks also show the
 * end of what they reported.
 *
 * Reads the head commit's check runs, up to 300 in three pages, and the
 * annotations of up to five of them: at most eight requests. Fails with a
 * `PluginError` when the event names no pull request or has no head commit,
 * the Connection has no token, or GitHub refuses or cannot be reached.
 */
export const buildChecksFailedSignal = (
  event: StoredEvent,
  context: SignalBuildContext,
): Effect.Effect<SignalDraft, PluginError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const item = yield* readEventItem(event);
    const payload = yield* decodeEventPayload(ChecksPayload, event);
    const token = yield* readBuildToken(context);
    const listing = yield* Effect.mapError(
      fetchListing(
        {
          method: "GET",
          path: `/repos/${item.repo}/commits/${encodeURIComponent(payload.headSha)}/check-runs`,
          token,
          query: { filter: "latest", per_page: "100" },
        },
        MAX_CHECK_RUN_PAGES,
        { itemsField: "check_runs" },
      ),
      convertToBuildError,
    );
    const runs = yield* decodeGithubValue(
      Schema.Array(ListedCheckRun),
      listing.items,
      "check runs",
    );
    const failed = runs.filter(
      (run) => run.conclusion !== null && !PASSING_CONCLUSIONS.has(run.conclusion),
    );
    const pending = runs.filter((run) => run.status !== "completed");
    const rows = [...failed, ...pending].slice(0, MAX_CHECK_ROWS);
    // The failed checks come first among the rows, so the logs line up with the rows' first entries.
    const logs = yield* Effect.forEach(failed.slice(0, MAX_LOGGED_CHECKS), (run) =>
      readFailedCheckLog(item, token, run),
    );
    const place = buildItemPlace(item);
    const app = failed[0]?.app?.name;
    return {
      title: cutText(payload.subject.title ?? place, MAX_SIGNAL_TITLE_LENGTH),
      ...(app === undefined ? {} : { asker: app }),
      place,
      blocks: [
        {
          type: "checks",
          rows: rows.map((run, index) => buildCheckRow(run, logs[index])),
          passed: runs.filter(
            (run) => run.conclusion !== null && PASSING_CONCLUSIONS.has(run.conclusion),
          ).length,
          omitted: failed.length + pending.length - rows.length,
        },
      ],
      actions: [
        {
          id: "rerun",
          label: "Re-run failed checks",
          action: "checks.rerun",
          input: { repo: item.repo, number: item.number, sha: payload.headSha },
          primary: true,
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
    rule: 'event.payload.reviewer == "team" && !event.payload.byYou ? "yes" : "no"',
    guidance:
      "A review was requested from one of the user's teams. Any member of the team may answer it. A request the user made themselves is never a signal.",
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
  {
    word: "assigned",
    label: "Assigned",
    description: "Someone assigned you an issue or a pull request.",
    from: ["github.issue.assigned"],
    rule: 'event.payload.toYou && !event.payload.byYou ? "yes" : "no"',
    guidance:
      "An issue or a pull request was assigned to the user. Assigning it to oneself is never a signal.",
    threadRef: THREAD_REF,
    namesYou: true,
    priority: "normal",
    matchFields: [REPO_MATCH_FIELD, AUTHOR_MATCH_FIELD],
    ends: [
      {
        eventKind: "github.issue.unassigned",
        condition: "event.payload.toYou",
        resolution: "withdrawn",
        outcome:
          'event.payload.byYou ? "You unassigned yourself on GitHub" : event.author == null ? "Unassigned" : "Unassigned by " + event.author',
      },
      buildFinishedEnd("github.issue.closed", "Closed"),
      ...PULL_REQUEST_FINISHED_ENDS,
    ],
    build: provideFetchClient(buildAssignedSignal),
  },
  {
    word: "changes-requested",
    label: "Changes requested",
    description: "A reviewer asked for changes on your pull request.",
    from: ["github.pr.review-submitted"],
    rule: 'event.payload.verdict == "changes-requested" && event.payload.onYourPullRequest && !event.payload.byYou ? "yes" : "no"',
    guidance:
      "A review on the user's own pull request asks for changes. Other verdicts, and the user's own reviews, are never this signal.",
    threadRef: THREAD_REF,
    namesYou: true,
    priority: "normal",
    matchFields: [
      REPO_MATCH_FIELD,
      { name: "reviewer", label: "Reviewer", path: "event.payload.reviewer" },
    ],
    ends: [
      {
        // Asking the reviewer again is the user's move, but it is not one of the
        // signal's answers (Reply only comments), so no `actionId`.
        eventKind: "github.pr.review-requested",
        condition: "event.payload.byYou",
        resolution: "decided",
        outcome: '"Asked for another review on GitHub"',
      },
      ...PULL_REQUEST_FINISHED_ENDS,
    ],
    build: provideFetchClient(buildChangesRequestedSignal),
  },
  {
    word: "checks-failed",
    label: "Checks failed",
    description: "The checks on your pull request failed.",
    from: ["github.pr.checks-completed"],
    rule: 'event.payload.conclusion == "failure" && event.payload.onYourPullRequest ? "yes" : "no"',
    guidance:
      "The checks on the user's own pull request finished with a failure. The user asked nobody, so it does not name them.",
    threadRef: THREAD_REF,
    namesYou: false,
    priority: "normal",
    matchFields: [
      REPO_MATCH_FIELD,
      {
        name: "check",
        label: "Check",
        // The first failed check by name. The list may be empty, and indexing an
        // empty list is an error the core logs as a warning on every signal.
        path: "size(event.payload.failedChecks) > 0 ? event.payload.failedChecks[0] : null",
      },
    ],
    ends: [
      {
        // A new failure on a newer head commit is not an end: the core replaces
        // the older signal of the same kind on the thread.
        eventKind: "github.pr.checks-completed",
        condition: 'event.payload.conclusion != "failure"',
        resolution: "withdrawn",
        outcome: '"Checks passed"',
      },
      ...PULL_REQUEST_FINISHED_ENDS,
    ],
    build: provideFetchClient(buildChecksFailedSignal),
  },
];
