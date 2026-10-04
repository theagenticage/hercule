/**
 * The `checks` feed: one `github.pr.checks-completed` each time every check
 * suite on a pull request's head commit has finished with a verdict the
 * feed has not reported yet. A commit's first verdict emits, and so does a
 * different one after a check is run again, such as a failure that turns
 * into a success.
 *
 * Per repository and poll, the requests are:
 *
 * 1. `GET /repos/{o}/{r}/pulls?state=open&sort=updated&direction=desc`, with
 *    the last ETag, up to ten pages of 100. A 304 reuses the pull requests
 *    from the last poll. A repository with more open pull requests than that
 *    has only the most recently updated thousand followed.
 * 2. For each open pull request updated in the last `checksWindowDays`:
 *    `GET /repos/{o}/{r}/commits/{sha}/check-suites`, with that commit's last
 *    ETag. A commit whose checks finished is still asked, because a check
 *    can be run again.
 *
 * So a quiet repository costs one free 304 plus one free 304 per pull
 * request in the window.
 */
import { Clock, Effect, Option, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { IngestContext, PollResult } from "@hercule/plugin-host";
import { buildItemEvent, type GithubItem } from "../subject";
import { computeDigest } from "./digest";
import { GithubCheckSuites, ListedPull, type GithubCheckSuite } from "./feed-objects";
import {
  decodeGithubValue,
  fetchFeedResponse,
  fetchListing,
  readGithubObject,
  truncateRaw,
  type FeedError,
} from "./requests";
import { pollWatchedRepos, type RepoPoll } from "./state";

/** What the feed keeps of one open pull request, to reuse when the listing answers 304. */
const PullRequestSnapshot = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  author: Schema.optionalKey(Schema.String),
  headSha: Schema.String,
  updatedAt: Schema.String,
});

type PullRequestSnapshot = Schema.Schema.Type<typeof PullRequestSnapshot>;

/** What the feed keeps of one head commit. */
const HeadState = Schema.Struct({
  /** The ETag of the last check-suites answer, sent back as `If-None-Match`. */
  etag: Schema.optionalKey(Schema.String),
  /**
   * The digest of the last verdict seen, as `computeVerdictDigest` returns
   * it. Absent until every counted suite has finished once.
   */
  verdict: Schema.optionalKey(Schema.String),
});

type HeadState = Schema.Schema.Type<typeof HeadState>;

/** What the feed keeps between polls for one repository. */
const ChecksState = Schema.Struct({
  /**
   * When this repository was first polled, as ISO 8601, by this machine's
   * clock. Checks that finished before then emit nothing, so a newly watched
   * repository does not report every finished commit it already had.
   */
  watchedSince: Schema.String,
  /** The ETag of the last pull request listing, sent back as `If-None-Match`. */
  etag: Schema.optionalKey(Schema.String),
  /** The open pull requests of the last listing that were updated within the window. */
  pullRequests: Schema.Array(PullRequestSnapshot),
  /** The head commits of those pull requests, keyed by SHA. */
  heads: Schema.Record(Schema.String, HeadState),
});

type ChecksState = Schema.Schema.Type<typeof ChecksState>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The most pages of open pull requests one poll reads, 100 each. */
const MAX_PULL_PAGES = 10;

/** The conclusions that do not make a commit's checks fail. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Returns the one conclusion of a commit's finished check suites:
 *
 * - `failure` when any suite concluded anything other than `success`,
 *   `neutral` or `skipped`, such as `failure`, `timed_out`, `cancelled`,
 *   `action_required` or `stale`;
 * - `success` when at least one suite succeeded and the rest were neutral or
 *   skipped;
 * - `neutral` when every suite was neutral or skipped.
 *
 * A workflow reads it as a green or red verdict, so anything that needs a
 * person's attention counts as red.
 */
export const rollUpConclusion = (suites: ReadonlyArray<GithubCheckSuite>): string => {
  const conclusions = suites.map((suite) => suite.conclusion ?? "unknown");
  if (conclusions.some((conclusion) => !PASSING_CONCLUSIONS.has(conclusion))) return "failure";
  return conclusions.includes("success") ? "success" : "neutral";
};

