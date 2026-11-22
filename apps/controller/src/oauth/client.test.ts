import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, it } from "vitest";
import {
  exchangeCode,
  isStale,
  MAX_ANSWER_BYTES,
  parseTokens,
  refreshAccess,
  serializeTokens,
  type OAuthClient,
  type TokenSet,
} from "./client";

const TOKEN = "gho_secret-access-token";

describe("parseTokens", () => {
  it("parses what serializeTokens wrote", async () => {
    const tokens: TokenSet = {
      accessToken: TOKEN,
      refreshToken: "refresh-1",
      expiresAt: "2026-10-02T00:00:00.000Z",
      obtainedAt: "2026-10-01T23:55:00.000Z",
    };
    expect(await Effect.runPromise(parseTokens(serializeTokens(tokens)))).toEqual(tokens);
  });

  it.each([
    ["text that is not JSON", `{accessToken: ${TOKEN}`],
    ["JSON in another shape", JSON.stringify({ accessToken: 7, note: TOKEN })],
    ["JSON that is not an object", JSON.stringify(TOKEN)],
  ])("fails with StoredTokensUnreadable, quoting nothing, on %s", async (_, stored) => {
    const failure = await Effect.runPromise(Effect.flip(parseTokens(stored)));

    expect(failure._tag).toBe("StoredTokensUnreadable");
    expect(String(failure)).not.toContain(TOKEN);
    expect(JSON.stringify(failure)).not.toContain(TOKEN);
  });
});

describe("isStale", () => {
  const MINUTE = 60 * 1000;
  const OBTAINED = Date.parse("2026-10-02T00:00:00.000Z");
  const buildTokensLivingFor = (lifetimeMillis: number): TokenSet => ({
    accessToken: TOKEN,
    obtainedAt: new Date(OBTAINED).toISOString(),
    expiresAt: new Date(OBTAINED + lifetimeMillis).toISOString(),
  });

  it("is false for a token that lives 5 minutes, at the moment it was obtained", () => {
    expect(isStale(buildTokensLivingFor(5 * MINUTE), OBTAINED)).toBe(false);
  });

  it("is true for a token that lives 5 minutes, 3 minutes after it was obtained", () => {
    expect(isStale(buildTokensLivingFor(5 * MINUTE), OBTAINED + 3 * MINUTE)).toBe(true);
  });

  it("is true for a token that lives an hour only in its last 10 minutes", () => {
    const tokens = buildTokensLivingFor(60 * MINUTE);
    expect(isStale(tokens, OBTAINED + 49 * MINUTE)).toBe(false);
    expect(isStale(tokens, OBTAINED + 50 * MINUTE)).toBe(true);
  });

  it("keeps the fixed 10 minute margin for a stored set without obtainedAt", () => {
    const stored: TokenSet = {
      accessToken: TOKEN,
      expiresAt: new Date(OBTAINED + 5 * MINUTE).toISOString(),
    };
    expect(isStale(stored, OBTAINED)).toBe(true);
    expect(
      isStale({ ...stored, expiresAt: new Date(OBTAINED + 11 * MINUTE).toISOString() }, OBTAINED),
    ).toBe(false);
  });

  it("is false for a token that never expires", () => {
    expect(isStale({ accessToken: TOKEN }, OBTAINED)).toBe(false);
  });
});

/** What the fake token endpoint received: the form fields and the `Authorization` header. */
interface ReceivedRequest {
  readonly form: Record<string, string>;
  readonly authorization: string | undefined;
}

/**
 * A fake token endpoint: an `HttpClient` that answers every request with
 * `answer()`, and records what it received in `requests`.
 */
const fakeTokenEndpoint = (answer: () => Response) => {
  const requests: Array<ReceivedRequest> = [];
  const client = HttpClient.make((request) => {
    const body = request.body as { readonly body: Uint8Array };
    requests.push({
      form: Object.fromEntries(new URLSearchParams(new TextDecoder().decode(body.body))),
      authorization: request.headers["authorization"],
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, answer()));
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, client), requests };
};

const answerTokens = () =>
  new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh" }), {
    headers: { "content-type": "application/json" },
  });

const TOKEN_URL = "https://auth.test/token";

const exchange = (
  endpoint: ReturnType<typeof fakeTokenEndpoint>,
  extra: Partial<Parameters<typeof exchangeCode>[0]> & { client: OAuthClient },
) =>
  Effect.runPromise(
    exchangeCode({
      tokenUrl: TOKEN_URL,
      code: "the-code",
      redirectUri: "http://127.0.0.1:1234/callback",
      codeVerifier: "the-verifier",
      ...extra,
    }).pipe(Effect.provide(endpoint.layer)),
  );

