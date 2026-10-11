/**
 * The followed items: issues and pull requests outside the watch list that
 * the `repos` feed reads one by one, so what happens on them still emits.
 * An item is followed while it is one of these:
 *
 * - one of the user's own open pull requests, in any repository, so changes
 *   requested on it reach the user;
 * - the thread of an open signal from this Connection, so the event that
 *   ends the signal is seen, such as the user's review or a merge;
 * - an item the `notifications` feed saw news on since the last poll, such
 *   as a review request or a mention in a repository nobody watches.
 *
 * An item in a watched repository is not followed: the watch list's own
 * poll covers it, and one fact is found by one poll.
 *
 * Each item is read in three steps:
 *
 * 1. `GET /repos/{o}/{r}/issues/{n}` with the last ETag. A 304 means nothing
 *    changed, costs no quota, and ends the read.
 * 2. Otherwise, everything at or after the item's `since` is emitted: its
 *    comments (`.../issues/{n}/comments?since=`), and for a pull request its
 *    reviews and the review requests in its history, as the watched
 *    repositories emit them (`activity.ts`), and a close or merge.
 * 3. `since` moves to the item's `updated_at`.
 *
 * Where `since` starts on an item's first read depends on why it is
 * followed: for a notification, at the notifications feed's cursor before
 * the news; for an open signal, when the signal was raised. An own pull
 * request seen for the first time is recorded at its `updated_at` and emits
 * nothing, as a newly watched repository baselines.
 *
 * One poll reads at most `MAX_FOLLOWED_ITEMS_PER_POLL` items, in turn, and
 * logs a warning naming how many it left for the next poll.
 */
