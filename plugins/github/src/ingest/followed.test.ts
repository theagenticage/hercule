/**
 * Tests the followed items: the issues and pull requests outside the watch
 * list that the `repos` feed reads one by one, because a notification named
 * them, an open signal is about them, or they are the user's own.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { TEST_TOKEN } from "../actions/testing";
import {
  answerUserRequests,
  buildIngestHarness,
  isUserRequest,
  readStubRequestTarget,
  runAgainstStub,
  stubGithub,
  TEST_ACCOUNT,
  TEST_IDENTITY,
  type StubResponse,
} from "../testing";
import { MAX_FOLLOWED_ITEMS_PER_POLL, pollFollowedItems, recordFollowedHints } from "./followed";
import { GithubRateLimited } from "./requests";

const REPO = "acme/webshop";
const SINCE = "2026-10-11T08:00:00Z";

/** An open pull request of `acme/webshop`, as `GET .../issues/{number}` returns it. */
const buildPull = (number: number, extra: object = {}) => ({
  number,
  title: `Pull ${String(number)}`,
  state: "open",
  user: { login: "marta", id: 9 },
  labels: [],
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-11T09:30:00Z",
  closed_at: null,
  pull_request: { merged_at: null },
  ...extra,
});

/** An open pull request of `acme/webshop`, as `GET .../pulls/{number}` returns it, still asking the user. */
const buildPullDetail = (number: number) => ({
  number,
  title: `Pull ${String(number)}`,
  state: "open",
  user: { login: "marta", id: 9 },
  head: { sha: "sha-a" },
  updated_at: "2026-10-11T09:30:00Z",
  requested_reviewers: [TEST_ACCOUNT],
});

/**
 * Answers the requests for item `number`: the item itself, as an issue and
 * as a pull request, no comments, no reviews, and a history with one review
 * request to the user.
 */
const answerItem =
  (item: (number: number) => object) =>
  (request: HttpClientRequest.HttpClientRequest): StubResponse => {
    const { path } = readStubRequestTarget(request);
    const match = /\/(issues|pulls)\/(\d+)(\/\w+)?$/.exec(path);
    const number = Number(match?.[2]);
    switch (match?.[3]) {
      case undefined:
        return {
          status: 200,
          body: match?.[1] === "pulls" ? buildPullDetail(number) : item(number),
        };
      case "/events":
        return {
          status: 200,
          body: [
            {
              id: number,
              event: "review_requested",
              created_at: "2026-10-11T09:00:00Z",
              actor: { login: "marta", id: 9 },
              requested_reviewer: TEST_ACCOUNT,
            },
          ],
        };
      default:
        return { status: 200, body: [] };
    }
  };

/** Polls the followed items once against `route`, with no watch list and no teams. */
const pollOnce = (
  harness: ReturnType<typeof buildIngestHarness>,
  route: (request: HttpClientRequest.HttpClientRequest) => StubResponse,
) => {
  const stub = stubGithub(route);
  return runAgainstStub(
    pollFollowedItems(TEST_TOKEN, harness.context, [], TEST_IDENTITY, new Set()),
    stub,
  ).then((result) => ({ result, stub }));
};

/** Returns the number of the item a request is about, or undefined for a request about the user. */
const readItemNumber = (request: HttpClientRequest.HttpClientRequest): number | undefined => {
  const match = /\/(?:issues|pulls)\/(\d+)/.exec(readStubRequestTarget(request).path);
  return match === null ? undefined : Number(match[1]);
};

/** Records hints for items 1 to `count` of `acme/webshop`, as the notifications feed does. */
const recordHints = (harness: ReturnType<typeof buildIngestHarness>, count: number) =>
  Effect.runPromise(
    recordFollowedHints(
      harness.context.state,
      Array.from({ length: count }, (_, index) => ({
        ref: `github:pr:${REPO}#${String(index + 1)}`,
        since: SINCE,
      })),
    ),
  );