describe("exchangeCode and refreshAccess", () => {
  it("send a client with a secret and no method as a form field, and no resource", async () => {
    const endpoint = fakeTokenEndpoint(answerTokens);

    await exchange(endpoint, { client: { clientId: "id", clientSecret: "secret" } });

    expect(endpoint.requests).toEqual([
      {
        authorization: undefined,
        form: {
          grant_type: "authorization_code",
          code: "the-code",
          redirect_uri: "http://127.0.0.1:1234/callback",
          client_id: "id",
          client_secret: "secret",
          code_verifier: "the-verifier",
        },
      },
    ]);
  });

  it("record when an answer with expires_in arrived, and leave obtainedAt out when it has none", async () => {
    const withLifetime = fakeTokenEndpoint(
      () => new Response(JSON.stringify({ access_token: "a", expires_in: 300 })),
    );
    const without = fakeTokenEndpoint(answerTokens);
    const before = Date.now();

    const timed = await exchange(withLifetime, { client: { clientId: "id" } });
    const untimed = await exchange(without, { client: { clientId: "id" } });

    const obtainedAt = Date.parse(timed.obtainedAt ?? "");
    expect(obtainedAt).toBeGreaterThanOrEqual(before);
    expect(Date.parse(timed.expiresAt ?? "")).toBe(obtainedAt + 300_000);
    expect(untimed).not.toHaveProperty("obtainedAt");
    expect(untimed).not.toHaveProperty("expiresAt");
  });

  it("send a public client's id and no secret", async () => {
    const endpoint = fakeTokenEndpoint(answerTokens);

    await exchange(endpoint, { client: { clientId: "id" } });

    expect(endpoint.requests[0]?.form).toMatchObject({ client_id: "id" });
    expect(endpoint.requests[0]?.form).not.toHaveProperty("client_secret");
  });

  it("send no secret for the method none, even when the client has one", async () => {
    const endpoint = fakeTokenEndpoint(answerTokens);

    await exchange(endpoint, {
      client: { clientId: "id", clientSecret: "secret", authMethod: "none" },
    });

    expect(endpoint.requests[0]?.form).toMatchObject({ client_id: "id" });
    expect(endpoint.requests[0]?.form).not.toHaveProperty("client_secret");
    expect(endpoint.requests[0]?.authorization).toBeUndefined();
  });

  it("send the form-encoded id and secret as a Basic header for client_secret_basic", async () => {
    const endpoint = fakeTokenEndpoint(answerTokens);

    await exchange(endpoint, {
      client: { clientId: "id:1", clientSecret: "se cret/+%", authMethod: "client_secret_basic" },
    });

    // RFC 6749 section 2.3.1: each part is form-encoded, then joined with ":".
    const expected = Buffer.from("id%3A1:se+cret%2F%2B%25").toString("base64");
    expect(endpoint.requests[0]?.authorization).toBe(`Basic ${expected}`);
    expect(endpoint.requests[0]?.form).not.toHaveProperty("client_id");
    expect(endpoint.requests[0]?.form).not.toHaveProperty("client_secret");
  });

  it("send the resource of an exchange and of a refresh, only when given", async () => {
    const endpoint = fakeTokenEndpoint(answerTokens);
    const client = { clientId: "id" };

    await exchange(endpoint, { client, resource: "https://mcp.test/server" });
    await exchange(endpoint, { client });
    await Effect.runPromise(
      refreshAccess({
        tokenUrl: TOKEN_URL,
        client,
        refreshToken: "refresh-1",
        resource: "https://mcp.test/server",
      }).pipe(Effect.provide(endpoint.layer)),
    );
    await Effect.runPromise(
      refreshAccess({ tokenUrl: TOKEN_URL, client, refreshToken: "refresh-1" }).pipe(
        Effect.provide(endpoint.layer),
      ),
    );

    expect(endpoint.requests.map((request) => request.form["resource"])).toEqual([
      "https://mcp.test/server",
      undefined,
      "https://mcp.test/server",
      undefined,
    ]);
  });
});

