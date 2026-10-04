/**
 * Tests what every feed shares: how GitHub's failures and rate limits reach
 * the host, the token, the config, and the watch list read on every poll.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { AuthError, PluginError } from "@hercule/plugin-host";
import {
  buildIngestHarness,
  stubGithub,
  stubHttpClient,
  type GithubStub,
  type IngestHarness,
  type StubResponse,
} from "../testing";
import type { GithubConnectionConfig } from "../connection-type";
import { openGithubIngest, pollGithubFeed } from "./index";

/** Polls `feed` once against `stub` and returns the result, success or failure. */
const poll = (
  stub: GithubStub,
  feed = "notifications",
  harness: IngestHarness = buildIngestHarness(),
  config: GithubConnectionConfig = {},
) =>
  Effect.runPromise(
    Effect.result(pollGithubFeed(feed, config, harness.context).pipe(Effect.provide(stub.layer))),
  );

/** Returns a stub that answers every request with `response`. */
const answerAlways = (response: StubResponse): GithubStub => stubGithub(() => response);

describe("a GitHub feed's poll", () => {
  it("fails with an AuthError when GitHub rejects the token", async () => {
    const result = await poll(answerAlways({ status: 401, body: { message: "Bad credentials" } }));

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure).toBeInstanceOf(AuthError);
    expect(result.failure.message).toContain("Bad credentials");
  });

  it("fails with an AuthError when the Connection holds no token", async () => {
    const result = await poll(
      answerAlways({ status: 200, body: [] }),
      "notifications",
      buildIngestHarness({}),
    );

    expect(Result.isFailure(result) && result.failure instanceof AuthError).toBe(true);
  });

  it("fails with a PluginError on a server error, naming the request", async () => {
    const result = await poll(answerAlways({ status: 502, body: { message: "Server Error" } }));

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure).toBeInstanceOf(PluginError);
    expect(result.failure.message).toContain("502");
    expect(result.failure.message).toContain("GET /notifications");
  });

  it("fails with a PluginError when GitHub cannot be reached", async () => {
    const stub = stubHttpClient((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: "connection refused",
          }),
        }),
      ),
    );

    const result = await poll(stub);

    expect(Result.isFailure(result) && result.failure instanceof PluginError).toBe(true);
  });

  it("succeeds with GitHub's Retry-After as the wait when rate limited", async () => {
    const limited = await poll(answerAlways({ status: 429, headers: { "retry-after": "90" } }));
    const forbidden = await poll(
      answerAlways({
        status: 403,
        body: { message: "secondary rate limit" },
        headers: { "retry-after": "30" },
      }),
    );

    expect(limited).toEqual(Result.succeed({ nextAfterSeconds: 90 }));
    expect(forbidden).toEqual(Result.succeed({ nextAfterSeconds: 30 }));
  });

  it("waits until the rate limit resets when the token has no requests left", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 600;

    const result = await poll(
      answerAlways({
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) },
      }),
    );

    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.nextAfterSeconds).toBeGreaterThanOrEqual(599);
    expect(result.success.nextAfterSeconds).toBeLessThanOrEqual(600);
  });

  it("treats a 403 that is not a rate limit as a failure", async () => {
    const result = await poll(
      answerAlways({
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      }),
    );

    expect(Result.isFailure(result) && result.failure instanceof PluginError).toBe(true);
  });

  it("fails with a PluginError for a feed it does not have", async () => {
    const result = await poll(answerAlways({ status: 200, body: [] }), "releases");

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure.message).toContain('"releases"');
  });

  it("reads the watch list on every poll, so a Resource linked later is watched from the next poll", async () => {
    const harness = buildIngestHarness();
    // Every repository is empty, so a first poll only records its state.
    const stub = answerAlways({ status: 200, body: [] });
    const config = { repos: ["Octocat/Spoon-Knife"] };

    await poll(stub, "repos", harness, config);
    expect([...harness.state.keys()]).toEqual(["repos/octocat/spoon-knife"]);

    harness.resources.push({
      id: "res_1",
      kind: "repo",
      label: null,
      remote: "github.com/octocat/hello-world",
    });
    await poll(stub, "repos", harness, config);

    expect([...harness.state.keys()].sort()).toEqual([
      "repos/octocat/hello-world",
      "repos/octocat/spoon-knife",
    ]);
    expect(harness.events).toEqual([]);
  });
});

describe("openGithubIngest", () => {
  it("refuses a Connection whose config is invalid", async () => {
    const harness = buildIngestHarness();

    const result = await Effect.runPromise(
      Effect.result(
        openGithubIngest({ id: "conn_1", config: { checksWindowDays: 90 } }, harness.context),
      ),
    );

    expect(Result.isFailure(result) && result.failure instanceof PluginError).toBe(true);
  });

  it("opens a Connection with the empty config", async () => {
    const harness = buildIngestHarness();

    const result = await Effect.runPromise(
      Effect.result(openGithubIngest({ id: "conn_1", config: {} }, harness.context)),
    );

    expect(Result.isSuccess(result)).toBe(true);
  });
});
