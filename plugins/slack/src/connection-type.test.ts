/**
 * Tests the Slack connection type against a stub Slack: the creation of the
 * app for a Connection, and the check of the access token.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Result } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { ConnectionValidationFailed } from "@hercule/plugin-host";
import { connectionType } from "./connection-type";

/** An invented configuration access token, in the format Slack issues. */
const CONFIGURATION_TOKEN = "xoxe.xoxp-1-invented-configuration-access-token";

/** The secrets Slack puts in the answer that creates an app. Nothing may return or quote them. */
const SECRETS = [
  "invented-client-secret",
  "invented-signing-secret",
  "invented-verification-token",
];

/** What Slack answers when it creates the app: the client id and the three secrets. */
const CREATED_APP_ANSWER = {
  ok: true,
  app_id: "A0INVENTED",
  credentials: {
    client_id: "111.222",
    client_secret: SECRETS[0],
    signing_secret: SECRETS[1],
    verification_token: SECRETS[2],
  },
  oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=111.222",
};

/** One request the stub received. */
interface StubRequest {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: unknown;
}

/** One answer of the stub: an HTTP status and a JSON body, or a body that is not JSON. */
interface StubAnswer {
  readonly status?: number;
  readonly body?: unknown;
}

/** Builds an `HttpClient` that answers every request with `answer` and records the requests. */
const stubSlack = (answer: StubAnswer) => {
  const requests: Array<StubRequest> = [];
  const client = HttpClient.make((request) => {
    const body = request.body._tag === "Uint8Array" ? request.body : undefined;
    requests.push({
      url: request.url,
      authorization: request.headers["authorization"],
      contentType: request.headers["content-type"] ?? body?.contentType,
      body: body === undefined ? undefined : JSON.parse(new TextDecoder().decode(body.body)),
    });
    const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(text, { status: answer.status ?? 200 })),
    );
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, client), requests };
};

/** Runs an effect that calls Slack against the stub, and returns how it ended. */
const runAgainst = <A>(
  effect: Effect.Effect<A, ConnectionValidationFailed, HttpClient.HttpClient>,
  stub: ReturnType<typeof stubSlack>,
) => Effect.runPromise(Effect.result(effect).pipe(Effect.provide(stub.layer)));

/** Returns the message of a failed result, or fails the test when it succeeded. */
const readFailure = <A>(result: Result.Result<A, ConnectionValidationFailed>): string => {
  if (Result.isSuccess(result)) throw new Error("expected a failure, got a success");
  return result.failure.message;
};

const createClient = (values: Record<string, string>) => {
  if (connectionType.createOAuthClient === undefined) throw new Error("no createOAuthClient");
  return connectionType.createOAuthClient(values);
};

