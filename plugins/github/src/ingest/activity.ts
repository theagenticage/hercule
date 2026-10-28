/**
 * The events about what people did on one issue or pull request: a comment,
 * a mention of the user in it, a review, a review request, and an assignment
 * or an unassignment. The `repos` feed emits them for the watched
 * repositories, and the followed items (`followed.ts`) for the items outside
 * them. Both build them here, so one fact has one dedup key whichever feed
 * finds it.
 */
import { Effect, Option, Schema } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import type { EmittedEvent, IngestContext, PluginError } from "@hercule/plugin-host";
import { readReviewVerdict, type ReviewVerdict } from "../github-objects";
import { findMention, isUserAccount, type GithubIdentity } from "../identity";
import { buildItemEvent, buildItemPlace, type GithubItem } from "../subject";
import { IssueEvent, ListedPull, ListedReview, type ListedComment } from "./feed-objects";
import {
  decodeGithubValue,
  fetchFeedResponse,
  fetchNewestItems,
  readGithubObject,
  truncateRaw,
  type FeedError,
} from "./requests";
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
 * The most requests `findLastReviewRequestTime` sends, 100 history entries a
 * page. They cover a whole history of up to 300 entries, and the newest 200
 * of a longer one: the first request reads the oldest page, which
 * `fetchNewestItems` uses only when it reaches it. The pull requests it is
 * asked about still ask the user for a review, so the request is most often
 * among the newest entries.
 */
const MAX_REVIEW_REQUEST_LOOKUP_PAGES = 3;

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
 * The kinds that close or merge an item. The feeds emit one only for an item
 * that is closed now, so it was the item's last change of state, and it goes
 * after every other event of its own second. Otherwise a review or an
 * assignment of that second would raise a signal on an item that is already
 * finished, and nothing would end it: the close is written only once.
 */
const CLOSING_KINDS = new Set(["github.issue.closed", "github.pr.closed", "github.pr.merged"]);

/** Returns where `event` goes among the events of its own second: lower comes first. */
const readTieRank = (event: EmittedEvent): number =>
  CLOSING_KINDS.has(event.kind) ? 2 : (TIE_RANKS.get(event) ?? 0);

/**
 * Runs `read` with a copy of `poll` whose `emit` holds events back, then
 * emits the held events through `poll.emit`, oldest `occurredAt` first.
 * Within one second, a review request the pull request still holds comes
 * after the other events, and one it no longer holds before them
 * (`TIE_RANKS`); a close or a merge comes last (`CLOSING_KINDS`); the rest
 * keep the order they were found in.
 *
 * When `read` fails, the held events are dropped. The caller keeps its
 * stored state when `read` fails, so the next poll reads the same events
 * again and emits them all, in order. Emitting part of them now would fix
 * the wrong order for good: a review emitted before the read of its
 * request failed would come before that request, and the next poll's copy
 * of the review is dropped as a duplicate.
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
          readTieRank(left) - readTieRank(right),
      );
    return Effect.forEach(ordered, poll.emit, { discard: true });
  });
  return read({ ...poll, emit: (event) => Effect.sync(() => void held.push(event)) }).pipe(
    Effect.tap(() => emitHeld),
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
 * `emitReviewEvent` decides. `onYourPullRequest` says whether the user wrote
 * the pull request.
 */
