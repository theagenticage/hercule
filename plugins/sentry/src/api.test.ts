/**
 * Tests how the plugin calls Sentry: that the token only goes to sentry.io,
 * how a response's headers are read, and how failures are told apart.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result, Schema } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { AuthError, PluginError } from "@hercule/plugin-host";
import {
  callSentry,
  computeRateLimitWaitSeconds,
  readPages,
  readToken,
  requestSentry,
  SentryRateLimited,
  TOKEN_REFUSED_MESSAGE,
} from "./api";
import { readFakeRequest, runAgainstStub, stubHttpClient, stubSentry, TEST_TOKEN } from "./testing";

const REQUEST = {
  method: "GET",
  baseUrl: "https://us.sentry.io",
  path: "/api/0/organizations/acme/teams/",
  token: TEST_TOKEN,
} as const;

/** Builds a `Link` header the way Sentry does. */
const link = (previous: boolean, next: boolean, cursor: string): string =>
  `<https://us.sentry.io/x?cursor=0>; rel="previous"; results="${String(previous)}"; cursor="0", ` +
  `<https://us.sentry.io/x?cursor=${cursor}>; rel="next"; results="${String(next)}"; cursor="${cursor}"`;

/** Builds a client that answers every request with a proxy's HTML page and `status`. */
const buildHtmlStub = (status: number, rateLimitResetAt?: string) =>
  stubHttpClient((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response("<html>a proxy</html>", {
          status,
          headers:
            rateLimitResetAt === undefined ? {} : { "x-sentry-rate-limit-reset": rateLimitResetAt },
        }),
      ),
    ),
  );

describe("requestSentry", () => {
  it("sends the token as a bearer token with a user agent, and returns the status and body", async () => {
    const stub = stubSentry(() => ({ status: 200, body: [{ id: "1" }] }));

    const result = await runAgainstStub(requestSentry({ ...REQUEST, query: [["a", "1"]] }), stub);

    expect(Result.isSuccess(result) && result.success).toMatchObject({
      status: 200,
      body: [{ id: "1" }],
    });
    const sent = stub.requests[0]!;
    expect(sent.headers["authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
    expect(sent.headers["user-agent"]).toBe("Hercule");
  });

  it("reads the next cursor only when the link says there are results", async () => {
    const more = stubSentry(() => ({
      status: 200,
      body: [],
      headers: { link: link(false, true, "100") },
    }));
    const last = stubSentry(() => ({
      status: 200,
      body: [],
      headers: { link: link(true, false, "200") },
    }));

    const first = await runAgainstStub(requestSentry(REQUEST), more);
    const second = await runAgainstStub(requestSentry(REQUEST), last);

    expect(Result.isSuccess(first) && first.success.nextCursor).toBe("100");
    expect(Result.isSuccess(second) && second.success.nextCursor).toBeUndefined();
  });

  it("reads the end of the rate limit window", async () => {
    const stub = stubSentry(() => ({
      status: 200,
      body: null,
      headers: { "x-sentry-rate-limit-reset": "1790000000" },
    }));

    const result = await runAgainstStub(requestSentry(REQUEST), stub);

    expect(Result.isSuccess(result) && result.success.rateLimitResetAt).toBe(1790000000);
  });

  it.each([
    "http://sentry.io",
    "https://example.com",
    "https://sentry.io.example.com",
    "https://evilsentry.io",
    "https://sentry.io:8443",
    "not a url",
  ])("sends nothing to %s", async (baseUrl) => {
    const stub = stubSentry(() => ({ status: 200, body: null }));

    const result = await runAgainstStub(requestSentry({ ...REQUEST, baseUrl }), stub);

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(PluginError);
    expect(stub.requests).toHaveLength(0);
  });

  it("sends nothing when the path would replace the host", async () => {
    const stub = stubSentry(() => ({ status: 200, body: null }));

    const result = await runAgainstStub(
      requestSentry({ ...REQUEST, path: "//example.com/steal" }),
      stub,
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(stub.requests).toHaveLength(0);
  });

  it("fails when the body of a successful response is not JSON", async () => {
    const result = await runAgainstStub(requestSentry(REQUEST), buildHtmlStub(200));

    expect(Result.isFailure(result) && result.failure.message).toContain("not JSON");
  });

  it("returns the status of a response that is not JSON, so the caller can classify it", async () => {
    const result = await runAgainstStub(requestSentry(REQUEST), buildHtmlStub(429, "1790000000"));

    expect(Result.isSuccess(result) && result.success).toMatchObject({
      status: 429,
      body: null,
      rateLimitResetAt: 1790000000,
    });
  });

  it("fails with a PluginError when Sentry cannot be reached", async () => {
    const stub = stubHttpClient((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request }),
        }),
      ),
    );

    const result = await runAgainstStub(requestSentry(REQUEST), stub);

    expect(Result.isFailure(result) && result.failure.message).toContain("could not be reached");
  });
});