import { Effect, Option, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { PluginError, type IngestContext, type KeyValueStore } from "@hercule/plugin-host";
import type { GithubIdentity } from "../identity";
import {
  buildItemEvent,
  buildItemPlace,
  buildItemRef,
  parseItemRef,
  type GithubItem,
} from "../subject";
import {
  emitCommentEvents,
  emitReviewEvent,
  emitReviewRequestEvents,
  isAtOrAfter,
  type ActivityPoll,
} from "./activity";
import { ListedComment, ListedIssue, ListedReview } from "./feed-objects";
import { fetchOwnOpenPullRequests } from "./own-pulls";
import {
  decodeGithubValue,
  fetchFeedResponse,
  fetchListing,
  readGithubObject,
  truncateRaw,
  type FeedError,
} from "./requests";
import { orderFromLastPolled, readFeedState } from "./state";

/** The prefix of each followed item's state key, such as `followed/github:pr:acme/webshop#1293`. */
const ITEM_PREFIX = "followed/";

/** The key of the items the notifications feed saw news on, which the next poll reads. */
const HINTS_KEY = "followed-hints";

/** The key of the last item read, where the next poll's turn starts after. */
const LAST_READ_KEY = "followed-last-read";

/**
 * How many followed items one poll reads. An item that did not change costs
 * one free 304. A changed one costs about four requests: the item, its
 * comments, and for a pull request its reviews and its history, each one
 * page. So a poll sends about 80 requests here, and two more for the search
 * of the user's own pull requests and the teams, about 40 seconds.
 */
export const MAX_FOLLOWED_ITEMS_PER_POLL = 20;

/** The most pages of comments or reviews one read fetches for one item, 100 each. */
const MAX_DETAIL_PAGES = 3;

/** What is kept between polls for one followed item. */
const FollowedItemState = Schema.Struct({
  /** Activity at or after this ISO 8601 time is new. */
  since: Schema.String,
  /** The ETag of the last read of the item, sent back as `If-None-Match`. */
  etag: Schema.optionalKey(Schema.String),
});

type FollowedItemState = Schema.Schema.Type<typeof FollowedItemState>;

/** The items the notifications feed saw news on: each item's ref, and the time its news is new from. */
const FollowedHints = Schema.Record(Schema.String, Schema.String);

/** Returns the earlier of two ISO 8601 timestamps. */
const pickEarlier = (left: string, right: string): string =>
  Date.parse(right) < Date.parse(left) ? right : left;

/**
 * Records that the notifications feed saw news on an issue or a pull
 * request, new from `since`, so the next `repos` poll reads it. An item that
 * already has a hint keeps the earlier time.
 */
export const recordFollowedHints = (
  store: KeyValueStore,
  hints: ReadonlyArray<{ readonly ref: string; readonly since: string }>,
): Effect.Effect<void, PluginError> =>
  Effect.gen(function* () {
    if (hints.length === 0) return;
    const stored = Option.getOrElse(
      yield* readFeedState(store, HINTS_KEY, FollowedHints),
      () => ({}),
    );
    const next: Record<string, string> = { ...stored };
    for (const { ref, since } of hints) {
      const known = next[ref];
      next[ref] = known === undefined ? since : pickEarlier(known, since);
    }
    yield* store.set(HINTS_KEY, next);
  });

/** Why one item is followed: where its `since` starts on its first read. */
interface FollowedItem {
  readonly item: Pick<GithubItem, "repo" | "kind" | "number">;
  /** The time activity is new from, when the item is read for the first time. */
  readonly start: string;
  /** True when the first read records the item and emits nothing, as for an own pull request. */
  readonly baseline: boolean;
}

/**
 * Adds one item to the followed set. When it is already there for another
 * reason, a reason with a start wins over a baseline, and of two starts the
 * earlier wins, so nothing either reason would emit is skipped.
 */
const addFollowedItem = (followed: Map<string, FollowedItem>, next: FollowedItem): void => {
  const ref = buildItemRef(next.item);
  const known = followed.get(ref);
  if (known === undefined || (known.baseline && !next.baseline)) {
    followed.set(ref, next);
  } else if (!known.baseline && !next.baseline) {
    followed.set(ref, { ...known, start: pickEarlier(known.start, next.start) });
  }
};

/** Returns one second after an ISO 8601 time: what GitHub, counting whole seconds, has strictly after it. */
const addOneSecond = (time: string): string => new Date(Date.parse(time) + 1000).toISOString();

/**
 * Reads one followed item and emits what happened on it at or after
 * `stored.since`, as the header comment describes. Returns the item's new
 * state. Fails as `fetchFeedResponse` fails, and with a `PluginError` when
 * GitHub returns an object without the fields read.
 */
const readFollowedItem = (
  poll: ActivityPoll,
  number: number,
  stored: FollowedItemState,
): Effect.Effect<FollowedItemState, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const path = `/repos/${poll.repo}/issues/${String(number)}`;
    const response = yield* fetchFeedResponse({
      method: "GET",
      path,
      token: poll.token,
      ...(stored.etag === undefined ? {} : { etag: stored.etag }),
    });
    if (response.status === 304) return stored;
    const body = yield* readGithubObject(response.body, "an issue");
    const issue = yield* decodeGithubValue(ListedIssue, body, "an issue");
    const item: GithubItem = {
      repo: poll.repo,
      kind: issue.pull_request === undefined ? "issue" : "pr",
      number,
      title: issue.title,
      ...(issue.user === null ? {} : { author: issue.user.login }),
      state: issue.state,
    };
    const since = stored.since;

    const comments = yield* fetchListing(
      {
        method: "GET",
        path: `${path}/comments`,
        token: poll.token,
        query: { since, per_page: "100" },
      },
      MAX_DETAIL_PAGES,
    );
    for (const raw of comments.items) {
      const comment = yield* decodeGithubValue(ListedComment, raw, "a comment");
      if (isAtOrAfter(comment.created_at, since)) {
        yield* emitCommentEvents(poll, item, comment, raw);
      }
    }

    if (item.kind === "pr") {
      yield* emitReviewRequestEvents(poll, item, since);
      const reviews = yield* fetchListing(
        {
          method: "GET",
          path: `/repos/${poll.repo}/pulls/${String(number)}/reviews`,
          token: poll.token,
          query: { per_page: "100" },
        },
        MAX_DETAIL_PAGES,
      );
      for (const raw of reviews.items) {
        const review = yield* decodeGithubValue(ListedReview, raw, "a review");
        yield* emitReviewEvent(poll, item, review, raw, since);
      }
    }

    if (
      issue.state === "closed" &&
      issue.closed_at !== null &&
      isAtOrAfter(issue.closed_at, since)
    ) {
      // The same keys as the watched repositories' diff, so a fact both
      // find is written once.
      const place = buildItemPlace(item);
      const closer = issue.closed_by?.login ?? null;
      const mergedAt = issue.pull_request?.merged_at ?? null;
      yield* poll.emit(
        buildItemEvent(
          item,
          mergedAt === null
            ? {
                kind: `github.${item.kind}.closed`,
                dedupKey: `${item.kind}.closed:${place}:${issue.closed_at}`,
                occurredAt: issue.closed_at,
                title:
                  closer === null
                    ? `${item.kind === "pr" ? "Pull request" : "Issue"} ${place} was closed`
                    : `${closer} closed ${place}`,
                author: closer,
                raw: truncateRaw(body),
              }
            : {
                kind: "github.pr.merged",
                dedupKey: `pr.merged:${place}`,
                occurredAt: mergedAt,
                title:
                  closer === null
                    ? `Pull request ${place} was merged`
                    : `${closer} merged ${place}`,
                author: closer,
                raw: truncateRaw(body),
              },
        ),
      );
    }

    return {
      since: issue.updated_at,
      ...(response.etag === undefined ? {} : { etag: response.etag }),
    };
  });

