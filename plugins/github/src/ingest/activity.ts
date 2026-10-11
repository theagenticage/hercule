/**
 * The events about what people did on one issue or pull request: a comment,
 * a mention of the user in it, a review, and a review request to the user or
 * one of their teams. The `repos` feed emits them for the watched
 * repositories, and the followed items (`followed.ts`) for the items outside
 * them. Both build them here, so one fact has one dedup key whichever feed
 * finds it.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { IngestContext } from "@hercule/plugin-host";
import { readReviewVerdict, type ReviewVerdict } from "../github-objects";
import { findMention, isUserAccount, type GithubIdentity } from "../identity";
import { buildItemEvent, buildItemPlace, type GithubItem } from "../subject";
import { IssueEvent, type ListedComment, type ListedReview } from "./feed-objects";
import { decodeGithubValue, fetchListing, truncateRaw, type FeedError } from "./requests";
import { buildTeamName } from "./teams";

/** What the activity emitters need besides the item: where events go, and who the user is. */
export interface ActivityPoll {
  /** The repository, as lowercase `owner/repo`. */
  readonly repo: string;
  readonly token: string;
  readonly emit: IngestContext["emit"];
  readonly identity: GithubIdentity;
  /** The user's teams, as lowercase `org/slug`. */
  readonly teams: ReadonlySet<string>;
}

/**
 * The most pages of an item's history one poll reads, 100 entries each. The
 * history is listed oldest first, so an item with more than 1,000 entries
 * has its newest review requests left unread.
 */
const MAX_HISTORY_PAGES = 10;

/** The longest excerpt of a mentioning comment, in characters. */
const MAX_EXCERPT_LENGTH = 280;

/** How many characters before the mention an excerpt starts. */
const EXCERPT_LEAD = 80;

/** Checks whether ISO 8601 timestamp `time` is at or after `start`. An absent start is before everything. */
export const isAtOrAfter = (time: string, start: string | undefined): boolean =>
  start === undefined || Date.parse(time) >= Date.parse(start);

/**
 * Removes the quoted lines of a comment, those starting with `>`. A reply
 * often quotes the comment it answers, and a mention inside the quote was
 * made by someone else, earlier.
 */
const removeQuotedLines = (body: string): string =>
  body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");

/**
 * Returns the part of `text` around position `at`, at most 280 characters,
 * on one line, with an ellipsis where it was cut.
 */