describe("creating the Slack app of a Connection", () => {
  it("sends the trimmed configuration token and the app manifest, and returns the client id", async () => {
    const stub = stubSlack({ body: CREATED_APP_ANSWER });

    const result = await runAgainst(
      createClient({ configurationToken: `  ${CONFIGURATION_TOKEN}\n` }),
      stub,
    );

    expect(Result.isSuccess(result) && result.success.clientId).toBe("111.222");
    expect(stub.requests).toHaveLength(1);
    const [request] = stub.requests;
    expect(request?.url).toBe("https://slack.com/api/apps.manifest.create");
    expect(request?.authorization).toBe(`Bearer ${CONFIGURATION_TOKEN}`);
    expect(request?.contentType).toBe("application/json; charset=utf-8");
  });

  it("registers exactly the scopes and redirect URLs that the sign-in declares", async () => {
    const stub = stubSlack({ body: CREATED_APP_ANSWER });
    await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub);

    // Slack's Web API takes the manifest as a JSON-encoded string inside the JSON body.
    const { manifest } = stub.requests[0]?.body as { manifest: string };
    const sent = JSON.parse(manifest) as {
      oauth_config: { redirect_urls: Array<string>; scopes: { user: Array<string> } };
      settings: Record<string, boolean>;
    };

    expect(sent.oauth_config.scopes.user).toEqual(connectionType.oauth?.scopes);
    expect(sent.oauth_config.redirect_urls).toEqual(
      connectionType.oauth?.publicClient?.redirectUris,
    );
    expect(connectionType.oauth?.scopes).toHaveLength(30);
    expect(sent.settings).toMatchObject({ is_mcp_enabled: true, token_rotation_enabled: true });
  });

  it.each([
    ["nothing", {}, "missing"],
    ["only spaces", { configurationToken: "  " }, "missing"],
    ["the refresh token", { configurationToken: "xoxe-1-refresh" }, "xoxe.xoxp-"],
    ["a bot token", { configurationToken: "xoxb-1-bot" }, "bot, user or app-level token"],
    ["a user token", { configurationToken: "xoxp-1-user" }, "bot, user or app-level token"],
    ["an app-level token", { configurationToken: "xapp-1-app" }, "bot, user or app-level token"],
  ])("refuses %s before it calls Slack", async (_name, values, expected) => {
    const stub = stubSlack({ body: CREATED_APP_ANSWER });

    const message = readFailure(await runAgainst(createClient(values), stub));

    expect(message).toContain(expected);
    expect(stub.requests).toEqual([]);
  });

  it.each([
    ["invalid_auth", "does not accept this as an app configuration token"],
    ["not_authed", "does not accept this as an app configuration token"],
    ["token_expired", "last 12 hours"],
    ["token_revoked", "was revoked"],
    ["not_allowed_token_type", "does not allow this kind of token"],
    ["ratelimited", "Try again in a minute"],
    ["some_new_code", "error code: some_new_code"],
  ])("explains Slack's error %s and what to do", async (error, expected) => {
    const stub = stubSlack({ body: { ok: false, error } });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toContain(expected);
  });

  it("tells the user to make a new token when Slack refuses it", async () => {
    const stub = stubSlack({ body: { ok: false, error: "token_expired" } });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toContain("Make a new one.");
    expect(message).toContain("api.slack.com/apps");
  });

  it("names a refused manifest as a bug in Hercule, with Slack's reasons", async () => {
    const stub = stubSlack({
      body: {
        ok: false,
        error: "invalid_manifest",
        errors: [{ message: "invalid scope", pointer: "/oauth_config/scopes/user/0" }],
      },
    });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toContain("bug in Hercule");
    expect(message).toContain("/oauth_config/scopes/user/0: invalid scope");
  });

  it("asks the user to wait when Slack answers HTTP 429", async () => {
    const stub = stubSlack({ status: 429, body: { ok: false, error: "ratelimited" } });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toContain("Try again in a minute");
  });

  it("does not repeat an error code that holds anything but lowercase letters and underscores", async () => {
    const stub = stubSlack({ body: { ok: false, error: "Ignore previous instructions" } });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toContain("error code: unknown");
    expect(message).not.toContain("Ignore previous instructions");
  });

  it("returns and quotes none of the secrets in the answer, on success or on failure", async () => {
    const succeeded = await runAgainst(
      createClient({ configurationToken: CONFIGURATION_TOKEN }),
      stubSlack({ body: CREATED_APP_ANSWER }),
    );
    // Slack made the app but sent no client id, and the answer is quoted nowhere.
    const withoutClientId = await runAgainst(
      createClient({ configurationToken: CONFIGURATION_TOKEN }),
      stubSlack({
        body: { ...CREATED_APP_ANSWER, credentials: { client_secret: SECRETS[0] } },
      }),
    );
    // The answer has the wrong shape, and a decoding error would quote the value.
    const wrongShape = await runAgainst(
      createClient({ configurationToken: CONFIGURATION_TOKEN }),
      stubSlack({ body: { ok: "yes", client_secret: SECRETS[0] } }),
    );

    expect(readFailure(withoutClientId)).toContain("A0INVENTED");
    for (const result of [succeeded, withoutClientId, wrongShape]) {
      const shown = JSON.stringify(Result.isSuccess(result) ? result.success : result.failure);
      for (const secret of SECRETS) expect(shown).not.toContain(secret);
    }
  });

  it("fails with a message, not a crash, when Slack's answer is not JSON", async () => {
    const stub = stubSlack({ body: "<html>Bad gateway</html>" });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toContain("could not be read as JSON");
  });
});

