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
 *    `GET /repos/{o}/{r}/commits/{sha}/check-suites`, up to three pages of
 *    100. A commit whose checks finished is still asked, because a check can
 *    be run again. The commit's ETag is kept, and sent with the next request,
 *    only when its suites fit on one page: GitHub's ETag covers one page, so
 *    a 304 on the first page says nothing about a suite on the second.
 *
 * 3. When a commit's verdict is a failure that is about to be emitted:
 *    `GET /repos/{o}/{r}/commits/{sha}/check-runs?filter=latest&per_page=100`,
 *    one page, for the names of the check runs that failed. A passing
 *    verdict sends no such request.
 *
 * So a quiet repository costs one free 304 plus one free 304 per pull
 * request in the window, as long as no commit has more than 100 suites.
 *
 * After the watch list, the feed checks the user's own open pull requests in
 * the repositories outside it, so their failed checks reach the user too.
 * That costs one search, and per pull request in the window one
 * `GET /repos/{o}/{r}/pulls/{n}` with its ETag, for the head commit, and the
 * same check-suites request as above. Their state is kept under
 * `checks-own`, outside the per-repository keys.
 */
import { Clock, Effect, Option, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { PluginError, type IngestContext, type PollResult } from "@hercule/plugin-host";
import { isUserAccount, type GithubIdentity } from "../identity";
import { buildItemEvent, buildItemPlace, type GithubItem } from "../subject";
import { computeDigest } from "./digest";
import { GithubCheckSuite, ListedCheckRun, ListedPull } from "./feed-objects";
import { fetchOwnOpenPullRequests } from "./own-pulls";
import {
  decodeGithubValue,
  fetchFeedResponse,
  fetchListing,
  readGithubObject,
  truncateRaw,
  type FeedError,
} from "./requests";
import { pollWatchedRepos, readFeedState, type RepoPoll } from "./state";

/** What the feed keeps of one open pull request, to reuse when the listing answers 304. */
const PullRequestSnapshot = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  author: Schema.optionalKey(Schema.String),
  /**
   * True when the user wrote the pull request. Absent in state an older
   * version wrote, which counts as false until the next listing replaces it.
   */
  authoredByYou: Schema.optionalKey(Schema.Boolean),
  headSha: Schema.String,
  updatedAt: Schema.String,
});

type PullRequestSnapshot = Schema.Schema.Type<typeof PullRequestSnapshot>;

/** What the feed keeps of one head commit. */
const HeadState = Schema.Struct({
  /**
   * The ETag of the last check-suites answer, sent back as `If-None-Match`.
   * Absent when the suites took more than one page.
   */
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

/**
 * The most pages of check suites one poll reads for one commit, 100 each. A
 * commit with more suites never gets a verdict, because one suite left
 * unread could still be running; the feed logs a warning on each poll
 * instead of reporting from part of the list.
 */
const MAX_SUITE_PAGES = 3;

/** Returns how an event title says a rolled-up conclusion: "failed", "passed" or "finished". */
const describeConclusion = (conclusion: string): string => {
  if (conclusion === "failure") return "failed";
  if (conclusion === "success") return "passed";
  return "finished";
};

/** The conclusions that do not make a commit's checks fail. */
export const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

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
  identity: GithubIdentity,
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
          authoredByYou: isUserAccount(identity, pull.user),
          headSha: pull.head.sha,
          updatedAt: pull.updated_at,
        })),
    };
  });

/**
 * Fetches the names of the check runs on a commit that failed, sorted and
 * without duplicates. A run failed when it concluded with anything but
 * `success`, `neutral` or `skipped`; one still running has no conclusion and
 * did not fail. Reads one page of the commit's latest runs, 100 at most, so
 * a commit with more runs lists only those. Fails as `fetchListing` fails,
 * and with a `PluginError` when a run lacks the fields read.
 */
const fetchFailedCheckNames = (
  poll: RepoPoll,
  headSha: string,
): Effect.Effect<Array<string>, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const listing = yield* fetchListing(
      {
        method: "GET",
        path: `/repos/${poll.repo}/commits/${headSha}/check-runs`,
        token: poll.token,
        query: { filter: "latest", per_page: "100" },
      },
      1,
      { itemsField: "check_runs" },
    );
    const runs = yield* decodeGithubValue(
      Schema.Array(ListedCheckRun),
      listing.items,
      "check runs",
    );
    const failed = runs
      .filter((run) => run.conclusion !== null && !PASSING_CONCLUSIONS.has(run.conclusion))
      .map((run) => run.name);
    return [...new Set(failed)].sort();
  });