export const emitNewReviews = (
  poll: ActivityPoll,
  item: GithubItem,
  start: string | undefined,
  onYourPullRequest: boolean,
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
      yield* emitReviewEvent(poll, item, review, raw, start, onYourPullRequest);
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
  onYourPullRequest: boolean,
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
      fields: {
        reviewer,
        verdict,
        reviewId: review.id,
        byYou: isUserAccount(poll.identity, review.user),
        onYourPullRequest,
      },
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

/** Checks whether an entry of an item's history asks the user or one of their teams for a review. */
const isReviewRequestToUser = (poll: ActivityPoll, entry: IssueEvent): boolean =>
  entry.event === "review_requested" && readRequestedReviewer(poll, entry) !== undefined;

/**
 * Finds when a pull request last asked the user or one of their teams for a
 * review. Reads the pull request's history newest first, with at most
 * `MAX_REVIEW_REQUEST_LOOKUP_PAGES` requests, and stops at the first page
 * that holds such a request. Returns the `created_at` of the newest one, or
 * undefined when the pages read hold none.
 *
 * Deciding whether to read an older page skips an entry that does not
 * decode; the entries read are then decoded strictly, as `emitHistoryEvents`
 * decodes them, so one malformed entry fails the lookup.
 *
 * A request to a team is found only when the team is in `poll.teams`, which
 * stays empty when the token may not list the user's teams. Fails as
 * `fetchNewestItems` fails, and with a `PluginError` when an entry lacks the
 * fields read.
 */
export const findLastReviewRequestTime = (
  poll: ActivityPoll,
  number: number,
): Effect.Effect<string | undefined, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const decodeEntry = Schema.decodeUnknownOption(IssueEvent);
    const listing = yield* fetchNewestItems(
      {
        method: "GET",
        path: `/repos/${poll.repo}/issues/${String(number)}/events`,
        token: poll.token,
        query: { per_page: "100" },
      },
      MAX_REVIEW_REQUEST_LOOKUP_PAGES,
      (items) =>
        !items.some((raw) =>
          Option.exists(decodeEntry(raw), (entry) => isReviewRequestToUser(poll, entry)),
        ),
    );
    const entries = yield* decodeGithubValue(
      Schema.Array(IssueEvent),
      listing.items,
      "the entries of an item's history",
    );
    return entries.findLast((entry) => isReviewRequestToUser(poll, entry))?.created_at;
  });

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
 * Returns every review a pull request asks for now, of anyone: the login of
 * each requested account, and `team:<org>/<slug>` for each requested team,
 * sorted. The snapshot keeps it to notice a request to someone other than the
 * user or their teams.
 */
export const readAllReviewRequests = (poll: ActivityPoll, pull: ListedPull): Array<string> => {
  const owner = poll.repo.split("/")[0]!;
  const accounts = (pull.requested_reviewers ?? []).map((account) => account.login);
  const teams = (pull.requested_teams ?? []).map(
    (team) => `team:${buildTeamName(owner, team.slug)}`,
  );
  return [...accounts, ...teams].sort();
};

/**
 * Fetches a pull request as it is now. Fails as `fetchFeedResponse` fails,
 * and with a `PluginError` when GitHub returns an object without the fields
 * read.
 */
export const fetchPull = (
  poll: ActivityPoll,
  number: number,
): Effect.Effect<ListedPull, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* fetchFeedResponse({
      method: "GET",
      path: `/repos/${poll.repo}/pulls/${String(number)}`,
      token: poll.token,
    });
    const body = yield* readGithubObject(response.body, "a pull request");
    return yield* decodeGithubValue(ListedPull, body, "a pull request");
  });

/**
 * Emits `github.issue.assigned` or `github.issue.unassigned` for one history
 * entry, for whoever was assigned or unassigned, not only the user. Emits
 * nothing for an entry that names no assignee. The event's `author` is who
 * made the change.
 */
const emitAssignmentEvent = (
  poll: ActivityPoll,
  item: GithubItem,
  entry: IssueEvent,
  raw: Schema.JsonObject,
): Effect.Effect<void, FeedError> => {
  if (entry.assignee == null) return Effect.void;
  const assigned = entry.event === "assigned";
  const actor = entry.actor?.login ?? null;
  const assignee = entry.assignee.login;
  const place = buildItemPlace(item);
  const kind = assigned ? "github.issue.assigned" : "github.issue.unassigned";
  const dedupPrefix = assigned ? "issue.assigned" : "issue.unassigned";
  return poll.emit(
    buildItemEvent(item, {
      kind,
      dedupKey: `${dedupPrefix}:${String(entry.id)}`,
      occurredAt: entry.created_at,
      title: assigned
        ? `${actor ?? "Someone"} assigned ${assignee} to ${place}`
        : `${actor ?? "Someone"} unassigned ${assignee} from ${place}`,
      author: actor,
      fields: {
        assignee,
        toYou: isUserAccount(poll.identity, entry.assignee),
        byYou: isUserAccount(poll.identity, entry.actor),
      },
      raw: truncateRaw(raw),
    }),
  );
};

