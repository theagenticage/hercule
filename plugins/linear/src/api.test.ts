/**
 * Tests how the plugin calls Linear's API: the request it sends, and how it
 * reads Linear's answers, failures and rate limits.
 */
import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { AuthError } from "@hercule/plugin-host";
import {
  buildAuthorization,
  callLinear,
  computeRateLimitWaitSeconds,
  CREDENTIAL_REFUSED_MESSAGE,
  LinearRateLimited,
  readPages,
} from "./api";
import { runAgainstStub, stubLinear, type StubResponse } from "./testing";

const VIEWER = { name: "LinearViewer", text: "query LinearViewer { viewer { id } }" };
const ViewerAnswer = Schema.Struct({ viewer: Schema.Struct({ id: Schema.String }) });

/** Calls the viewer query against a stub that answers `response`. */
const callViewer = (response: StubResponse) => {
  const stub = stubLinear(() => response);
  return runAgainstStub(callLinear("lin_api_key", VIEWER, ViewerAnswer), stub);
};

describe("buildAuthorization", () => {
  it("sends an access token as a bearer token, and an API key as it is", () => {
    expect(buildAuthorization({ accessToken: "tok" })).toBe("Bearer tok");
    expect(buildAuthorization({ apiKey: "lin_api_key" })).toBe("lin_api_key");
    expect(buildAuthorization({})).toBeUndefined();
  });
});

describe("callLinear", () => {
  it("posts the operation by name with its variables, and returns the decoded data", async () => {
    const stub = stubLinear(() => ({ status: 200, body: { data: { viewer: { id: "u1" } } } }));

    const result = await runAgainstStub(
      callLinear("lin_api_key", { ...VIEWER, variables: { first: 1 } }, ViewerAnswer),
      stub,
    );

    expect(result).toEqual(Result.succeed({ viewer: { id: "u1" } }));
    expect(stub.requests).toEqual([
      { operationName: "LinearViewer", variables: { first: 1 }, authorization: "lin_api_key" },
    ]);
  });

  it("fails with an AuthError on a 401", async () => {
    const result = await callViewer({
      status: 401,
      body: { errors: [{ message: "Authentication required, not authenticated" }] },
    });

    expect(result).toEqual(Result.fail(new AuthError({ message: CREDENTIAL_REFUSED_MESSAGE })));
  });

  it("fails with LinearRateLimited on a 400 with the code RATELIMITED", async () => {
    const result = await callViewer({
      status: 400,
      headers: { "retry-after": "12" },
      body: { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] },
    });

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(LinearRateLimited);
    expect(Result.isFailure(result) && result.failure).toMatchObject({ retryAfterSeconds: 12 });
  });

  it("fails with Linear's message when a 200 carries errors", async () => {
    const result = await callViewer({
      status: 200,
      body: { data: null, errors: [{ message: "Entity not found" }] },
    });

    expect(Result.isFailure(result) && result.failure.message).toBe(
      "Linear answered LinearViewer with errors. Linear said: Entity not found",
    );
  });

  it("fails naming the status for another failure", async () => {
    const result = await callViewer({ status: 503 });

    expect(Result.isFailure(result) && result.failure.message).toBe(
      "Linear answered 503 to LinearViewer.",
    );
  });

  it("fails naming the query when the data has another shape", async () => {
    const result = await callViewer({ status: 200, body: { data: { viewer: null } } });

    expect(Result.isFailure(result) && result.failure.message).toContain(
      "Linear's answer to LinearViewer did not have the expected shape",
    );
  });
});

describe("computeRateLimitWaitSeconds", () => {
  const now = 1_791_903_000_000;

  it("waits as long as retry-after says, at least a second", () => {
    expect(computeRateLimitWaitSeconds({ "retry-after": "30" }, now)).toBe(30);
    expect(computeRateLimitWaitSeconds({ "retry-after": "0" }, now)).toBe(1);
  });

  it("waits until the reset of the limit that ran out, which is in epoch milliseconds", () => {
    expect(
      computeRateLimitWaitSeconds(
        {
          "x-ratelimit-requests-remaining": "0",
          "x-ratelimit-requests-reset": String(now + 90_500),
          "x-ratelimit-complexity-reset": String(now + 5_000),
        },
        now,
      ),
    ).toBe(91);
    expect(
      computeRateLimitWaitSeconds(
        {
          "x-ratelimit-requests-remaining": "12",
          "x-ratelimit-requests-reset": String(now + 90_000),
          "x-ratelimit-complexity-reset": String(now + 5_000),
        },
        now,
      ),
    ).toBe(5);
  });

  it("waits a minute when Linear names no time", () => {
    expect(computeRateLimitWaitSeconds({}, now)).toBe(60);
  });
});

describe("readPages", () => {
  const Item = Schema.Struct({ id: Schema.String });
  const query = {
    name: "LinearTeamChoices",
    text: "query LinearTeamChoices { teams { nodes { id } } }",
  };

  /** Answers pages of one item each from `ids`, with the cursor as the next index. */
  const pageThrough = (ids: ReadonlyArray<string>) =>
    stubLinear((request) => {
      const start =
        typeof request.variables["after"] === "string" ? Number(request.variables["after"]) : 0;
      const hasNextPage = start + 1 < ids.length;
      return {
        status: 200,
        body: {
          data: {
            teams: {
              nodes: ids.slice(start, start + 1).map((id) => ({ id })),
              pageInfo: { hasNextPage, endCursor: hasNextPage ? String(start + 1) : null },
            },
          },
        },
      };
    });

  it("follows the cursor and asks for the largest page", async () => {
    const stub = pageThrough(["a", "b", "c"]);

    const result = await runAgainstStub(readPages("key", query, "teams", Item, 4), stub);

    expect(result).toEqual(
      Result.succeed({ items: [{ id: "a" }, { id: "b" }, { id: "c" }], hasMore: false }),
    );
    expect(stub.requests.map((request) => request.variables)).toEqual([
      { first: 250, after: null },
      { first: 250, after: "1" },
      { first: 250, after: "2" },
    ]);
  });

  it("stops after the most pages it may read, and says there are more", async () => {
    const result = await runAgainstStub(
      readPages("key", query, "teams", Item, 2),
      pageThrough(["a", "b", "c"]),
    );

    expect(result).toEqual(Result.succeed({ items: [{ id: "a" }, { id: "b" }], hasMore: true }));
  });
});