/**
 * Returns the suites that count toward a commit's verdict. A suite with no
 * check runs is one GitHub created for an app that has nothing to run on
 * this commit, such as an app installed on the repository that only checks
 * some branches. It stays queued forever, so counting it would hold the
 * verdict back forever.
 */
const listCountedSuites = (
  suites: ReadonlyArray<GithubCheckSuite>,
): ReadonlyArray<GithubCheckSuite> => suites.filter((suite) => suite.latest_check_runs_count > 0);

/**
 * Returns a short digest of which suites finished with which conclusion.
 * Running a check again keeps its suite, so the digest changes when a
 * conclusion changes or a suite is added, and stays the same otherwise.
 */
const computeVerdictDigest = (suites: ReadonlyArray<GithubCheckSuite>): string =>
  computeDigest(
    suites.map((suite) => `${String(suite.id)}:${suite.conclusion ?? "unknown"}`).sort(),
  );

/** Returns the latest of the suites' `updated_at`, or undefined when none has one. */
const findLatestUpdate = (suites: ReadonlyArray<GithubCheckSuite>): string | undefined =>
  suites
    .map((suite) => suite.updated_at)
    .filter((time): time is string => time !== null)
    .reduce<string | undefined>(
      (latest, time) =>
        latest === undefined || Date.parse(time) > Date.parse(latest) ? time : latest,
      undefined,
    );

/**
 * Fetches the repository's open pull requests updated at or after `oldest`,
 * in milliseconds since the epoch, or returns the stored ones with their
 * ETag when GitHub answers 304.
 */
const fetchOpenPullRequests = (
  poll: RepoPoll,
  stored: ChecksState,
  oldest: number,
): Effect.Effect<
  { readonly etag?: string; readonly pullRequests: ReadonlyArray<PullRequestSnapshot> },
  FeedError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const listing = yield* fetchListing(
      {
        method: "GET",
        path: `/repos/${poll.repo}/pulls`,
        token: poll.token,
        query: { state: "open", sort: "updated", direction: "desc", per_page: "100" },
        ...(stored.etag === undefined ? {} : { etag: stored.etag }),
      },
      MAX_PULL_PAGES,
    );
    if (listing.unchanged) return stored;
    const pulls = yield* decodeGithubValue(
      Schema.Array(ListedPull),
      listing.items,
      "open pull requests",
    );
    return {
      ...(listing.firstPage.etag === undefined ? {} : { etag: listing.firstPage.etag }),
      pullRequests: pulls
        .filter((pull) => Date.parse(pull.updated_at) >= oldest)
        .map((pull) => ({
          number: pull.number,
          title: pull.title,
          ...(pull.user === null ? {} : { author: pull.user.login }),
          headSha: pull.head.sha,
          updatedAt: pull.updated_at,
        })),
    };
  });

/**
 * Fetches the check suites of one pull request's head commit, and emits
 * `github.pr.checks-completed` when every counted suite has finished, with
 * a verdict other than the one in `head`, since the repository was first
 * polled. Returns the commit's new state. While a check runs again, the
 * state keeps the last verdict, so a re-run that ends the same way emits
 * nothing.
 */
