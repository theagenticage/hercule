/**
 * The user's own open pull requests, in any repository. The `repos` and
 * `checks` feeds read them as well as the watch list, so changes requested
 * on them and their failed checks reach the user wherever they live.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { FoundIssue } from "./feed-objects";
import { decodeGithubValue, fetchListing, type FeedError } from "./requests";

/** One of the user's open pull requests. */
export interface OwnPullRequest {
  /** The repository, as lowercase `owner/repo`. */
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly updatedAt: string;
}

/**
 * How many of the user's open pull requests are read, the most recently
 * updated first: one page of the search. A person with more open pull
 * requests than this has the rest read only once they are updated again.
 */
const MAX_OWN_PULL_REQUESTS = 100;

/** Returns the repository a search result's `repository_url` points at, as lowercase `owner/repo`. */
const parseRepositoryUrl = (url: string): string | undefined =>
  /\/repos\/([^/]+\/[^/]+)$/.exec(url)?.[1]?.toLowerCase();

/**
 * Searches for the open pull requests the token's user authored, in any
 * repository the token can see, and returns up to 100 of them, the most
 * recently updated first. The search API allows 30 requests a minute, and
 * the `repos` and `checks` feeds each send one per poll.
 *
 * The query names the user as `@me`, which GitHub reads from the token,
 * rather than by login: a user who renames their account keeps the same
 * token, and a stored login would then find nothing. Fails as
 * `fetchListing` fails.
 */
export const fetchOwnOpenPullRequests = (
  token: string,
): Effect.Effect<ReadonlyArray<OwnPullRequest>, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const listing = yield* fetchListing(
      {
        method: "GET",
        path: "/search/issues",
        token,
        query: {
          q: "is:pr is:open archived:false author:@me",
          sort: "updated",
          order: "desc",
          per_page: String(MAX_OWN_PULL_REQUESTS),
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
