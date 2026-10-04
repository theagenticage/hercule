/**
 * The `checks` feed: one `github.pr.checks-completed` per pull request head
 * commit, when every check suite on that commit has finished.
 *
 * Per repository and poll, the requests are:
 *
 * 1. `GET /repos/{o}/{r}/pulls?state=open&sort=updated&direction=desc`, one
 *    page of 100, with the last ETag. A 304 reuses the pull requests from the
 *    last poll.
 * 2. For each open pull request updated in the last `checksWindowDays` whose
 *    head commit has not completed yet:
 *    `GET /repos/{o}/{r}/commits/{sha}/check-suites`, with that commit's last
 *    ETag. A commit whose checks completed is not asked about again.
 *
 * So a quiet repository costs one free 304 plus one free 304 per waiting
 * commit.
 */
import { Clock, Effect, Option, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { IngestContext, PollResult } from "@hercule/plugin-host";
import { buildItemEvent, type GithubItem } from "../subject";
import { GithubCheckSuites, GithubPull, type GithubCheckSuite } from "./feed-objects";
import {
  decodeGithubValue,
  fetchGithub,
  readGithubObject,
  truncateRaw,
  type FeedError,
} from "./requests";
import { pollWatchedRepos } from "./state";

/** What the feed keeps of one open pull request, to reuse when the listing answers 304. */
const PullRequestSnapshot = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  author: Schema.optionalKey(Schema.String),
  headSha: Schema.String,
  updatedAt: Schema.String,
});

type PullRequestSnapshot = Schema.Schema.Type<typeof PullRequestSnapshot>;

/** What the feed keeps between polls for one repository. */
const ChecksState = Schema.Struct({
  /**
   * When this repository was first polled, as ISO 8601. Checks that
   * completed before then emit nothing, so a newly watched repository does
   * not report every finished commit it already had.
   */
  watchedSince: Schema.String,
  /** The ETag of the last pull request listing, sent back as `If-None-Match`. */
  etag: Schema.optionalKey(Schema.String),
  /** The open pull requests of the last listing. */
  pullRequests: Schema.Array(PullRequestSnapshot),
  /**
   * The head commits of those pull requests, keyed by SHA: the ETag of their
   * last check-suites answer, and whether their checks completed.
   */
  heads: Schema.Record(
    Schema.String,
    Schema.Struct({ etag: Schema.optionalKey(Schema.String), done: Schema.Boolean }),
  ),
});

type ChecksState = Schema.Schema.Type<typeof ChecksState>;
type HeadState = ChecksState["heads"][string];

const DAY_MS = 24 * 60 * 60 * 1000;

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
 * check runs is one GitHub created for an app that never ran on this commit:
 * it stays queued forever, so it would hold the verdict back forever.
 */
const listCountedSuites = (
  suites: ReadonlyArray<GithubCheckSuite>,
): ReadonlyArray<GithubCheckSuite> => suites.filter((suite) => suite.latest_check_runs_count > 0);

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

/** The per-repository work of one poll: what it needs and where its events go. */
interface RepoPoll {
  readonly repo: string;
  readonly token: string;
  readonly emit: IngestContext["emit"];
}

/**
 * Fetches the repository's open pull requests, or returns the stored ones
 * with their ETag when GitHub answers 304.
 */
const fetchOpenPullRequests = (
  poll: RepoPoll,
  stored: ChecksState,
): Effect.Effect<
  { readonly etag?: string; readonly pullRequests: ReadonlyArray<PullRequestSnapshot> },
  FeedError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const response = yield* fetchGithub({
      method: "GET",
      path: `/repos/${poll.repo}/pulls`,
      token: poll.token,
      query: { state: "open", sort: "updated", direction: "desc", per_page: "100" },
      ...(stored.etag === undefined ? {} : { etag: stored.etag }),
    });
    if (response.status === 304) return stored;
    const pulls = yield* decodeGithubValue(
      Schema.Array(GithubPull),
      response.body,
      "open pull requests",
    );
    return {
      ...(response.etag === undefined ? {} : { etag: response.etag }),
      pullRequests: pulls.map((pull) => ({
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
 * `github.pr.checks-completed` when every counted suite has completed since
 * the repository was first polled. Returns the commit's new state: done once
 * its checks completed, whether or not that emitted.
 */
const checkHead = (
  poll: RepoPoll,
  pullRequest: PullRequestSnapshot,
  head: HeadState | undefined,
  watchedSince: string,
): Effect.Effect<HeadState, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* fetchGithub({
      method: "GET",
      path: `/repos/${poll.repo}/commits/${pullRequest.headSha}/check-suites`,
      token: poll.token,
      query: { per_page: "100" },
      ...(head?.etag === undefined ? {} : { etag: head.etag }),
    });
    if (response.status === 304 && head !== undefined) return head;
    const etag = response.etag === undefined ? {} : { etag: response.etag };
    const body = yield* readGithubObject(response.body, "check suites");
    const { check_suites } = yield* decodeGithubValue(GithubCheckSuites, body, "check suites");
    const suites = listCountedSuites(check_suites);
    if (suites.length === 0 || suites.some((suite) => suite.status !== "completed")) {
      return { ...etag, done: false };
    }
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
          dedupKey: `pr.checks-completed:${poll.repo}#${String(pullRequest.number)}:${pullRequest.headSha}`,
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
    return { ...etag, done: true };
  });

/**
 * Polls one watched repository: checks every recent open pull request whose
 * head commit is still waiting, and returns the new state. Commits no longer
 * at the head of an open pull request are dropped from the state.
 */
const pollRepo = (
  poll: RepoPoll,
  stored: ChecksState,
  windowDays: number,
): Effect.Effect<ChecksState, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const listing = yield* fetchOpenPullRequests(poll, stored);
    const oldest = (yield* Clock.currentTimeMillis) - windowDays * DAY_MS;
    const heads: Record<string, HeadState> = {};
    for (const pullRequest of listing.pullRequests) {
      const head = stored.heads[pullRequest.headSha];
      if (head?.done === true) {
        heads[pullRequest.headSha] = head;
      } else if (Date.parse(pullRequest.updatedAt) >= oldest) {
        heads[pullRequest.headSha] = yield* checkHead(poll, pullRequest, head, stored.watchedSince);
      }
    }
    return {
      watchedSince: stored.watchedSince,
      ...(listing.etag === undefined ? {} : { etag: listing.etag }),
      pullRequests: listing.pullRequests,
      heads,
    };
  });

/**
 * Records when a newly watched repository was first polled. Sends no request
 * and emits nothing: the next poll fetches its pull requests, and only
 * checks that complete from now on emit.
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