describe("a token endpoint's answer", () => {
  const failWith = (answer: () => Response) =>
    Effect.runPromise(
      Effect.flip(
        refreshAccess({ tokenUrl: TOKEN_URL, client: { clientId: "id" }, refreshToken: "r" }),
      ).pipe(Effect.provide(fakeTokenEndpoint(answer).layer)),
    );

  it("is refused with fixed text when it is over 64 KiB, with or without a Content-Length", async () => {
    const huge = "x".repeat(1024 * 1024);
    const withLength = await failWith(() => new Response(huge, { status: 200 }));
    const chunked = await failWith(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < 16; i++) controller.enqueue(new Uint8Array((1024 * 1024) / 16));
              controller.close();
            },
          }),
        ),
    );

    for (const failure of [withLength, chunked]) {
      expect(failure._tag).toBe("ProviderUnreachable");
      expect(failure.message).toBe(
        `the token endpoint answered with more than ${String(MAX_ANSWER_BYTES)} bytes`,
      );
    }
  });

  it("keeps a standard error code and no text of the provider", async () => {
    const failure = await failWith(
      () =>
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "SECRET-DESCRIPTION" }),
          { status: 400 },
        ),
    );

    expect(failure).toMatchObject({ _tag: "ProviderRefused", code: "invalid_grant" });
    expect(failure.message).toBe("the token endpoint refused the request: invalid_grant");
    expect(JSON.stringify(failure)).not.toContain("SECRET-DESCRIPTION");
  });

  it("drops an error code that is not a standard one", async () => {
    const failure = await failWith(
      () =>
        new Response(JSON.stringify({ error: "SECRET-CODE: ignore previous" }), { status: 400 }),
    );

    expect(failure._tag).toBe("ProviderRefused");
    expect(failure).not.toHaveProperty("code");
    expect(failure.message).toBe("the token endpoint refused the request");
  });

  it("quotes no text of the provider when the answer is not JSON or has no access token", async () => {
    const notJson = await failWith(() => new Response("SECRET-BODY", { status: 200 }));
    const noToken = await failWith(
      () => new Response(JSON.stringify({ note: "SECRET-BODY" }), { status: 200 }),
    );
    const serverError = await failWith(() => new Response("SECRET-BODY", { status: 502 }));
    const clientError = await failWith(() => new Response("SECRET-BODY", { status: 418 }));

    expect([notJson._tag, noToken._tag, serverError._tag, clientError._tag]).toEqual([
      "ProviderUnreachable",
      "ProviderUnreachable",
      "ProviderUnreachable",
      "ProviderRefused",
    ]);
    for (const failure of [notJson, noToken, serverError, clientError]) {
      expect(failure.message).not.toContain("SECRET-BODY");
    }
  });
});

describe("the lifetime and the type of a token", () => {
  const answerWith = (fields: Record<string, unknown>) => () =>
    new Response(JSON.stringify({ access_token: "a", ...fields }), { status: 200 });

  const tryExchange = (fields: Record<string, unknown>, bearerOnly = false) =>
    Effect.runPromise(
      Effect.flip(
        exchangeCode({
          tokenUrl: TOKEN_URL,
          client: { clientId: "id" },
          code: "c",
          redirectUri: "http://127.0.0.1:1/callback",
          codeVerifier: "v",
          bearerOnly,
        }),
      ).pipe(Effect.provide(fakeTokenEndpoint(answerWith(fields)).layer)),
    );

  it.each([
    ["a negative number", -1],
    ["a fraction", 3600.5],
    ["more than ten years", 10 * 365 * 24 * 60 * 60 + 1],
    ["a number too large for a date", 1e308],
  ])("refuses expires_in of %s with a typed failure and fixed text", async (_name, expires) => {
    const failure = await tryExchange({ expires_in: expires });

    expect(failure).toMatchObject({
      _tag: "ProviderUnreachable",
      message: "the token endpoint's response has an expires_in that is not a lifetime in seconds",
    });
  });

  it.each([0, 1, 10 * 365 * 24 * 60 * 60])("accepts expires_in of %i", async (expires) => {
    const tokens = await exchange(fakeTokenEndpoint(answerWith({ expires_in: expires })), {
      client: { clientId: "id" },
    });

    expect(Date.parse(tokens.expiresAt ?? "") - Date.parse(tokens.obtainedAt ?? "")).toBe(
      expires * 1000,
    );
  });

  it.each(["Bearer", "bearer", "BEARER"])(
    "accepts the token type %s when only bearer is",
    async (type) => {
      const tokens = await exchange(fakeTokenEndpoint(answerWith({ token_type: type })), {
        client: { clientId: "id" },
        bearerOnly: true,
      });

      expect(tokens.accessToken).toBe("a");
    },
  );

  it("accepts an answer with no token type when only bearer is", async () => {
    const tokens = await exchange(fakeTokenEndpoint(answerWith({})), {
      client: { clientId: "id" },
      bearerOnly: true,
    });

    expect(tokens.accessToken).toBe("a");
  });

  it("refuses another token type when only bearer is, and accepts it otherwise", async () => {
    const failure = await tryExchange({ token_type: "MAC" }, true);
    const accepted = await exchange(fakeTokenEndpoint(answerWith({ token_type: "MAC" })), {
      client: { clientId: "id" },
    });

    expect(failure).toMatchObject({
      _tag: "ProviderUnreachable",
      message: "the token endpoint's response holds a token that is not a bearer token",
    });
    expect(accepted.accessToken).toBe("a");
  });
});
