/**
 * Tests the parts of discovery and registration that need no network: reading
 * a `WWW-Authenticate` challenge, listing where metadata may be, the outbound
 * rules on an address, and validating the three documents (protected resource
 * metadata, authorization server metadata, a client registration answer). The
 * requests themselves are tested against a fake authorization server in
 * `sign-in.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import {
  buildAuthorizationServerMetadataUrls,
  buildAuthorizationUrl,
  buildResourceMetadataCandidates,
  checkOutboundUrl,
  parseBearerChallenge,
  readAuthorizationServerMetadata,
  readProtectedResourceMetadata,
  readRegisteredClient,
  REGISTERED_REDIRECT_URI,
} from "./authorization";

const SERVER = new URL("https://mcp.example.com/mcp");
const ISSUER = "https://auth.example.com";

/** Returns a copy of the object without the key, as a server that never sends the field. */
const leaveOut = (object: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));

/** Runs an effect that must fail and returns its error. */
const fails = <E>(effect: Effect.Effect<unknown, E>) => Effect.runPromise(Effect.flip(effect));

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
    ["no header", undefined, { resourceMetadata: undefined, scope: undefined }],
  ])("reads %s", (_name, header, expected) => {
    expect(parseBearerChallenge(header)).toEqual(expected);
  });
});

describe("the addresses where metadata may be", () => {
  it("lists the protected resource metadata of a server with a path, path first, each with the identifier it was built from", () => {
    expect(
      buildResourceMetadataCandidates(new URL("https://mcp.example.com/a/mcp?k=1#top")),
    ).toEqual([
      {
        url: "https://mcp.example.com/.well-known/oauth-protected-resource/a/mcp",
        resource: "https://mcp.example.com/a/mcp?k=1",
      },
      {
        url: "https://mcp.example.com/.well-known/oauth-protected-resource",
        resource: "https://mcp.example.com/",
      },
    ]);
  });

  it("lists the protected resource metadata of a server with no path once", () => {
    expect(buildResourceMetadataCandidates(new URL("https://mcp.example.com"))).toEqual([
      {
        url: "https://mcp.example.com/.well-known/oauth-protected-resource",
        resource: "https://mcp.example.com/",
      },
    ]);
  });

  it("lists the authorization server metadata of an issuer with no path", () => {
    expect(buildAuthorizationServerMetadataUrls(new URL("https://auth.example.com/"))).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
  });

  it("lists the authorization server metadata of an issuer with a path in the three forms", () => {
    expect(
      buildAuthorizationServerMetadataUrls(new URL("https://auth.example.com/tenant/1")),
    ).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant/1",
      "https://auth.example.com/.well-known/openid-configuration/tenant/1",
      "https://auth.example.com/tenant/1/.well-known/openid-configuration",
    ]);
  });
});

describe("checkOutboundUrl", () => {
  it("accepts an https address for an https server and an http address for an http server", async () => {
    expect(
      (await Effect.runPromise(checkOutboundUrl("https://a.example/x", SERVER, "t"))).href,
    ).toBe("https://a.example/x");
    const http = new URL("http://127.0.0.1:9/mcp");
    expect(
      (await Effect.runPromise(checkOutboundUrl("http://127.0.0.1:9/token", http, "t"))).href,
    ).toBe("http://127.0.0.1:9/token");
  });

  it("accepts an https address for an http server", async () => {
    const http = new URL("http://127.0.0.1:9/mcp");
    await expect(
      Effect.runPromise(checkOutboundUrl("https://a.example/x", http, "t")),
    ).resolves.toBeDefined();
  });

  it.each([
    ["not an address", "not a url", "the token endpoint is not an http or https address"],
    ["a file address", "file:///etc/passwd", "the token endpoint is not an http or https address"],
    ["a user name", "https://u@a.example/x", "the token endpoint holds a user name or a password"],
    ["a password", "https://u:p@a.example/x", "the token endpoint holds a user name or a password"],
    [
      "a downgrade",
      "http://a.example/x",
      "the token endpoint is http, and the MCP server is https",
    ],
  ])("refuses %s, and never quotes the address", async (_name, raw, message) => {
    const error = await fails(checkOutboundUrl(raw, SERVER, "token endpoint"));
    expect(error).toMatchObject({ _tag: "AuthorizationUnreadable", message });
  });
});

describe("readProtectedResourceMetadata", () => {
  const SERVER_RESOURCE = "https://mcp.example.com/mcp";
  const read = (body: unknown, expected = SERVER_RESOURCE) =>
    Effect.runPromise(readProtectedResourceMetadata(body, expected));

  it("returns the resource, the first authorization server and the listed scopes", async () => {
    expect(
      await read({
        resource: "https://mcp.example.com/mcp",
        authorization_servers: [ISSUER, "https://other.example"],
        scopes_supported: ["read", 3, "write"],
      }),
    ).toEqual({
      resource: "https://mcp.example.com/mcp",
      issuer: ISSUER,
      scopesSupported: ["read", "write"],
    });
  });

  it.each([
    ["the address with no path slash", "https://mcp.example.com", "https://mcp.example.com/"],
    [
      "the address with its query",
      "https://mcp.example.com/mcp?k=1",
      "https://mcp.example.com/mcp?k=1",
    ],
  ])("accepts %s as the resource", async (_name, resource, expected) => {
    const found = await read({ resource, authorization_servers: [ISSUER] }, expected);
    expect(found.resource).toBe(resource);
  });

  it.each([
    ["another address", { resource: "https://evil.example/mcp", authorization_servers: [ISSUER] }],
    ["a fragment", { resource: "https://mcp.example.com/mcp#x", authorization_servers: [ISSUER] }],
    [
      "a query that the expected address lacks",
      { resource: "https://mcp.example.com/mcp?k=1", authorization_servers: [ISSUER] },
    ],
    ["no resource", { authorization_servers: [ISSUER] }],
    ["an address that is not one", { resource: "nope", authorization_servers: [ISSUER] }],
    [
      "no authorization server",
      { resource: "https://mcp.example.com/mcp", authorization_servers: [] },
    ],
    [
      "a first authorization server that is not text",
      { resource: "https://mcp.example.com/mcp", authorization_servers: [7] },
    ],
    ["a body that is not an object", "text"],
  ])("refuses %s", async (_name, body) => {
    expect(await fails(readProtectedResourceMetadata(body, SERVER_RESOURCE))).toMatchObject({
      _tag: "AuthorizationUnreadable",
    });
  });

  it("refuses a resource that drops the query of the address it must equal", async () => {
    const body = { resource: "https://mcp.example.com/mcp", authorization_servers: [ISSUER] };
    expect(
      await fails(readProtectedResourceMetadata(body, "https://mcp.example.com/mcp?k=1")),
    ).toMatchObject({ _tag: "AuthorizationUnreadable" });
  });
});

