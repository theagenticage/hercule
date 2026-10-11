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
 *    A 403, 404 or 410 means the item is gone for the token: the read ends,
 *    and the hint that named it is used up.
 * 2. Otherwise, everything at or after the item's `since` is emitted: its
 *    comments (`.../issues/{n}/comments?since=`), and for a pull request its
 *    reviews and the review requests in its history, as the watched
 *    repositories emit them (`activity.ts`), and a close or merge. Each
 *    listing is read newest first and stops at a page limit; a listing that
 *    has more since `since` than the limit allows logs a warning, because
 *    what it did not read is never emitted.
 * 3. `since` moves to the item's `updated_at`.
 *
 * Where `since` starts on an item's first read depends on why it is
 * followed: for a notification, at the notifications feed's cursor before
 * the news; for an open signal, when the signal was raised. An own pull
 * request seen for the first time is recorded at its `updated_at` and emits
 * nothing, as a newly watched repository baselines.
 * A notification's hint from before an item's stored `since` moves `since`
 * back to the hint and drops the ETag, so the news it names is read.
 *
 * One poll reads at most `MAX_FOLLOWED_ITEMS_PER_POLL` items, in turn, and
 * starts none once it has sent `MAX_FOLLOWED_REQUESTS_PER_POLL` requests. It
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
  emitNewReviews,
  emitReviewRequestEvents,
  emitInTimeOrder,
  fetchReviewRequests,
  isAtOrAfter,
  type ActivityPoll,
} from "./activity";
import { ListedComment, ListedIssue } from "./feed-objects";
import { fetchOwnOpenPullRequests } from "./own-pulls";
import {
  countRequests,
  decodeGithubValue,
  fetchFeedResponse,
  fetchNewestItems,
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
 * comments, and for a pull request its history and its reviews, each one
 * page when nothing much happened.
 */
export const MAX_FOLLOWED_ITEMS_PER_POLL = 20;

/**
 * How many requests the followed items may send in one poll before no
 * further item is started. The item being read when the count is reached
 * still finishes, at most 18 more requests: the item, 3 pages of comments, 3
 * of reviews, 10 of history and the pull request. With the search for the user's own pull
 * requests, a poll sends at most about 100 requests here, about 50 seconds.
 * Exported for the tests.
 */
export const MAX_FOLLOWED_REQUESTS_PER_POLL = 80;

/** The most requests one read of an item sends for its comments, 100 a page, read newest first. */
const MAX_COMMENT_PAGES = 3;

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
 * The statuses that say a followed item is gone for the token: deleted, moved
 * out of reach, or in a repository the token may no longer read. A rate
 * limit's 403 is told apart before these are looked at.
 */
const GONE_STATUSES = [403, 404, 410];

/**
 * Reads one followed item and emits what happened on it at or after
 * `stored.since`, as the header comment describes. Returns the item's new
 * state, or `Option.none()` when GitHub answers that the item is gone
 * (`GONE_STATUSES`), which is logged. Fails as `fetchFeedResponse` fails,
 * and with a `PluginError` when GitHub returns an object without the fields
 * read.
 */
const readFollowedItem = (
  poll: ActivityPoll,
  number: number,
  stored: FollowedItemState,
): Effect.Effect<Option.Option<FollowedItemState>, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const path = `/repos/${poll.repo}/issues/${String(number)}`;
    const response = yield* fetchFeedResponse(
      {
        method: "GET",
        path,
        token: poll.token,
        ...(stored.etag === undefined ? {} : { etag: stored.etag }),
      },
      GONE_STATUSES,
    );
    if (GONE_STATUSES.includes(response.status)) {
      yield* Effect.logWarning(
        `GitHub answered ${String(response.status)} for ${buildItemPlace({ repo: poll.repo, number })}, which the GitHub repos feed followed outside the watch list. The item is deleted or hidden from the Connection's account, so the feed stops reading it for the notification that named it.`,
      );
      return Option.none();
    }
    if (response.status === 304) return Option.some(stored);
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

    const comments = yield* fetchNewestItems(
      {
        method: "GET",
        path: `${path}/comments`,
        token: poll.token,
        query: { since, per_page: "100" },
      },
      MAX_COMMENT_PAGES,
      (items) => {
        const oldest = items[0]?.["created_at"];
        return typeof oldest !== "string" || isAtOrAfter(oldest, since);
      },
    );
    if (comments.truncated) {
      yield* Effect.logWarning(
        `The GitHub plugin read only the newest comments of ${buildItemPlace(item)}: older ones since the last poll were not emitted.`,
      );
    }
    for (const raw of comments.items) {
      const comment = yield* decodeGithubValue(ListedComment, raw, "a comment");
      if (isAtOrAfter(comment.created_at, since)) {
        yield* emitCommentEvents(poll, item, comment, raw);
      }
    }

    if (item.kind === "pr") {
      yield* emitNewReviews(poll, item, since);
      yield* emitReviewRequestEvents(poll, item, since, fetchReviewRequests(poll, number));
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

    return Option.some({
      since: issue.updated_at,
      ...(response.etag === undefined ? {} : { etag: response.etag }),
    });
  });

