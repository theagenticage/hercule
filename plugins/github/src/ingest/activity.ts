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
import type { EmittedEvent, IngestContext, PluginError } from "@hercule/plugin-host";
import { readReviewVerdict, type ReviewVerdict } from "../github-objects";
import { findMention, isUserAccount, type GithubIdentity } from "../identity";
import { buildItemEvent, buildItemPlace, type GithubItem } from "../subject";
import { IssueEvent, ListedReview, type ListedComment, type ListedPull } from "./feed-objects";
import { decodeGithubValue, fetchNewestItems, truncateRaw, type FeedError } from "./requests";
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
 * The most requests one poll sends for an item's history, 100 entries a
 * page. The history is read newest first (`fetchNewestItems`), so only an
 * item with more than about 900 entries since the last poll has entries
 * left unread, and a warning says so.
 */
const MAX_HISTORY_PAGES = 10;

/**
 * The most requests one poll sends for a pull request's reviews, 100 a page,
 * read newest first. A pull request rarely has more than 100 reviews in all.
 */
const MAX_REVIEW_PAGES = 3;

/** The longest excerpt of a mentioning comment, in characters. */
const MAX_EXCERPT_LENGTH = 280;

/** How many characters before the mention an excerpt starts. */
const EXCERPT_LEAD = 80;

/** Checks whether ISO 8601 timestamp `time` is at or after `start`. An absent start is before everything. */
export const isAtOrAfter = (time: string, start: string | undefined): boolean =>
  start === undefined || Date.parse(time) >= Date.parse(start);

/**
 * Returns a test for `fetchNewestItems`: older items are needed while the
 * oldest item read that has `field` as a string is at or after `start`, and
 * always when `start` is absent. An item without that field, such as a
 * pending review without `submitted_at`, says nothing either way.
 */
const isNewerThanStart =
  (field: string, start: string | undefined) =>
  (items: ReadonlyArray<Schema.JsonObject>): boolean => {
    const oldest = items.map((item) => item[field]).find((time) => typeof time === "string");
    return typeof oldest !== "string" || isAtOrAfter(oldest, start);
  };

/**
 * Where a review request goes among the events of its own second, by
 * event: -1 before the others, 1 after them. Events not in the map stay
 * in the middle.
 *
 * GitHub's timestamps count whole seconds, so a review and a request made
 * again right after it can share one. Their times cannot tell the order, but
 * the pull request's current requests can: a request it still holds came
 * last, and one it no longer holds was answered or taken back after. Kept
 * beside the events, rather than in them, because the order is not a fact
 * about the event the core should store.
 */
const TIE_RANKS = new WeakMap<EmittedEvent, number>();

/**
 * Runs `read` with a copy of `poll` whose `emit` holds events back, then
 * emits the held events through `poll.emit`, oldest `occurredAt` first.
 * Within one second, a review request the pull request still holds comes
 * after the other events, and one it no longer holds before them
 * (`TIE_RANKS`); the rest keep the order they were found in.
 * The held events are emitted whether `read` succeeds or fails, as they
 * would have been without holding them; a failed read is read again by the
 * next poll, and the dedup keys keep its events from being written twice.
 *
 * A poll reads an item's comments, reviews and history one listing after
 * another, but the core routes events in the order they are written: when a
 * review and a later request for another review arrive in one poll, the
 * request must come after the review, or the review would end the new
 * request's signal.
 */
