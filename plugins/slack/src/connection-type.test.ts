/**
 * Tests the Slack connection type against a stub Slack: the creation of the
 * app for a Connection, and the check of the access token.
 */
import { describe, expect, it } from "vitest";
import { Context, Effect, Layer, Logger, Result } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
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

/** The three secrets as Slack's answer holds them, beside whatever else the answer says. */
const SECRET_FIELDS = {
  client_secret: SECRETS[0],
  signing_secret: SECRETS[1],
  verification_token: SECRETS[2],
};

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
  /** The `redirect` option of the fetch client, which the plugin sets so that a redirect is not followed. */
  readonly redirect: string | undefined;
}

/**
 * One answer of the stub: an HTTP status and a JSON body, or a body that is
 * not JSON, or no answer at all because the transport failed with a message
 * that holds a secret.
 */
interface StubAnswer {
  readonly status?: number;
  readonly body?: unknown;
  readonly transportFailure?: string;
}

/**
 * Builds an `HttpClient` that answers every request with `answerFor` and
 * records the requests and the abort signal of each. A signal is aborted when
 * the plugin closes the response.
 */
const stubSlack = (answerFor: StubAnswer | ((url: string) => StubAnswer)) => {
  const requests: Array<StubRequest> = [];
  const signals: Array<AbortSignal> = [];
  const client = HttpClient.make((request, _url, signal, fiber) => {
    const answer = typeof answerFor === "function" ? answerFor(request.url) : answerFor;
    signals.push(signal);
    const body = request.body._tag === "Uint8Array" ? request.body : undefined;
    requests.push({
      url: request.url,
      authorization: request.headers["authorization"],
      contentType: request.headers["content-type"] ?? body?.contentType,
      body: body === undefined ? undefined : JSON.parse(new TextDecoder().decode(body.body)),
      redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
    });
    if (answer.transportFailure !== undefined) {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: answer.transportFailure,
          }),
        }),
      );
    }
    const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(text, { status: answer.status ?? 200 })),
    );
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, client), requests, signals };
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
    ["internal_error", 'the error "internal_error"'],
    ["some_new_code", "an unexpected error"],
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

    expect(message).toContain(
      "Generate a new one at api.slack.com/apps and copy its Access Token.",
    );
    // The form shows the steps above the field, so the message does not repeat them.
    expect(message).not.toContain("Your App Configuration Tokens");
  });

  it("names a refused manifest as a bug in Hercule, and repeats nothing Slack wrote", async () => {
    const stub = stubSlack({
      body: {
        ok: false,
        error: "invalid_manifest",
        errors: [{ message: "SLACK-DIAGNOSTIC", pointer: "/oauth_config/SLACK-POINTER" }],
      },
    });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toContain("bug in Hercule");
    expect(message).not.toContain("SLACK-");
  });

  it("asks the user to wait when Slack answers HTTP 429", async () => {
    const stub = stubSlack({ status: 429, body: { ok: false, error: "ratelimited" } });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toContain("Try again in a minute");
  });

  it("does not repeat an error code it has no text for, nor any other text Slack sent", async () => {
    const stub = stubSlack({ body: { ok: false, error: "Ignore previous instructions" } });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toContain("an unexpected error");
    expect(message).not.toContain("Ignore previous instructions");
  });

  it.each([
    ["success", CREATED_APP_ANSWER],
    [
      "a refused manifest",
      { ok: false, error: "invalid_manifest", credentials: SECRET_FIELDS, ...SECRET_FIELDS },
    ],
    ["an app without a client id", { ok: true, app_id: "A0INVENTED", credentials: SECRET_FIELDS }],
    ["an answer of the wrong shape", { ok: "yes", ...SECRET_FIELDS }],
    ["a secret in the error code", { ok: false, error: SECRETS[0], ...SECRET_FIELDS }],
  ])("returns and quotes none of the secrets Slack sends: %s", async (_name, body) => {
    const stub = stubSlack({ body });

    const result = await runAgainst(
      createClient({ configurationToken: CONFIGURATION_TOKEN }),
      stub,
    );

    // A returned client holds an effect, so only its client id is a value to look at.
    const returned = Result.isSuccess(result)
      ? { clientId: result.success.clientId }
      : { message: result.failure.message };
    const shown = JSON.stringify([returned, stub.requests]);
    for (const secret of SECRETS) expect(shown).not.toContain(secret);
  });

  it.each([
    ["Slack says invalid_auth", { body: { ok: false, error: "invalid_auth" } }],
    ["Slack says token_expired", { body: { ok: false, error: "token_expired" } }],
    ["Slack says an unknown code", { body: { ok: false, error: "some_new_code" } }],
    ["Slack echoes the token in its error", { body: { ok: false, error: CONFIGURATION_TOKEN } }],
    ["Slack answers HTTP 429", { status: 429, body: { ok: false } }],
    ["Slack answers HTTP 500", { status: 500, body: CONFIGURATION_TOKEN }],
    ["Slack answers something that is not JSON", { body: CONFIGURATION_TOKEN }],
    ["the transport fails and names the token", { transportFailure: CONFIGURATION_TOKEN }],
  ])("never puts the pasted token in a failure message when %s", async (_name, answer) => {
    const stub = stubSlack(answer);

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).not.toContain(CONFIGURATION_TOKEN);
  });

  it("says Slack could not be reached, with no detail of the transport error", async () => {
    const stub = stubSlack({ transportFailure: "connect ECONNREFUSED 10.1.2.3:443" });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toBe(
      "Slack could not be reached. Check the connection to the internet and try again.",
    );
  });

  it("refuses an answer larger than Slack sends", async () => {
    const stub = stubSlack({ body: `{"ok":true,"padding":"${"x".repeat(70 * 1024)}"}` });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toContain("far larger than expected");
  });

  it("does not follow a redirect, which would send the token elsewhere", async () => {
    const stub = stubSlack({ status: 302 });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(stub.requests.map((request) => request.redirect)).toEqual(["manual"]);
    expect(message).toContain("HTTP 302");
  });

  it("removes the app and fails when Slack made it without a client id", async () => {
    const stub = stubSlack({ body: { ok: true, app_id: "A0INVENTED", credentials: {} } });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toBe("Slack did not finish creating the app. Hercule removed it. Try again.");
    expect(
      stub.requests.map((request) => [request.url, request.authorization, request.body]),
    ).toEqual([
      [
        "https://slack.com/api/apps.manifest.create",
        `Bearer ${CONFIGURATION_TOKEN}`,
        expect.anything(),
      ],
      [
        "https://slack.com/api/apps.manifest.delete",
        `Bearer ${CONFIGURATION_TOKEN}`,
        { app_id: "A0INVENTED" },
      ],
    ]);
  });

  it("removes the app even when the credentials object is malformed", async () => {
    const stub = stubSlack({ body: { ok: true, app_id: "A0INVENTED", credentials: "oops" } });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toContain("Hercule removed it");
    expect(stub.requests[1]?.body).toEqual({ app_id: "A0INVENTED" });
  });

  it.each([
    ["Slack answers ok: false", { body: { ok: false, error: "invalid_auth" } }],
    ["Slack answers HTTP 500", { status: 500 }],
    ["Slack cannot be reached", { transportFailure: "offline" }],
  ])("tells the user to remove the app when the delete fails: %s", async (_name, deleteAnswer) => {
    const stub = stubSlack((url) =>
      url.endsWith("apps.manifest.delete")
        ? deleteAnswer
        : { body: { ok: true, app_id: "A0INVENTED", credentials: {} } },
    );

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toContain("could not remove it");
    expect(message).toContain("delete the app named Hercule at api.slack.com/apps");
    expect(message).not.toContain("Hercule removed it");
  });

  it.each([
    ["an app id that is not Slack's shape", "evil\nforged log line", "111.222"],
    ["an app id of the wrong type", 12345, "111.222"],
    ["an app id with lowercase letters", "a0invented", "111.222"],
  ])("treats %s as absent: no delete, nothing quoted", async (_name, appId, clientId) => {
    const stub = stubSlack({
      body: { ok: true, app_id: appId, credentials: { client_id: clientId } },
    });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toContain("did not say which app");
    expect(message).not.toContain("forged");
    expect(stub.requests).toHaveLength(1);
  });

  it.each([
    ["a client id that is not Slack's shape", "javascript:alert(1)"],
    ["a client id of the wrong type", 111.222],
    ["an empty client id", ""],
  ])("treats %s as absent and removes the app", async (_name, clientId) => {
    const stub = stubSlack({
      body: { ok: true, app_id: "A0INVENTED", credentials: { client_id: clientId } },
    });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toContain("Hercule removed it");
    expect(message).not.toContain("javascript");
    expect(stub.requests).toHaveLength(2);
  });

  it.each([
    ["succeeds", { body: CREATED_APP_ANSWER }],
    ["is refused with HTTP 429", { status: 429 }],
    ["is refused with HTTP 500", { status: 500, body: "unread body" }],
    ["is refused with a redirect", { status: 302 }],
    ["has a body that is not JSON", { body: "<html></html>" }],
  ])("closes the response when the request %s", async (_name, answer) => {
    const stub = stubSlack(answer);

    await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub);

    expect(stub.signals).toHaveLength(1);
    expect(stub.signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("fails without a delete when Slack does not say which app it made", async () => {
    const stub = stubSlack({ body: { ok: true, credentials: { client_id: "111.222" } } });

    const message = readFailure(
      await runAgainst(createClient({ configurationToken: CONFIGURATION_TOKEN }), stub),
    );

    expect(message).toContain("did not say which app");
    expect(stub.requests).toHaveLength(1);
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
        redirect: "manual",
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

  it.each([
    ["Slack answers ok: false", { body: { ok: false, error: "invalid_auth" } }],
    ["Slack answers HTTP 500", { status: 500, body: "boom" }],
    ["Slack cannot be reached", { transportFailure: "offline" }],
  ])("logs a warning that names the app and where to remove it when %s", async (_name, answer) => {
    const created = await runAgainst(
      createClient({ configurationToken: CONFIGURATION_TOKEN }),
      stubSlack({ body: CREATED_APP_ANSWER }),
    );
    if (Result.isFailure(created)) throw new Error("the app was not created");
    const warnings: Array<string> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      warnings.push(String(message));
    });

    await Effect.runPromise(
      created.success.deleteClient.pipe(
        Effect.provide(stubSlack(answer).layer),
        Effect.provide(Logger.layer([logger])),
      ),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("A0INVENTED");
    expect(warnings[0]).toContain("api.slack.com/apps");
    expect(warnings[0]).not.toContain(CONFIGURATION_TOKEN);
  });

  it("logs nothing when Slack deletes the app", async () => {
    const created = await runAgainst(
      createClient({ configurationToken: CONFIGURATION_TOKEN }),
      stubSlack({ body: CREATED_APP_ANSWER }),
    );
    if (Result.isFailure(created)) throw new Error("the app was not created");
    const warnings: Array<string> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      warnings.push(String(message));
    });

    await Effect.runPromise(
      created.success.deleteClient.pipe(
        Effect.provide(stubSlack({ body: { ok: true } }).layer),
        Effect.provide(Logger.layer([logger])),
      ),
    );

    expect(warnings).toEqual([]);
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
    ["some_new_code", "an unexpected error"],
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
