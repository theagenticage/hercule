#!/usr/bin/env bun
/**
 * Throwaway proof for issue #1210: can the controller be the OAuth client for a
 * remote MCP server while the user's browser sits on another machine?
 *
 * The sign-in is split in two:
 *   - `catch`  runs on the user's machine. It listens on loopback, receives the
 *              redirect the authorization server sends the browser to, and prints
 *              the whole query string (code, state, iss, or error).
 *   - `start`  runs on the controller machine. It discovers the server, registers
 *              a client, makes the PKCE verifier and state, and prints the URL
 *              to open in the browser.
 *   - `finish` runs on the controller machine. It takes the printed query string,
 *              checks state and iss, swaps the code for tokens with the verifier
 *              it kept, then talks MCP and refreshes once.
 *
 * Nothing secret is printed or put in the report: not access tokens, refresh
 * tokens, client secrets, the code, or the verifier. They live only in the state
 * file (mode 0600) between `start` and `finish`, and `finish` deletes it.
 * The one exception is `catch`, which must print the query string it received.
 *
 * Usage: bun proof.ts <catch|start|finish> [options]   (see README.md)
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const REQUEST_TIMEOUT_MS = 30_000;
const CATCH_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_STATE_FILE = join(import.meta.dir, "attempt.json");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A step failed or a check refused to continue. The message is always safe to print. */
class Refusal extends Error {}

function fail(message: string): never {
  throw new Refusal(message);
}

function say(line: string): void {
  console.log(line);
}

type Json = Record<string, unknown>;

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** Returns the value if it is a string, else undefined. */
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/**
 * Parses a URL and refuses anything but http(s) without credentials in it.
 * Every URL we follow, including ones a server told us about, goes through here.
 */
function checkUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(`${what}: not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`${what}: only http and https URLs are allowed, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    fail(`${what}: the URL must not contain a user name or password`);
  }
  return url;
}

/** Origin plus path, no query. Queries can hold codes, so they are never printed. */
function show(url: URL): string {
  return url.origin + url.pathname;
}

/**
 * Makes text from a server safe to print: control characters become "?" and the
 * text is cut to `max` characters. Every server-supplied string goes through
 * here, so an odd answer cannot flood the terminal or carry escape codes.
 */
function clip(text: string, max = 200): string {
  const plain = text.replace(/[\u0000-\u001f\u007f]/g, "?");
  return plain.length > max ? `${plain.slice(0, max)}...` : plain;
}

/** Returns up to 20 clipped strings from a JSON array, or null when the value is not an array. */
function clippedStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 20).map((item) => clip(String(item), 200));
}

/**
 * Formats the `error` code (at most 100 characters) and `error_description`
 * (at most 200) of an OAuth error answer. Never prints anything else of the body.
 */
function describeOAuthError(body: Json): string {
  const error = str(body.error) ? clip(str(body.error)!, 100) : "(no error field)";
  const description = str(body.error_description);
  return description ? `${error} - ${clip(description)}` : error;
}

/**
 * Returns text that is safe to print for any thrown value. Our own refusals
 * carry bounded messages; anything else (a JSON parse error can quote the
 * input) is reduced to its name.
 */
