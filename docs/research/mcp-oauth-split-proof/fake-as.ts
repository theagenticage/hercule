/**
 * A local fake that plays both the MCP server and its authorization server, so
 * proof.ts can be tested without touching a real vendor. One Bun.serve on
 * 127.0.0.1. Run it alone with `bun fake-as.ts`, or import `startFake()` in a test.
 *
 * Paths:
 *   POST/DELETE /mcp                                        the MCP server (needs a Bearer token)
 *   GET /.well-known/oauth-protected-resource/mcp           protected resource metadata
 *   GET /.well-known/oauth-authorization-server/auth        authorization server metadata (issuer has a path)
 *   POST /auth/register, GET /auth/authorize, POST /auth/token
 */
import { createHash, randomBytes } from "node:crypto";

export interface FakeHandle {
  /** The MCP server URL to pass to `proof.ts start --server`. */
  serverUrl: string;
  issuer: string;
  /**
   * What the authorize endpoint puts in the redirect:
   * "ok" sends the right iss, "wrong" a different one, "absent" none.
   */
  issMode: "ok" | "wrong" | "absent";
  /**
   * How the authorize endpoint compares redirect URIs:
   * "ignore-port" follows RFC 8252 (any port on a loopback host), "exact" wants a string match.
   */
  redirectMatching: "ignore-port" | "exact";
  /** Every secret the fake handed out, so a test can check none of them is printed. */
  issued: { codes: string[]; accessTokens: string[]; refreshTokens: string[] };
  stop(): Promise<void>;
}

interface Client {
  redirectUris: string[];
}
interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  scope: string;
}

