/**
 * Tests the three Sentry actions against the fake Sentry: the request each
 * sends, what the fake does with it, how Sentry's failures become an
 * `ActionError`, and the describe lines and outcomes a Signal's answer shows.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ActionError, type ActionContext } from "@hercule/plugin-host";
import {
  buildFakeIssue,
  buildFakeSentry,
  buildFakeWorld,
  runAgainstStub,
  stubHttpClient,
  TEST_TOKEN,
} from "../testing";
import { issueArchive, issueAssign, issueResolve } from "./issue";
import { buildActionContext } from "./testing";

const ADDRESS = {
  orgSlug: "acme",
  issueId: "1001",
  shortId: "WEBSHOP-1001",
  projectSlug: "webshop",
};

/** Runs an action's `perform` against a fake with one issue, and returns the result and the fake. */
const run = async <Input>(
  action: {
    readonly perform: (
      input: Input,
      context: ActionContext,
    ) => Effect.Effect<unknown, ActionError, HttpClient.HttpClient>;
  },
  input: Input,
  arrange: (fake: ReturnType<typeof buildFakeSentry>) => void = () => undefined,
  credentials?: Readonly<Record<string, string>>,
) => {
  const fake = buildFakeSentry(buildFakeWorld([buildFakeIssue("1001")]));
  arrange(fake);
  const result = await runAgainstStub(action.perform(input, buildActionContext(credentials)), fake);
  return { result, fake };
};

/** Returns the one PUT request the fake received. */
const readUpdate = (fake: ReturnType<typeof buildFakeSentry>) => {
  const puts = fake.requests.filter((request) => request.method === "PUT");
  expect(puts).toHaveLength(1);
  return puts[0]!;
};

