/**
 * Tests the key check through its service interface, with the provider's API
 * replaced at the `HttpClient` seam.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Layer, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import type { AccountKind } from "@hercule/plugin-host";
import type { RegisteredProvider } from "../plugins";
import { ProviderKeyCheck, ProviderKeyCheckLayer, ProviderKeyCheckTimeout } from "./key-check";
import { buildFakeProviderApi, type FakeProviderAnswer } from "./testing";

const PROVIDER = { id: "acme/acme", displayName: "Acme" } as RegisteredProvider;

const KIND: AccountKind = {
  id: "api-key",
  title: "API key",
  description: "A key for Acme.",
  setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
  keyCheck: {
    url: "https://api.acme.test/v1/models",
    headers: { authorization: "Bearer {apiKey}", "x-version": "1" },
  },
  harnesses: [],
};

/** Checks `key` against a fake provider that answers as `answer` says, and returns the outcome and the requests. */
const checkKey = async (
  key: string,
  answer: () => FakeProviderAnswer,
  timeout?: Duration.Duration,
) => {
  const api = buildFakeProviderApi(answer);
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const keyCheck = yield* ProviderKeyCheck;
      return yield* Effect.exit(keyCheck.check(PROVIDER, KIND, Redacted.make(key)));
    }).pipe(
      Effect.provide(
        ProviderKeyCheckLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, api.client))),
      ),
      timeout === undefined
        ? (effect) => effect
        : Effect.provideService(ProviderKeyCheckTimeout, timeout),
    ),
  );
  return { outcome, requests: api.requests };
};

/** Returns the error a failed check ended with. */
const readFailure = (outcome: Awaited<ReturnType<typeof checkKey>>["outcome"]): unknown => {
  if (outcome._tag !== "Failure") throw new Error("the check was expected to fail");
  const failure = outcome.cause.reasons.find((reason) => reason._tag === "Fail");
  return failure?.error;
};

describe("ProviderKeyCheck.check", () => {
  it("accepts a key the provider answers with a 2xx status, sending the declared headers with the key in them", async () => {
    // A `$&` in a key must reach the provider as it is, not as a replacement pattern.
    const { outcome, requests } = await checkKey("sk-$&-1", () => new Response("{}"));

    expect(outcome._tag).toBe("Success");
    expect(requests).toEqual([
      {
        url: "https://api.acme.test/v1/models",
        headers: { authorization: "Bearer sk-$&-1", "x-version": "1" },
        redirect: "manual",
      },
    ]);
  });

  it.each([401, 403])(
    "refuses the key with Validation carrying the provider's own words on a %s",
    async (status) => {
      const { outcome } = await checkKey(
        "sk-bad",
        () =>
          new Response(
            JSON.stringify({ error: { type: "auth", message: "invalid  x-api-key\nsee docs" } }),
            { status },
          ),
      );

      expect(readFailure(outcome)).toMatchObject({
        error: { code: "validation", message: "invalid x-api-key see docs" },
      });
    },
  );

  it("bounds the provider's words to 500 characters", async () => {
    const { outcome } = await checkKey(
      "sk-bad",
      () => new Response(JSON.stringify({ error: { message: "x".repeat(900) } }), { status: 401 }),
    );

    const failure = readFailure(outcome) as { error: { message: string } };
    expect(failure.error.message).toHaveLength(500);
  });

  it("strips control characters from the provider's words, so an escape sequence reaches no terminal", async () => {
    const { outcome } = await checkKey(
      "sk-bad",
      () =>
        new Response(
          JSON.stringify({ error: { message: "bad\u001b[31m key\u0007\u007f\u0000!" } }),
          { status: 401 },
        ),
    );

    expect(readFailure(outcome)).toMatchObject({
      error: { code: "validation", message: "bad[31m key!" },
    });
  });

  it("reads a bounded part of a refusal body, so a body that never ends cannot hold the check", async () => {
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    const { outcome } = await checkKey(
      "sk-bad",
      () =>
        new Response(new ReadableStream({ pull: (controller) => controller.enqueue(chunk) }), {
          status: 401,
        }),
      Duration.seconds(5),
    );

    // Not the "could not reach" of a timeout: the check answered with the status text.
    expect(readFailure(outcome)).toMatchObject({
      error: { code: "validation", message: "Unauthorized" },
    });
  });

  it("uses the status text when the refusal has no message in its body", async () => {
    const { outcome: unauthorized } = await checkKey(
      "sk-bad",
      () => new Response("not json", { status: 401 }),
    );
    const { outcome: forbidden } = await checkKey(
      "sk-bad",
      () => new Response("{}", { status: 403 }),
    );

    expect(readFailure(unauthorized)).toMatchObject({ error: { message: "Unauthorized" } });
    expect(readFailure(forbidden)).toMatchObject({ error: { message: "Forbidden" } });
  });

  it("fails InvalidState, asking to try again, when the provider cannot be reached", async () => {
    const { outcome } = await checkKey("sk-1", () => "unreachable");

    expect(readFailure(outcome)).toMatchObject({
      error: {
        code: "invalid_state",
        message: "Could not reach Acme to check the key. Try again.",
      },
    });
  });

  it("fails InvalidState when the provider does not answer in time", async () => {
    const { outcome } = await checkKey("sk-1", () => "silent", Duration.millis(30));

    expect(readFailure(outcome)).toMatchObject({
      error: {
        code: "invalid_state",
        message: "Could not reach Acme to check the key. Try again.",
      },
    });
  });

  it.each([429, 500, 404])(
    "fails InvalidState naming the status when the provider answers %s",
    async (status) => {
      const { outcome } = await checkKey("sk-1", () => new Response("busy", { status }));

      expect(readFailure(outcome)).toMatchObject({
        error: {
          code: "invalid_state",
          message: `Acme could not check the key (HTTP ${status}). Try again.`,
        },
      });
    },
  );

  it("does not follow a redirect, which would carry the key to another host", async () => {
    const { outcome, requests } = await checkKey(
      "sk-1",
      () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } }),
    );

    expect(readFailure(outcome)).toMatchObject({
      error: { code: "invalid_state", message: expect.stringContaining("HTTP 302") as unknown },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.redirect).toBe("manual");
  });

  it("refuses a key with a line break without sending anything", async () => {
    const { outcome, requests } = await checkKey("sk-1\nx-evil: 1", () => new Response("{}"));

    expect(readFailure(outcome)).toMatchObject({ error: { code: "validation" } });
    expect(requests).toEqual([]);
  });

  it("never puts the key in an error", async () => {
    const failures = await Promise.all([
      checkKey("sk-very-secret", () => "unreachable"),
      checkKey("sk-very-secret", () => new Response("{}", { status: 500 })),
      checkKey("sk-very-secret", () => new Response("{}", { status: 401 })),
    ]);

    for (const { outcome } of failures) {
      expect(JSON.stringify(readFailure(outcome))).not.toContain("sk-very-secret");
    }
  });
});