function safeMessage(error: unknown): string {
  if (error instanceof Refusal) return error.message;
  return `unexpected ${error instanceof Error ? error.name : "failure"}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Sends one request with a 30 s timeout and without following redirects.
 * Fails with a message that names the URL (no query) and never echoes a body.
 */
async function rawFetch(url: URL, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "error";
    return fail(`${what}: request to ${show(url)} failed (${name})`);
  }
}

/**
 * Like rawFetch, but any 3xx answer is a failure. Used for every request that
 * carries a credential, a code, a verifier or a refresh token: such a request
 * must never be replayed to a place the server picked.
 */
async function requestOnce(url: URL, init: RequestInit, what: string): Promise<Response> {
  const response = await rawFetch(url, init, what);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    fail(`${what}: ${show(url)} answered a redirect (${response.status}), which is refused`);
  }
  return response;
}

/** Like requestOnce, and also refuses to send a credential over plain http to a non-loopback host. */
async function sendCredential(url: URL, init: RequestInit, what: string): Promise<Response> {
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    fail(`${what}: refusing to send a credential over plain http to ${url.hostname}`);
  }
  return requestOnce(url, init, what);
}

/**
 * GET without any credential. Follows at most 3 redirects by hand, only to
 * https URLs, and bumps `facts.metadataRedirects` when one happened.
 */
async function getPublic(start: URL, what: string, facts: Json): Promise<Response> {
  let url = start;
  for (let hops = 0; ; hops++) {
    const response = await rawFetch(url, { headers: { Accept: "application/json" } }, what);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    await response.body?.cancel();
    if (hops === 3) return fail(`${what}: more than 3 redirects`);
    const next = checkUrl(new URL(location, url).href, `${what} redirect`);
    if (next.protocol !== "https:") fail(`${what}: redirect to a non-https URL is refused`);
    facts.metadataRedirects = Number(facts.metadataRedirects ?? 0) + 1;
    url = next;
  }
}

async function readJsonObject(response: Response, what: string): Promise<Json> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return fail(`${what}: the answer is not JSON`);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail(`${what}: the answer is not a JSON object`);
  }
  return body as Json;
}

/** Tries each URL in order and returns the first that answers 200 with a JSON object. */
async function getFirstMetadata(urls: string[], what: string, facts: Json): Promise<{ url: URL; body: Json }> {
  for (const raw of urls) {
    const url = checkUrl(raw, what);
    const response = await getPublic(url, what, facts);
    if (response.status === 200) return { url, body: await readJsonObject(response, what) };
    await response.body?.cancel();
    say(`  ${show(url)} answered ${response.status}`);
  }
  return fail(`${what}: none of the ${urls.length} candidate URLs answered 200`);
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

interface McpAnswer {
  message: Json;
  sessionId?: string;
  format: "json" | "sse";
}

/**
 * Reads a text/event-stream body until the JSON-RPC message with the wanted id
 * arrives. Other events (notifications, server requests) are skipped.
 */
async function readSseMessage(response: Response, id: number): Promise<Json> {
  const reader = response.body?.getReader();
  if (!reader) return fail("MCP: the event stream has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        try {
          const message = JSON.parse(data) as Json;
          if (message.id === id) return message;
        } catch {
          // Not JSON (a keep-alive or a priming event): skip it.
        }
      }
      if (done) return fail("MCP: the event stream ended without an answer");
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Sends one JSON-RPC request and returns the answer, whether it came as JSON or as SSE. */
async function mcpRequest(
  server: URL,
  token: string,
  session: { id?: string; protocol: string },
  id: number,
  method: string,
  params: Json,
): Promise<McpAnswer> {
  const response = await sendCredential(
    server,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": session.protocol,
        ...(session.id ? { "Mcp-Session-Id": session.id } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    },
    `MCP ${method}`,
  );
  if (response.status !== 200) {
    await response.body?.cancel();
    fail(`MCP ${method}: the server answered ${response.status}`);
  }
  const sessionId = response.headers.get("mcp-session-id") ?? undefined;
  const type = response.headers.get("content-type") ?? "";
  let message: Json;
  let format: "json" | "sse";
  if (type.includes("text/event-stream")) {
    message = await readSseMessage(response, id);
    format = "sse";
  } else {
    const body: unknown = await readJsonObject(response, `MCP ${method}`);
    message = body as Json;
    format = "json";
  }
  if (message.error) {
    const error = message.error as Json;
    fail(`MCP ${method}: JSON-RPC error ${clip(String(error.code), 20)} - ${clip(String(error.message))}`);
  }
  return { message, sessionId, format };
}

interface McpRun {
  protocolVersion: string;
  sessionIdGiven: boolean;
  toolCount: number;
  toolPageFormats: string[];
  tooManyPages: boolean;
  deleteStatus?: number;
}

/**
 * Runs a whole MCP session with the given access token: initialize, the
 * initialized notification, tools/list over all pages (at most 10), and DELETE
 * of the session when the server gave one. Fails if any step is refused.
 */
async function runMcpSession(serverUrl: URL, token: string): Promise<McpRun> {
  const session: { id?: string; protocol: string } = { protocol: MCP_PROTOCOL_VERSION };
  const init = await mcpRequest(serverUrl, token, session, 1, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "hercule-sign-in-proof", version: "0" },
  });
  const result = (init.message.result ?? {}) as Json;
  session.protocol = str(result.protocolVersion) ?? MCP_PROTOCOL_VERSION;
  session.id = init.sessionId;
  say(`  initialize ok, protocol ${session.protocol}, session id ${session.id ? "given" : "not given"}`);

  // A notification has no id and no answer body: the server replies 202.
  const notified = await sendCredential(
    serverUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": session.protocol,
        ...(session.id ? { "Mcp-Session-Id": session.id } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    },
    "MCP notifications/initialized",
  );
  await notified.body?.cancel();
  if (notified.status !== 202 && notified.status !== 200) {
    fail(`MCP notifications/initialized: the server answered ${notified.status}`);
  }

  let toolCount = 0;
  const toolPageFormats: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await mcpRequest(serverUrl, token, session, 2 + pages, "tools/list", cursor ? { cursor } : {});
    const pageResult = (page.message.result ?? {}) as Json;
    const tools = pageResult.tools;
    if (!Array.isArray(tools)) fail("MCP tools/list: the answer has no tools list");
    toolCount += tools.length;
    toolPageFormats.push(page.format);
    cursor = str(pageResult.nextCursor);
    pages++;
  } while (cursor && pages < 10);
  const tooManyPages = Boolean(cursor);
  say(`  tools/list ok, ${toolCount} tools over ${pages} page(s) (${toolPageFormats.join(", ")})`);

  let deleteStatus: number | undefined;
  if (session.id) {
    const deleted = await sendCredential(
      serverUrl,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "MCP-Protocol-Version": session.protocol,
          "Mcp-Session-Id": session.id,
        },
      },
      "MCP session DELETE",
    );
    await deleted.body?.cancel();
    deleteStatus = deleted.status;
    // 405 is allowed by the spec: the server may refuse to let a client end a session.
    say(`  session DELETE answered ${deleteStatus}`);
  }
  return {
    protocolVersion: session.protocol,
    sessionIdGiven: Boolean(session.id),
    toolCount,
    toolPageFormats,
    tooManyPages,
    deleteStatus,
  };
}

// ---------------------------------------------------------------------------
// start: discovery, registration, PKCE, authorization URL
// ---------------------------------------------------------------------------

type ClientAuthMethod = "none" | "client_secret_post" | "client_secret_basic";
type RegistrationMode = "dcr-portless" | "dcr-exact";

/**
 * The client registration kept between runs (`--client-file`), so a second run on
 * another catcher port can reuse the same client. Holds the client secret when
 * the server gave one, so it is written with mode 0600.
 */
interface StoredClient {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  clientAuthMethod: ClientAuthMethod;
  registrationMode: RegistrationMode;
  registeredRedirectUris: string[];
  answeredRedirectUris: string[] | null;
}

/** Everything `finish` needs. Holds secrets (verifier, client secret), so it is written with mode 0600. */
interface Attempt {
  server: string;
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  clientAuthMethod: ClientAuthMethod;
  issParameterAdvertised: boolean;
  redirectUri: string;
  registeredRedirectUris: string[];
  clientReused: boolean;
  registrationMode: RegistrationMode;
  resource: string;
  state: string;
  codeVerifier: string;
  /** Non-secret facts found by `start`, copied into the final report. */
  facts: { discovery: Json; registration: Json };
  verdicts: { discovery: boolean; registration: boolean };
}

/** Reads one parameter (`resource_metadata`, `scope`) out of a WWW-Authenticate header. */
function challengeParam(header: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[\\s,])${name}=(?:"([^"]*)"|([^\\s,]+))`, "i").exec(header);
  return match?.[1] ?? match?.[2];
}