describe("callSentry", () => {
  const call = (status: number, headers: Record<string, string> = {}, body: unknown = {}) =>
    runAgainstStub(
      callSentry(REQUEST),
      stubSentry(() => ({ status, body, headers })),
    );

  it("fails with an AuthError on a 401", async () => {
    const result = await call(401);

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(AuthError);
    if (Result.isFailure(result)) expect(result.failure.message).toBe(TOKEN_REFUSED_MESSAGE);
  });

  it("fails with the wait Sentry asked for on a 429", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 25);

    const result = await call(429, { "x-sentry-rate-limit-reset": reset });

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(SentryRateLimited);
    if (Result.isFailure(result) && result.failure instanceof SentryRateLimited) {
      expect(result.failure.retryAfterSeconds).toBeGreaterThanOrEqual(24);
      expect(result.failure.retryAfterSeconds).toBeLessThanOrEqual(25);
    }
  });

  it("fails with an AuthError on a 401 whose body is not JSON", async () => {
    const result = await runAgainstStub(callSentry(REQUEST), buildHtmlStub(401));

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(AuthError);
  });

  it("fails with the wait Sentry asked for on a 429 whose body is not JSON", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 25);

    const result = await runAgainstStub(callSentry(REQUEST), buildHtmlStub(429, reset));

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(SentryRateLimited);
    if (Result.isFailure(result) && result.failure instanceof SentryRateLimited) {
      expect(result.failure.retryAfterSeconds).toBeGreaterThanOrEqual(24);
      expect(result.failure.retryAfterSeconds).toBeLessThanOrEqual(25);
    }
  });

  it("waits a minute after a 429 that says nothing about the window", async () => {
    const result = await call(429);

    expect(Result.isFailure(result) && result.failure).toMatchObject({ retryAfterSeconds: 60 });
  });

  it("fails with a plain PluginError on a 403, hinting at a gone project", async () => {
    const result = await call(403, {}, { detail: "No permission." });

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(PluginError);
    if (Result.isFailure(result)) {
      expect(result.failure).not.toBeInstanceOf(AuthError);
      expect(result.failure.message).toContain("No permission.");
      expect(result.failure.message).toContain("gone or hidden");
    }
  });

  it("returns a status the caller tolerates", async () => {
    const result = await runAgainstStub(
      callSentry(REQUEST, [404]),
      stubSentry(() => ({ status: 404, body: { detail: "Not found" } })),
    );

    expect(Result.isSuccess(result) && result.success.status).toBe(404);
  });
});

describe("computeRateLimitWaitSeconds", () => {
  it("waits until the window ends, and at least one second", () => {
    const now = 1_790_000_000_000;

    expect(computeRateLimitWaitSeconds({ rateLimitResetAt: 1_790_000_017 }, now)).toBe(17);
    expect(computeRateLimitWaitSeconds({ rateLimitResetAt: 1_789_999_000 }, now)).toBe(1);
    expect(computeRateLimitWaitSeconds({}, now)).toBe(60);
  });
});

describe("readPages", () => {
  it("follows the cursor until the last page", async () => {
    const pages: Record<string, { id: string; link: string }> = {
      first: { id: "1", link: link(false, true, "a") },
      a: { id: "2", link: link(true, true, "b") },
      b: { id: "3", link: link(true, false, "c") },
    };
    const stub = stubSentry((raw) => {
      const page = pages[readFakeRequest(raw).params.get("cursor") ?? "first"]!;
      return { status: 200, body: [{ id: page.id }], headers: { link: page.link } };
    });

    const result = await runAgainstStub(
      readPages(REQUEST, Schema.Struct({ id: Schema.String }), 10),
      stub,
    );

    expect(Result.isSuccess(result) && result.success).toEqual({
      items: [{ id: "1" }, { id: "2" }, { id: "3" }],
      hasMore: false,
    });
  });

  it("stops at the page limit and says the list is partial", async () => {
    const stub = stubSentry(() => ({
      status: 200,
      body: [{ id: "1" }],
      headers: { link: link(false, true, "1") },
    }));

    const result = await runAgainstStub(
      readPages(REQUEST, Schema.Struct({ id: Schema.String }), 3),
      stub,
    );

    expect(Result.isSuccess(result) && result.success.hasMore).toBe(true);
    expect(stub.requests).toHaveLength(3);
  });

  it("fails naming the request when an item has another shape", async () => {
    const stub = stubSentry(() => ({ status: 200, body: [{ id: 1 }] }));

    const result = await runAgainstStub(
      readPages(REQUEST, Schema.Struct({ id: Schema.String }), 3),
      stub,
    );

    expect(Result.isFailure(result) && result.failure.message).toContain("expected shape");
  });
});

describe("readToken", () => {
  it("prefers the device flow's access token to the pasted one", () => {
    expect(readToken({ accessToken: "a", token: "b" })).toBe("a");
    expect(readToken({ token: "b" })).toBe("b");
    expect(readToken({})).toBeUndefined();
  });
});
