/**
 * Tests the searches for open pull requests that concern the user: the
 * user's own, and those that ask the user or one of their teams for a review.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { AuthError, PluginError } from "@hercule/plugin-host";
import { TEST_TOKEN } from "../actions/testing";
import { readStubRequestTarget, runAgainstStub, stubGithub, type StubResponse } from "../testing";
import { fetchOwnOpenPullRequests, fetchPullRequestsAskingForReview } from "./pull-searches";
import { GithubRateLimited } from "./requests";

const SEARCHES = [
  { search: fetchOwnOpenPullRequests, qualifier: "author:@me" },
  { search: fetchPullRequestsAskingForReview, qualifier: "review-requested:@me" },
];

describe.each(SEARCHES)("the search for $qualifier", ({ search, qualifier }) => {
  it("names the user as @me, and reads one page, the most recently updated first", async () => {
    const stub = stubGithub(() => ({
      status: 200,
      body: {
        total_count: 101,
        items: [
          {
            number: 87,
            title: "Fix the cart",
            repository_url: "https://api.github.com/repos/Acme/WebShop",
            updated_at: "2026-10-11T09:00:00Z",
          },
        ],
      },
      headers: { link: '<https://api.github.com/search/issues?page=2>; rel="next"' },
    }));

    const result = await runAgainstStub(search(TEST_TOKEN), stub);

    expect(stub.requests).toHaveLength(1);
    expect(readStubRequestTarget(stub.requests[0]!)).toEqual({
      path: "/search/issues",
      query: {
        q: `is:pr is:open archived:false ${qualifier}`,
        sort: "updated",
        order: "desc",
        per_page: "100",
      },
    });
    expect(Result.getOrThrow(result)).toEqual([
      {
        repo: "acme/webshop",
        number: 87,
        title: "Fix the cart",
        updatedAt: "2026-10-11T09:00:00Z",
      },
    ]);
  });

  it.each<[string, StubResponse, new (...args: never) => Error]>([
    ["a rejected token", { status: 401, body: { message: "Bad credentials" } }, AuthError],
    [
      "a rate limit",
      { status: 429, body: { message: "rate limit" }, headers: { "retry-after": "60" } },
      GithubRateLimited,
    ],
    ["a server error", { status: 500, body: { message: "Server Error" } }, PluginError],
  ])("fails on %s", async (_, response, expected) => {
    const result = await runAgainstStub(
      search(TEST_TOKEN),
      stubGithub(() => response),
    );

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(expected);
  });
});