describe("pollFollowedItems", () => {
  it("reads an item a notification named, and emits the review request on it", async () => {
    const harness = buildIngestHarness();
    await recordHints(harness, 1);
    const stub = stubGithub(answerUserRequests(answerItem((number) => buildPull(number))));

    const result = await runAgainstStub(
      pollFollowedItems(TEST_TOKEN, harness.context, [], TEST_IDENTITY, new Set()),
      stub,
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(harness.events).toMatchObject([
      { kind: "github.pr.review-requested", payload: { reviewer: "you" } },
    ]);
    expect(harness.state.has("followed-hints")).toBe(false);
  });

  it("emits the merge that ends an open signal on an item outside the watch list", async () => {
    const harness = buildIngestHarness();
    harness.openSignals.push({
      kind: "github/review-requested",
      threadRef: `github:pr:${REPO}#7`,
      raisedAt: "2026-10-11T09:10:00Z",
    });
    const merged = {
      state: "closed",
      closed_at: "2026-10-11T09:20:00Z",
      closed_by: { login: "marta", id: 9 },
      pull_request: { merged_at: "2026-10-11T09:20:00Z" },
    };
    const stub = stubGithub(answerUserRequests(answerItem((number) => buildPull(number, merged))));

    await runAgainstStub(
      pollFollowedItems(TEST_TOKEN, harness.context, [], TEST_IDENTITY, new Set()),
      stub,
    );

    // The review request at 09:00 is from before the signal was raised, so only the merge is new.
    expect(harness.events.map((event) => [event.kind, event.author])).toEqual([
      ["github.pr.merged", "marta"],
    ]);
  });

  it("leaves an item in a watched repository to the watch list's own poll", async () => {
    const harness = buildIngestHarness();
    await recordHints(harness, 1);
    const stub = stubGithub(answerUserRequests(answerItem((number) => buildPull(number))));

    await runAgainstStub(
      pollFollowedItems(TEST_TOKEN, harness.context, [REPO], TEST_IDENTITY, new Set()),
      stub,
    );

    expect(stub.requests.filter((request) => !isUserRequest(request))).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("reads at most 20 items a poll, and keeps the hints of the rest for the next poll", async () => {
    const harness = buildIngestHarness();
    await recordHints(harness, MAX_FOLLOWED_ITEMS_PER_POLL + 5);
    // One comment per item and an empty history: four requests an item, so
    // the item limit, not the request budget, stops the poll.
    const answer = answerItem((number) => buildPull(number));
    const stub = stubGithub(
      answerUserRequests((request) => {
        const { path } = readStubRequestTarget(request);
        const number = readItemNumber(request)!;
        if (path.endsWith("/events")) return { status: 200, body: [] };
        if (!path.endsWith("/comments")) return answer(request);
        return {
          status: 200,
          body: [
            {
              id: number,
              html_url: `https://github.com/${REPO}/pull/${String(number)}#issuecomment-${String(number)}`,
              issue_url: `https://api.github.com/repos/${REPO}/issues/${String(number)}`,
              user: { login: "marta", id: 9 },
              body: "Looks good.",
              created_at: "2026-10-11T09:00:00Z",
              updated_at: "2026-10-11T09:00:00Z",
            },
          ],
        };
      }),
    );

    await runAgainstStub(
      pollFollowedItems(TEST_TOKEN, harness.context, [], TEST_IDENTITY, new Set()),
      stub,
    );

    expect(harness.events).toHaveLength(MAX_FOLLOWED_ITEMS_PER_POLL);
    expect(Object.keys(harness.state.get("followed-hints") as object)).toHaveLength(5);

    await runAgainstStub(
      pollFollowedItems(TEST_TOKEN, harness.context, [], TEST_IDENTITY, new Set()),
      stub,
    );

    expect(harness.events).toHaveLength(MAX_FOLLOWED_ITEMS_PER_POLL + 5);
    expect(harness.state.has("followed-hints")).toBe(false);
  });

  it("keeps the hint and the state of an item whose read failed, and tries it again", async () => {
    const harness = buildIngestHarness();
    await recordHints(harness, 1);
    const failing = answerUserRequests(() => ({
      status: 500,
      body: { message: "Server Error" },
    }));

    const { result } = await pollOnce(harness, failing);

    expect(Result.isSuccess(result)).toBe(true);
    expect(harness.events).toEqual([]);
    expect(Object.keys(harness.state.get("followed-hints") as object)).toEqual([
      `github:pr:${REPO}#1`,
    ]);
    expect(harness.state.has(`followed/github:pr:${REPO}#1`)).toBe(false);

    await pollOnce(harness, answerUserRequests(answerItem((number) => buildPull(number))));

    expect(harness.events).toHaveLength(1);
    expect(harness.state.has("followed-hints")).toBe(false);
  });

  it("drops the hint of an item GitHub answers is gone, and emits nothing for it", async () => {
    const harness = buildIngestHarness();
    await recordHints(harness, 1);

    const { result } = await pollOnce(
      harness,
      answerUserRequests(() => ({ status: 404, body: { message: "Not Found" } })),
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(harness.events).toEqual([]);
    expect(harness.state.has("followed-hints")).toBe(false);
  });

  it("keeps what it read before a rate limit, and the hints of the items it did not reach", async () => {
    const harness = buildIngestHarness();
    await recordHints(harness, 3);
    const answer = answerItem((number) => buildPull(number));
    const limited = answerUserRequests((request) =>
      readItemNumber(request) === 2
        ? { status: 429, body: { message: "rate limit" }, headers: { "retry-after": "60" } }
        : answer(request),
    );

    const { result } = await pollOnce(harness, limited);

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(GithubRateLimited);
    expect(harness.events).toHaveLength(1);
    expect(harness.state.get(`followed/github:pr:${REPO}#1`)).toMatchObject({
      since: "2026-10-11T09:30:00Z",
    });
    expect(Object.keys(harness.state.get("followed-hints") as object).sort()).toEqual([
      `github:pr:${REPO}#2`,
      `github:pr:${REPO}#3`,
    ]);
    expect(harness.state.get("followed-last-read")).toBe(`github:pr:${REPO}#1`);

    // The next poll starts with the item the rate limit stopped.
    const { stub } = await pollOnce(harness, answerUserRequests(answer));

    expect(stub.requests.map(readItemNumber).find((number) => number !== undefined)).toBe(2);
    expect(harness.events).toHaveLength(3);
    expect(harness.state.has("followed-hints")).toBe(false);
  });

  it("deletes the state of an item it no longer follows", async () => {
    const harness = buildIngestHarness();
    await recordHints(harness, 1);
    await pollOnce(harness, answerUserRequests(answerItem((number) => buildPull(number))));
    expect(harness.state.has(`followed/github:pr:${REPO}#1`)).toBe(true);

    await pollOnce(harness, answerUserRequests(answerItem((number) => buildPull(number))));

    expect(harness.state.has(`followed/github:pr:${REPO}#1`)).toBe(false);
  });

  it("records an own pull request seen for the first time, and emits what happens on it after", async () => {
    const harness = buildIngestHarness();
    let updatedAt = "2026-10-11T08:30:00Z";
    const route = (request: HttpClientRequest.HttpClientRequest): StubResponse =>
      readStubRequestTarget(request).path === "/search/issues"
        ? {
            status: 200,
            body: {
              total_count: 1,
              items: [
                {
                  number: 1,
                  title: "Pull 1",
                  repository_url: `https://api.github.com/repos/${REPO}`,
                  updated_at: updatedAt,
                },
              ],
            },
          }
        : answerUserRequests(answerItem((number) => buildPull(number)))(request);

    const { stub } = await pollOnce(harness, route);

    expect(stub.requests.filter((request) => !isUserRequest(request))).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(harness.state.get(`followed/github:pr:${REPO}#1`)).toEqual({
      since: "2026-10-11T08:30:01.000Z",
    });

    // The review request at 09:00 comes after the baseline.
    updatedAt = "2026-10-11T09:30:00Z";
    await pollOnce(harness, route);

    expect(harness.events.map((event) => event.kind)).toEqual(["github.pr.review-requested"]);
  });

  it("reads an own pull request whose read failed again, even once it is closed", async () => {
    const harness = buildIngestHarness();
    let own = true;
    let failing = false;
    const route = (request: HttpClientRequest.HttpClientRequest): StubResponse => {
      const { path } = readStubRequestTarget(request);
      if (path === "/search/issues") {
        const items = own
          ? [
              {
                number: 1,
                title: "Pull 1",
                repository_url: `https://api.github.com/repos/${REPO}`,
                updated_at: "2026-10-11T08:30:00Z",
              },
            ]
          : [];
        return { status: 200, body: { total_count: items.length, items } };
      }
      if (failing && path.endsWith("/events")) {
        return { status: 500, body: { message: "Server Error" } };
      }
      return answerUserRequests(answerItem((number) => buildPull(number)))(request);
    };
    await pollOnce(harness, route);

    // The review request at 09:00 is read, then the history read fails.
    failing = true;
    await pollOnce(harness, route);
    expect(harness.events).toEqual([]);

    // The pull request is closed, so the search no longer finds it.
    own = false;
    failing = false;
    await pollOnce(harness, route);

    expect(harness.events.map((event) => event.kind)).toEqual(["github.pr.review-requested"]);
  });

  it("goes back to a notification's hint from before an own pull request's last read", async () => {
    const harness = buildIngestHarness();
    const answer = answerItem((number) => buildPull(number));
    const route = (request: HttpClientRequest.HttpClientRequest): StubResponse => {
      const { path } = readStubRequestTarget(request);
      if (path === "/search/issues") {
        return {
          status: 200,
          body: {
            total_count: 1,
            items: [
              {
                number: 1,
                title: "Pull 1",
                repository_url: `https://api.github.com/repos/${REPO}`,
                updated_at: "2026-10-11T09:30:00Z",
              },
            ],
          },
        };
      }
      if (path === `/repos/${REPO}/issues/1`) {
        return request.headers["if-none-match"] === '"e1"'
          ? { status: 304 }
          : { status: 200, body: buildPull(1), headers: { etag: '"e1"' } };
      }
      if (path.endsWith("/comments")) {
        // A comment from before the own pull request was first recorded.
        return {
          status: 200,
          body: [
            {
              id: 400,
              html_url: `https://github.com/${REPO}/pull/1#issuecomment-400`,
              issue_url: `https://api.github.com/repos/${REPO}/issues/1`,
              user: { login: "marta", id: 9 },
              body: `@${TEST_IDENTITY.login} can you look?`,
              created_at: "2026-10-11T09:10:00Z",
              updated_at: "2026-10-11T09:10:00Z",
            },
          ],
        };
      }
      return answerUserRequests(answer)(request);
    };
    // The first poll records the pull request; the second reads it and keeps its ETag.
    await pollOnce(harness, route);
    await pollOnce(harness, route);
    expect(harness.events).toEqual([]);
    expect(harness.state.get(`followed/github:pr:${REPO}#1`)).toMatchObject({ etag: '"e1"' });

    // The notifications feed then reports the mention, from before the last read.
    await recordHints(harness, 1);
    const { stub } = await pollOnce(harness, route);

    const itemRead = stub.requests.find(
      (request) => readStubRequestTarget(request).path === `/repos/${REPO}/issues/1`,
    );
    expect(itemRead?.headers["if-none-match"]).toBeUndefined();
    expect(harness.events.map((event) => event.kind)).toContain("github.mentioned");
    expect(harness.state.has("followed-hints")).toBe(false);
  });

  it("emits one item's events oldest first, so a request after a review comes after it", async () => {
    const harness = buildIngestHarness();
    await recordHints(harness, 1);
    const answer = answerItem((number) => buildPull(number));
    const route = answerUserRequests((request) =>
      readStubRequestTarget(request).path.endsWith("/reviews")
        ? {
            status: 200,
            body: [
              {
                id: 300,
                user: TEST_ACCOUNT,
                state: "APPROVED",
                submitted_at: "2026-10-11T08:50:00Z",
              },
            ],
          }
        : answer(request),
    );

    await pollOnce(harness, route);

    // The request at 09:00 is found after the review at 08:50, which is
    // emitted first all the same, or it would end that request's signal.
    expect(harness.events.map((event) => event.kind)).toEqual([
      "github.pr.review-submitted",
      "github.pr.review-requested",
    ]);
  });
});