/**
 * Fetches the check suites of one pull request's head commit, and emits
 * `github.pr.checks-completed` when every counted suite has finished, with
 * a verdict other than the one in `head`, since the repository was first
 * polled. Returns the commit's new state. While a check runs again, the
 * state keeps the last verdict, so a re-run that ends the same way emits
 * nothing.
 *
 * A failure verdict also reads the commit's check runs, for the names of
 * those that failed. When that read fails, so does this, with no event
 * emitted and no new state kept, so the next poll reads the commit again.
 */
const checkHead = (
  poll: RepoPoll,
  pullRequest: PullRequestSnapshot,
  head: HeadState | undefined,
  watchedSince: string,
): Effect.Effect<HeadState, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const listing = yield* fetchListing(
      {
        method: "GET",
        path: `/repos/${poll.repo}/commits/${pullRequest.headSha}/check-suites`,
        token: poll.token,
        query: { per_page: "100" },
        ...(head?.etag === undefined ? {} : { etag: head.etag }),
      },
      MAX_SUITE_PAGES,
      { itemsField: "check_suites" },
    );
    if (listing.unchanged) return head ?? {};
    // The first page's ETag stays the same while a suite on a later page
    // finishes, so it is kept only when there is no later page.
    const etag =
      listing.firstPage.etag === undefined || listing.firstPage.nextPageUrl !== undefined
        ? {}
        : { etag: listing.firstPage.etag };
    const lastVerdict = head?.verdict === undefined ? {} : { verdict: head.verdict };
    if (listing.truncated) {
      yield* Effect.logWarning(
        `The GitHub checks feed cannot report the checks of ${poll.repo}#${String(pullRequest.number)} at ${pullRequest.headSha}: the commit has more than ${String(MAX_SUITE_PAGES * 100)} check suites, and a verdict needs all of them.`,
      );
      return lastVerdict;
    }
    const body = yield* readGithubObject(listing.firstPage.body, "check suites");
    const checkSuites = yield* decodeGithubValue(
      Schema.Array(GithubCheckSuite),
      listing.items,
      "check suites",
    );
    const suites = listCountedSuites(checkSuites);
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
      const conclusion = rollUpConclusion(suites);
      const failedChecks =
        conclusion === "failure" ? yield* fetchFailedCheckNames(poll, pullRequest.headSha) : [];
      yield* poll.emit(
        buildItemEvent(item, {
          kind: "github.pr.checks-completed",
          // Twelve characters of a commit SHA name it within one pull request,
          // and keep the key under the host's 200 characters.
          dedupKey: `pr.checks-completed:${poll.repo}#${String(pullRequest.number)}:${pullRequest.headSha.slice(0, 12)}:${verdict}`,
          occurredAt: completedAt,
          title: `Checks ${describeConclusion(conclusion)} on ${buildItemPlace(item)}`,
          author: null,
          fields: {
            conclusion,
            suites: suites.map((suite) => ({
              name: suite.app?.name ?? "unknown",
              conclusion: suite.conclusion ?? "unknown",
            })),
            headSha: pullRequest.headSha,
            failedChecks,
            onYourPullRequest: pullRequest.authoredByYou === true,
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
  identity: GithubIdentity,
): Effect.Effect<ChecksState, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const oldest = (yield* Clock.currentTimeMillis) - windowDays * DAY_MS;
    const listing = yield* fetchOpenPullRequests(poll, stored, oldest, identity);
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

/** What the feed keeps of one of the user's own open pull requests outside the watch list. */
const OwnPullRequestSnapshot = Schema.Struct({
  repo: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  headSha: Schema.String,
  updatedAt: Schema.String,
  /** The ETag of the last `GET .../pulls/{n}`, sent back as `If-None-Match`. */
  etag: Schema.optionalKey(Schema.String),
});

/** What the feed keeps between polls for the user's own open pull requests outside the watch list. */
const OwnChecksState = Schema.Struct({
  /** When the feed first checked them, as ISO 8601; checks that finished before emit nothing. */
  watchedSince: Schema.String,
  pullRequests: Schema.Array(OwnPullRequestSnapshot),
  /** The head commits, keyed by `<owner>/<repo>@<sha>`. */
  heads: Schema.Record(Schema.String, HeadState),
});

type OwnChecksState = Schema.Schema.Type<typeof OwnChecksState>;

/**
 * How many of the user's own open pull requests outside the watch list one
 * poll checks. Each costs a request for the pull request, free when it did
 * not change, and up to three for its check suites, so this bounds the
 * poll at about 80 requests however many pull requests the user has open.
 */
const MAX_OWN_PULL_REQUESTS_PER_POLL = 20;

/** The key of `OwnChecksState`. It is outside `checks/`, where each watched repository's state is. */
const OWN_CHECKS_KEY = "checks-own";

/**
 * Checks the head commit of each of the user's own open pull requests
 * outside the watch list, updated within the window, and returns the new
 * state. A pull request that fails with a `PluginError`, such as one in a
 * repository deleted since, is logged as a warning and keeps its state, so
 * it cannot set the Connection to `error`: it is not on the watch list the
 * user set up.
 */
const checkOwnPullRequests = (
  token: string,
  emit: IngestContext["emit"],
  stored: OwnChecksState,
  watchList: ReadonlyArray<string>,
  windowDays: number,
  identity: GithubIdentity,
): Effect.Effect<OwnChecksState, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const oldest = (yield* Clock.currentTimeMillis) - windowDays * DAY_MS;
    const watched = new Set(watchList);
    const own = (yield* fetchOwnOpenPullRequests(token)).filter(
      (pullRequest) =>
        !watched.has(pullRequest.repo) && Date.parse(pullRequest.updatedAt) >= oldest,
    );
    const pullRequests: Array<Schema.Schema.Type<typeof OwnPullRequestSnapshot>> = [];
    const heads: Record<string, HeadState> = {};
    const checked = own.slice(0, MAX_OWN_PULL_REQUESTS_PER_POLL);
    // The search lists the most recently updated first, so the ones left
    // over are the quietest. They keep their state, so their checks are not
    // treated as new when they are checked again.
    for (const found of own.slice(MAX_OWN_PULL_REQUESTS_PER_POLL)) {
      const previous = stored.pullRequests.find(
        (snapshot) => snapshot.repo === found.repo && snapshot.number === found.number,
      );
      if (previous === undefined) continue;
      pullRequests.push(previous);
      const headKey = `${previous.repo}@${previous.headSha}`;
      const head = stored.heads[headKey];
      if (head !== undefined) heads[headKey] = head;
    }
    if (own.length > checked.length) {
      yield* Effect.logWarning(
        `The GitHub checks feed found ${String(own.length)} of the user's own open pull requests outside the watch list and checks the ${String(MAX_OWN_PULL_REQUESTS_PER_POLL)} most recently updated each poll. The others are checked once they are updated again.`,
      );
    }
    for (const found of checked) {
      const previous = stored.pullRequests.find(
        (snapshot) => snapshot.repo === found.repo && snapshot.number === found.number,
      );
      yield* Effect.gen(function* () {
        const response = yield* fetchFeedResponse({
          method: "GET",
          path: `/repos/${found.repo}/pulls/${String(found.number)}`,
          token,
          ...(previous?.etag === undefined ? {} : { etag: previous.etag }),
        });
        const snapshot =
          response.status === 304 && previous !== undefined
            ? previous
            : yield* Effect.map(
                decodeGithubValue(ListedPull, response.body, "a pull request"),
                (pull) => ({
                  repo: found.repo,
                  number: found.number,
                  title: pull.title,
                  headSha: pull.head.sha,
                  updatedAt: pull.updated_at,
                  ...(response.etag === undefined ? {} : { etag: response.etag }),
                }),
              );
        const headKey = `${found.repo}@${snapshot.headSha}`;
        heads[headKey] = yield* checkHead(
          { repo: found.repo, token, emit },
          { ...snapshot, author: identity.login, authoredByYou: true },
          stored.heads[headKey],
          stored.watchedSince,
        );
        pullRequests.push(snapshot);
      }).pipe(
        Effect.catchIf(
          (error): error is PluginError => error instanceof PluginError,
          (error) =>
            Effect.logWarning(
              `The GitHub checks feed could not check ${buildItemPlace(found)}, one of the user's own pull requests: ${error.message}`,
            ),
        ),
      );
    }
    return { watchedSince: stored.watchedSince, pullRequests, heads };
  });

/**
 * Polls the checks feed once: every repository on the watch list, in turn,
 * then the user's own open pull requests outside it. A repository with no
 * state yet baselines and emits nothing, and so do the user's own pull
 * requests on the first poll. Fails as `pollWatchedRepos` fails.
 */
export const pollChecks = (
  token: string,
  context: Pick<IngestContext, "emit" | "state">,
  watchList: ReadonlyArray<string>,
  windowDays: number,
  identity: GithubIdentity,
): Effect.Effect<PollResult, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    yield* pollWatchedRepos("checks", context.state, watchList, ChecksState, (repo, stored) =>
      Option.isNone(stored)
        ? baselineRepo
        : pollRepo({ repo, token, emit: context.emit }, stored.value, windowDays, identity),
    );
    const stored = yield* readFeedState(context.state, OWN_CHECKS_KEY, OwnChecksState);
    const next = Option.isNone(stored)
      ? { ...(yield* baselineRepo), pullRequests: [] }
      : yield* checkOwnPullRequests(
          token,
          context.emit,
          stored.value,
          watchList,
          windowDays,
          identity,
        );
    yield* context.state.set(OWN_CHECKS_KEY, next);
    return {};
  });