/**
 * Lists where the authorization server metadata may live for an issuer
 * (RFC 8414 first, then OpenID Connect discovery, with the path rules of each).
 */
function authServerMetadataUrls(issuer: URL): string[] {
  const path = issuer.pathname.replace(/\/$/, "");
  if (path === "") {
    return [
      `${issuer.origin}/.well-known/oauth-authorization-server`,
      `${issuer.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
    `${issuer.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** Returns the client_id clipped for printing. The client_id is public, not a secret. */
function clientId(client: StoredClient): string {
  return clip(client.clientId, 200);
}

/** Picks how the client proves itself at the token endpoint when it was given a secret. */
function chooseClientAuthMethod(registered: Json, metadata: Json): ClientAuthMethod {
  const answered = str(registered.token_endpoint_auth_method);
  if (answered === "client_secret_post" || answered === "client_secret_basic") return answered;
  const supported = metadata.token_endpoint_auth_methods_supported;
  if (Array.isArray(supported) && supported.includes("client_secret_post")) return "client_secret_post";
  return "client_secret_basic";
}

async function startCommand(options: {
  server: string;
  redirectPort: number;
  redirectHost: string;
  /** Undefined means "dcr-portless for a new client, whatever the client file says for a reused one". */
  registration?: RegistrationMode;
  stateFile: string;
  clientFile: string;
}): Promise<void> {
  const serverUrl = checkUrl(options.server, "--server");
  const discovery: Json = {};
  const registration: Json = {};

  // 1. Protected resource discovery (RFC 9728). An MCP server that needs a
  //    sign-in answers an anonymous request with 401 and says where to look.
  say(`Discovery: asking ${show(serverUrl)} without credentials`);
  const probe = await requestOnce(
    serverUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "hercule-sign-in-proof", version: "0" },
        },
      }),
    },
    "anonymous initialize",
  );
  await probe.body?.cancel();
  discovery.anonymousStatus = probe.status;
  if (probe.status !== 401) fail(`expected 401 from the anonymous initialize, got ${probe.status}`);
  const challenge = probe.headers.get("www-authenticate") ?? "";
  const challengeMetadataUrl = challengeParam(challenge, "resource_metadata");
  const challengeScope = challengeParam(challenge, "scope");
  discovery.wwwAuthenticateHasResourceMetadata = Boolean(challengeMetadataUrl);
  discovery.wwwAuthenticateScope = challengeScope ? clip(challengeScope) : null;
  say(
    `  401 received; WWW-Authenticate has resource_metadata: ${Boolean(challengeMetadataUrl)}, scope: ${challengeScope ? clip(challengeScope) : "none"}`,
  );

  const wellKnown = `${serverUrl.origin}/.well-known/oauth-protected-resource`;
  const resourcePath = serverUrl.pathname === "/" ? "" : serverUrl.pathname;
  const prmCandidates = challengeMetadataUrl
    ? [challengeMetadataUrl]
    : [`${wellKnown}${resourcePath}`, wellKnown];
  const prm = await getFirstMetadata(prmCandidates, "protected resource metadata", discovery);
  const authorizationServers = prm.body.authorization_servers;
  if (!Array.isArray(authorizationServers) || typeof authorizationServers[0] !== "string") {
    fail("protected resource metadata has no authorization_servers");
  }
  const issuerRaw = authorizationServers[0] as string;
  const resource = str(prm.body.resource) ?? serverUrl.href;
  const scopesSupported = Array.isArray(prm.body.scopes_supported)
    ? prm.body.scopes_supported.filter((s): s is string => typeof s === "string")
    : [];
  discovery.protectedResourceMetadataUrl = show(prm.url);
  discovery.resource = clip(resource);
  discovery.authorizationServers = clippedStrings(authorizationServers);
  discovery.scopesSupported = clippedStrings(scopesSupported);
  say(`  protected resource metadata at ${show(prm.url)}`);
  say(`  resource ${clip(resource)}, authorization server ${clip(issuerRaw)}, scopes_supported: ${clip(scopesSupported.join(" ")) || "none"}`);

  // 2. Authorization server metadata (RFC 8414 or OpenID Connect discovery).
  const issuerUrl = checkUrl(issuerRaw, "authorization server issuer");
  const asMeta = await getFirstMetadata(authServerMetadataUrls(issuerUrl), "authorization server metadata", discovery);
  const metadata = asMeta.body;
  // The issuer inside the metadata must equal the one we asked for, or an attacker
  // could serve metadata for a different server from this URL (RFC 8414 section 3.3).
  if (metadata.issuer !== issuerRaw) {
    fail(`authorization server metadata names issuer ${clip(String(metadata.issuer))}, expected ${clip(issuerRaw)}`);
  }
  const authorizationEndpoint = str(metadata.authorization_endpoint);
  const tokenEndpoint = str(metadata.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) fail("authorization server metadata lacks an authorization or token endpoint");
  const methods = metadata.code_challenge_methods_supported;
  const supportsS256 = Array.isArray(methods) && methods.includes("S256");
  const issAdvertised = metadata.authorization_response_iss_parameter_supported === true;
  Object.assign(discovery, {
    authorizationServerMetadataUrl: show(asMeta.url),
    issuerMatches: true,
    authorizationEndpoint: show(checkUrl(authorizationEndpoint, "authorization_endpoint")),
    tokenEndpoint: show(checkUrl(tokenEndpoint, "token_endpoint")),
    registrationEndpointPresent: Boolean(metadata.registration_endpoint),
    codeChallengeMethodsSupportsS256: supportsS256,
    authorizationResponseIssParameterSupported: metadata.authorization_response_iss_parameter_supported ?? null,
    clientIdMetadataDocumentSupported: metadata.client_id_metadata_document_supported ?? null,
    tokenEndpointAuthMethodsSupported: clippedStrings(metadata.token_endpoint_auth_methods_supported),
    grantTypesSupported: clippedStrings(metadata.grant_types_supported),
  });
  say(`  authorization server metadata at ${show(asMeta.url)}, issuer matches`);
  say(`  authorization_endpoint ${show(checkUrl(authorizationEndpoint, "authorization_endpoint"))}`);
  say(`  token_endpoint ${show(checkUrl(tokenEndpoint, "token_endpoint"))}`);
  say(`  registration_endpoint present: ${Boolean(metadata.registration_endpoint)}`);
  say(`  S256 supported: ${supportsS256}`);
  say(`  iss response parameter advertised: ${String(metadata.authorization_response_iss_parameter_supported ?? "not stated")}`);
  say(`  client ID metadata documents supported: ${String(metadata.client_id_metadata_document_supported ?? "not stated")}`);
  say(`  token endpoint auth methods: ${JSON.stringify(clippedStrings(metadata.token_endpoint_auth_methods_supported) ?? "not stated")}`);
  say(`  grant types: ${JSON.stringify(clippedStrings(metadata.grant_types_supported) ?? "not stated")}`);
  // PKCE with S256 is required by the MCP authorization spec: without it we stop.
  if (!supportsS256) fail("the authorization server does not list S256 in code_challenge_methods_supported");

  // 3. The client: reuse the one in the client file, or register a new one
  //    (RFC 7591) and keep it there. Reuse lets a second run on another catcher
  //    port show whether one registration covers variable loopback ports.
  const redirectUri = `http://${options.redirectHost}:${options.redirectPort}/callback`;
  let client: StoredClient;
  const clientReused = existsSync(options.clientFile);
  if (clientReused) {
    client = JSON.parse(readFileSync(options.clientFile, "utf8")) as StoredClient;
    if (client.issuer !== issuerRaw || typeof client.clientId !== "string") {
      fail(`the client file ${options.clientFile} belongs to another authorization server: delete it or pass another --client-file`);
    }
    if (options.registration && options.registration !== client.registrationMode) {
      fail(`the client file was registered as ${client.registrationMode}, not ${options.registration}: delete it or pass another --client-file`);
    }
    registration.mode = client.registrationMode;
    registration.reused = true;
    registration.clientId = clientId(client);
    registration.clientSecretReturned = Boolean(client.clientSecret);
    registration.clientAuthMethod = client.clientAuthMethod;
    registration.registeredRedirectUris = client.registeredRedirectUris;
    say(`Registration: reusing the client from ${options.clientFile}`);
    say(`  ${client.registrationMode}, client_id ${clientId(client)}, registered redirect URIs ${JSON.stringify(client.registeredRedirectUris)}, client secret kept: ${Boolean(client.clientSecret)}`);
  } else {
    const mode = options.registration ?? "dcr-portless";
    const registrationEndpoint = str(metadata.registration_endpoint);
    if (!registrationEndpoint) {
      fail("no registration_endpoint: dynamic client registration is not offered (this proof cannot continue)");
    }
    // RFC 8252 section 7.3: an authorization server must accept any port on a loopback
    // redirect URI. "portless" registers without a port to test exactly that.
    const registeredRedirectUri = mode === "dcr-portless" ? `http://${options.redirectHost}/callback` : redirectUri;
    const registered = await sendCredential(
      checkUrl(registrationEndpoint, "registration_endpoint"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_name: "Hercule sign-in proof",
          redirect_uris: [registeredRedirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          application_type: "native",
        }),
      },
      "client registration",
    );
    const registeredBody = await readJsonObject(registered, "client registration").catch(() => ({}) as Json);
    registration.mode = mode;
    registration.reused = false;
    registration.registeredRedirectUris = [registeredRedirectUri];
    registration.status = registered.status;
    if (registered.status !== 201 && registered.status !== 200) {
      fail(`registration refused: HTTP ${registered.status}, ${describeOAuthError(registeredBody)}`);
    }
    const newClientId = str(registeredBody.client_id);
    if (!newClientId) fail("registration answered without a client_id");
    const clientSecret = str(registeredBody.client_secret);
    client = {
      issuer: issuerRaw,
      clientId: newClientId,
      clientSecret,
      clientAuthMethod: clientSecret ? chooseClientAuthMethod(registeredBody, metadata) : "none",
      registrationMode: mode,
      registeredRedirectUris: [registeredRedirectUri],
      answeredRedirectUris: clippedStrings(registeredBody.redirect_uris),
    };
    registration.clientId = clientId(client);
    registration.clientSecretReturned = Boolean(clientSecret);
    registration.clientAuthMethod = client.clientAuthMethod;
    registration.answeredRedirectUris = client.answeredRedirectUris;
    writeFileSync(options.clientFile, JSON.stringify(client, null, 2), { mode: 0o600 });
    chmodSync(options.clientFile, 0o600);
    say(`Registration: ${mode}, redirect URI registered as ${registeredRedirectUri}`);
    say(`  HTTP ${registered.status}, client_id ${clientId(client)}, client secret returned: ${Boolean(clientSecret)}, auth method ${client.clientAuthMethod}`);
    say(`  client saved to ${options.clientFile} (mode 0600); delete it when the proof is done`);
  }

  // 4. PKCE (RFC 7636). The verifier never leaves this machine until the token
  //    request. `state` ties the answer to this attempt.
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const state = base64url(randomBytes(16));
  const scope = challengeScope ?? (scopesSupported.length > 0 ? scopesSupported.join(" ") : undefined);

  const attempt: Attempt = {
    server: serverUrl.href,
    issuer: issuerRaw,
    tokenEndpoint,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    clientAuthMethod: client.clientAuthMethod,
    issParameterAdvertised: issAdvertised,
    redirectUri,
    registeredRedirectUris: client.registeredRedirectUris,
    clientReused,
    registrationMode: client.registrationMode,
    resource,
    state,
    codeVerifier,
    facts: { discovery, registration },
    verdicts: { discovery: true, registration: true },
  };
  writeFileSync(options.stateFile, JSON.stringify(attempt, null, 2), { mode: 0o600 });
  chmodSync(options.stateFile, 0o600);
  say(`Attempt saved to ${options.stateFile} (mode 0600, deleted by finish)`);

  const authorizeUrl = checkUrl(authorizationEndpoint, "authorization_endpoint");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", client.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("resource", resource);
  if (scope) authorizeUrl.searchParams.set("scope", scope);
  say("");
  say("Open this URL in the browser on the machine that runs `catch`:");
  say(authorizeUrl.href);
}

