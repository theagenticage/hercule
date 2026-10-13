/**
 * Tests the followed items: the issues and pull requests outside the watch
 * list that the `repos` feed reads one by one, because a notification named
 * them, an open signal is about them, they are the user's own, or a search
 * finds them asking the user or one of their teams for a review.
 */
import { describe, expect, it } from "vitest";
import { Effect, Logger, Result } from "effect";
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
  type GithubStub,
  TEST_IDENTITY,
  type StubResponse,
} from "../testing";
import {
  MAX_FOLLOWED_ITEMS_PER_POLL,
  MAX_FOLLOWED_REQUESTS_PER_POLL,
  pollFollowedItems,
  recordFollowedHints,
} from "./followed";
import { GithubRateLimited } from "./requests";

const REPO = "acme/webshop";
const SINCE = "2026-10-11T08:00:00Z";

/**
 * The state key that marks that the search for review requests has
 * baselined. Written out rather than imported: the key is stored, so a
 * change to it would make every Connection baseline again, and this test
 * should fail when that happens.
 */
const REVIEW_REQUESTS_BASELINED_KEY = "review-requests-baselined";

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

/** A pull request of `repo`, as `GET /search/issues` lists it. */
const buildFoundPull = (number: number, updatedAt = "2026-10-11T09:30:00Z", repo = REPO) => ({
  number,
  title: `Pull ${String(number)}`,
  repository_url: `https://api.github.com/repos/${repo}`,
  updated_at: updatedAt,
});

/** A comment by marta on pull request `number` of `acme/webshop`, as `GET .../comments` lists it. */
const buildComment = (id: number, number: number, createdAt: string, body = "Looks good.") => ({
  id,
  html_url: `https://github.com/${REPO}/pull/${String(number)}#issuecomment-${String(id)}`,
  issue_url: `https://api.github.com/repos/${REPO}/issues/${String(number)}`,
  user: { login: "marta", id: 9 },
  body,
  created_at: createdAt,
  updated_at: createdAt,
});

/**
 * A history entry in which marta asks for a review: by default from the
 * user, or from whoever `target` names, such as `{ requested_team: { slug } }`.
 */
const buildReviewRequest = (
  id: number,
  createdAt: string,
  target: object = { requested_reviewer: TEST_ACCOUNT },
) => ({
  id,
  event: "review_requested",
  created_at: createdAt,
  actor: { login: "marta", id: 9 },
  ...target,
});

/**
 * Answers the requests for item `number`: the item itself, as an issue and
 * as a pull request, no comments, no reviews, and the history `history`
 * returns, by default one review request to the user at 09:00 whose id is
 * the item's number.
 */
const answerItem =
  (
    item: (number: number) => object,
    history: (number: number) => ReadonlyArray<object> = (number) => [
      buildReviewRequest(number, "2026-10-11T09:00:00Z"),
    ],
  ) =>
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
        return { status: 200, body: history(number) };
      default:
        return { status: 200, body: [] };
    }
  };

/**
 * Returns a route that answers the search for the user's own pull requests
 * with `found.own`, the search for pull requests asking the user for a
 * review with `found.asking`, and the user's teams with none. Every other
 * request goes to `route`.
 */
const answerSearches =
  (
    found: { readonly own?: ReadonlyArray<object>; readonly asking?: ReadonlyArray<object> },
    route: (request: HttpClientRequest.HttpClientRequest) => StubResponse,
  ) =>
  (request: HttpClientRequest.HttpClientRequest): StubResponse => {
    const { path, query } = readStubRequestTarget(request);
    if (path !== "/search/issues") return answerUserRequests(route)(request);
    const items = (query["q"]?.endsWith("author:@me") ? found.own : found.asking) ?? [];
    return { status: 200, body: { total_count: items.length, items } };
  };

/**
 * Polls the followed items once against `route`, by default with no watch
 * list and no teams. Returns the poll's result, the stub, and the warnings
 * the poll logged.
 */
const pollOnce = (
  harness: ReturnType<typeof buildIngestHarness>,
  route: (request: HttpClientRequest.HttpClientRequest) => StubResponse,
  { watchList = [], teams = [] }: { watchList?: Array<string>; teams?: Array<string> } = {},
) => {
  const stub = stubGithub(route);
  const warnings: Array<string> = [];
  const captureWarnings = Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push([message].flat().join(" "));
    }),
  ]);
  return runAgainstStub(
    pollFollowedItems(TEST_TOKEN, harness.context, watchList, TEST_IDENTITY, new Set(teams)).pipe(
      Effect.provide(captureWarnings),
    ),
    stub,
  ).then((result) => ({ result, stub, warnings }));
};

