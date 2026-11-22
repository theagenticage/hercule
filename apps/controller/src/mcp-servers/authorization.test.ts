/**
 * Tests discovery and registration (`discoverAuthorization`,
 * `registerClient`) through the requests they send and what they return,
 * against a stub HTTP client that records every request and answers from a
 * table. The two documents and the registration answer are validated inside
 * them, so their rules are tested here with documents that break one rule at a
 * time, not through the helpers. Four things have a test of their own: the
 * challenge grammar, the cancelling of a body nobody reads (it needs a real
 * socket), the address of the authorization endpoint, and the requests
 * themselves against a fake authorization server in
 * `oauth-sign-in.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";
import {
  buildAuthorizationUrl,
  discoverAuthorization,
  parseBearerChallenge,
  registerClient,
  type AuthorizationServer,
} from "./authorization";

const SERVER = "https://mcp.example.com/mcp";
const ISSUER = "https://auth.example.com";
const PRM_URL = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const AS_URL = `${ISSUER}/.well-known/oauth-authorization-server`;

/** A protected resource metadata document for `SERVER` that names `ISSUER`. */
const PRM = { resource: SERVER, authorization_servers: [ISSUER] };

/** A valid authorization server metadata document, which a test breaks one rule of. */
const AS = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  code_challenge_methods_supported: ["plain", "S256"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_post", 4],
  authorization_response_iss_parameter_supported: true,
};

/**
 * What the stub web answers, by `"<METHOD> <address>"`: a `Response`, or a
 * value that is answered as a JSON body with status 200. Any other request
 * gets 404.
 */
type Answers = Record<string, unknown>;