// ---------------------------------------------------------------------------
// finish: check the answer, exchange the code, talk MCP, refresh
// ---------------------------------------------------------------------------

/** Accepts a bare query string, "?query", or a whole pasted URL, and returns its parameters. */
function parseCallbackQuery(input: string): URLSearchParams {
  let query = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(query)) query = new URL(query).search;
  query = query.replace(/#.*$/, "").replace(/^\?/, "");
  return new URLSearchParams(query);
}

async function readQueryInput(queryOption: string | undefined): Promise<string> {
  if (queryOption !== undefined) return queryOption;
  if (process.stdin.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await readline.question("Paste the query string (or the whole URL), then press Enter: ");
    readline.close();
    return answer;
  }
  return Bun.stdin.text();
}

/** Posts a form to the token endpoint with the client's own authentication. Returns the status and the JSON answer. */
async function postTokenForm(attempt: Attempt, fields: Record<string, string>, what: string): Promise<{ status: number; body: Json }> {
  const form = new URLSearchParams(fields);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (attempt.clientAuthMethod === "client_secret_basic" && attempt.clientSecret) {
    const pair = `${encodeURIComponent(attempt.clientId)}:${encodeURIComponent(attempt.clientSecret)}`;
    headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
  } else {
    form.set("client_id", attempt.clientId);
    if (attempt.clientAuthMethod === "client_secret_post" && attempt.clientSecret) {
      form.set("client_secret", attempt.clientSecret);
    }
  }
  const response = await sendCredential(
    checkUrl(attempt.tokenEndpoint, "token_endpoint"),
    { method: "POST", headers, body: form },
    what,
  );
  const body = await readJsonObject(response, what).catch(() => ({}) as Json);
  return { status: response.status, body };
}

