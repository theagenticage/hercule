/** Tests how the plugin tells a rate-limited response from any other refusal. */
import { describe, expect, it } from "vitest";
import { isRateLimited, type GithubResponse } from "./api";

/** Builds a response with this status and these rate-limit headers, already parsed. */
const buildResponse = (
  status: number,
  headers: Pick<GithubResponse, "retryAfterSeconds" | "rateLimitRemaining"> = {},
): GithubResponse => ({ status, body: null, ...headers });

describe("isRateLimited", () => {
  it("counts a 429 as a rate limit, with or without headers", () => {
    expect(isRateLimited(buildResponse(429))).toBe(true);
  });

  it("counts a 403 with Retry-After as a rate limit", () => {
    expect(isRateLimited(buildResponse(403, { retryAfterSeconds: 60 }))).toBe(true);
  });

  it("counts a 403 with no requests left as a rate limit", () => {
    expect(isRateLimited(buildResponse(403, { rateLimitRemaining: 0 }))).toBe(true);
  });

  it("does not count a 403 with requests left and no Retry-After", () => {
    expect(isRateLimited(buildResponse(403))).toBe(false);
    expect(isRateLimited(buildResponse(403, { rateLimitRemaining: 4999 }))).toBe(false);
  });

  it("does not count a success, even one that used the last request", () => {
    expect(isRateLimited(buildResponse(200, { rateLimitRemaining: 0 }))).toBe(false);
  });
});
