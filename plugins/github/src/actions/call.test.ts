/**
 * Tests what every GitHub action shares: reading the Connection's token, and
 * turning each kind of GitHub failure into the step error's code and message.
 * The failures are driven through `issue.read`, the simplest action, because
 * every action calls GitHub the same way.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type { ActionError } from "@hercule/plugin-host";
import { stubAnswer, stubGithub, stubHttpClient, type GithubStub } from "../testing";
import { issueRead } from "./issue";
import { buildActionContext, runAgainstStub, TEST_TOKEN } from "./testing";

const ADDRESS = { repo: "octocat/hello-world", number: 1347 };

/** Runs `issue.read` against a stub and returns the error it failed with. */
const readFailure = async (
  stub: GithubStub,
  context = buildActionContext(),
): Promise<ActionError> => {
  const outcome = await runAgainstStub(issueRead.perform(ADDRESS, context), stub);
  if (!Result.isFailure(outcome)) throw new Error("the action was expected to fail");
  return outcome.failure;
};

describe("the Connection's token", () => {
  it("sends the device flow's access token when no token was pasted", async () => {
    const stub = stubAnswer(404, { message: "Not Found" });

    await readFailure(stub, buildActionContext({ accessToken: "gho_device-token" }));

    expect(stub.requests[0]?.headers["authorization"]).toBe("Bearer gho_device-token");
  });

  it("fails without calling GitHub when the Connection has no token", async () => {
    const stub = stubAnswer(200, {});

    const error = await readFailure(stub, buildActionContext({}));

    expect(error.code).toBe("unauthenticated");
    expect(error.message).toContain("Reconnect");
    expect(stub.requests).toEqual([]);
  });

  it("fails without calling GitHub when the step has no Connection", async () => {
    const stub = stubAnswer(200, {});
    const { run, signal } = buildActionContext();
    const context = { run, signal };

    const error = await readFailure(stub, context);

    expect(error.code).toBe("unauthenticated");
    expect(error.message).toContain("connection param");
    expect(stub.requests).toEqual([]);
  });
});

describe("how a GitHub failure becomes the step's error", () => {
  it("reports a rejected token as unauthenticated, and asks to reconnect", async () => {
    const error = await readFailure(stubAnswer(401, { message: "Bad credentials" }));

    expect(error).toMatchObject({
      code: "unauthenticated",
      message: "GitHub rejected the Connection's token. Reconnect it under Connections.",
    });
  });

  it("reports a 403 as forbidden, with GitHub's message", async () => {
    const error = await readFailure(
      stubAnswer(403, { message: "Resource not accessible by personal access token" }),
    );

    expect(error.code).toBe("forbidden");
    expect(error.message).toContain("Resource not accessible by personal access token");
  });

  it("reports a 403 about the rate limit as rate_limited, with the wait GitHub asks for", async () => {
    const stub = stubGithub(() => ({
      status: 403,
      body: { message: "API rate limit exceeded for user ID 1." },
      headers: { "x-ratelimit-remaining": "0", "retry-after": "60" },
    }));

    const error = await readFailure(stub);

    expect(error.code).toBe("rate_limited");
    expect(error.message).toContain("60 seconds");
  });

  it("reports a 403 with no requests left as rate_limited, even without Retry-After", async () => {
    const stub = stubGithub(() => ({
      status: 403,
      body: { message: "API rate limit exceeded for user ID 1." },
      headers: { "x-ratelimit-remaining": "0" },
    }));

    const error = await readFailure(stub);

    expect(error.code).toBe("rate_limited");
    expect(error.message).toContain("Try again later.");
  });

  it("reports a 403 as forbidden when requests are left, whatever its message says", async () => {
    const stub = stubGithub(() => ({
      status: 403,
      body: { message: "Mentions the rate limit, but is not one." },
      headers: { "x-ratelimit-remaining": "4999" },
    }));

    const error = await readFailure(stub);

    expect(error.code).toBe("forbidden");
  });

  it("reports a 429 as rate_limited", async () => {
    const error = await readFailure(
      stubAnswer(429, { message: "You have exceeded a secondary rate limit." }),
    );

    expect(error.code).toBe("rate_limited");
    expect(error.message).toContain("Try again later.");
  });

  it("reports a 404 as not_found, naming what was asked for", async () => {
    const error = await readFailure(stubAnswer(404, { message: "Not Found" }));

    expect(error).toMatchObject({
      code: "not_found",
      message:
        "The issue octocat/hello-world#1347 does not exist, or the Connection's account cannot see it.",
    });
  });

  it("reports a 405 and a 409 as conflict, with GitHub's message", async () => {
    const notMergeable = await readFailure(
      stubAnswer(405, { message: "Pull Request is not mergeable" }),
    );
    const moved = await readFailure(
      stubAnswer(409, { message: "Head branch was modified. Review and try the merge again." }),
    );

    expect(notMergeable.code).toBe("conflict");
    expect(notMergeable.message).toContain("Pull Request is not mergeable");
    expect(moved.code).toBe("conflict");
    expect(moved.message).toContain("Head branch was modified");
  });

  it("reports a 422 as validation, with what GitHub found wrong with each field", async () => {
    const error = await readFailure(
      stubAnswer(422, {
        message: "Validation Failed",
        errors: [
          { resource: "PullRequest", code: "custom", message: "A pull request already exists." },
          { resource: "PullRequest", field: "head", code: "invalid" },
        ],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.message).toBe(
      "GitHub refused the request as invalid. GitHub said: Validation Failed: A pull request already exists.: head invalid",
    );
  });

  it("reports a 5xx as unavailable", async () => {
    const error = await readFailure(stubAnswer(502, { message: "Server Error" }));

    expect(error).toMatchObject({ code: "unavailable" });
    expect(error.message).toContain("502");
  });

  it("reports any other status as unexpected, with the status", async () => {
    const error = await readFailure(stubAnswer(418, { message: "I'm a teapot" }));

    expect(error.code).toBe("unexpected");
    expect(error.message).toContain("418");
  });

  it("reports a request that never reached GitHub as unavailable", async () => {
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

    const error = await readFailure(stub);

    expect(error.code).toBe("unavailable");
  });

  it("reports a 2xx body of the wrong shape as unexpected", async () => {
    const error = await readFailure(stubAnswer(200, { number: "not a number" }));

    expect(error.code).toBe("unexpected");
    expect(error.message).toContain("expected shape");
  });

  it("never puts the token in the error", async () => {
    const errors = await Promise.all(
      [401, 403, 404, 405, 422, 500].map((status) =>
        readFailure(stubAnswer(status, { message: "failed" })),
      ),
    );

    for (const error of errors) expect(error.message).not.toContain(TEST_TOKEN);
  });
});