async function finishCommand(options: { stateFile: string; query?: string }): Promise<number> {
  if (!existsSync(options.stateFile)) fail(`no attempt found at ${options.stateFile}: run \`start\` first`);
  const attempt = JSON.parse(readFileSync(options.stateFile, "utf8")) as Attempt;
  const params = parseCallbackQuery(await readQueryInput(options.query));

  // The authorization server may answer with an error instead of a code.
  const error = params.get("error");
  if (error) {
    say("The authorization server answered with an error:");
    say(`  error: ${clip(error, 100)}`);
    say(`  error_description: ${clip(params.get("error_description") ?? "(none)")}`);
    rmSync(options.stateFile, { force: true });
    say("The attempt is over; the state file was deleted.");
    return 1;
  }

  // Checks that must pass before the code is used. On refusal the state file is
  // kept, so a wrong paste can be retried.
  if (params.get("state") !== attempt.state) fail("state does not match this attempt: refused (nothing was sent to the server)");
  say("state matches");
  const iss = params.get("iss");
  if (iss !== null && iss !== attempt.issuer) fail("iss does not equal the issuer found in discovery: refused (nothing was sent to the server)");
  if (iss === null && attempt.issParameterAdvertised) {
    fail("the server advertises authorization_response_iss_parameter_supported but iss is missing: refused (nothing was sent to the server)");
  }
  say(iss === null ? "iss absent (the server did not promise it)" : "iss present and equals the issuer");
  const code = params.get("code");
  if (!code) fail("the query has no code");

  const serverUrl = checkUrl(attempt.server, "server");
  const report: Json = {
    server: attempt.server,
    redirectUriUsed: attempt.redirectUri,
    registeredRedirectUris: attempt.registeredRedirectUris,
    clientReused: attempt.clientReused,
    registrationMode: attempt.registrationMode,
    ...attempt.facts,
    authorizationResponse: { issPresent: iss !== null, issEqualsIssuer: iss !== null, issAdvertised: attempt.issParameterAdvertised },
  };
  const verdicts: Record<string, boolean | null> = {
    discovery: attempt.verdicts.discovery,
    registration: attempt.verdicts.registration,
    // finish only runs when the redirect delivered a code.
    authorizationRedirectAccepted: true,
    issChecked: iss !== null,
    codeExchangedOnController: false,
    toolsListed: false,
    refreshWorked: null,
  };
  report.verdicts = verdicts;

  // The code works once, so the attempt is spent from here on, whatever happens.
  rmSync(options.stateFile, { force: true });

  try {
    say("Token exchange on this machine:");
    const exchanged = await postTokenForm(
      attempt,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: attempt.redirectUri,
        code_verifier: attempt.codeVerifier,
        resource: attempt.resource,
      },
      "token exchange",
    );
    const accessToken = str(exchanged.body.access_token);
    report.tokenExchange = {
      status: exchanged.status,
      tokenType: clip(String(exchanged.body.token_type ?? "not given"), 40),
      expiresIn: typeof exchanged.body.expires_in === "number" ? exchanged.body.expires_in : null,
      scope: str(exchanged.body.scope) ? clip(str(exchanged.body.scope)!) : null,
      refreshTokenReturned: Boolean(str(exchanged.body.refresh_token)),
    };
    if (exchanged.status !== 200 || !accessToken) {
      fail(`token exchange refused: HTTP ${exchanged.status}, ${describeOAuthError(exchanged.body)}`);
    }
    verdicts.codeExchangedOnController = true;
    const tokenFacts = report.tokenExchange as Json;
    say(`  HTTP ${exchanged.status}, token_type ${String(tokenFacts.tokenType)}, expires_in ${String(tokenFacts.expiresIn ?? "not given")}, scope ${String(tokenFacts.scope ?? "not given")}, refresh token returned: ${Boolean(str(exchanged.body.refresh_token))}`);

    say("MCP with the access token:");
    const mcp = await runMcpSession(serverUrl, accessToken);
    report.mcp = mcp;
    verdicts.toolsListed = true;

    const refreshToken = str(exchanged.body.refresh_token);
    if (refreshToken) {
      say("Refresh:");
      const refreshed = await postTokenForm(
        attempt,
        { grant_type: "refresh_token", refresh_token: refreshToken, resource: attempt.resource },
        "token refresh",
      );
      const newAccessToken = str(refreshed.body.access_token);
      const newRefreshToken = str(refreshed.body.refresh_token);
      report.refresh = {
        status: refreshed.status,
        refreshTokenRotated: Boolean(newRefreshToken && newRefreshToken !== refreshToken),
        toolCountAfterRefresh: null,
      };
      if (refreshed.status !== 200 || !newAccessToken) {
        verdicts.refreshWorked = false;
        fail(`token refresh refused: HTTP ${refreshed.status}, ${describeOAuthError(refreshed.body)}`);
      }
      say(`  HTTP ${refreshed.status}, refresh token rotated: ${Boolean(newRefreshToken && newRefreshToken !== refreshToken)}`);
      // A fresh MCP session: the first one was deleted above, and most servers
      // refuse to reuse a deleted session id.
      verdicts.refreshWorked = false;
      const again = await runMcpSession(serverUrl, newAccessToken);
      (report.refresh as Json).toolCountAfterRefresh = again.toolCount;
      verdicts.refreshWorked = true;
    } else {
      say("No refresh token came back: refresh not tested.");
    }
  } catch (caught) {
    report.failure = safeMessage(caught);
    say(`FAILED: ${String(report.failure)}`);
  }

  say("");
  say("=== REPORT ===");
  say(JSON.stringify(report, null, 2));
  return report.failure ? 1 : 0;
}