/**
 * Removes the hints a poll used up from the stored hints. `hintsAtStart` are
 * the hints the poll started with, and `used` the refs of those it used up.
 * A hint the notifications feed recorded or moved to an earlier time while
 * the poll ran is news the poll did not read, so it stays. Writes nothing
 * when no hint was used up.
 */
const removeUsedHints = (
  store: KeyValueStore,
  hintsAtStart: Readonly<Record<string, string>>,
  used: ReadonlySet<string>,
): Effect.Effect<void, PluginError> =>
  Effect.gen(function* () {
    if (used.size === 0) return;
    const stored = yield* readFeedState(store, HINTS_KEY, FollowedHints);
    if (Option.isNone(stored)) return;
    const remaining = Object.fromEntries(
      Object.entries(stored.value).filter(
        ([ref, since]) => !(used.has(ref) && hintsAtStart[ref] === since),
      ),
    );
    if (Object.keys(remaining).length === 0) yield* store.delete(HINTS_KEY);
    else yield* store.set(HINTS_KEY, remaining);
  });

/** Checks whether two states of a followed item are the same, so the stored one need not be written again. */
const isSameItemState = (left: FollowedItemState, right: FollowedItemState): boolean =>
  left.since === right.since && left.etag === right.etag;

/**
 * Reads the followed items in turn and emits what happened on them. One
 * poll reads at most `MAX_FOLLOWED_ITEMS_PER_POLL` items, and starts no
 * further item once it has sent `MAX_FOLLOWED_REQUESTS_PER_POLL` requests;
 * the next poll starts with the item after the last one read. The events of
 * one item are emitted oldest first (`emitInTimeOrder`). The state of an
 * item no longer followed is deleted.
 *
 * A hint from the notifications feed is used up when its item is read, when
 * GitHub answers that the item is gone, or when the item is not followed
 * after all because its repository is watched. It stays for the next poll
 * when the item was not reached. An item whose read fails, for any reason,
 * gets a hint at the `since` it was read from: the failed read emitted
 * nothing (`emitInTimeOrder`), so the next poll reads it again, followed or
 * not.
 *
 * One item failing with a `PluginError` is logged as a warning and does not
 * stop the others: an item outside the watch list is not something the user
 * set up, so it must not set the Connection to `error`. Fails with an
 * `AuthError` when GitHub rejects the token, and with `GithubRateLimited` on
 * a rate limit. The items read before it keep their new state, and the turn
 * and the used-up hints are saved all the same.
 */