describe("issue.resolve", () => {
  it("sends status resolved to the issue's address on sentry.io", async () => {
    const { result, fake } = await run(issueResolve, ADDRESS);

    const request = readUpdate(fake);
    expect(request.origin).toBe("https://sentry.io");
    expect(request.path).toBe("/api/0/organizations/acme/issues/1001/");
    expect(request.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(request.body).toEqual({ status: "resolved" });
    expect(Result.isSuccess(result) && result.success).toEqual({
      issueId: "1001",
      status: "resolved",
    });
    expect(fake.world.issues[0]?.status).toBe("resolved");
  });

  it("uses the access token of a Connection made with the device flow", async () => {
    const { result } = await run(issueResolve, ADDRESS, () => undefined, {
      accessToken: TEST_TOKEN,
    });

    expect(Result.isSuccess(result)).toBe(true);
  });

  it("describes itself and its outcome from the stored input", () => {
    expect(issueResolve.describe(ADDRESS)).toEqual([
      { kind: "text", text: "Resolves " },
      { kind: "text", text: "issue " },
      { kind: "marked", text: "WEBSHOP-1001" },
      { kind: "text", text: " in " },
      { kind: "marked", text: "acme/webshop" },
    ]);
    expect(issueResolve.outcome?.(ADDRESS)).toBe("Resolved WEBSHOP-1001");
  });

  it("describes an input that names no issue without failing", () => {
    expect(issueResolve.describe({})).toEqual([
      { kind: "text", text: "Resolves " },
      { kind: "text", text: "a Sentry issue" },
    ]);
    expect(issueResolve.describe(undefined)).toHaveLength(2);
    expect(issueResolve.outcome?.(null)).toBe("Resolved the issue");
  });
});

describe("issue.archive", () => {
  it("archives until the issue escalates by default", async () => {
    const { fake } = await run(issueArchive, ADDRESS);

    expect(readUpdate(fake).body).toEqual({
      status: "ignored",
      substatus: "archived_until_escalating",
    });
  });

  it("archives until it escalates when asked", async () => {
    const { fake } = await run(issueArchive, { ...ADDRESS, until: "escalating" });

    expect(readUpdate(fake).body).toMatchObject({ substatus: "archived_until_escalating" });
  });

  it("archives for good when asked", async () => {
    const { result, fake } = await run(issueArchive, { ...ADDRESS, until: "forever" });

    expect(readUpdate(fake).body).toEqual({ status: "ignored", substatus: "archived_forever" });
    expect(Result.isSuccess(result) && result.success).toEqual({
      issueId: "1001",
      status: "ignored",
    });
  });

  it("describes itself and its outcome", () => {
    expect(issueArchive.outcome?.(ADDRESS)).toBe("Archived WEBSHOP-1001");
    expect(issueArchive.describe(ADDRESS)[0]).toEqual({ kind: "text", text: "Archives " });
  });
});

describe("issue.assign", () => {
  it("assigns a user by id", async () => {
    const { result, fake } = await run(issueAssign, {
      ...ADDRESS,
      assignee: { type: "user", id: "88", name: "ada" },
    });

    expect(readUpdate(fake).body).toEqual({ assignedTo: "user:88" });
    expect(Result.isSuccess(result)).toBe(true);
    expect(fake.world.issues[0]?.assignedTo).toEqual({ type: "user", id: "88", name: "ada" });
  });

  it("assigns a team as team:<id>", async () => {
    const { fake } = await run(issueAssign, {
      ...ADDRESS,
      assignee: { type: "team", id: "31", name: "platform" },
    });

    expect(readUpdate(fake).body).toEqual({ assignedTo: "team:31" });
  });

  it("names the assignee in the describe line and the outcome", () => {
    const input = { ...ADDRESS, assignee: { type: "user", id: "88", name: "ada" } };

    expect(issueAssign.describe(input).slice(-2)).toEqual([
      { kind: "text", text: " to " },
      { kind: "marked", text: "ada" },
    ]);
    expect(issueAssign.outcome?.(input)).toBe("Assigned WEBSHOP-1001 to ada");
    expect(issueAssign.outcome?.(ADDRESS)).toBe("Assigned WEBSHOP-1001");
  });
});

describe("the failures every action shares", () => {
  const failure = async (
    arrange: (fake: ReturnType<typeof buildFakeSentry>) => void,
    credentials?: Readonly<Record<string, string>>,
  ) => {
    const { result } = await run(issueResolve, ADDRESS, arrange, credentials);
    if (!Result.isFailure(result)) throw new Error("the action was expected to fail");
    expect(result.failure).toBeInstanceOf(ActionError);
    return result.failure;
  };

  it("tells the user to reconnect when Sentry refuses the token", async () => {
    const error = await failure((fake) => {
      fake.world.token = "another-token";
    });

    expect(error.code).toBe("unauthenticated");
    expect(error.message).toBe("Sentry refused the token; reconnect the Connection");
  });

  it("fails as unauthenticated when the Connection holds no token", async () => {
    const error = await failure(() => undefined, {});

    expect(error.code).toBe("unauthenticated");
  });

  it("says when to try again after a rate limit", async () => {
    const error = await failure((fake) => {
      fake.world.override = () => ({
        status: 429,
        headers: { "x-sentry-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 40) },
      });
    });

    expect(error.code).toBe("rate_limited");
    expect(error.message).toMatch(/Try again in (39|40) seconds/);
  });

  it("fails as not_found for an issue Sentry does not have", async () => {
    const { result } = await run(issueResolve, { ...ADDRESS, issueId: "9999" });

    expect(Result.isFailure(result) && result.failure.code).toBe("not_found");
  });

  it("fails as forbidden, with what Sentry said", async () => {
    const error = await failure((fake) => {
      fake.world.override = () => ({ status: 403, body: { detail: "You may not do that." } });
    });

    expect(error.code).toBe("forbidden");
    expect(error.message).toContain("You may not do that.");
  });

  it("fails as unavailable on a server error", async () => {
    const error = await failure((fake) => {
      fake.world.override = () => ({ status: 503 });
    });

    expect(error.code).toBe("unavailable");
  });

  it("fails as unavailable when Sentry cannot be reached, because trying again may work", async () => {
    const stub = stubHttpClient((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request }),
        }),
      ),
    );

    const result = await runAgainstStub(issueResolve.perform(ADDRESS, buildActionContext()), stub);

    expect(Result.isFailure(result) && result.failure.code).toBe("unavailable");
  });

  it("fails as unexpected, not unavailable, when the reply is not JSON", async () => {
    const stub = stubHttpClient((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("<html>a proxy</html>", { status: 200 })),
      ),
    );

    const result = await runAgainstStub(issueResolve.perform(ADDRESS, buildActionContext()), stub);

    expect(Result.isFailure(result) && result.failure.code).toBe("unexpected");
    if (Result.isFailure(result)) expect(result.failure.message).toContain("not JSON");
  });

  it("fails as unauthenticated on a 401 whose body is not JSON", async () => {
    const stub = stubHttpClient((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("<html>a proxy</html>", { status: 401 })),
      ),
    );

    const result = await runAgainstStub(issueResolve.perform(ADDRESS, buildActionContext()), stub);

    expect(Result.isFailure(result) && result.failure.code).toBe("unauthenticated");
  });

  it("fails as rate_limited on a 429 whose body is not JSON", async () => {
    const stub = stubHttpClient((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("<html>a proxy</html>", { status: 429 })),
      ),
    );

    const result = await runAgainstStub(issueResolve.perform(ADDRESS, buildActionContext()), stub);

    expect(Result.isFailure(result) && result.failure.code).toBe("rate_limited");
  });

  it("never sends the token anywhere but sentry.io", async () => {
    const { result, fake } = await run(issueResolve, { ...ADDRESS, orgSlug: "../../evil" });

    // The slug is one path segment, so it cannot change the host or climb out of the organizations path.
    expect(fake.requests.every((request) => request.origin === "https://sentry.io")).toBe(true);
    expect(Result.isFailure(result)).toBe(true);
  });
});