// ---------------------------------------------------------------------------
// catch: the listener on the user's machine
// ---------------------------------------------------------------------------

const CAUGHT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign-in received</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem;">
<p>Sign-in received. You can close this tab.</p>
</body></html>`;

async function catchCommand(options: { host: string; port: number }): Promise<number> {
  let deliver!: (query: string) => void;
  const received = new Promise<string>((resolve) => {
    deliver = resolve;
  });
  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== "GET" || pathname !== "/callback") return new Response("Not found", { status: 404 });
      // The raw text after "?", exactly as the browser sent it.
      const question = request.url.indexOf("?");
      deliver(question === -1 ? "" : request.url.slice(question + 1));
      return new Response(CAUGHT_PAGE, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
      });
    },
  });
  say(`Listening on http://${options.host}:${server.port}/callback`);
  say(String(server.port));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CATCH_TIMEOUT_MS);
  });
  const query = await Promise.race([received, timeout]);
  clearTimeout(timer);
  // Let the page finish sending before the listener closes.
  await Bun.sleep(200);
  await server.stop(true);
  if (query === null) {
    console.error("Timed out after 10 minutes without a sign-in.");
    return 1;
  }
  say("===== QUERY STRING (copy the next line, without the markers) =====");
  say(query);
  say("===== END =====");
  return 0;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function parsePort(value: string | undefined, flag: string, allowZero: boolean): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < (allowZero ? 0 : 1) || port > 65535) fail(`${flag} must be a port number`);
  return port;
}

