/**
 * Tests how the plugin sends a request to GitHub: where it may send the
 * token, how long it waits for an answer, and how it tells a rate-limited
 * response from any other refusal.
 */
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  computeRateLimitWaitSeconds,
  GITHUB_REQUEST_TIMEOUT,
  isRateLimited,
  requestGithub,
  type GithubResponse,
} from "./api";
import { TEST_TOKEN } from "./actions/testing";
import { runAgainstStub, stubGithub, stubHttpClient } from "./testing";

/** Builds a response with this status, and these rate-limit headers and body, already parsed. */
const buildResponse = (
  status: number,
  fields: Partial<
    Pick<GithubResponse, "retryAfterSeconds" | "rateLimitRemaining" | "rateLimitResetAt" | "body">
  > = {},
): GithubResponse => ({ status, body: null, ...fields });

describe("requestGithub", () => {
  it("sends a path to GitHub's API with the token", async () => {
    const stub = stubGithub(() => ({ status: 200, body: {} }));

    const outcome = await runAgainstStub(
      requestGithub({ method: "GET", path: "/user", token: TEST_TOKEN }),
      stub,
    );

    expect(Result.isSuccess(outcome)).toBe(true);
    expect(stub.requests.map((request) => request.url)).toEqual(["https://api.github.com/user"]);
    expect(stub.requests[0]?.headers["authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("refuses to send the token to a full URL on another origin", async () => {
    const stub = stubGithub(() => ({ status: 200, body: {} }));

    const outcome = await runAgainstStub(
      requestGithub({ method: "GET", path: "https://example.com/user", token: TEST_TOKEN }),
      stub,
    );

    if (!Result.isFailure(outcome)) throw new Error("the request was expected to fail");
    expect(outcome.failure._tag).toBe("GithubUnreachable");
    expect(outcome.failure.message).toContain("https://example.com");
    expect(stub.requests).toEqual([]);
  });

  it("refuses a path that would move the request to another host", async () => {
    const stub = stubGithub(() => ({ status: 200, body: {} }));

    const outcome = await runAgainstStub(
      requestGithub({ method: "GET", path: "@example.com/user", token: TEST_TOKEN }),
      stub,
    );

    expect(Result.isFailure(outcome)).toBe(true);
    expect(stub.requests).toEqual([]);
  });

  it("refuses to follow a next-page link to another origin", async () => {
    const stub = stubGithub(() => ({
      status: 200,
      body: [],
      headers: { link: '<https://example.com/repos?page=2>; rel="next"' },
    }));

    const outcome = await runAgainstStub(
      Effect.gen(function* () {
        const first = yield* requestGithub({ method: "GET", path: "/repos", token: TEST_TOKEN });
        return yield* requestGithub({
          method: "GET",
          path: first.nextPageUrl ?? "",
          token: TEST_TOKEN,
        });
      }),
      stub,
    );

    expect(Result.isFailure(outcome)).toBe(true);
    expect(stub.requests.map((request) => request.url)).toEqual(["https://api.github.com/repos"]);
  });

  it("fails as unreachable when GitHub does not answer in time", async () => {
    const stub = stubHttpClient(() => Effect.never);

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const running = yield* Effect.forkChild(
          Effect.result(requestGithub({ method: "GET", path: "/user", token: TEST_TOKEN })),
        );
        yield* TestClock.adjust(GITHUB_REQUEST_TIMEOUT);
        return yield* Fiber.join(running);
      }).pipe(Effect.provide(stub.layer), Effect.provide(TestClock.layer())),
    );

    if (!Result.isFailure(outcome)) throw new Error("the request was expected to fail");
    expect(outcome.failure._tag).toBe("GithubUnreachable");
    expect(outcome.failure.message).toBe("GitHub did not answer GET /user within 30 seconds.");
  });
});

describe("isRateLimited", () => {
  it("counts a 429 as a rate limit, with or without headers", () => {
    expect(isRateLimited(buildResponse(429))).toBe(true);
    expect(isRateLimited(buildResponse(429, { rateLimitRemaining: 5 }))).toBe(true);
  });

  it("counts a 403 with Retry-After as a rate limit", () => {
    expect(isRateLimited(buildResponse(403, { retryAfterSeconds: 60 }))).toBe(true);
  });

  it("counts a 403 with no requests left as a rate limit", () => {
    expect(isRateLimited(buildResponse(403, { rateLimitRemaining: 0 }))).toBe(true);
  });

  it("counts a 403 about a secondary rate limit as a rate limit, though requests are left", () => {
    const response = buildResponse(403, {
      rateLimitRemaining: 4999,
      body: {
        message:
          "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      },
    });

    expect(isRateLimited(response)).toBe(true);
  });

  it("does not count any other 403", () => {
    expect(isRateLimited(buildResponse(403))).toBe(false);
    expect(
      isRateLimited(
        buildResponse(403, {
          rateLimitRemaining: 4999,
          body: { message: "Resource not accessible by personal access token" },
        }),
      ),
    ).toBe(false);
  });

  it("does not count a success, even one that used the last request", () => {
    expect(isRateLimited(buildResponse(200, { rateLimitRemaining: 0 }))).toBe(false);
  });
});

describe("computeRateLimitWaitSeconds", () => {
  const NOW_MILLIS = 1_000_000_000_000;
  const NOW_SECONDS = NOW_MILLIS / 1000;

  it("waits as long as Retry-After asks", () => {
    const response = buildResponse(403, {
      retryAfterSeconds: 30,
      rateLimitRemaining: 0,
      rateLimitResetAt: NOW_SECONDS + 600,
    });

    expect(computeRateLimitWaitSeconds(response, NOW_MILLIS)).toBe(30);
  });

  it("waits until the window resets when no requests are left", () => {
    const response = buildResponse(403, {
      rateLimitRemaining: 0,
      rateLimitResetAt: NOW_SECONDS + 600,
    });

    expect(computeRateLimitWaitSeconds(response, NOW_MILLIS)).toBe(600);
  });

  it("waits a minute for a secondary rate limit, whenever the window resets", () => {
    const response = buildResponse(403, {
      rateLimitRemaining: 4999,
      rateLimitResetAt: NOW_SECONDS + 3000,
    });

    expect(computeRateLimitWaitSeconds(response, NOW_MILLIS)).toBe(60);
  });
});