const checkHead = (
  poll: RepoPoll,
  pullRequest: PullRequestSnapshot,
  head: HeadState | undefined,
  watchedSince: string,
): Effect.Effect<HeadState, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* fetchFeedResponse({
      method: "GET",
      path: `/repos/${poll.repo}/commits/${pullRequest.headSha}/check-suites`,
      token: poll.token,
      query: { per_page: "100" },
      ...(head?.etag === undefined ? {} : { etag: head.etag }),
    });
    if (response.status === 304 && head !== undefined) return head;
    const etag = response.etag === undefined ? {} : { etag: response.etag };
    const lastVerdict = head?.verdict === undefined ? {} : { verdict: head.verdict };
    const body = yield* readGithubObject(response.body, "check suites");
    const { check_suites } = yield* decodeGithubValue(GithubCheckSuites, body, "check suites");
    const suites = listCountedSuites(check_suites);
    if (suites.length === 0 || suites.some((suite) => suite.status !== "completed")) {
      return { ...etag, ...lastVerdict };
    }
    const verdict = computeVerdictDigest(suites);
    if (verdict === head?.verdict) return { ...etag, verdict };
    const completedAt = findLatestUpdate(suites);
    if (completedAt !== undefined && Date.parse(completedAt) >= Date.parse(watchedSince)) {
      const item: GithubItem = {
        repo: poll.repo,
        kind: "pr",
        number: pullRequest.number,
        title: pullRequest.title,
        ...(pullRequest.author === undefined ? {} : { author: pullRequest.author }),
        state: "open",
      };
      yield* poll.emit(
        buildItemEvent(item, {
          kind: "github.pr.checks-completed",
          // Twelve characters of a commit SHA name it within one pull request,
          // and keep the key under the host's 200 characters.
          dedupKey: `pr.checks-completed:${poll.repo}#${String(pullRequest.number)}:${pullRequest.headSha.slice(0, 12)}:${verdict}`,
          occurredAt: completedAt,
          fields: {
            conclusion: rollUpConclusion(suites),
            suites: suites.map((suite) => ({
              name: suite.app?.name ?? "unknown",
              conclusion: suite.conclusion ?? "unknown",
            })),
          },
          raw: truncateRaw(body),
        }),
      );
    }
    return { ...etag, verdict };
  });

/**
 * Polls one watched repository: checks the head commit of every open pull
 * request updated within the window, and returns the new state. Commits no
 * longer at the head of such a pull request are dropped from the state.
 */
const pollRepo = (
  poll: RepoPoll,
  stored: ChecksState,
  windowDays: number,
): Effect.Effect<ChecksState, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const oldest = (yield* Clock.currentTimeMillis) - windowDays * DAY_MS;
    const listing = yield* fetchOpenPullRequests(poll, stored, oldest);
    // A 304 returns the stored pull requests, some of which may have left the window since.
    const recent = listing.pullRequests.filter(
      (pullRequest) => Date.parse(pullRequest.updatedAt) >= oldest,
    );
    const heads: Record<string, HeadState> = {};
    for (const pullRequest of recent) {
      heads[pullRequest.headSha] = yield* checkHead(
        poll,
        pullRequest,
        stored.heads[pullRequest.headSha],
        stored.watchedSince,
      );
    }
    return {
      watchedSince: stored.watchedSince,
      ...(listing.etag === undefined ? {} : { etag: listing.etag }),
      pullRequests: recent,
      heads,
    };
  });

/**
 * Records when a newly watched repository was first polled. Sends no request
 * and emits nothing: the next poll fetches its pull requests, and only
 * checks that finish from now on emit. The time is this machine's: GitHub's
 * own clock is not available to the feeds here.
 */
const baselineRepo: Effect.Effect<ChecksState> = Effect.map(Clock.currentTimeMillis, (now) => ({
  watchedSince: new Date(now).toISOString(),
  pullRequests: [],
  heads: {},
}));

/**
 * Polls the checks feed once: every repository on the watch list, in turn.
 * A repository with no state yet baselines and emits nothing. Fails as
 * `pollWatchedRepos` fails.
 */
export const pollChecks = (
  token: string,
  context: Pick<IngestContext, "emit" | "state">,
  watchList: ReadonlyArray<string>,
  windowDays: number,
): Effect.Effect<PollResult, FeedError, HttpClient.HttpClient> =>
  Effect.as(
    pollWatchedRepos("checks", context.state, watchList, ChecksState, (repo, stored) =>
      Option.isNone(stored)
        ? baselineRepo
        : pollRepo({ repo, token, emit: context.emit }, stored.value, windowDays),
    ),
    {},
  );