/** Builds a stub HTTP client over `answers`, and the list of `"<METHOD> <address>"` it received. */
const stubWeb = (answers: Answers) => {
  const requests: Array<string> = [];
  const client = HttpClient.make((request) => {
    // The client keeps the query apart from the address.
    const query = UrlParams.toString(request.urlParams);
    const key = `${request.method} ${request.url}${query === "" ? "" : `?${query}`}`;
    requests.push(key);
    const answer = answers[key];
    const response =
      answer instanceof Response
        ? answer
        : answer === undefined
          ? new Response("not found", { status: 404 })
          : Response.json(answer);
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  return {
    requests,
    /** The metadata requests only, which are the GETs. */
    get metadataRequests() {
      return requests.filter((key) => key.startsWith("GET ")).map((key) => key.slice(4));
    },
    run: <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
      Effect.runPromise(
        Effect.result(effect.pipe(Effect.provideService(HttpClient.HttpClient, client))),
      ),
  };
};

/** Discovers `server` against `answers`, and returns the outcome (`success` or `failure`) with the requests. */
const discover = async (answers: Answers, server = SERVER) => {
  const web = stubWeb(answers);
  const outcome = await web.run(discoverAuthorization(server));
  return { outcome, web };
};

/** Returns the message of a failed outcome. Fails the test when the outcome is a success. */
const failureMessage = (outcome: { readonly _tag: string }): string => {
  const { failure } = outcome as { failure?: { message: string } };
  if (failure === undefined) throw new Error("the outcome is not a failure");
  return failure.message;
};

/** Discovers against a web that serves `prm` and `as`, and returns the failure's tag, which the test expects. */
const discoveryFailure = async (prm: unknown, as: unknown, server = SERVER): Promise<string> => {
  const { outcome } = await discover({ [`GET ${PRM_URL}`]: prm, [`GET ${AS_URL}`]: as }, server);
  if (outcome._tag !== "Failure") throw new Error("discovery did not fail");
  return (outcome.failure as { _tag: string })._tag;
};

/** Returns a copy of the object without the key, as a server that never sends the field. */
const leaveOut = (object: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));

describe("parseBearerChallenge", () => {
  it.each([
    [
      "a challenge that names its metadata and a scope",
      'Bearer realm="mcp", resource_metadata="https://a.example/meta", scope="read write"',
      { resourceMetadata: "https://a.example/meta", scope: "read write" },
    ],
    ["a bare Bearer challenge", "Bearer", { resourceMetadata: undefined, scope: undefined }],
    [
      "a Basic challenge that carries the parameter",
      'Basic realm="x", resource_metadata="https://a.example/meta"',
      { resourceMetadata: undefined, scope: undefined },
    ],
    [
      "a Basic challenge and then a Bearer challenge",
      'Basic realm="x", Bearer error="invalid_token", resource_metadata="https://a.example/meta"',
      { resourceMetadata: "https://a.example/meta", scope: undefined },
    ],
    [
      "a parameter name inside another parameter's quoted text",
      'Bearer error_description="resource_metadata=x, scope=y"',
      { resourceMetadata: undefined, scope: undefined },
    ],
    [
      "unquoted values and mixed case names",
      "Bearer Resource_Metadata=https://a.example/meta, SCOPE=read",
      { resourceMetadata: "https://a.example/meta", scope: "read" },
    ],
    [
      "an escaped quote in a quoted value",
      'Bearer scope="a\\"b"',
      { resourceMetadata: undefined, scope: 'a"b' },
    ],
    [
      "an unquoted address that holds an equals sign",
      "Bearer resource_metadata=https://a.example/meta?x=1",
      { resourceMetadata: "https://a.example/meta?x=1", scope: undefined },
    ],
    ["no header", undefined, { resourceMetadata: undefined, scope: undefined }],
  ])("reads %s", (_name, header, expected) => {
    expect(parseBearerChallenge(header)).toEqual(expected);
  });

  it("reads no challenge from a header over 8 KiB, and a hostile 64 KiB header in a few milliseconds", () => {
    const tooLong = `Bearer scope="read", ${"a".repeat(8 * 1024)}`;
    expect(parseBearerChallenge(tooLong)).toEqual({
      resourceMetadata: undefined,
      scope: undefined,
    });

    // Shapes that make a backtracking pattern run in quadratic time.
    for (const hostile of [
      `Bearer ${"a".repeat(8000)}"=`,
      `Bearer ${"a=".repeat(4000)}"`,
      `Bearer ${' a "'.repeat(2000)}`,
      `Bearer x="${"\\".repeat(8000)}`,
    ]) {
      const started = performance.now();
      parseBearerChallenge(hostile);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });
});

describe("discoverAuthorization", () => {
  it("returns the endpoints, the resource, the scope the resource lists and the auth methods", async () => {
    const { outcome } = await discover({
      [`GET ${PRM_URL}`]: { ...PRM, scopes_supported: ["read", 3, "write"] },
      [`GET ${AS_URL}`]: AS,
    });

    expect(outcome).toMatchObject({
      _tag: "Success",
      success: {
        issuer: ISSUER,
        authorizationEndpoint: `${ISSUER}/authorize`,
        tokenEndpoint: `${ISSUER}/token`,
        registrationEndpoint: `${ISSUER}/register`,
        resource: SERVER,
        scope: "read write",
        sendsIssuer: true,
        tokenEndpointAuthMethods: ["none", "client_secret_post"],
      },
    });
  });

  it("says the authorization server sends no iss unless its metadata says true, and has no registration endpoint when it names none", async () => {
    for (const flag of [undefined, "true"]) {
      const { outcome } = await discover({
        [`GET ${PRM_URL}`]: PRM,
        [`GET ${AS_URL}`]: {
          ...leaveOut(AS, "registration_endpoint"),
          authorization_response_iss_parameter_supported: flag,
        },
      });
      expect(outcome).toMatchObject({
        success: { sendsIssuer: false, registrationEndpoint: undefined },
      });
    }
  });

  it("goes to the address a Bearer challenge names, and asks for the scope the challenge asks for", async () => {
    const { outcome, web } = await discover({
      [`POST ${SERVER}`]: new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="https://mcp.example.com/meta", scope="admin"`,
        },
      }),
      "GET https://mcp.example.com/meta": { ...PRM, scopes_supported: ["read"] },
      [`GET ${AS_URL}`]: AS,
    });

    expect(outcome).toMatchObject({ success: { scope: "admin" } });
    expect(web.metadataRequests[0]).toBe("https://mcp.example.com/meta");
  });

  it.each([
    [
      "a server with a path and a query, path first",
      "https://mcp.example.com/a/mcp?k=1#top",
      [
        "https://mcp.example.com/.well-known/oauth-protected-resource/a/mcp?k=1",
        "https://mcp.example.com/.well-known/oauth-protected-resource",
      ],
    ],
    [
      "a server with a query and no path, the query first",
      "https://mcp.example.com/?tenant=1",
      [
        "https://mcp.example.com/.well-known/oauth-protected-resource?tenant=1",
        "https://mcp.example.com/.well-known/oauth-protected-resource",
      ],
    ],
    [
      "a server with no path, once",
      "https://mcp.example.com",
      ["https://mcp.example.com/.well-known/oauth-protected-resource"],
    ],
  ])("asks for the protected resource metadata of %s", async (_name, server, expected) => {
    const { outcome, web } = await discover({}, server);

    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AuthorizationUnsupported", message: "it publishes no OAuth metadata" },
    });
    expect(web.metadataRequests).toEqual(expected);
  });

  it("accepts the metadata at the origin of the server, which is about the origin", async () => {
    const { outcome } = await discover(
      {
        "GET https://mcp.example.com/.well-known/oauth-protected-resource": {
          resource: "https://mcp.example.com/",
          authorization_servers: [ISSUER],
        },
        [`GET ${AS_URL}`]: AS,
      },
      "https://mcp.example.com/a/mcp",
    );

    expect(outcome).toMatchObject({ success: { resource: "https://mcp.example.com/" } });
  });

  it.each([
    [
      "an issuer with no path, in the two forms",
      ISSUER,
      [
        `${ISSUER}/.well-known/oauth-authorization-server`,
        `${ISSUER}/.well-known/openid-configuration`,
      ],
    ],
    [
      "an issuer with a path, in the three forms",
      `${ISSUER}/tenant/`,
      [
        `${ISSUER}/.well-known/oauth-authorization-server/tenant`,
        `${ISSUER}/.well-known/openid-configuration/tenant`,
        `${ISSUER}/tenant/.well-known/openid-configuration`,
      ],
    ],
  ])("asks for the authorization server metadata of %s", async (_name, issuer, expected) => {
    const { outcome, web } = await discover({
      [`GET ${PRM_URL}`]: { resource: SERVER, authorization_servers: [issuer] },
    });

    expect(outcome).toMatchObject({ failure: { _tag: "AuthorizationUnreadable" } });
    expect(failureMessage(outcome)).toContain("is not there");
    expect(web.metadataRequests.slice(1)).toEqual(expected);
  });

  it("accepts a resource identifier that differs only as the URL standard writes it", async () => {
    const { outcome } = await discover(
      {
        "GET https://mcp.example.com/.well-known/oauth-protected-resource": {
          resource: "https://mcp.example.com",
          authorization_servers: [ISSUER],
        },
        [`GET ${AS_URL}`]: AS,
      },
      "https://mcp.example.com",
    );

    expect(outcome).toMatchObject({ _tag: "Success" });
  });

  it.each([
    ["another address", { ...PRM, resource: "https://evil.example/mcp" }],
    ["a fragment", { ...PRM, resource: `${SERVER}#x` }],
    ["a query that the server's address lacks", { ...PRM, resource: `${SERVER}?k=1` }],
    ["no resource", leaveOut(PRM, "resource")],
    ["an address that is not one", { ...PRM, resource: "nope" }],
    ["no authorization server", { ...PRM, authorization_servers: [] }],
    ["a first authorization server that is not text", { ...PRM, authorization_servers: [7] }],
    ["a body that is not an object", "text"],
  ])("refuses protected resource metadata with %s", async (_name, prm) => {
    expect(await discoveryFailure(prm, AS)).toBe("AuthorizationUnreadable");
  });

  it("refuses protected resource metadata that drops the query of the server's address", async () => {
    const server = `${SERVER}?k=1`;
    const { outcome } = await discover(
      { [`GET ${PRM_URL}?k=1`]: PRM, [`GET ${AS_URL}`]: AS },
      server,
    );
    expect(outcome).toMatchObject({ failure: { _tag: "AuthorizationUnreadable" } });
  });

  it.each([
    ["another issuer", { ...AS, issuer: "https://evil.example" }],
    ["no token endpoint", leaveOut(AS, "token_endpoint")],
    ["a token endpoint on http", { ...AS, token_endpoint: "http://auth.example.com/token" }],
    ["a file address as an endpoint", { ...AS, token_endpoint: "file:///etc/passwd" }],
    [
      "an authorization endpoint with a user name",
      { ...AS, authorization_endpoint: "https://u@auth.example.com/a" },
    ],
    [
      "a registration endpoint on http",
      { ...AS, registration_endpoint: "http://auth.example.com/register" },
    ],
    ["a body that is not an object", 3],
  ])("refuses authorization server metadata with %s", async (_name, as) => {
    expect(await discoveryFailure(PRM, as)).toBe("AuthorizationUnreadable");
  });

  it("refuses an issuer with a query", async () => {
    const issuer = `${ISSUER}?a=1`;
    const { outcome } = await discover({
      [`GET ${PRM_URL}`]: { ...PRM, authorization_servers: [issuer] },
      [`GET ${ISSUER}/.well-known/oauth-authorization-server`]: { ...AS, issuer },
    });
    expect(outcome).toMatchObject({ failure: { _tag: "AuthorizationUnreadable" } });
  });

  it.each([
    ["no PKCE methods", leaveOut(AS, "code_challenge_methods_supported")],
    ["only the plain PKCE method", { ...AS, code_challenge_methods_supported: ["plain"] }],
  ])("is unsupported when the authorization server has %s", async (_name, as) => {
    expect(await discoveryFailure(PRM, as)).toBe("AuthorizationUnsupported");
  });

  it("refuses a metadata answer that is a 200 but not JSON, and one over the size limit", async () => {
    const notJson = await discover({ [`GET ${PRM_URL}`]: new Response("<html>no</html>") });
    const tooLarge = await discover({
      [`GET ${PRM_URL}`]: new Response("x".repeat(1024 * 1024 + 1)),
    });

    expect(notJson.outcome).toMatchObject({ failure: { _tag: "AuthorizationUnreadable" } });
    expect(failureMessage(tooLarge.outcome)).toContain("more than 1048576 bytes");
  });

  it("refuses a redirect, which it never follows, and a server error", async () => {
    const redirect = await discover({
      [`GET ${PRM_URL}`]: new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/" },
      }),
    });
    const failing = await discover({ [`GET ${PRM_URL}`]: new Response(null, { status: 503 }) });

    expect(failureMessage(redirect.outcome)).toContain("redirect");
    expect(failing.outcome).toMatchObject({ failure: { _tag: "AuthorizationUnreadable" } });
    expect(redirect.web.metadataRequests).toEqual([PRM_URL]);
  });

  describe("on an http server", () => {
    const HTTP_SERVER = "http://127.0.0.1:9/mcp";
    const HTTP_ISSUER = "http://127.0.0.1:9";
    const http = (key: string, value: string) =>
      ({
        ...AS,
        issuer: HTTP_ISSUER,
        authorization_endpoint: `${HTTP_ISSUER}/authorize`,
        token_endpoint: `${HTTP_ISSUER}/token`,
        registration_endpoint: `${HTTP_ISSUER}/register`,
        [key]: value,
      }) as Record<string, unknown>;
    const answers = (as: unknown, issuer = HTTP_ISSUER) => ({
      "GET http://127.0.0.1:9/.well-known/oauth-protected-resource/mcp": {
        resource: HTTP_SERVER,
        authorization_servers: [issuer],
      },
      [`GET ${issuer}/.well-known/oauth-authorization-server`]: as,
    });

    it("accepts an http authorization server on the origin of the server", async () => {
      const { outcome } = await discover(
        answers(http("token_endpoint", `${HTTP_ISSUER}/token`)),
        HTTP_SERVER,
      );
      expect(outcome).toMatchObject({ success: { tokenEndpoint: `${HTTP_ISSUER}/token` } });
    });

    it.each([
      ["another port", "http://127.0.0.1:77"],
      ["another host", "http://127.0.0.2:9"],
    ])("refuses an http authorization server on %s", async (_name, issuer) => {
      const as = {
        ...AS,
        issuer,
        authorization_endpoint: `${issuer}/a`,
        token_endpoint: `${issuer}/t`,
        registration_endpoint: `${issuer}/r`,
      };
      const { outcome } = await discover(answers(as, issuer), HTTP_SERVER);
      expect(outcome).toMatchObject({
        failure: {
          message: "the authorization server is http, and only the MCP server's own origin may be",
        },
      });
    });

    it.each(["authorization_endpoint", "token_endpoint", "registration_endpoint"])(
      "refuses an http %s of an https issuer, even on the origin of the server",
      async (key) => {
        const { outcome } = await discover(
          {
            "GET http://127.0.0.1:9/.well-known/oauth-protected-resource/mcp": {
              resource: HTTP_SERVER,
              authorization_servers: [ISSUER],
            },
            [`GET ${AS_URL}`]: { ...AS, [key]: "http://127.0.0.1:9/endpoint" },
          },
          HTTP_SERVER,
        );
        expect(failureMessage(outcome)).toContain("but its authorization server is https");
      },
    );
  });
});

describe("registerClient", () => {
  const AUTHORIZATION: AuthorizationServer = {
    issuer: ISSUER,
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    registrationEndpoint: `${ISSUER}/register`,
    sendsIssuer: false,
    tokenEndpointAuthMethods: [],
  };
  const register = (answer: unknown, authorization = AUTHORIZATION) =>
    stubWeb({ [`POST ${ISSUER}/register`]: answer }).run(registerClient(authorization));

  it("returns a public client when no secret and no method come back", async () => {
    expect(await register({ client_id: "c1" })).toMatchObject({
      success: { clientId: "c1", authMethod: "none" },
    });
  });

  it("returns a public client for the method none, and drops a secret that comes with it", async () => {
    const outcome = await register({
      client_id: "c1",
      client_secret: "s",
      token_endpoint_auth_method: "none",
    });
    expect(outcome).toMatchObject({ success: { clientId: "c1", authMethod: "none" } });
    expect((outcome as { success: object }).success).not.toHaveProperty("clientSecret");
  });

  it.each(["client_secret_post", "client_secret_basic"] as const)(
    "keeps the secret and the method %s",
    async (method) => {
      expect(
        await register({ client_id: "c1", client_secret: "s", token_endpoint_auth_method: method }),
      ).toMatchObject({ success: { clientSecret: "s", authMethod: method } });
    },
  );

  it("picks client_secret_post for a secret with no method when the token endpoint lists it, else basic", async () => {
    const answer = { client_id: "c1", client_secret: "s" };
    expect(
      await register(answer, {
        ...AUTHORIZATION,
        tokenEndpointAuthMethods: ["client_secret_post"],
      }),
    ).toMatchObject({ success: { authMethod: "client_secret_post" } });
    expect(
      await register(answer, { ...AUTHORIZATION, tokenEndpointAuthMethods: ["private_key_jwt"] }),
    ).toMatchObject({ success: { authMethod: "client_secret_basic" } });
  });

  it("keeps when the secret expires, in milliseconds, and treats 0 as never", async () => {
    const answer = {
      client_id: "c1",
      client_secret: "s",
      token_endpoint_auth_method: "client_secret_post",
    };
    expect(await register({ ...answer, client_secret_expires_at: 1_900_000_000 })).toMatchObject({
      success: { secretExpiresAtMillis: 1_900_000_000_000 },
    });
    expect(
      ((await register({ ...answer, client_secret_expires_at: 0 })) as { success: object }).success,
    ).not.toHaveProperty("secretExpiresAtMillis");
  });

  it("reads a secret expiry more than ten years away, or too large to convert, as no expiry", async () => {
    const answer = {
      client_id: "c1",
      client_secret: "s",
      token_endpoint_auth_method: "client_secret_post",
    };
    for (const farAway of [4_000_000_000, 1e306]) {
      const outcome = (await register({ ...answer, client_secret_expires_at: farAway })) as {
        success: object;
      };
      expect(outcome.success).not.toHaveProperty("secretExpiresAtMillis");
    }
  });

  it("accepts redirect addresses that include the registered one", async () => {
    expect(
      await register({
        client_id: "c1",
        redirect_uris: ["http://x.example/cb", "http://127.0.0.1/callback"],
      }),
    ).toMatchObject({ _tag: "Success" });
  });

  it.each([
    ["no client id", { client_secret: "s" }],
    ["an empty client id", { client_id: "" }],
    [
      "redirect addresses that lose the registered one",
      { client_id: "c1", redirect_uris: ["http://other.example/cb"] },
    ],
    [
      "a method Hercule does not speak",
      { client_id: "c1", client_secret: "s", token_endpoint_auth_method: "private_key_jwt" },
    ],
    [
      "a method that needs a secret, and no secret",
      { client_id: "c1", token_endpoint_auth_method: "client_secret_post" },
    ],
    ["a body that is not an object", undefined],
  ])("refuses an answer with %s", async (_name, answer) => {
    expect(await register(answer === undefined ? new Response("[]") : answer)).toMatchObject({
      failure: { _tag: "AuthorizationUnreadable" },
    });
  });

  it("is unsupported when the authorization server has no registration endpoint or refuses Hercule, and unreadable for a server error", async () => {
    expect(
      await stubWeb({}).run(registerClient({ ...AUTHORIZATION, registrationEndpoint: undefined })),
    ).toMatchObject({ failure: { _tag: "AuthorizationUnsupported" } });
    expect(await register(new Response("no", { status: 400 }))).toMatchObject({
      failure: { _tag: "AuthorizationUnsupported" },
    });
    expect(await register(new Response("no", { status: 503 }))).toMatchObject({
      failure: { _tag: "AuthorizationUnreadable" },
    });
  });
});

describe("buildAuthorizationUrl", () => {
  const request = {
    authorizationEndpoint: "https://auth.example.com/authorize?audience=mcp",
    clientId: "c 1",
    redirectUri: "http://127.0.0.1:50000/callback",
    codeChallenge: "challenge",
    state: "state",
    resource: "https://mcp.example.com/mcp",
    scope: "read write",
  };

  it("sets the authorization code parameters and keeps the endpoint's own query", () => {
    const url = new URL(buildAuthorizationUrl(request));
    expect(`${url.origin}${url.pathname}`).toBe("https://auth.example.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      audience: "mcp",
      response_type: "code",
      client_id: "c 1",
      redirect_uri: "http://127.0.0.1:50000/callback",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      state: "state",
      resource: "https://mcp.example.com/mcp",
      scope: "read write",
    });
  });

  it("leaves the scope out when there is none", () => {
    const url = new URL(buildAuthorizationUrl({ ...request, scope: undefined }));
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("replaces a parameter of the same name that the endpoint already has", () => {
    const url = new URL(
      buildAuthorizationUrl({
        ...request,
        authorizationEndpoint: "https://auth.example.com/authorize?state=evil&response_type=token",
      }),
    );
    expect(url.searchParams.getAll("state")).toEqual(["state"]);
    expect(url.searchParams.getAll("response_type")).toEqual(["code"]);
  });
});

describe("the body of an answer that discovery does not read", () => {
  /** How the test server answers: a body that never ends, or one that is a few bytes. */
  interface Answer {
    readonly status: number;
    readonly headers?: Record<string, string>;
    /** The size of each chunk of a body that never ends. A body with no `endless` is empty. */
    readonly endless?: number;
  }

  /**
   * Starts a server that answers a POST (the probe of the MCP server) and a
   * GET (a metadata request) as `answers` say, and records which endless
   * bodies the client cancelled.
   */
  const startServer = (answers: { readonly post: Answer; readonly get: Answer }) => {
    const cancelled = { post: false, get: false };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const kind = request.method === "POST" ? "post" : "get";
        const { endless, ...init } = answers[kind];
        if (endless === undefined) return new Response(null, init);
        const chunk = new Uint8Array(endless);
        let timer: ReturnType<typeof setInterval> | undefined;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(chunk);
              timer = setInterval(() => controller.enqueue(chunk), 20);
            },
            cancel() {
              cancelled[kind] = true;
              clearInterval(timer);
            },
          }),
          init,
        );
      },
    });
    return {
      cancelled,
      url: `http://127.0.0.1:${String(server.port)}/mcp`,
      stop: () => server.stop(true),
    };
  };

  /**
   * Waits until the server saw the body cancelled, and gives up after 300
   * milliseconds. A client that only gives up its connection later (when its
   * runtime notices, almost a second on Bun) fails this on purpose.
   */
  const waitForCancel = async (read: () => boolean): Promise<boolean> => {
    for (let waited = 0; waited < 300 && !read(); waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return read();
  };

  const discover = (url: string) =>
    Effect.runPromise(
      Effect.flip(discoverAuthorization(url)).pipe(Effect.provide(FetchHttpClient.layer)),
    );

  it("is cancelled for the probe, which only its status and headers matter for", async () => {
    // The probe answers 200 with a body that never ends, so discovery goes on
    // to the metadata, which is not there.
    const server = startServer({ post: { status: 200, endless: 1 }, get: { status: 404 } });
    try {
      expect((await discover(server.url))._tag).toBe("AuthorizationUnsupported");
      expect(await waitForCancel(() => server.cancelled.post)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("is cancelled for a redirect", async () => {
    const server = startServer({
      post: { status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" }, endless: 1 },
      get: { status: 404 },
    });
    try {
      expect(await discover(server.url)).toMatchObject({ _tag: "AuthorizationUnreadable" });
      expect(await waitForCancel(() => server.cancelled.post)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("is cancelled for a server error", async () => {
    const server = startServer({ post: { status: 503, endless: 1 }, get: { status: 404 } });
    try {
      expect(await discover(server.url)).toMatchObject({ _tag: "AuthorizationUnreadable" });
      expect(await waitForCancel(() => server.cancelled.post)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("is cancelled for a body over the limit", async () => {
    const server = startServer({
      post: { status: 401 },
      get: { status: 200, endless: 1024 * 1024 + 1 },
    });
    try {
      expect(await discover(server.url)).toMatchObject({ _tag: "AuthorizationUnreadable" });
      expect(await waitForCancel(() => server.cancelled.get)).toBe(true);
    } finally {
      await server.stop();
    }
  });
});