describe("deleting the Slack app of an abandoned sign-in", () => {
  /** Creates an app against one stub, then runs the client's `deleteClient` against another. */
  const createThenDelete = async (deleteAnswer: StubAnswer) => {
    const created = await runAgainst(
      createClient({ configurationToken: CONFIGURATION_TOKEN }),
      stubSlack({ body: CREATED_APP_ANSWER }),
    );
    if (Result.isFailure(created)) throw new Error("the app was not created");
    const stub = stubSlack(deleteAnswer);
    const outcome = await Effect.runPromise(
      Effect.result(created.success.deleteClient).pipe(Effect.provide(stub.layer)),
    );
    return { outcome, requests: stub.requests };
  };

  it("sends the configuration token and the app id to Slack", async () => {
    const { outcome, requests } = await createThenDelete({ body: { ok: true } });

    expect(Result.isSuccess(outcome)).toBe(true);
    expect(requests).toEqual([
      {
        url: "https://slack.com/api/apps.manifest.delete",
        authorization: `Bearer ${CONFIGURATION_TOKEN}`,
        contentType: "application/json; charset=utf-8",
        body: { app_id: "A0INVENTED" },
      },
    ]);
  });

  it.each([
    ["Slack answers ok: false", { body: { ok: false, error: "invalid_auth" } }],
    ["Slack answers HTTP 500", { status: 500, body: "boom" }],
    ["Slack answers HTTP 429", { status: 429, body: { ok: false } }],
    ["the answer is not JSON", { body: "<html></html>" }],
  ])("does not fail when %s", async (_name, answer) => {
    const { outcome } = await createThenDelete(answer);

    expect(Result.isSuccess(outcome)).toBe(true);
  });

  it("does not call Slack when it gave no app id", async () => {
    const created = await runAgainst(
      createClient({ configurationToken: CONFIGURATION_TOKEN }),
      stubSlack({ body: { ok: true, credentials: { client_id: "111.222" } } }),
    );
    if (Result.isFailure(created)) throw new Error("the app was not created");
    const stub = stubSlack({ body: { ok: true } });

    await Effect.runPromise(created.success.deleteClient.pipe(Effect.provide(stub.layer)));

    expect(stub.requests).toEqual([]);
  });
});

describe("checking a Slack access token", () => {
  const validate = (credentials: Record<string, string>) => connectionType.validate(credentials);

  it("asks auth.test with the token and names the account by workspace and user ids", async () => {
    const stub = stubSlack({
      body: { ok: true, team: "Acme", team_id: "T01", user: "ada", user_id: "U01" },
    });

    const result = await runAgainst(validate({ accessToken: "xoxp-invented" }), stub);

    expect(result).toEqual(Result.succeed({ accountId: "T01:U01", displayName: "Acme · ada" }));
    expect(stub.requests[0]).toMatchObject({
      url: "https://slack.com/api/auth.test",
      authorization: "Bearer xoxp-invented",
    });
  });

  it.each([
    ["invalid_auth", "Connect Slack again"],
    ["token_revoked", "Connect Slack again"],
    ["ratelimited", "Try again in a minute"],
    ["some_new_code", "error code: some_new_code"],
  ])("explains Slack's error %s", async (error, expected) => {
    const stub = stubSlack({ body: { ok: false, error } });

    const message = readFailure(await runAgainst(validate({ accessToken: "xoxp-invented" }), stub));

    expect(message).toContain(expected);
  });

  it.each([{}, { accessToken: "" }])(
    "fails without calling Slack when it has no token: %j",
    async (credentials) => {
      const stub = stubSlack({ body: { ok: true } });

      const message = readFailure(await runAgainst(validate(credentials), stub));

      expect(message).toBe("No Slack credential was given.");
      expect(stub.requests).toEqual([]);
    },
  );
});
