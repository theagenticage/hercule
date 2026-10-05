/**
 * The `notifications` feed: what GitHub notifies the user about, such as
 * mentions, assignments, review requests and state changes on threads the
 * user follows. Each changed thread becomes one `github.notification` event,
 * whose `reason` is GitHub's word for why it notified.
 *
 * Each poll is one conditional request, `GET /notifications` with
 * `If-Modified-Since`, so a poll with nothing new is a free 304. GitHub's
 * `X-Poll-Interval` is passed back as `nextAfterSeconds`, so the host never
 * polls sooner than GitHub allows.
 *
 * Every request asks with `all=true`. Without it GitHub lists only unread
 * threads, so a thread the user read on GitHub between two polls would
 * never be emitted.
 *
 * GitHub lists the threads updated strictly after `since`. The feed adds no
 * overlap to it: `If-Modified-Since` compares whole seconds as well, so a
 * thread updated in the same second as the last one seen would get a 304
 * anyway.
 */
import { Clock, Effect, Option, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { EmittedEvent, IngestContext, PollResult } from "@hercule/plugin-host";
import { buildItemEvent, buildRepoEvent } from "../subject";
import { GithubNotification } from "./feed-objects";
import {
  decodeGithubValue,
  fetchFeedResponse,
  fetchListing,
  truncateRaw,
  type FeedError,
} from "./requests";
import { readFeedState } from "./state";

/** The key of this feed's state. */
const STATE_KEY = "notifications";

/** What the feed keeps between polls. */
const NotificationsState = Schema.Struct({
  /** The `Last-Modified` of the last listing, sent back as `If-Modified-Since`. */
  lastModified: Schema.optionalKey(Schema.String),
  /** The newest update seen, as ISO 8601; the next listing asks only for threads updated since. */
  since: Schema.String,
});

/**
 * The most pages one poll fetches, 50 threads each. GitHub lists the newest
 * thread first and offers no other order, so when more than 1,000 threads
 * changed since the last poll, as after the controller was off for a long
 * time, the oldest of them are not emitted. A person's inbox does not change
 * that fast while the controller runs.
 */
const MAX_PAGES = 20;

/**
 * Returns the issue or pull request an API URL points at, such as
 * `https://api.github.com/repos/owner/repo/pulls/87`, or undefined for any
 * other URL.
 */
const parseSubjectUrl = (
  url: string,
): { readonly kind: "issue" | "pr"; readonly number: number } | undefined => {
  const match = /\/repos\/[^/]+\/[^/]+\/(issues|pulls)\/(\d+)$/.exec(url);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { kind: match[1] === "pulls" ? "pr" : "issue", number: Number(match[2]) };
};

/**
 * Builds the event for one notification thread. A thread about an issue or a
 * pull request gets that item's subject, refs and URL. Any other thread, such
 * as a release, a discussion or a check suite, gets its repository's: this
 * plugin has no ref for those.
 */
const buildNotificationEvent = (
  thread: GithubNotification,
  raw: Schema.JsonObject,
): EmittedEvent => {
  const repo = thread.repository.full_name;
  const facts = {
    kind: "github.notification",
    dedupKey: `notification:${thread.id}:${thread.updated_at}`,
    occurredAt: thread.updated_at,
    fields: { reason: thread.reason },
    raw: truncateRaw(raw),
  };
  const item = thread.subject.url === null ? undefined : parseSubjectUrl(thread.subject.url);
  if (item !== undefined) {
    return buildItemEvent({ repo, ...item, title: thread.subject.title }, facts);
  }
  return buildRepoEvent(repo, thread.subject.title, facts);
};

/** Converts an HTTP date, as `Last-Modified` carries it, to ISO 8601. Returns undefined when it does not parse. */
const convertHttpDate = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
};

/** Returns the later of two ISO 8601 timestamps. */
const pickLater = (left: string, right: string): string =>
  Date.parse(right) > Date.parse(left) ? right : left;

/**
 * Polls the notifications feed once and emits one event per thread updated
 * since the last poll, oldest first. Returns GitHub's `X-Poll-Interval` as
 * `nextAfterSeconds`.
 *
 * The first poll, with no state yet, emits nothing: it records where the
 * feed stands, so a new Connection never emits the user's backlog.
 *
 * Fails as `fetchFeedResponse` fails, and with a `PluginError` when GitHub returns
 * a thread without the fields this feed reads or the host refuses an event.
 */
export const pollNotifications = (
  token: string,
  context: Pick<IngestContext, "emit" | "state">,
): Effect.Effect<PollResult, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const stored = yield* readFeedState(context.state, STATE_KEY, NotificationsState);

    if (Option.isNone(stored)) {
      // One thread is enough: only the response's `Last-Modified` is kept. It
      // is the newest thread's update time, so the next poll lists only
      // threads updated after the baseline.
      const response = yield* fetchFeedResponse({
        method: "GET",
        path: "/notifications",
        token,
        query: { all: "true", per_page: "1" },
      });
      const lastModified = response.lastModified;
      const since =
        convertHttpDate(lastModified) ?? new Date(yield* Clock.currentTimeMillis).toISOString();
      yield* context.state.set(STATE_KEY, {
        ...(lastModified === undefined ? {} : { lastModified }),
        since,
      });
      return buildPollResult(response.pollIntervalSeconds);
    }

    const listing = yield* fetchListing(
      {
        method: "GET",
        path: "/notifications",
        token,
        query: { all: "true", since: stored.value.since, per_page: "50" },
        ...(stored.value.lastModified === undefined
          ? {}
          : { lastModified: stored.value.lastModified }),
      },
      MAX_PAGES,
    );
    if (listing.unchanged) return buildPollResult(listing.firstPage.pollIntervalSeconds);

    const threads = yield* Effect.forEach(listing.items, (raw) =>
      Effect.map(decodeGithubValue(GithubNotification, raw, "a notification"), (thread) => ({
        thread,
        raw,
      })),
    );
    // GitHub lists the newest first; events are emitted in the order they happened.
    const oldestFirst = [...threads].sort(
      (left, right) => Date.parse(left.thread.updated_at) - Date.parse(right.thread.updated_at),
    );
    for (const { thread, raw } of oldestFirst) {
      yield* context.emit(buildNotificationEvent(thread, raw));
    }

    const lastModified = listing.firstPage.lastModified ?? stored.value.lastModified;
    const since = oldestFirst.reduce(
      (latest, { thread }) => pickLater(latest, thread.updated_at),
      stored.value.since,
    );
    yield* context.state.set(STATE_KEY, {
      ...(lastModified === undefined ? {} : { lastModified }),
      since,
    });
    return buildPollResult(listing.firstPage.pollIntervalSeconds);
  });

/** Builds the poll's result from GitHub's `X-Poll-Interval`, when it sent one. */
const buildPollResult = (pollIntervalSeconds: number | undefined): PollResult =>
  pollIntervalSeconds === undefined ? {} : { nextAfterSeconds: pollIntervalSeconds };
