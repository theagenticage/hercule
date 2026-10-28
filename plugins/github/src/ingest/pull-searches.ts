/**
 * The searches for open pull requests that concern the user, in any
 * repository: the user's own, and those that ask the user or one of their
 * teams for a review. The `repos` feed follows both outside the watch list,
 * and the `checks` feed reads the user's own, so what happens on them
 * reaches the user wherever they live.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import { REPO_NAME_PATTERN } from "../repo-name";
import { FoundIssue } from "./feed-objects";
import { decodeGithubValue, fetchListing, type FeedError } from "./requests";

/** One open pull request a search found. */
export interface FoundPullRequest {
  /** The repository, as lowercase `owner/repo`. */
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly updatedAt: string;
}

/**
 * How many pull requests one search reads, the most recently updated first:
 * one page. A search that finds more has the rest read only once they are
 * updated again.
 */
const MAX_FOUND_PULL_REQUESTS = 100;

const REPOSITORY_URL = new RegExp(`/repos/(${REPO_NAME_PATTERN})$`);

/**
 * Returns the repository a search result's `repository_url` points at, as
 * lowercase `owner/repo`, or undefined when the URL ends in no valid
 * repository name.
 */
const parseRepositoryUrl = (url: string): string | undefined =>
  REPOSITORY_URL.exec(url)?.[1]?.toLowerCase();

/**
 * Searches for the open pull requests that match `qualifier`, in any
 * repository the token can see, and returns up to 100 of them, the most
 * recently updated first. The search API allows 30 requests a minute; the
 * `repos` feed sends two searches per poll and the `checks` feed one.
 *
 * The qualifier names the user as `@me`, which GitHub reads from the token,
 * rather than by login: a user who renames their account keeps the same
 * token, and a stored login would then find nothing. Fails as
 * `fetchListing` fails.
 */
const searchOpenPullRequests = (
  token: string,
  qualifier: string,
): Effect.Effect<ReadonlyArray<FoundPullRequest>, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const listing = yield* fetchListing(
      {
        method: "GET",
        path: "/search/issues",
        token,
        query: {
          q: `is:pr is:open archived:false ${qualifier}`,
          sort: "updated",
          order: "desc",
          per_page: String(MAX_FOUND_PULL_REQUESTS),
        },
      },
      1,
      { itemsField: "items" },
    );
    const found = yield* decodeGithubValue(
      Schema.Array(FoundIssue),
      listing.items,
      "pull requests found by the search",
    );
    return found.flatMap((result) => {
      const repo = parseRepositoryUrl(result.repository_url);
      return repo === undefined
        ? []
        : [{ repo, number: result.number, title: result.title, updatedAt: result.updated_at }];
    });
  });

/** Searches for the open pull requests the token's user authored, as `searchOpenPullRequests` does. */
export const fetchOwnOpenPullRequests = (
  token: string,
): Effect.Effect<ReadonlyArray<FoundPullRequest>, FeedError, HttpClient.HttpClient> =>
  searchOpenPullRequests(token, "author:@me");

/**
 * Searches for the open pull requests that ask the token's user, or one of
 * their teams, for a review, as `searchOpenPullRequests` does. GitHub's
 * `review-requested:` qualifier includes a request to any team the user is
 * on, so one search covers the teams too.
 */
export const fetchOpenPullRequestsAskingForUserReview = (
  token: string,
): Effect.Effect<ReadonlyArray<FoundPullRequest>, FeedError, HttpClient.HttpClient> =>
  searchOpenPullRequests(token, "review-requested:@me");