/** Returns a route that answers 500 for an item's history and everything else as `answer` does. */
const failHistoryReads =
  (answer: (request: HttpClientRequest.HttpClientRequest) => StubResponse) =>
  (request: HttpClientRequest.HttpClientRequest): StubResponse =>
    readStubRequestTarget(request).path.endsWith("/events")
      ? { status: 500, body: { message: "Server Error" } }
      : answer(request);

/** Returns how many requests for an item's history the stub received. */
const countHistoryReads = (stub: GithubStub): number =>
  stub.requests.filter((request) => readStubRequestTarget(request).path.endsWith("/events")).length;

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

  it("reads the history of a followed issue, and emits the assignments in it", async () => {
    const harness = buildIngestHarness();
    await Effect.runPromise(
      recordFollowedHints(harness.context.state, [{ ref: `github:issue:${REPO}#3`, since: SINCE }]),
    );
    // An issue is a pull request's listing entry without its `pull_request` field.
    const issue = { ...buildPull(3), pull_request: undefined };
    const assignment = (id: number, event: string, assignee: object, time: string) => ({
      id,
      event,
      created_at: time,
      actor: { login: "marta", id: 9 },
      assignee,
    });
    const stub = stubGithub(
      answerUserRequests((request) => {
        const { path } = readStubRequestTarget(request);
        if (path.endsWith("/events")) {
          return {
            status: 200,
            body: [
              // Before the hint's time: already known, so not emitted.
              assignment(1, "assigned", { login: "hubot", id: 5 }, "2026-10-11T07:00:00Z"),
              assignment(2, "unassigned", { login: "hubot", id: 5 }, "2026-10-11T09:00:00Z"),
              assignment(3, "assigned", TEST_ACCOUNT, "2026-10-11T09:10:00Z"),
            ],
          };
        }
        return path.endsWith("/issues/3")
          ? { status: 200, body: issue }
          : { status: 200, body: [] };
      }),
    );

    await runAgainstStub(
      pollFollowedItems(TEST_TOKEN, harness.context, [], TEST_IDENTITY, new Set()),
      stub,
    );

    expect(harness.events.map((event) => [event.kind, event.dedupKey])).toEqual([
      ["github.issue.unassigned", "issue.unassigned:2"],
      ["github.issue.assigned", "issue.assigned:3"],
    ]);
    expect(harness.events[1]!.refs).toContain(`github:issue:${REPO}#3`);
    expect(harness.events[1]!.payload).toMatchObject({
      assignee: TEST_ACCOUNT.login,
      toYou: true,
      byYou: false,
    });
  });

  it("emits the merge that ends an open signal on an item outside the watch list", async () => {
    const harness = buildIngestHarness();
    harness.openSignals.push({
      kind: "github/review-requested",
      threadRef: `github:pr:${REPO}#7`,
      eventDedupKey: "review-request-7",
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
          body: [buildComment(number, number, "2026-10-11T09:00:00Z")],
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
    const route = (updatedAt: string) =>
      answerSearches({ own: [buildFoundPull(1, updatedAt)] }, answerItem(buildPull));

    const { stub } = await pollOnce(harness, route("2026-10-11T08:30:00Z"));

    expect(stub.requests.filter((request) => !isUserRequest(request))).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(harness.state.get(`followed/github:pr:${REPO}#1`)).toEqual({
      since: "2026-10-11T08:30:01.000Z",
    });

    // The review request at 09:00 comes after the baseline.
    await pollOnce(harness, route("2026-10-11T09:30:00Z"));

    expect(harness.events.map((event) => event.kind)).toEqual(["github.pr.review-requested"]);
  });

  it("reads an own pull request whose read failed again, even once it is closed", async () => {
    const harness = buildIngestHarness();
    const answer = answerItem(buildPull);
    const own = [buildFoundPull(1, "2026-10-11T08:30:00Z")];
    await pollOnce(harness, answerSearches({ own }, answer));

    // The review request at 09:00 is read, then the history read fails.
    await pollOnce(harness, answerSearches({ own }, failHistoryReads(answer)));
    expect(harness.events).toEqual([]);

    // The pull request is closed, so the search no longer finds it.
    await pollOnce(harness, answerSearches({}, answer));

    expect(harness.events.map((event) => event.kind)).toEqual(["github.pr.review-requested"]);
  });

  it("goes back to a notification's hint from before an own pull request's last read", async () => {
    const harness = buildIngestHarness();
    const answer = answerItem((number) => buildPull(number));
    const route = answerSearches({ own: [buildFoundPull(1)] }, (request) => {
      const { path } = readStubRequestTarget(request);
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
            buildComment(400, 1, "2026-10-11T09:10:00Z", `@${TEST_IDENTITY.login} can you look?`),
          ],
        };
      }
      return answer(request);
    });
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

describe("pollFollowedItems, for pull requests the search finds asking for a review", () => {
  const FOLLOWED_1 = `followed/github:pr:${REPO}#1`;

  it("records what its first search finds, emits nothing, and marks the search baselined", async () => {
    const harness = buildIngestHarness();

    const { stub } = await pollOnce(
      harness,
      answerSearches(
        { asking: [buildFoundPull(1, "2026-10-11T08:30:00Z")] },
        answerItem(buildPull),
      ),
    );

    expect(stub.requests.filter((request) => !isUserRequest(request))).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(harness.state.get(FOLLOWED_1)).toEqual({ since: "2026-10-11T08:30:01.000Z" });
    expect(harness.state.get(REVIEW_REQUESTS_BASELINED_KEY)).toBe(true);
  });

  it("keeps a recorded pull request's time when a read finds it unchanged, so a later edit emits no old request", async () => {
    const harness = buildIngestHarness();
    // marta asked for the review at 09:30, the pull request's update time.
    const history = () => [buildReviewRequest(70, "2026-10-11T09:30:00Z")];
    const asking = [buildFoundPull(1)];
    await pollOnce(harness, answerSearches({ asking }, answerItem(buildPull, history)));

    await pollOnce(harness, answerSearches({ asking }, answerItem(buildPull, history)));
    expect(harness.state.get(FOLLOWED_1)).toEqual({ since: "2026-10-11T09:30:01.000Z" });

    // marta edits the title at 10:00.
    const edited = (number: number) => buildPull(number, { updated_at: "2026-10-11T10:00:00Z" });
    await pollOnce(
      harness,
      answerSearches(
        { asking: [buildFoundPull(1, "2026-10-11T10:00:00Z")] },
        answerItem(edited, history),
      ),
    );

    expect(harness.events).toEqual([]);
    expect(harness.state.get(FOLLOWED_1)).toEqual({ since: "2026-10-11T10:00:00Z" });
  });

  it("records an own pull request its first search also finds at the later of the two times", async () => {
    const harness = buildIngestHarness();

    await pollOnce(
      harness,
      answerSearches(
        {
          own: [buildFoundPull(1, "2026-10-11T08:30:00Z")],
          asking: [buildFoundPull(1, "2026-10-11T09:30:00Z")],
        },
        answerItem(buildPull),
      ),
    );

    expect(harness.state.get(FOLLOWED_1)).toEqual({ since: "2026-10-11T09:30:01.000Z" });
  });

  it("records what its first search finds and marks it baselined before a rate limit stops the poll", async () => {
    const harness = buildIngestHarness();
    await recordHints(harness, 2);
    const answer = answerItem(buildPull);
    const limited = answerSearches({ asking: [buildFoundPull(3)] }, (request) =>
      readItemNumber(request) === 1
        ? { status: 429, body: { message: "rate limit" }, headers: { "retry-after": "60" } }
        : answer(request),
    );

    const { result } = await pollOnce(harness, limited);

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(GithubRateLimited);
    expect(harness.state.get(`followed/github:pr:${REPO}#3`)).toEqual({
      since: "2026-10-11T09:30:01.000Z",
    });
    expect(harness.state.get(REVIEW_REQUESTS_BASELINED_KEY)).toBe(true);
  });

  it.each([
    {
      whom: "the user",
      target: { requested_reviewer: TEST_ACCOUNT },
      teams: [],
      payload: { reviewer: "you", toYou: true },
    },
    {
      whom: "one of the user's teams",
      target: { requested_team: { slug: "reviewers" } },
      teams: ["acme/reviewers"],
      payload: { reviewer: "team", team: "acme/reviewers", toYou: false },
    },
  ])(
    "emits the request to $whom that put a pull request in a later search",
    async ({ target, teams, payload }) => {
      const harness = buildIngestHarness();
      const answer = answerItem(buildPull, () => [
        buildReviewRequest(70, "2026-10-11T09:00:00Z", target),
      ]);
      // The first search finds nothing, so what the next one finds is new.
      await pollOnce(harness, answerSearches({}, answer));

      await pollOnce(harness, answerSearches({ asking: [buildFoundPull(1)] }, answer), { teams });

      expect(harness.events).toMatchObject([
        { kind: "github.pr.review-requested", dedupKey: "pr.review-requested:70", payload },
      ]);
    },
  );

  it("emits what happened on a newly found pull request after the request, and nothing before it", async () => {
    const harness = buildIngestHarness();
    harness.state.set(REVIEW_REQUESTS_BASELINED_KEY, true);
    const answer = answerItem(buildPull);
    const route = answerSearches({ asking: [buildFoundPull(1)] }, (request) =>
      readStubRequestTarget(request).path.endsWith("/comments")
        ? {
            status: 200,
            body: [
              buildComment(401, 1, "2026-10-11T08:50:00Z"),
              buildComment(402, 1, "2026-10-11T09:10:00Z"),
            ],
          }
        : answer(request),
    );

    await pollOnce(harness, route);

    // The request is at 09:00, between the two comments.
    expect(harness.events.map((event) => event.dedupKey)).toEqual([
      "pr.review-requested:1",
      "pr.commented:402",
    ]);
  });

  it("records a found pull request whose history names no request to the user, and warns once", async () => {
    const harness = buildIngestHarness();
    harness.state.set(REVIEW_REQUESTS_BASELINED_KEY, true);
    const toSomeoneElse = { requested_reviewer: { login: "hubot", id: 5 } };
    const route = answerSearches(
      { asking: [buildFoundPull(1)] },
      answerItem(buildPull, () => [buildReviewRequest(70, "2026-10-11T09:00:00Z", toSomeoneElse)]),
    );
    const namesPull = (warning: string) => warning.includes(`${REPO}#1`);

    const first = await pollOnce(harness, route);

    expect(harness.events).toEqual([]);
    expect(harness.state.get(FOLLOWED_1)).toEqual({ since: "2026-10-11T09:30:01.000Z" });
    expect(first.warnings.filter(namesPull)).toHaveLength(1);

    const second = await pollOnce(harness, route);

    expect(second.warnings.filter(namesPull)).toEqual([]);
  });

  it("reads a found pull request it already follows from its stored time, with no lookup", async () => {
    const harness = buildIngestHarness();
    harness.state.set(REVIEW_REQUESTS_BASELINED_KEY, true);
    harness.state.set(FOLLOWED_1, { since: "2026-10-11T09:10:00Z" });

    const { stub } = await pollOnce(
      harness,
      answerSearches({ asking: [buildFoundPull(1)] }, answerItem(buildPull)),
    );

    // The request at 09:00 is before the stored time, so it is not emitted.
    // The one history read is the item's own read: there is no lookup.
    expect(harness.events).toEqual([]);
    expect(countHistoryReads(stub)).toBe(1);
    expect(harness.state.get(FOLLOWED_1)).toEqual({ since: "2026-10-11T09:30:00Z" });
  });

  it("reads a found pull request a notification also named once, from the notification's time", async () => {
    const harness = buildIngestHarness();
    harness.state.set(REVIEW_REQUESTS_BASELINED_KEY, true);
    // The notification's time is 08:00.
    await recordHints(harness, 1);
    const answer = answerItem(buildPull);
    const route = answerSearches({ asking: [buildFoundPull(1)] }, (request) =>
      readStubRequestTarget(request).path.endsWith("/comments")
        ? { status: 200, body: [buildComment(401, 1, "2026-10-11T08:30:00Z")] }
        : answer(request),
    );

    const { stub } = await pollOnce(harness, route);

    const itemRequests = stub.requests.filter((request) => !isUserRequest(request));
    // The item is read first, and its one history read is its own: there is no lookup.
    expect(readStubRequestTarget(itemRequests[0]!).path).toBe(`/repos/${REPO}/issues/1`);
    expect(countHistoryReads(stub)).toBe(1);
    // The comment at 08:30 is after the notification's time and before the
    // request at 09:00. The request has the key a search alone gives it.
    expect(harness.events.map((event) => event.dedupKey)).toEqual([
      "pr.commented:401",
      "pr.review-requested:1",
    ]);
  });

  it("reads an own pull request the search for review requests also finds, rather than recording it", async () => {
    const harness = buildIngestHarness();
    harness.state.set(REVIEW_REQUESTS_BASELINED_KEY, true);
    const found = [buildFoundPull(1)];

    await pollOnce(harness, answerSearches({ own: found, asking: found }, answerItem(buildPull)));

    expect(harness.events.map((event) => event.dedupKey)).toEqual(["pr.review-requested:1"]);
  });

  it("leaves a found pull request in a watched repository to the watch list's poll", async () => {
    const harness = buildIngestHarness();
    harness.state.set(REVIEW_REQUESTS_BASELINED_KEY, true);
    const asking = [buildFoundPull(1), buildFoundPull(2, undefined, "acme/other")];

    const { stub } = await pollOnce(harness, answerSearches({ asking }, answerItem(buildPull)), {
      watchList: [REPO],
    });

    const paths = stub.requests
      .filter((request) => !isUserRequest(request))
      .map((request) => readStubRequestTarget(request).path);
    expect(paths).not.toEqual([]);
    expect(paths.filter((path) => !path.startsWith("/repos/acme/other/"))).toEqual([]);
    expect(harness.state.has(FOLLOWED_1)).toBe(false);
  });

  it("forgets a pull request that leaves the search, and emits a new request when it is found again", async () => {
    const harness = buildIngestHarness();
    harness.state.set(REVIEW_REQUESTS_BASELINED_KEY, true);
    const answer = answerItem(buildPull);
    await pollOnce(harness, answerSearches({ asking: [buildFoundPull(1)] }, answer));

    // The user reviewed, so the search no longer finds the pull request.
    await pollOnce(harness, answerSearches({}, answer));
    expect(harness.state.has(FOLLOWED_1)).toBe(false);

    // marta asks again at 10:00.
    const askedAgain = answerItem(buildPull, () => [
      buildReviewRequest(1, "2026-10-11T09:00:00Z"),
      buildReviewRequest(2, "2026-10-11T10:00:00Z"),
    ]);
    await pollOnce(
      harness,
      answerSearches({ asking: [buildFoundPull(1, "2026-10-11T10:00:00Z")] }, askedAgain),
    );

    expect(harness.events.map((event) => event.dedupKey)).toEqual([
      "pr.review-requested:1",
      "pr.review-requested:2",
    ]);
  });

  it("counts the searches and the lookups toward the request limit, and leaves the rest for the next poll", async () => {
    const harness = buildIngestHarness();
    harness.state.set(REVIEW_REQUESTS_BASELINED_KEY, true);
    const found = Array.from({ length: 25 }, (_, index) => buildFoundPull(index + 1));
    const route = answerSearches({ asking: found }, answerItem(buildPull));

    const first = await pollOnce(harness, route);

    // Each item costs six requests: the lookup, the item, its comments,
    // reviews and history, and the pull request. The two searches come first.
    const read = Math.ceil((MAX_FOLLOWED_REQUESTS_PER_POLL - 2) / 6);
    expect(harness.events).toHaveLength(read);
    expect(first.warnings).toContainEqual(
      expect.stringContaining(`so ${String(found.length - read)} wait for the next poll`),
    );

    await pollOnce(harness, route);

    expect(harness.events).toHaveLength(found.length);
  });

  it("records nothing for a found pull request whose lookup fails, and finds it again at the next poll", async () => {
    const harness = buildIngestHarness();
    harness.state.set(REVIEW_REQUESTS_BASELINED_KEY, true);
    const answer = answerItem(buildPull);
    const asking = [buildFoundPull(1)];

    await pollOnce(harness, answerSearches({ asking }, failHistoryReads(answer)));

    expect(harness.events).toEqual([]);
    expect(harness.state.has(FOLLOWED_1)).toBe(false);
    expect(harness.state.has("followed-hints")).toBe(false);

    await pollOnce(harness, answerSearches({ asking }, answer));

    expect(harness.events.map((event) => event.dedupKey)).toEqual(["pr.review-requested:1"]);
  });
});