export const pollFollowedItems = (
  token: string,
  context: Pick<IngestContext, "emit" | "state" | "openSignals">,
  watchList: ReadonlyArray<string>,
  identity: GithubIdentity,
  teams: ReadonlySet<string>,
): Effect.Effect<void, FeedError, HttpClient.HttpClient> =>
  countRequests((sent) =>
    Effect.gen(function* () {
      const store = context.state;
      const followed = new Map<string, FollowedItem>();
      for (const own of yield* fetchOwnOpenPullRequests(token)) {
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
      const hints: Readonly<Record<string, string>> = Option.getOrElse(
        yield* readFeedState(store, HINTS_KEY, FollowedHints),
        () => ({}),
      );
      const watched = new Set(watchList);
      // The refs of the hints used up. A hint is used up only by what this
      // poll did with it, so a poll stopped by a rate limit keeps the rest.
      const usedHints = new Set<string>();
      for (const [ref, since] of Object.entries(hints)) {
        const item = parseItemRef(ref);
        // A hint the plugin cannot parse, or one in a repository the watch list's poll covers, is not read here.
        if (item === undefined || watched.has(item.repo)) usedHints.add(ref);
        else addFollowedItem(followed, { item, start: since, baseline: false });
      }
      for (const [ref, { item }] of followed) {
        if (watched.has(item.repo)) followed.delete(ref);
      }

      const keys = yield* store.list();
      for (const key of keys) {
        if (key.startsWith(ITEM_PREFIX) && !followed.has(key.slice(ITEM_PREFIX.length))) {
          yield* store.delete(key);
        }
      }

      let lastRead: string | undefined;
      // Saved after the loop even when a rate limit stops it, so the turn
      // moves on and the hints used so far are not read again. The hints
      // key decoded when the poll started, so reading it again here fails
      // only by a defect.
      const saveProgress = Effect.gen(function* () {
        if (lastRead !== undefined) yield* store.set(LAST_READ_KEY, lastRead);
        yield* removeUsedHints(store, hints, usedHints);
      });

      const order = orderFromLastPolled(
        [...followed.keys()],
        Option.getOrUndefined(yield* readFeedState(store, LAST_READ_KEY, Schema.String)),
      );
      let read = 0;
      let waiting = 0;
      yield* Effect.gen(function* () {
        for (const ref of order) {
          const { item, start, baseline } = followed.get(ref)!;
          const key = `${ITEM_PREFIX}${ref}`;
          const stored = yield* readFeedState(store, key, FollowedItemState);
          if (Option.isNone(stored) && baseline) {
            yield* store.set(key, { since: start });
            continue;
          }
          const spent = read > 0 && sent() >= MAX_FOLLOWED_REQUESTS_PER_POLL;
          if (read === MAX_FOLLOWED_ITEMS_PER_POLL || spent) {
            waiting += 1;
            continue;
          }
          read += 1;
          const state = Option.match(stored, {
            onNone: () => ({ since: start }),
            // A hint from before the stored `since` is news the item's
            // last read did not cover, such as a mention on an own pull
            // request that was recorded after it. The read goes back to the
            // hint, without the ETag, whose 304 would hide that news. An
            // open signal's start does not do this: it is earlier than
            // `since` after every first read.
            onSome: (known) => {
              const hint = hints[ref];
              return hint !== undefined && Date.parse(hint) < Date.parse(known.since)
                ? { since: hint }
                : known;
            },
          });
          const poll: ActivityPoll = {
            repo: item.repo,
            token,
            emit: context.emit,
            identity,
            teams,
          };
          const next = yield* emitInTimeOrder(poll, (held) =>
            readFollowedItem(held, item.number, state),
          ).pipe(
            // A failed read emits nothing, so the next poll must read the
            // item again from the same `since`. A hint makes sure of that
            // even for an item followed for another reason, such as an own
            // pull request that is closed before the next poll and so drops
            // out of the search.
            Effect.tapError(() => recordFollowedHints(store, [{ ref, since: state.since }])),
            Effect.catchIf(
              (error): error is PluginError => error instanceof PluginError,
              (error) =>
                Effect.as(
                  Effect.logWarning(
                    `The GitHub repos feed could not read ${buildItemPlace(item)}, which it follows outside the watch list, and tries again at the next poll: ${error.message}`,
                  ),
                  undefined,
                ),
            ),
          );
          lastRead = ref;
          if (next === undefined) continue;
          usedHints.add(ref);
          const unchanged =
            Option.isNone(next) ||
            (Option.isSome(stored) && isSameItemState(stored.value, next.value));
          if (!unchanged) yield* store.set(key, next.value);
        }
      }).pipe(Effect.ensuring(Effect.orDie(saveProgress)));

      if (waiting > 0) {
        yield* Effect.logWarning(
          `The GitHub repos feed follows ${String(followed.size)} issues and pull requests outside the watch list and reads at most ${String(MAX_FOLLOWED_ITEMS_PER_POLL)}, or ${String(MAX_FOLLOWED_REQUESTS_PER_POLL)} requests' worth, per poll, so ${String(waiting)} wait for the next poll. Their events arrive late, not never.`,
        );
      }
    }),
  );