/**
 * Emits `github.pr.review-requested` with `reviewer: "other"` for one
 * history entry in which the user asked someone who is neither the user nor
 * one of their teams. A request that two other people made between
 * themselves is none of the user's business, so the caller does not pass it.
 *
 * `pullNow` is the pull request as it is now: whether it still asks the
 * reviewer decides where the request goes among the events of its own second
 * (`TIE_RANKS`), as for a request to the user.
 */
const emitReviewRequestToOther = (
  poll: ActivityPoll,
  item: GithubItem,
  entry: IssueEvent,
  raw: Schema.JsonObject,
  pullNow: ListedPull,
): Effect.Effect<void, FeedError> => {
  const team =
    entry.requested_team == null
      ? undefined
      : buildTeamName(poll.repo.split("/")[0]!, entry.requested_team.slug);
  const requested = entry.requested_reviewer?.login ?? team ?? "someone";
  // The same spelling `readAllReviewRequests` uses for each request.
  const key = entry.requested_reviewer?.login ?? (team === undefined ? undefined : `team:${team}`);
  const stillAsked = key !== undefined && readAllReviewRequests(poll, pullNow).includes(key);
  const event = buildItemEvent(item, {
    kind: "github.pr.review-requested",
    dedupKey: `pr.review-requested:${String(entry.id)}`,
    occurredAt: entry.created_at,
    title: `${poll.identity.login} requested a review from ${requested} on ${buildItemPlace(item)}`,
    author: poll.identity.login,
    fields: { reviewer: "other", requestedBy: poll.identity.login, byYou: true, toYou: false },
    raw: truncateRaw(raw),
  });
  TIE_RANKS.set(event, stillAsked ? 1 : -1);
  return poll.emit(event);
};

/**
 * Fetches an issue's or a pull request's history, newest first, and emits
 * what it holds at or after `start`. Each event's dedup key is the history
 * entry's id:
 *
 * - `github.issue.assigned` and `github.issue.unassigned` for each
 *   assignment, to anyone (`emitAssignmentEvent`);
 * - `github.pr.review-requested` and `github.pr.review-request-removed` for
 *   each request to the user or one of their teams made or taken back;
 * - `github.pr.review-requested` with `reviewer: "other"` for each request
 *   the user made to anyone else (`emitReviewRequestToOther`).
 *
 * Only the history says who asked, who assigned and when. A pull request's
 * list of requested reviewers says only who is asked now, and GitHub also
 * drops a reviewer from it when they review, which is not a removal.
 *
 * `readPullNow` returns the pull request as it is now. It runs at most once,
 * and only when the history holds a review request or a removal to emit. The
 * reviews the pull request asks now decide two things:
 *
 * - where a request goes among the events of its own second
 *   (`TIE_RANKS`);
 * - `teamStillRequested` on a team's removal: whether the pull request
 *   still asks another of the user's teams, so the team's signal stays open.
 *
 * So the answer must be read after the reviews and the history, which is why
 * callers emit the reviews first and pass a fresh read such as `fetchPull`.
 * A list read earlier can be stale: a review submitted after it clears a
 * request, and a removal made after it
 * still shows the removed team as asked. Either would keep a signal open
 * that should end, and the next poll cannot correct it, because the events
 * it emits again have the same dedup keys.
 */
export const emitHistoryEvents = (
  poll: ActivityPoll,
  item: GithubItem,
  start: string | undefined,
  readPullNow: Effect.Effect<ListedPull, FeedError, HttpClient.HttpClient>,
): Effect.Effect<void, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    let pullNow: ListedPull | undefined;
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
      const entry = yield* decodeGithubValue(IssueEvent, raw, "an entry of an item's history");
      if (!isAtOrAfter(entry.created_at, start)) continue;
      if (entry.event === "assigned" || entry.event === "unassigned") {
        yield* emitAssignmentEvent(poll, item, entry, raw);
        continue;
      }
      const requested = entry.event === "review_requested";
      if (!requested && entry.event !== "review_request_removed") continue;
      const asker = entry.review_requester ?? entry.actor;
      const target = readRequestedReviewer(poll, entry);
      if (target === undefined) {
        if (requested && isUserAccount(poll.identity, asker)) {
          pullNow ??= yield* readPullNow;
          yield* emitReviewRequestToOther(poll, item, entry, raw, pullNow);
        }
        continue;
      }
      pullNow ??= yield* readPullNow;
      const requestsNow = readReviewRequests(poll, pullNow);
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