export const emitInTimeOrder = <A, E, R>(
  poll: ActivityPoll,
  read: (held: ActivityPoll) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PluginError, R> => {
  const held: Array<EmittedEvent> = [];
  const emitHeld = Effect.suspend(() => {
    // Array.prototype.sort is stable, so events of one second and rank keep the order they were found in.
    const ordered = held
      .splice(0)
      .sort(
        (left, right) =>
          Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
          (TIE_RANKS.get(left) ?? 0) - (TIE_RANKS.get(right) ?? 0),
      );
    return Effect.forEach(ordered, poll.emit, { discard: true });
  });
  return read({ ...poll, emit: (event) => Effect.sync(() => void held.push(event)) }).pipe(
    Effect.tap(() => emitHeld),
    Effect.tapError(() => emitHeld),
  );
};

/**
 * Logs that a listing read newest first stopped at its page limit, so
 * activity older than what was read, but newer than the last poll, was not
 * emitted.
 */
const logTruncatedListing = (what: string, item: GithubItem): Effect.Effect<void> =>
  Effect.logWarning(
    `The GitHub plugin read only the newest ${what} of ${buildItemPlace(item)}: older ones since the last poll were not emitted.`,
  );

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
 * Fetches a pull request's reviews, newest first, and emits one
 * `github.pr.review-submitted` per review submitted at or after `start`, as
 * `emitReviewEvent` decides.
 */
export const emitNewReviews = (
  poll: ActivityPoll,
  item: GithubItem,
  start: string | undefined,
): Effect.Effect<void, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const listing = yield* fetchNewestItems(
      {
        method: "GET",
        path: `/repos/${poll.repo}/pulls/${String(item.number)}/reviews`,
        token: poll.token,
        query: { per_page: "100" },
      },
      MAX_REVIEW_PAGES,
      isNewerThanStart("submitted_at", start),
    );
    if (listing.truncated) yield* logTruncatedListing("reviews", item);
    for (const raw of listing.items) {
      const review = yield* decodeGithubValue(ListedReview, raw, "a review");
      yield* emitReviewEvent(poll, item, review, raw, start);
    }
  });

/**
 * Emits `github.pr.review-submitted` for one review submitted at or after
 * `start`. A pending review is not submitted yet, and a dismissed one is no
 * longer a verdict, so neither emits.
 */
const emitReviewEvent = (
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
 * Returns the reviews a pull request asks of the user and their teams now,
 * as the snapshot keeps them: `you`, and `team:<org>/<slug>` per team,
 * sorted.
 */
export const readReviewRequests = (poll: ActivityPoll, pull: ListedPull): Array<string> => {
  const owner = poll.repo.split("/")[0]!;
  const you = (pull.requested_reviewers ?? []).some((account) =>
    isUserAccount(poll.identity, account),
  );
  const teams = (pull.requested_teams ?? [])
    .map((team) => buildTeamName(owner, team.slug))
    .filter((team) => poll.teams.has(team))
    .map((team) => `team:${team}`);
  return [...(you ? ["you"] : []), ...teams].sort();
};

/**
 * Fetches a pull request's history, newest first, and emits `github.pr.review-requested`
 * and `github.pr.review-request-removed` for each request to the user or one
 * of their teams made or taken back at or after `start`. Each one's dedup
 * key is the history entry's id.
 *
 * Only the history says who asked and when. A pull request's list of
 * requested reviewers says only who is asked now, and GitHub also drops a
 * reviewer from it when they review, which is not a removal.
 *
 * `readRequestsNow` returns the reviews the pull request asks of the user
 * and their teams now, as `readReviewRequests` returns them. It runs at most
 * once, and only when the history holds a request or a removal to emit. Its
 * answer decides two things:
 *
 * - where a request goes among the events of its own second
 *   (`TIE_RANKS`);
 * - `teamStillRequested` on a team's removal: whether the pull request
 *   still asks another of the user's teams, so the team's signal stays open.
 */
export const emitReviewRequestEvents = (
  poll: ActivityPoll,
  item: GithubItem,
  start: string | undefined,
  readRequestsNow: Effect.Effect<ReadonlyArray<string>, FeedError, HttpClient.HttpClient>,
): Effect.Effect<void, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    let requestsNow: ReadonlyArray<string> | undefined;
    const listing = yield* fetchNewestItems(
      {
        method: "GET",
        path: `/repos/${poll.repo}/issues/${String(item.number)}/events`,
        token: poll.token,
        query: { per_page: "100" },
      },
      MAX_HISTORY_PAGES,
      isNewerThanStart("created_at", start),
    );
    if (listing.truncated) yield* logTruncatedListing("history entries", item);
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
      requestsNow ??= yield* readRequestsNow;
      const asker = entry.review_requester ?? entry.actor;
      const askerLogin = asker?.login ?? null;
      const whom = target.reviewer === "you" ? "you" : target.team;
      const team = target.reviewer === "team" ? { team: target.team } : {};
      const event = requested
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
              ...(target.reviewer === "team"
                ? {
                    teamStillRequested: requestsNow.some((request) => request.startsWith("team:")),
                  }
                : {}),
              byYou: isUserAccount(poll.identity, entry.actor),
            },
            raw: truncateRaw(raw),
          });
      if (requested) {
        const key = target.reviewer === "you" ? "you" : `team:${target.team}`;
        TIE_RANKS.set(event, requestsNow.includes(key) ? 1 : -1);
      }
      yield* poll.emit(event);
    }
  });
