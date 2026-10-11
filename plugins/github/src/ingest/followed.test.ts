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

/**
 * Answers the requests for item `number`: the item itself, no comments, no
 * reviews, and a history with one review request to the user.
 */
const answerItem =
  (item: (number: number) => object) =>
  (request: HttpClientRequest.HttpClientRequest): StubResponse => {
    const { path } = readStubRequestTarget(request);
    const match = /\/(issues|pulls)\/(\d+)(\/\w+)?$/.exec(path);
    const number = Number(match?.[2]);
    switch (match?.[3]) {
      case undefined:
        return { status: 200, body: item(number) };
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
    const stub = stubGithub(answerUserRequests(answerItem((number) => buildPull(number))));

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
});