function parseLoopbackHost(value: string | undefined, flag: string): string {
  const host = value ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") fail(`${flag} must be 127.0.0.1 or localhost`);
  return host;
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      server: { type: "string" },
      "redirect-port": { type: "string" },
      "redirect-host": { type: "string" },
      registration: { type: "string" },
      "state-file": { type: "string" },
      "client-file": { type: "string" },
      query: { type: "string" },
    },
  });
  const stateFile = values["state-file"] ?? DEFAULT_STATE_FILE;
  switch (positionals[0]) {
    case "catch":
      return catchCommand({ host: parseLoopbackHost(values.host, "--host"), port: parsePort(values.port ?? "0", "--port", true) });
    case "start": {
      if (!values.server) fail("--server <mcp url> is required");
      const registration = values.registration;
      if (registration !== undefined && registration !== "dcr-portless" && registration !== "dcr-exact") {
        fail("--registration must be dcr-portless or dcr-exact");
      }
      const serverUrl = checkUrl(values.server, "--server");
      await startCommand({
        server: values.server,
        redirectPort: parsePort(values["redirect-port"], "--redirect-port", false),
        redirectHost: parseLoopbackHost(values["redirect-host"], "--redirect-host"),
        registration,
        stateFile,
        clientFile:
          values["client-file"] ??
          join(import.meta.dir, `client-${serverUrl.hostname.replace(/[^a-z0-9.-]/gi, "_")}.json`),
      });
      return 0;
    }
    case "finish":
      return finishCommand({ stateFile, query: values.query });
    default:
      console.error("Usage: bun proof.ts <catch|start|finish> [options]. See README.md.");
      return 2;
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  // Every message we throw is bounded text. Anything else prints only its error name.
  console.error(`error: ${safeMessage(error)}`);
  process.exitCode = 1;
}