describe("readAuthorizationServerMetadata", () => {
  const valid = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    registration_endpoint: `${ISSUER}/register`,
    code_challenge_methods_supported: ["plain", "S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", 4],
    authorization_response_iss_parameter_supported: true,
  };
  const read = (body: unknown, server = SERVER) =>
    Effect.runPromise(readAuthorizationServerMetadata(body, ISSUER, server));

  it("returns the endpoints, whether it sends iss, and the auth methods", async () => {
    expect(await read(valid)).toEqual({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      registrationEndpoint: `${ISSUER}/register`,
      sendsIssuer: true,
      tokenEndpointAuthMethods: ["none", "client_secret_post"],
    });
  });

  it("says it sends no iss unless the metadata says true", async () => {
    const without = leaveOut(valid, "authorization_response_iss_parameter_supported");
    expect((await read(without)).sendsIssuer).toBe(false);
    expect(
      (await read({ ...valid, authorization_response_iss_parameter_supported: "true" }))
        .sendsIssuer,
    ).toBe(false);
  });

  it("accepts metadata with no registration endpoint", async () => {
    const without = leaveOut(valid, "registration_endpoint");
    expect((await read(without)).registrationEndpoint).toBeUndefined();
  });

  it.each([
    ["another issuer", { ...valid, issuer: "https://evil.example" }],
    ["an issuer with a query", { ...valid, issuer: `${ISSUER}?a=1` }],
    ["no token endpoint", { ...valid, token_endpoint: undefined }],
    ["a token endpoint on http", { ...valid, token_endpoint: "http://auth.example.com/token" }],
    [
      "an authorization endpoint with a user name",
      { ...valid, authorization_endpoint: "https://u@auth.example.com/a" },
    ],
    [
      "a registration endpoint on http",
      { ...valid, registration_endpoint: "http://auth.example.com/register" },
    ],
    ["a body that is not an object", 3],
  ])("refuses %s", async (_name, body) => {
    expect(await fails(readAuthorizationServerMetadata(body, ISSUER, SERVER))).toMatchObject({
      _tag: "AuthorizationUnreadable",
    });
  });

  it.each([
    ["no PKCE methods", { ...valid, code_challenge_methods_supported: undefined }],
    ["only the plain PKCE method", { ...valid, code_challenge_methods_supported: ["plain"] }],
  ])("is unsupported with %s", async (_name, body) => {
    expect(await fails(readAuthorizationServerMetadata(body, ISSUER, SERVER))).toMatchObject({
      _tag: "AuthorizationUnsupported",
    });
  });
});

describe("readRegisteredClient", () => {
  const read = (body: unknown, methods: ReadonlyArray<string> = []) =>
    Effect.runPromise(readRegisteredClient(body, methods));

  it("returns a public client when no secret and no method come back", async () => {
    expect(await read({ client_id: "c1" })).toEqual({ clientId: "c1", authMethod: "none" });
  });

  it("returns a public client for the method none, and drops a secret that comes with it", async () => {
    expect(
      await read({ client_id: "c1", client_secret: "s", token_endpoint_auth_method: "none" }),
    ).toEqual({ clientId: "c1", authMethod: "none" });
  });

  it.each(["client_secret_post", "client_secret_basic"] as const)(
    "keeps the secret and the method %s",
    async (method) => {
      expect(
        await read({ client_id: "c1", client_secret: "s", token_endpoint_auth_method: method }),
      ).toEqual({ clientId: "c1", clientSecret: "s", authMethod: method });
    },
  );

  it("picks client_secret_post for a secret with no method when the token endpoint lists it, else basic", async () => {
    expect(
      await read({ client_id: "c1", client_secret: "s" }, ["client_secret_post"]),
    ).toMatchObject({
      authMethod: "client_secret_post",
    });
    expect(await read({ client_id: "c1", client_secret: "s" }, ["private_key_jwt"])).toMatchObject({
      authMethod: "client_secret_basic",
    });
  });

  it("accepts redirect addresses that include the registered one", async () => {
    expect(
      await read({
        client_id: "c1",
        redirect_uris: ["http://x.example/cb", REGISTERED_REDIRECT_URI],
      }),
    ).toMatchObject({ clientId: "c1" });
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
  ])("refuses %s", async (_name, body) => {
    expect(await fails(readRegisteredClient(body, []))).toMatchObject({
      _tag: "AuthorizationUnreadable",
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