const buildExcerpt = (text: string, at: number): string => {
  const start = Math.max(0, at - EXCERPT_LEAD);
  const end = Math.min(text.length, start + MAX_EXCERPT_LENGTH - 2);
  const excerpt = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${excerpt}${end < text.length ? "…" : ""}`;
};

/**
 * Emits the events of one comment on an issue or a pull request's
 * conversation: `github.issue.commented` or `github.pr.commented`, and
 * `github.mentioned` when the comment mentions the user outside a quote.
 */
export const emitCommentEvents = (
  poll: ActivityPoll,
  item: GithubItem,
  comment: ListedComment,
  raw: Schema.JsonObject,
): Effect.Effect<void, FeedError> =>
  Effect.gen(function* () {
    const commenter = comment.user?.login ?? null;
    const byYou = isUserAccount(poll.identity, comment.user);
    const place = buildItemPlace(item);
    yield* poll.emit(
      buildItemEvent(item, {
        kind: `github.${item.kind}.commented`,
        dedupKey: `${item.kind}.commented:${String(comment.id)}`,
        occurredAt: comment.created_at,
        title: `${commenter ?? "Someone"} commented on ${place}`,
        author: commenter,
        fields: { byYou },
        raw: truncateRaw(raw),
      }),
    );
    const text = removeQuotedLines(comment.body ?? "");
    const at = findMention(text, poll.identity.login);
    if (at === -1) return;
    yield* poll.emit(
      buildItemEvent(item, {
        kind: "github.mentioned",
        dedupKey: `mentioned:${String(comment.id)}`,
        occurredAt: comment.created_at,
        title: `${commenter ?? "Someone"} mentioned you on ${place}`,
        author: commenter,
        fields: {
          commentId: comment.id,
          commentUrl: comment.html_url,
          excerpt: buildExcerpt(text, at),
          byYou,
        },
        raw: truncateRaw(raw),
      }),
    );
  });

/** Returns the title of a review event, such as "marta approved acme/webshop#1293". */
const buildReviewTitle = (reviewer: string, verdict: ReviewVerdict, place: string): string => {
  switch (verdict) {
    case "approved":
      return `${reviewer} approved ${place}`;
    case "changes-requested":
      return `${reviewer} requested changes on ${place}`;
    case "commented":
      return `${reviewer} reviewed ${place}`;
  }
};

/**
 * Emits `github.pr.review-submitted` for one review submitted at or after
 * `start`. A pending review is not submitted yet, and a dismissed one is no
 * longer a verdict, so neither emits.
 */
export const emitReviewEvent = (
  poll: ActivityPoll,
  item: GithubItem,
  review: ListedReview,
  raw: Schema.JsonObject,
  start: string | undefined,
): Effect.Effect<void, FeedError> => {
  const verdict = readReviewVerdict(review.state);
  const submittedAt = review.submitted_at ?? null;
  if (verdict === undefined || submittedAt === null || !isAtOrAfter(submittedAt, start)) {
    return Effect.void;
  }
  const reviewer = review.user?.login ?? "ghost";
  return poll.emit(
    buildItemEvent(item, {
      kind: "github.pr.review-submitted",
      dedupKey: `pr.review-submitted:${String(review.id)}`,
      occurredAt: submittedAt,
      title: buildReviewTitle(reviewer, verdict, buildItemPlace(item)),
      author: review.user?.login ?? null,
      fields: { reviewer, verdict, byYou: isUserAccount(poll.identity, review.user) },
      raw: truncateRaw(raw),
    }),
  );
};

/**
 * Who a review request in an item's history is for, when it is for the user
 * or one of the user's teams: `{ reviewer: "you" }`, or
 * `{ reviewer: "team", team }` with the team as lowercase `org/slug`.
 * Returns undefined for a request to anyone else. A pull request's team
 * belongs to the organization that owns the repository.
 */
const readRequestedReviewer = (
  poll: ActivityPoll,
  entry: IssueEvent,
):
  | { readonly reviewer: "you" }
  | { readonly reviewer: "team"; readonly team: string }
  | undefined => {
  if (entry.requested_reviewer != null && isUserAccount(poll.identity, entry.requested_reviewer)) {
    return { reviewer: "you" };
  }
  if (entry.requested_team != null) {
    const team = buildTeamName(poll.repo.split("/")[0]!, entry.requested_team.slug);
    if (poll.teams.has(team)) return { reviewer: "team", team };
  }
  return undefined;
};

/**
 * Fetches a pull request's history and emits `github.pr.review-requested`
 * and `github.pr.review-request-removed` for each request to the user or one
 * of their teams made or taken back at or after `start`. Each one's dedup
 * key is the history entry's id.
 *
 * Only the history says who asked and when. A pull request's list of
 * requested reviewers says only who is asked now, and GitHub also drops a
 * reviewer from it when they review, which is not a removal.
 */
export const emitReviewRequestEvents = (
  poll: ActivityPoll,
  item: GithubItem,
  start: string | undefined,
): Effect.Effect<void, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const listing = yield* fetchListing(
      {
        method: "GET",
        path: `/repos/${poll.repo}/issues/${String(item.number)}/events`,
        token: poll.token,
        query: { per_page: "100" },
      },
      MAX_HISTORY_PAGES,
    );
    const place = buildItemPlace(item);
    for (const raw of listing.items) {
      const entry = yield* decodeGithubValue(
        IssueEvent,
        raw,
        "an entry of a pull request's history",
      );
      const requested = entry.event === "review_requested";
      if (!requested && entry.event !== "review_request_removed") continue;
      if (!isAtOrAfter(entry.created_at, start)) continue;
      const target = readRequestedReviewer(poll, entry);
      if (target === undefined) continue;
      const asker = entry.review_requester ?? entry.actor;
      const askerLogin = asker?.login ?? null;
      const whom = target.reviewer === "you" ? "you" : target.team;
      const team = target.reviewer === "team" ? { team: target.team } : {};
      yield* poll.emit(
        requested
          ? buildItemEvent(item, {
              kind: "github.pr.review-requested",
              dedupKey: `pr.review-requested:${String(entry.id)}`,
              occurredAt: entry.created_at,
              title:
                target.reviewer === "you"
                  ? `${askerLogin ?? "Someone"} requested your review on ${place}`
                  : `${askerLogin ?? "Someone"} requested a review from ${target.team} on ${place}`,
              author: askerLogin,
              fields: {
                reviewer: target.reviewer,
                ...team,
                requestedBy: askerLogin,
                byYou: isUserAccount(poll.identity, asker),
                toYou: target.reviewer === "you",
              },
              raw: truncateRaw(raw),
            })
          : buildItemEvent(item, {
              kind: "github.pr.review-request-removed",
              dedupKey: `pr.review-request-removed:${String(entry.id)}`,
              occurredAt: entry.created_at,
              title: `${entry.actor?.login ?? "Someone"} removed the review request for ${whom} on ${place}`,
              author: entry.actor?.login ?? null,
              fields: {
                reviewer: target.reviewer,
                ...team,
                byYou: isUserAccount(poll.identity, entry.actor),
              },
              raw: truncateRaw(raw),
            }),
      );
    }
  });