const TOOLS = [{ name: "search" }, { name: "fetch" }, { name: "create" }].map((tool) => ({
  ...tool,
  description: `The ${tool.name} tool`,
  inputSchema: { type: "object", properties: {} },
}));

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...init.headers },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, { status });
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export function startFake(): FakeHandle {
  const clients = new Map<string, Client>();
  const codes = new Map<string, PendingCode>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Map<string, { clientId: string; resource: string; scope: string }>();
  const sessions = new Set<string>();
  const handle: FakeHandle = {
    serverUrl: "",
    issuer: "",
    issMode: "ok",
    redirectMatching: "ignore-port",
    issued: { codes: [], accessTokens: [], refreshTokens: [] },
    stop: async () => {},
  };

  /** Checks a requested redirect URI against the registered ones, as the current mode demands. */
  function redirectUriAllowed(registered: string[], requested: string): boolean {
    if (registered.includes(requested)) return true;
    if (handle.redirectMatching === "exact") return false;
    const wanted = new URL(requested);
    return registered.some((uri) => {
      const known = new URL(uri);
      return (
        isLoopback(known.hostname) &&
        known.protocol === wanted.protocol &&
        known.hostname === wanted.hostname &&
        known.pathname === wanted.pathname
      );
    });
  }

  function issueTokens(clientId: string, resource: string, scope: string): Json {
    const accessToken = `at-${randomBytes(24).toString("hex")}`;
    const refreshToken = `rt-${randomBytes(24).toString("hex")}`;
    accessTokens.add(accessToken);
    refreshTokens.set(refreshToken, { clientId, resource, scope });
    handle.issued.accessTokens.push(accessToken);
    handle.issued.refreshTokens.push(refreshToken);
    return { access_token: accessToken, token_type: "Bearer", expires_in: 3600, scope, refresh_token: refreshToken };
  }

  type Json = Record<string, unknown>;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${server.port}`;
      const issuer = `${origin}/auth`;

      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return json({
          resource: `${origin}/mcp`,
          authorization_servers: [issuer],
          scopes_supported: ["read", "write"],
          bearer_methods_supported: ["header"],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server/auth") {
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
          client_id_metadata_document_supported: false,
        });
      }
      if (url.pathname === "/auth/register" && request.method === "POST") {
        const body = (await request.json()) as Json;
        const redirectUris = body.redirect_uris;
        if (!Array.isArray(redirectUris) || redirectUris.some((uri) => typeof uri !== "string")) {
          return oauthError("invalid_redirect_uri", "redirect_uris must be a list of strings");
        }
        const clientId = `client-${randomBytes(8).toString("hex")}`;
        clients.set(clientId, { redirectUris: redirectUris as string[] });
        return json(
          { client_id: clientId, redirect_uris: redirectUris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] },
          { status: 201 },
        );
      }
      if (url.pathname === "/auth/authorize" && request.method === "GET") {
        const q = url.searchParams;
        const client = clients.get(q.get("client_id") ?? "");
        const redirectUri = q.get("redirect_uri") ?? "";
        // Per RFC 6749 section 4.1.2.1 a bad client or redirect URI is shown to the user, never redirected to.
        if (!client) return new Response("unknown client", { status: 400 });
        if (!redirectUriAllowed(client.redirectUris, redirectUri)) {
          return new Response("redirect_uri does not match a registered one", { status: 400 });
        }
        if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
          return new Response("bad authorization request", { status: 400 });
        }
        const code = `code-${randomBytes(16).toString("hex")}`;
        codes.set(code, {
          clientId: q.get("client_id")!,
          redirectUri,
          challenge: q.get("code_challenge")!,
          resource: q.get("resource") ?? "",
          scope: q.get("scope") ?? "",
        });
        handle.issued.codes.push(code);
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        if (handle.issMode === "ok") back.searchParams.set("iss", issuer);
        if (handle.issMode === "wrong") back.searchParams.set("iss", "https://evil.example/auth");
        return new Response(null, { status: 302, headers: { Location: back.href } });
      }
      if (url.pathname === "/auth/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        const clientId = form.get("client_id") ?? "";
        if (!clients.has(clientId)) return oauthError("invalid_client", "unknown client", 401);
        if (form.get("grant_type") === "authorization_code") {
          const pending = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? ""); // a code works once
          if (!pending || pending.clientId !== clientId) return oauthError("invalid_grant", "unknown or used code");
          if (pending.redirectUri !== form.get("redirect_uri")) return oauthError("invalid_grant", "redirect_uri differs from the authorization request");
          if (pending.resource !== (form.get("resource") ?? "")) return oauthError("invalid_target", "resource differs from the authorization request");
          const verifier = form.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (verifier.length < 43 || verifier.length > 128 || challenge !== pending.challenge) {
            return oauthError("invalid_grant", "PKCE verification failed");
          }
          return json(issueTokens(clientId, pending.resource, pending.scope));
        }
        if (form.get("grant_type") === "refresh_token") {
          const known = refreshTokens.get(form.get("refresh_token") ?? "");
          refreshTokens.delete(form.get("refresh_token") ?? ""); // refresh tokens rotate
          if (!known || known.clientId !== clientId) return oauthError("invalid_grant", "unknown refresh token");
          if (known.resource !== (form.get("resource") ?? "")) return oauthError("invalid_target", "resource differs");
          return json(issueTokens(clientId, known.resource, known.scope));
        }
        return oauthError("unsupported_grant_type", "only authorization_code and refresh_token");
      }
      if (url.pathname === "/mcp") return handleMcp(request, origin);
      return new Response("Not found", { status: 404 });
    },
  });

  async function handleMcp(request: Request, origin: string): Promise<Response> {
    const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!bearer || !accessTokens.has(bearer)) {
      return new Response("unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read"`,
        },
      });
    }
    const sessionId = request.headers.get("mcp-session-id");
    if (request.method === "DELETE") {
      return new Response(null, { status: sessionId && sessions.delete(sessionId) ? 204 : 404 });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = (await request.json()) as { id?: number; method: string; params?: { cursor?: string } };

    if (message.method === "initialize") {
      const id = `session-${randomBytes(8).toString("hex")}`;
      sessions.add(id);
      return json(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } },
        },
        { headers: { "Mcp-Session-Id": id } },
      );
    }
    if (!sessionId || !sessions.has(sessionId)) return new Response("no session", { status: 404 });
    if (request.headers.get("mcp-protocol-version") !== "2025-11-25") return new Response("bad protocol version", { status: 400 });
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "tools/list") {
      // Page 1 is a JSON answer, page 2 an event stream, to cover both.
      if (message.params?.cursor === "2") {
        const answer = { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS.slice(2) } };
        return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\nevent: message\ndata: ${JSON.stringify(answer)}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return json({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS.slice(0, 2), nextCursor: "2" } });
    }
    return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }

  handle.serverUrl = `http://127.0.0.1:${server.port}/mcp`;
  handle.issuer = `http://127.0.0.1:${server.port}/auth`;
  handle.stop = async () => {
    await server.stop(true);
  };
  return handle;
}

if (import.meta.main) {
  const fake = startFake();
  console.log(`Fake MCP server and authorization server: ${fake.serverUrl}`);
}