/**
 * Reads the followed items, at most `MAX_FOLLOWED_ITEMS_PER_POLL` of them, in
 * turn, and emits what happened on them. The state of an item no longer
 * followed is deleted, and so are the hints of the items read.
 *
 * One item failing with a `PluginError`, such as one deleted since or hidden
 * from the token, is logged as a warning and does not stop the others: an
 * item outside the watch list is not something the user set up, so it must
 * not set the Connection to `error`. Fails with an `AuthError` when GitHub
 * rejects the token, and with `GithubRateLimited` on a rate limit; the items
 * read before it keep their new state.
 */
export const pollFollowedItems = (
  token: string,
  context: Pick<IngestContext, "emit" | "state" | "openSignals">,
  watchList: ReadonlyArray<string>,
  identity: GithubIdentity,
  teams: ReadonlySet<string>,
): Effect.Effect<void, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const store = context.state;
    const followed = new Map<string, FollowedItem>();
    for (const own of yield* fetchOwnOpenPullRequests(token, identity.login)) {
      addFollowedItem(followed, {
        item: { repo: own.repo, kind: "pr", number: own.number },
        start: addOneSecond(own.updatedAt),
        baseline: true,
      });
    }
    for (const signal of yield* context.openSignals()) {
      const item = parseItemRef(signal.threadRef);
      if (item !== undefined)
        addFollowedItem(followed, { item, start: signal.raisedAt, baseline: false });
    }
    const hints = Option.getOrElse(
      yield* readFeedState(store, HINTS_KEY, FollowedHints),
      () => ({}),
    );
    for (const [ref, since] of Object.entries(hints)) {
      const item = parseItemRef(ref);
      if (item !== undefined) addFollowedItem(followed, { item, start: since, baseline: false });
    }
    const watched = new Set(watchList);
    for (const [ref, { item }] of followed) {
      if (watched.has(item.repo)) followed.delete(ref);
    }

    const keys = yield* store.list();
    for (const key of keys) {
      if (key.startsWith(ITEM_PREFIX) && !followed.has(key.slice(ITEM_PREFIX.length))) {
        yield* store.delete(key);
      }
    }

    const lastRead = Option.getOrUndefined(
      yield* readFeedState(store, LAST_READ_KEY, Schema.String),
    );
    const leftForNextPoll: Array<string> = [];
    let read = 0;
    for (const ref of orderFromLastPolled([...followed.keys()], lastRead)) {
      const { item, start, baseline } = followed.get(ref)!;
      const key = `${ITEM_PREFIX}${ref}`;
      const stored = yield* readFeedState(store, key, FollowedItemState);
      if (Option.isNone(stored) && baseline) {
        yield* store.set(key, { since: start });
        continue;
      }
      if (read === MAX_FOLLOWED_ITEMS_PER_POLL) {
        leftForNextPoll.push(ref);
        continue;
      }
      read += 1;
      const poll: ActivityPoll = { repo: item.repo, token, emit: context.emit, identity, teams };
      const state = Option.getOrElse(stored, () => ({ since: start }));
      const next = yield* readFollowedItem(poll, item.number, state).pipe(
        Effect.catchIf(
          (error): error is PluginError => error instanceof PluginError,
          (error) =>
            Effect.as(
              Effect.logWarning(
                `The GitHub repos feed could not read ${buildItemPlace(item)}, which it follows outside the watch list: ${error.message}`,
              ),
              state,
            ),
        ),
      );
      yield* store.set(key, next);
      yield* store.set(LAST_READ_KEY, ref);
    }

    // A hint stays only for an item left for the next poll.
    const keptHints = Object.fromEntries(
      Object.entries(hints).filter(([ref]) => leftForNextPoll.includes(ref)),
    );
    if (Object.keys(keptHints).length > 0) yield* store.set(HINTS_KEY, keptHints);
    else yield* store.delete(HINTS_KEY);

    if (leftForNextPoll.length > 0) {
      yield* Effect.logWarning(
        `The GitHub repos feed follows ${String(followed.size)} issues and pull requests outside the watch list and reads at most ${String(MAX_FOLLOWED_ITEMS_PER_POLL)} per poll, so ${String(leftForNextPoll.length)} wait for the next poll. Their events arrive late, not never.`,
      );
    }
  });
