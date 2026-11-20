# MCP protocol and harness facts for central MCP support

These facts back the design of MCP support in Hercule under the constraint "install and sign in once on the controller, use on every runner". They come from the MCP specification, the official TypeScript SDK, and the documentation and source of each harness, all read on 2026-11-17. No session was started and no MCP server was added, removed or signed in to.

Versions examined:

| Thing | Version read | What Hercule pins |
|---|---|---|
| MCP specification | revision `2026-07-28` (current), `2025-11-25` (previous) | - |
| MCP TypeScript SDK | `v2.4.0` and `1.32.2`, both released 2026-10-23 | `@modelcontextprotocol/sdk` 1.30.0 (transitive) |
| Claude Agent SDK (TypeScript) | type definitions of `0.3.263`; docs at code.claude.com | `0.3.263`, which bundles Claude Code `2.1.263` |
| Claude Code CLI | `2.1.325` (`--help` only) | - |
| Codex | source at tag `rust-v0.154.0` (commit `6b9826e3`, 2026-09-09); docs at developers.openai.com, which describe the latest release (`0.169.0`) | `0.154.0` |
| pi | source and docs at `main` (commit `4afe78de`, release `v1.5.2`); README at tag `v0.85.1` | `0.85.1` |
| opencode | live docs at opencode.ai; docs in the repository at tag `v1.19.6` | not a Hercule harness |

## Method

- Spec pages were fetched as Markdown from modelcontextprotocol.io (every page has a `.md` form) and read whole.
- Claude Agent SDK facts come from `sdk.d.ts` of the installed package and from code.claude.com. The worktree has no `node_modules`, so the type definitions were read from the main checkout's `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.263...`.
- Codex facts come from a shallow clone of `openai/codex` at the pinned tag, from the generated protocol types in `apps/runner/src/harnesses/codex/generated/`, and from developers.openai.com. Where the docs describe something the pinned tag does not have, this note says so.
- pi moved: `badlogic/pi-mono` now redirects to `earendil-works/pi`. It was read through the GitHub API and a shallow clone.
- opencode moved: `sst/opencode` now redirects to `anomalyco/opencode`.
- Clones went to a scratch directory outside the repository, were only read, and were deleted afterwards.
- Local CLIs were run with `--help` only: `claude` 2.1.325, `codex` 0.169.0, `pi` 1.5.2, `opencode` 1.18.19.
- "Unverified" marks a claim that no primary source confirmed. The list is at the end.

## A. The MCP protocol

### A1. Current revision and what changed

- **The current revision is `2026-07-28`.** The one before is `2025-11-25` ([Versioning](https://modelcontextprotocol.io/specification/versioning)).
- **`2026-07-28` made the protocol stateless.** The `initialize` handshake is gone. Every request carries its protocol version and client capabilities in `_meta` (`io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities`). Servers must implement `server/discover` ([Key Changes 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog), items 2 and 3).
- **Protocol-level sessions are gone.** The `Mcp-Session-Id` header is removed. `tools/list` no longer varies per connection. A server that needs state across calls returns a handle and takes it back as an ordinary tool argument (same page, item 1).
- **Servers no longer send requests to clients.** Elicitation, sampling and roots now travel inside a result: the server returns `resultType: "input_required"` with `inputRequests`, and the client retries the original request with `inputResponses`. This is called Multi Round-Trip Requests, MRTR (same page, items 7 and 8).
- **The HTTP GET stream is gone.** Change notifications come on the response stream of one long-lived `subscriptions/listen` POST. SSE resumption (`Last-Event-ID`) is removed (same page, items 4 and 9).
- **Tasks left the core.** They are now the extension `io.modelcontextprotocol/tasks`, stage "Beta, to Core" (same page, item 6; [Extensions Overview](https://modelcontextprotocol.io/extensions/overview)).
- **Tool results.** `structuredContent` may be any JSON value, and `inputSchema` and `outputSchema` may use any JSON Schema 2020-12 keyword (same page, minor change 10).
- **Tool lists carry cache hints.** `tools/list` results must carry `ttlMs` and `cacheScope` (`"public"` or `"private"`). Servers should return tools in a stable order (same page, minor changes 3 and 5).
- **New required HTTP headers.** Every POST carries `MCP-Protocol-Version` and `Mcp-Method`, and `Mcp-Name` for `tools/call`, `resources/read` and `prompts/get`. A tool parameter marked `x-mcp-header` is copied into an `Mcp-Param-<name>` header (same page, minor change 4).
- **Authorization changes in `2026-07-28`:**
  - Dynamic Client Registration is deprecated in favour of Client ID Metadata Documents. Earliest removal: the first revision on or after 2027-07-28 ([Deprecated Features](https://modelcontextprotocol.io/specification/2026-07-28/deprecated)).
  - Clients must validate the `iss` parameter of the authorization response when it is present (RFC 9207).
  - Clients must key stored client credentials by the authorization server's issuer and never reuse them with another one.
- **Deprecated in `2026-07-28`:** Roots, Sampling, Logging, and the old HTTP+SSE transport (same page).
- **`2025-11-25` added** ([Key Changes 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/changelog)):
  - Client ID Metadata Documents as the recommended registration.
  - Step-up scope consent through `WWW-Authenticate`.
  - OpenID Connect Discovery for finding the authorization server.
  - URL mode elicitation.
  - Tool name guidance, icons, and experimental tasks.
- **Tool annotations are hints.** `ToolAnnotations` has `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`. Clients must treat them as untrusted unless the server is trusted ([Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [Schema](https://modelcontextprotocol.io/specification/2026-07-28/schema)).

### A2. Transports

- **Two standard transports: stdio and Streamable HTTP** ([Transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)).
- **stdio:** the client starts the server as a child process. Messages are newline-delimited JSON-RPC on stdin and stdout. All request metadata is in the message body. The server never writes a request to stdout ([stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)).
- **A stdio process is not a conversation.** Clients "SHOULD NOT use an individual task, thread, or conversation as the lifetime boundary for the stdio process" ([Overview, Statelessness](https://modelcontextprotocol.io/specification/2026-07-28/basic#statelessness)).
- **Streamable HTTP in `2026-07-28`:** one endpoint that accepts POST. Each request is its own POST. The answer is one JSON object or an SSE stream for that request only. Closing the stream cancels the request ([Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).
- **Streamable HTTP in `2025-03-26` to `2025-11-25`** had a different shape, which clients of that era still use:
  - The server may assign a session id at initialization in the `MCP-Session-Id` header. The client must then send it on every request.
  - The server may end the session at any time and then answers 404. The client ends it with HTTP DELETE.
  - The client may open a GET stream. The server may send requests on SSE streams.
  ([Transports 2025-11-25, Session Management](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management)).
- **Two eras, and a legacy client cannot reach a modern-only server.** The compatibility matrix says a legacy client (one that sends `initialize`) fails against a server that supports only `2026-07-28`, and has no way to fall forward. A server may support both eras on one endpoint ([Versioning and Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#compatibility-matrix)).
- **How a server identifies the caller:**
  - Over HTTP, by the access token. "Authorization MUST be included in every HTTP request from client to server" ([Authorization, Token Requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#token-requirements)).
  - `clientInfo` in `_meta` is self-reported. Implementations "SHOULD NOT rely on them for security decisions" ([Overview, `_meta`](https://modelcontextprotocol.io/specification/2026-07-28/basic#meta)).
  - Over stdio, there is no caller identity in the protocol. Credentials come from the environment.
  - A state handle is not authentication. Servers must not treat possession of one as such ([Security Best Practices, State Handle Hijacking](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#state-handle-hijacking)).
- **HTTP servers must validate the `Origin` header** and answer 403 when it is invalid ([Streamable HTTP, Security](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#security-endpoint)).

### A3. Authorization

All from [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) unless another page is linked.

- **Authorization is optional, and it is for HTTP only.** stdio implementations "SHOULD NOT follow this specification, and instead retrieve credentials from the environment".
- **Roles.** The MCP server is an OAuth 2.1 resource server. The MCP client is an OAuth 2.1 client "making protected resource requests on behalf of a resource owner". The authorization server may be separate.
- **Finding the authorization server.** The MCP server must publish Protected Resource Metadata (RFC 9728) with at least one entry in `authorization_servers`. The client reads its URL from the `resource_metadata` parameter of the 401's `WWW-Authenticate` header, or falls back to `/.well-known/oauth-protected-resource` ([Authorization Server Discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)).
- **Authorization server metadata.** The client must try RFC 8414 and OpenID Connect Discovery well-known URLs in a fixed order, and must reject a document whose `issuer` differs from the one it asked for (same page).
- **Three ways to get a client id**, tried in this order, with a fourth step when none applies ([Client Registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)):
  1. Pre-registered client information, when the client has it.
  2. A Client ID Metadata Document (CIMD), when the authorization server advertises `client_id_metadata_document_supported`.
  3. Dynamic Client Registration (RFC 7591), deprecated, as a fallback.
  4. Asking the user to enter client information.
- **CIMD.** The `client_id` is an HTTPS URL with a path. The document at that URL holds at least `client_id`, `client_name` and `redirect_uris`. The authorization server fetches it and must match the request's redirect URI exactly against it. So the URL must be reachable by the authorization server (same page).
- **PKCE is required.** Clients must use `S256` and must refuse an authorization server whose metadata has no `code_challenge_methods_supported` ([Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations#authorization-code-protection)).
- **Resource indicators (RFC 8707).** The client must send `resource=<canonical URI of the MCP server>` in both the authorization request and the token request, "regardless of whether authorization servers support it".
- **Audience binding.** The MCP server must check that a token was issued for it and must reject any other. The client must not send a server a token that the server's own authorization server did not issue.
- **No token passthrough.** "If the MCP server makes requests to upstream APIs, it may act as an OAuth client to them. The access token used at the upstream API is a separate token, issued by the upstream authorization server. The MCP server MUST NOT pass through the token it received from the MCP client" ([Security Considerations, Access Token Privilege Restriction](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations#access-token-privilege-restriction)).
- **Refresh.** A client must keep refresh tokens confidential "in transit and storage", may request `offline_access`, and must not assume a refresh token is issued. For public clients the authorization server must rotate refresh tokens. Authorization servers should issue short-lived access tokens ([Security Considerations, Token Theft](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations#token-theft)).
- **Scopes.** The client takes the scopes from the `scope` parameter of the 401 challenge, else from `scopes_supported` in the resource metadata.
- **Step-up.** At runtime a server answers 403 with `error="insufficient_scope"` and the scopes it needs. The client re-authorizes with the union of the old and the new scopes and retries a few times at most.
- **Extensions.** Two official authorization extensions exist, both at stage "Stable", both opt-in ([Extensions Overview](https://modelcontextprotocol.io/extensions/overview), [Authorization Extensions](https://modelcontextprotocol.io/extensions/auth/overview)):
  - **OAuth Client Credentials** (`io.modelcontextprotocol/oauth-client-credentials`): machine-to-machine, no user, with a client secret or a signed JWT.
  - **Enterprise-Managed Authorization** (`io.modelcontextprotocol/enterprise-managed-authorization`), also called cross-app access, from SEP-990. The user signs in to the client through the company identity provider. The client exchanges the ID token there for an ID-JAG (RFC 8693), then exchanges the ID-JAG at the MCP server's authorization server for an access token. There is no per-server consent screen ([Enterprise-Managed Authorization](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization)).
  - The TypeScript SDK ships both as `ClientCredentialsProvider` and `CrossAppAccessProvider` ([typescript-sdk `docs/clients/machine-auth.md`, v2.4.0](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/machine-auth.md)).
  - Which clients support them: unverified. The [support matrix](https://modelcontextprotocol.io/extensions/client-matrix) marks cells with icons that the Markdown form drops.

### A4. Who the OAuth client is, and what a central broker may do

- **The spec does not say where the client must run.** The client is defined by its role only. A host "creates and manages multiple client instances" ([Architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture)). No text ties the OAuth client to the machine or process that runs the model.
- **(i) A broker that proxies MCP traffic is a described pattern.** The spec names it "MCP proxy server": "an MCP server that connects MCP clients to third-party APIs ... acting as a single OAuth client to the third-party API server" ([Security Best Practices, Confused Deputy](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#confused-deputy-problem)). Rules that then apply to the broker:
  - It is a resource server towards the session. It must accept only tokens issued for itself, and must not forward them upstream (the passthrough rule above).
  - It is an OAuth client towards each upstream server, with a separate token per upstream.
  - If it uses a static client id upstream **and** lets MCP clients register dynamically, it must get the user's consent per registered client before forwarding to the upstream authorization server. The spec states this only for that combination. It has no text about a proxy whose clients hold pre-issued bearer tokens.
  - A proxy that aggregates several servers "SHOULD implement a disambiguation strategy such as prefixing tool names with a server identifier" ([Tools, Tool Names](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool-names)).
  - `tools/list` "MAY vary by the authorization presented on the request", so a proxy may answer each session token with a different tool set ([Tools, Capabilities](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#capabilities)).
  - A proxy that can start stdio servers on request is a named risk: a stolen proxy token becomes command execution. The spec asks for sandboxing and logging there ([Security Best Practices, stdio Transport Security in Proxy Scenarios](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#stdio-transport-security-in-proxy-scenarios)).
- **The spec also describes a server that signs in to third parties itself.** With URL mode elicitation, an MCP server sends the user to a URL, runs the third-party OAuth flow itself, and stores the tokens. "The third-party credentials MUST NOT transit through the MCP client" ([Elicitation, URL Mode Elicitation for OAuth Flows](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation#url-mode-elicitation-for-oauth-flows)).
- **(ii) A broker that hands an access token to a runner: the spec has no text for or against.** What it does say:
  - The token is still sent only to the server whose authorization server issued it, so the client-side rule holds.
  - "Token passthrough" is defined as an MCP *server* accepting and forwarding a token not issued for it. A client component giving its own token to another component of the same client is not covered by that definition.
  - Clients "MUST implement secure token storage and follow OAuth best practices" (OAuth 2.1 section 7.1), and refresh tokens must stay confidential "in transit and storage".
  - How long an access token lives is the upstream authorization server's choice ("SHOULD issue short-lived access tokens"). The client cannot shorten it.
- **Redirect URIs.** "All redirect URIs MUST be either `localhost` or use HTTPS" ([Security Considerations, Communication Security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations#communication-security)). The authorization server must match the redirect URI exactly against the registered one. What this means for a controller whose user sits at a browser on another machine:
  - A `localhost` redirect arrives on the browser's machine, not on the controller.
  - An HTTPS redirect needs the controller to be reachable over HTTPS from that browser.
  - With CIMD, the `client_id` URL must also be an HTTPS URL that the authorization server can fetch.
  - With Dynamic Client Registration, the client must send `application_type`: `"native"` for apps that use `localhost`, `"web"` for a web application "served from a non-local host" ([Client Registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration#application-type-and-redirect-uri-constraints)).
  - Authorization servers should warn on `localhost`-only redirect URIs, because a CIMD cannot prove which local process is listening ([Security Considerations, Localhost Redirect URI Risks](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations#localhost-redirect-uri-risks)).
- **What the harness CLIs do when the browser is on another machine:** all four print the authorization URL and let the user paste back the redirected `http://localhost...` or `http://127.0.0.1...` URL:
  - `claude mcp login <name> --no-browser` ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp#authenticate-from-the-command-line)).
  - `codex mcp login <name> --no-browser` ([Codex MCP docs](https://developers.openai.com/codex/mcp)).
  - pi's sign-in screen ([pi `docs/mcp.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md#authenticate-with-oauth)).
  - opencode's sign-in prompt ([opencode MCP docs](https://opencode.ai/docs/mcp-servers)).
- **Codex can also listen on a non-loopback callback.** `mcp_oauth_callback_url` takes "a devbox ingress URL", and "non-local callback URLs bind to `0.0.0.0`" ([Codex MCP docs](https://developers.openai.com/codex/mcp), [config reference](https://developers.openai.com/codex/config-reference)).

### A5. Keeping the tool list cheap

- **Pagination.** List calls use an opaque cursor: `nextCursor` in the result, `cursor` in the next request. The server chooses the page size ([Pagination](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination)).
- **`listChanged`.** A server that declares it sends `notifications/tools/list_changed`. In `2026-07-28` the client must have opened `subscriptions/listen` with `toolsListChanged: true` to get it ([Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#list-changed-notification)).
- **Cache hints.** `ttlMs` says how long a list may be treated as fresh. `cacheScope` says whether a shared intermediary may cache it. A TTL is not a polling interval ([Caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching)).
- **Stable order.** Servers should return tools in the same order while the set is unchanged, which helps prompt caching ([Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#capabilities)).
- **No deferred loading or tool search in the protocol.** The `2026-07-28` Tools, Overview, Transports and Schema pages contain neither. Deferred loading is done by each client (B1, B2, B3). Claude Code reads one non-standard key for it, `_meta["anthropic/alwaysLoad"]` on a tool ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp#mark-a-tool-to-load-upfront-or-stay-deferred)).

## B. Harness support

### B1. Claude Agent SDK (TypeScript)

Type facts are from `sdk.d.ts` of `@anthropic-ai/claude-agent-sdk` 0.3.263. Behaviour facts are from the linked docs.

- **`mcpServers` option.** `mcpServers?: Record<string, McpServerConfig>`, keyed by server name. The variants:

  | Variant | Fields |
  |---|---|
  | stdio (`McpStdioServerConfig`) | `type?: 'stdio'`, `command`, `args?`, `env?`, `timeout?`, `alwaysLoad?` |
  | SSE (`McpSSEServerConfig`) | `type: 'sse'`, `url`, `headers?`, `tools?`, `timeout?`, `alwaysLoad?` |
  | HTTP (`McpHttpServerConfig`) | `type: 'http'`, `url`, `headers?`, `tools?`, `timeout?`, `alwaysLoad?` |
  | in-process (`McpSdkServerConfigWithInstance`) | `type: 'sdk'`, `name`, `instance`, `timeout?`; built with `createSdkMcpServer({ name, version?, instructions?, tools?, alwaysLoad?, timeout? })` |

  `tools` is `McpServerToolPolicy[]`: `{ name, permission_policy?: 'always_allow' | 'always_ask' | 'always_deny' }`.
- **`strictMcpConfig: true`** uses only the servers passed in `mcpServers` (and in explicitly passed agent definitions). It ignores `.mcp.json`, user settings, plugins and agent frontmatter. It maps to the CLI flag `--strict-mcp-config`. Hercule already sets it, together with `settingSources: []` (`apps/runner/src/harnesses/claude-code.ts`).
- **An in-process server runs in the SDK host process**, which for Hercule is the runner. The CLI reaches it through `mcp_message` control requests. So its tools run on the runner, with no network hop to the model process.
- **Tool names** are `mcp__<server>__<tool>`. Characters such as `.` and spaces in the server name become `_` ([Agent SDK MCP docs](https://code.claude.com/docs/en/agent-sdk/mcp#tool-naming-convention)).
- **Permissions** ([Agent SDK MCP docs](https://code.claude.com/docs/en/agent-sdk/mcp#allow-mcp-tools), [Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)):
  - "MCP tools require explicit permission before Claude can use them."
  - `allowedTools` auto-approves. A glob is accepted only after a literal `mcp__<server>__` prefix: `mcp__github__*` works, `mcp__*` and `*` are ignored.
  - `disallowedTools` accepts `mcp__*`, `mcp__<server>` and `mcp__<server>__*`, and removes those tools from the model's context.
  - A call that no rule decides goes to `canUseTool`.
  - `permissionMode: "acceptEdits"` does not approve MCP tools. `"bypassPermissions"` does. `"dontAsk"` denies what is not pre-approved.
  - A tool whose server sets `_meta["anthropic/requiresUserInteraction"]` goes to `canUseTool` even when an allow rule matches.
  - `setMcpPermissionModeOverride(serverName, 'default' | 'auto' | null)` tightens one server mid-session.
- **Changing servers mid-session.** `setMcpServers(servers)` replaces the set of dynamically added servers, disconnects removed ones, connects new ones, and returns `{ added, removed, errors }`. `reconnectMcpServer(name)` and `toggleMcpServer(name, enabled)` also exist. All three are control requests, which the SDK supports only "when streaming input/output is used".
- **Status.**
  - The `system` `init` message has `mcp_servers: { name, status }[]`. A server may still show `pending` there.
  - `mcpServerStatus()` returns, per server, `status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'`, `serverInfo`, `error`, `scope`, and `tools` with `annotations: { readOnly?, destructive?, openWorld? }`.
- **Startup wait.** A stdio or HTTP server from `mcpServers` with no cached tool list holds the first turn until it connects, up to `MCP_TIMEOUT` (30 seconds). `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` changes this wait, but needs Claude Code 2.1.274, newer than the pinned 2.1.263 ([Agent SDK MCP docs, Connection timing](https://code.claude.com/docs/en/agent-sdk/mcp#connection-timing)).
- **The SDK does not run OAuth.** "The SDK doesn't open a browser or run an interactive OAuth flow." A server that answers with a challenge is reported as `needs-auth`, and the run goes on without its tools. The documented way: "complete the OAuth flow in your own application and pass the resulting access token in the server's `headers`" ([Agent SDK MCP docs, OAuth2 authentication](https://code.claude.com/docs/en/agent-sdk/mcp#oauth2-authentication)).
- **A sign-in made by interactive Claude Code on the same machine is reused.** The docs' other way to fix `needs-auth` is to "sign in from an interactive Claude Code session on the same machine before the run" (`/mcp` or `claude mcp login <name>`). Claude Code keeps these sign-ins "in a credential store": the system keychain on macOS, or a credentials file ([errors reference](https://code.claude.com/docs/en/errors#couldnt-read-the-stored-credentials-for-mcp-server), [Claude Code MCP docs](https://code.claude.com/docs/en/mcp#use-pre-configured-oauth-credentials)). Claude Code's own login is stored in the Keychain or in `.credentials.json` under `CLAUDE_CONFIG_DIR`, and the Keychain entry is keyed to that directory ([authentication](https://code.claude.com/docs/en/authentication)). That MCP sign-ins follow `CLAUDE_CONFIG_DIR` the same way is likely but unverified. Hercule sets `CLAUDE_CONFIG_DIR` per account, so such a sign-in would be per account and per runner.
- **A static `Authorization` header turns OAuth off for that server.** If the server rejects the header, Claude Code "reports the connection as failed instead of falling back to OAuth" ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp#authenticate-with-remote-mcp-servers)).
- **Dynamic headers: `headersHelper`.** A server entry may name a command that prints a JSON object of headers.
  - Claude Code runs it on each connection, at session start and on reconnect, and does not cache the result.
  - After a tool call returns 401 or 403, it re-runs the helper, reconnects and retries the call once.
  - It gives up on the helper after 10 seconds.
  - It sets `CLAUDE_CODE_MCP_SERVER_NAME` and `CLAUDE_CODE_MCP_SERVER_URL` for the helper.
  ([Claude Code MCP docs, dynamic headers](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication)).
- **Doc and types disagree on `headersHelper` in the SDK.** The docs list "a server from the SDK's `mcpServers` option or `setMcpServers()` method" among the places a helper can come from. The SDK type `McpHttpServerConfig` has no `headersHelper` field. Whether the bundled CLI 2.1.263 accepts it from the SDK is unverified.
- **Elicitation.** The `onElicitation` option receives form and URL elicitations. Without it, and without a hook that answers, they are declined.
- **Protocol revision.** Claude Code has two MCP client runtimes. v1 is built on TypeScript SDK 1.x (latest revision `2025-11-25`). v2 is built on SDK 2.0, asks HTTP and stdio servers whether they support `2026-07-28`, and uses it with those that do. `MCP_SDK_GENERATION=v1|v2` picks one. Which one the pinned 2.1.263 uses depends on the session: v2 from 2.1.232 in sessions that fetch feature flags, and v2 by default in other sessions only from 2.1.274 ([Claude Code MCP docs, MCP client runtimes](https://code.claude.com/docs/en/mcp#mcp-client-runtimes)).
- **`list_changed` in SDK mode** refreshes the tool list only, not prompts or resources ([Claude Code MCP docs, Dynamic tool updates](https://code.claude.com/docs/en/mcp#dynamic-tool-updates)).
- **Tool search (deferred tool loading)** ([Claude Code MCP docs, tool search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search), [Agent SDK tool search](https://code.claude.com/docs/en/agent-sdk/tool-search)):
  - It is on by default, in the SDK too, and it covers remote servers and in-process SDK servers.
  - With it on, "only tool names and server instructions load at session start". Claude searches when it needs a tool, and up to five matching tools are loaded per search. They stay loaded until compaction removes the messages where they were found.
  - The docs' cost figure: "50 tools can use 10-20K tokens" when loaded upfront.
  - `ENABLE_TOOL_SEARCH` controls it: unset or `true` defers all MCP tools; `auto` or `auto:N` defers only once deferrable definitions reach 10% (or N%) of the context window; `false` loads everything upfront. In the SDK it is set through the `env` option.
  - It is off on models older than Opus 4 and Sonnet 4, when `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` is set, and when the `ToolSearch` tool is denied.
  - `alwaysLoad: true` on a server keeps its tools out of deferral, and makes startup wait up to 5 seconds for that server.
  - Server instructions and upfront tool descriptions are cut at 4,096 characters, and descriptions of deferred tools at 16,384. Before 2.1.295 one limit of 2,048 characters applied to every tool description, so that is what the pinned 2.1.263 does.

### B2. Codex

Source paths are in `openai/codex` at tag `rust-v0.154.0`.

- **Servers are `[mcp_servers.<name>]` tables in `config.toml`** under `CODEX_HOME` (and in a trusted project's `.codex/config.toml`). Fields (`codex-rs/config/src/mcp_types.rs`, [Codex MCP docs](https://developers.openai.com/codex/mcp)):
  - stdio: `command`, `args`, `env`, `env_vars`, `cwd`.
  - Streamable HTTP: `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `http_headers_helper`, `auth` (`oauth` or `chatgpt`), `oauth` (`client_id`, `callback_url`, `callback_port`), `oauth_resource`, `scopes`.
  - Both: `enabled`, `required`, `startup_timeout_sec` (default 10), `tool_timeout_sec` (default 60), `enabled_tools`, `disabled_tools`, `default_tools_approval_mode`, `tools.<tool>.approval_mode`, `tools.<tool>.output_token_limit`, `supports_parallel_tool_calls`.
- **There is no SSE transport and no inline bearer token.** A `bearer_token` field is rejected (same source file).
- **`bearer_token_env_var` is read from the Codex process's own environment** with `env::var` when the server connects. An unset or empty variable is an error (`codex-rs/codex-mcp/src/rmcp_client.rs`, `resolve_bearer_token`).
- **`http_headers_helper`** is a local shell command that prints a JSON object of headers.
  - Codex caches its output for the connection.
  - After a same-origin POST returns 401 or 403, Codex runs it once more and retries only if the values changed.
  - A 403 that reports `insufficient_scope` does not trigger it.
  - It times out after 10 seconds.
  - A configured bearer token or stored OAuth credential wins over an `Authorization` header from the helper.
  (`codex-rs/rmcp-client/src/http_headers.rs`, [Codex MCP docs](https://developers.openai.com/codex/mcp)).
- **Per-process and per-thread config:**
  - `codex app-server -c key=value` overrides any config key with a dotted path (`codex app-server --help`). Hercule already starts the app-server this way.
  - `CODEX_HOME` moves the whole config and credential directory. Hercule already sets it per account.
  - `thread/start`, `thread/resume` and `thread/fork` take `config?: { [key]: JsonValue }`. Keys are dotted paths, and `mcp_servers.<name>.<field>` works: a test starts a thread with `mcp_servers.thread.command` and finds that server in the thread's config (`codex-rs/app-server/src/mcp_refresh.rs`, test `refresh_config_preserves_thread_mcp_overrides`).
  - `config/mcpServer/reload` re-reads the config from disk and refreshes every loaded thread. Thread-level `mcp_servers` overrides survive the reload (same test).
- **Codex's own OAuth login:**
  - `codex mcp login <name>`, with `--scopes`, `--no-browser` and `--oauth-client-registration auto|cimd|dcr`.
  - The app-server method `mcpServer/oauth/login` takes `{ name, threadId?, clientRegistration?, scopes?, timeoutSecs? }` and returns `{ authorizationUrl }`. The notification `mcpServer/oauthLogin/completed` follows.
  - Credentials go to the OS keyring, and fall back to `CODEX_HOME/.credentials.json`. `mcp_oauth_credentials_store = "auto" | "file" | "keyring"` chooses (`codex-rs/rmcp-client/src/oauth.rs`, [config reference](https://developers.openai.com/codex/config-reference)).
  - Codex refreshes stored tokens itself (`codex-rs/rmcp-client/src/oauth/refresh_transaction.rs`). When a stored login has expired for good, `mcpServer/startupStatus/updated` carries `failureReason: "reauthenticationRequired"` ([Codex app-server docs](https://developers.openai.com/codex/app-server)).
- **Status.** `mcpServerStatus/list` returns per server `runtimeStatus` (`notStarted`, `starting`, `connected`, `authenticationRequired`, `failed`, `cancelled`, `disabled`), `tools`, `toolsError`, `resources`, and `authStatus` (`unknown`, `unsupported`, `notLoggedIn`, `bearerToken`, `oAuth`). Also: `mcpServer/tool/call` and `mcpServer/resource/read` (generated types `v2/McpServerStatus.ts`, `v2/McpAuthStatus.ts`).
- **Tool approval** (`codex-rs/core/src/mcp_tool_call.rs`, `codex-rs/codex-mcp/src/mcp/mod.rs`):
  - The mode is `tools.<tool>.approval_mode`, else `default_tools_approval_mode`, else `auto`. Values: `auto`, `prompt`, `writes`, `approve`.
  - `approve` never asks. `prompt` always asks. `writes` asks unless the tool has `readOnlyHint: true`.
  - `auto` asks when `destructiveHint` is true, or when the tool is not read-only and either `destructiveHint` or `openWorldHint` is true or missing. So a tool with no annotations needs approval.
  - With approval policy `never`: a call is approved without asking when the sandbox has full disk write access, and denied otherwise ("MCP tool call requires approval, but approval policy is never").
  - The question reaches an app-server client as `item/tool/requestUserInput`, or as `mcpServer/elicitation/request` when the feature `ToolCallMcpElicitation` is on. Hercule already answers both (`apps/runner/src/harnesses/codex/approvals.ts`).
  - Under `auto`, an approval can be remembered for the session, and for a custom server it can be saved to config.
- **Elicitation** from a server arrives as `mcpServer/elicitation/request` with `mode: "form"` or `mode: "url"`.
- **Deferred tools.** When the model supports the search tool, every MCP tool is registered as deferred and reached through tool search; otherwise all are sent directly (`codex-rs/core/src/mcp_tool_exposure.rs`, `codex-rs/core/src/tools/spec_plan.rs`, `search_tool_enabled`). The config reference lists `tool_search = false` as a retired switch that is now rejected, so this cannot be turned off by config.
- **Dynamic tools.** `thread/start` takes `dynamicTools`: tool specs (`name`, `description`, `inputSchema`, `deferLoading?`, or a namespace of tools) that the *client* executes. Codex sends the call back as the server request `item/tool/call`. The field is marked experimental and needs `capabilities.experimentalApi = true` at `initialize`; Hercule's probe sends `experimentalApi: false`. They are saved in the thread's rollout and restored on `thread/resume` (`codex-rs/app-server-protocol/src/protocol/v2/thread.rs`, [Codex app-server docs](https://developers.openai.com/codex/app-server)).
- **Protocol revision.** The default mode is "Legacy": an `initialize` handshake at `2025-06-18`. The feature flag `Mcp20260728` switches to probing for `2026-07-28` with a fallback to `2025-06-18` (`codex-rs/rmcp-client/src/protocol_mode.rs`, `codex-rs/core/src/config/mod.rs`).
- **Docs newer than the pinned tag.** The developers.openai.com pages describe `startup_readiness`, a `loginId` on the OAuth notification, and `serverCapabilities` in the status list. None of these was found at `rust-v0.154.0`.

### B3. pi

- **pi 0.85.1, the version Hercule pins, has no MCP.** Its README: "No MCP. Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support" ([README at v0.85.1](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/README.md)).
- **pi has built-in MCP since 0.99.0 (2026-09-29).** It is a built-in extension, `builtin:mcp` ([CHANGELOG](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)). So the assumption "pi has no built-in MCP" is true only for the pinned version.
- **What built-in MCP offers at 1.5.2** ([`docs/mcp.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)):
  - Config in `~/.pi/agent/mcp.json` and, in trusted projects, `.pi/mcp.json`, in the `mcpServers` shape of Claude Code.
  - stdio (`command`, `args`, `env`, `cwd`) and Streamable HTTP (`url`, `headers`, `oauth`). SSE is rejected.
  - `env` and `headers` values may be `${VAR}` or `!command`.
  - OAuth with CIMD, Dynamic Client Registration or a pre-registered client. Tokens are stored in `~/.pi/agent/mcp-auth.json` and refreshed by pi.
  - Tools are named `mcp__<server>__<tool>`.
  - Per server `exposure`: `codemode` (default: tools are callable only from model-written scripts), `deferred` (loaded by `tool_search`), `direct`, or `hidden`.
  - Every MCP call passes through pi's tool pipeline, so an extension's `tool_call` handler gates it.
  - `--no-mcp` turns it off for one run.
- **Programmatic, per session:** `pi.registerMcpServer(name, config)` in an extension adds a server for the current session only, with the same config shape. `pi.unregisterMcpServer(name)` removes it. Registering the same name again replaces it. A server of the same name in `mcp.json` wins ([`docs/extensions.md`, MCP Servers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#mcp-servers)).
- **SDK sessions do not load built-in extensions.** They must add `createMcpExtension()`, and `createCodemodeExtension()` or `createToolSearchExtension()` for non-direct tools ([`docs/sdk.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)). `--no-extensions` also disables them unless `-e builtin:mcp` is given. Whether RPC mode loads them like the CLI does: unverified.
- **`pi.registerTool`** is the extension call that adds a tool, on 0.85.1 too. Hercule's own pi extension already uses it (`apps/runner/src/harnesses/pi/extension.ts`).
- **A third-party bridge exists:** `pi-mcp-adapter` on npm, version 7.0.1, last published 2026-11-04, from `github.com/nicobailon/pi-mcp-adapter`. Its peer range includes `@earendil-works/pi-ai` `^0.85.0`. pi's docs name it as an extension that replaces the built-in support. Its behaviour was not read.
- **Protocol revision.** pi's client sends `initialize` with `2025-11-25` and accepts back to `2024-11-05`. It does not speak `2026-07-28` (`packages/mcp/src/protocol/types.ts` at `4afe78de`).

### B4. opencode

- **The live docs and the latest release disagree on the config shape.**
  - opencode.ai/docs (read 2026-11-17) describes "V2": servers under `mcp.servers.<name>`, `disabled`, snake_case OAuth fields, a `protocol` field, tools behind "Code Mode" by default ([opencode MCP docs](https://opencode.ai/docs/mcp-servers)).
  - The docs in the repository at the latest release tag describe servers directly under `mcp.<name>`, `enabled`, and camelCase OAuth fields ([`mcp-servers.mdx` at v1.19.6](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/web/src/content/docs/mcp-servers.mdx)).
  - Which shape the installed 1.18.19 reads was not tested.
- **Both describe the same two kinds:**
  - `type: "local"`: `command` (an array), `environment`, `cwd`.
  - `type: "remote"`: `url`, `headers`, and `oauth` (an object, or `false`).
  - Values may use `{env:NAME}`.
- **OAuth is on by default for remote servers.** opencode discovers the authorization server, signs in with PKCE and refreshes tokens. At v1.19.6 tokens are in `~/.local/share/opencode/mcp-auth.json`. `oauth: false` plus `headers: { "Authorization": "Bearer ..." }` is the documented way to use a fixed token.
- **Programmatic injection** (docs at v1.19.6):
  - The `OPENCODE_CONFIG_CONTENT` environment variable holds inline JSON config that overrides project and global config ([`config.mdx`](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/web/src/content/docs/config.mdx)).
  - `OPENCODE_CONFIG` names a config file.
  - The server API has `POST /mcp` with `{ name, config }`, "Add MCP server dynamically", and `GET /mcp` for status ([`server.mdx`](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/web/src/content/docs/server.mdx)).
- **Tool names** are `<server>_<tool>`.
- **Protocol revision** (live docs): `legacy` by default, which sends `initialize` and speaks up to `2025-11-25`. `protocol: "auto"` probes for `2026-07-28`.

### B5. A static `Authorization: Bearer` header per session, and refreshing it

| Harness | Static bearer per session | Refresh without restarting the session |
|---|---|---|
| Claude Agent SDK | Yes: `headers` on an `http` or `sse` entry in `mcpServers`. | Yes: `setMcpServers()` with new headers replaces the server. Also `headersHelper`, re-run on reconnect and after a 401 or 403 (documented; missing from the SDK type). A static header that the server rejects marks the server `failed`. |
| Codex 0.154 | Yes: `bearer_token_env_var` (from the app-server's environment), or `http_headers`, set with `-c` or the `config` of `thread/start`. | Partly. `http_headers_helper` is re-run after a 401 or 403. A rewritten `config.toml` plus `config/mcpServer/reload` refreshes loaded threads. An environment variable cannot change while the process lives. A thread-level override stays as given at `thread/start`; whether `thread/resume` with a new `config` replaces it on a loaded thread is unverified. |
| pi 0.85.1 (pinned) | No MCP. | - |
| pi 1.5.2 | Yes: `headers` in `mcp.json` or in `pi.registerMcpServer()`. | Yes: `registerMcpServer()` again replaces the registration. Header values (`${VAR}`, `!command`) are resolved each time the transport is created, so a reconnect picks up a new value. Whether a 401 causes a reconnect is unverified. |
| opencode | Yes: `headers` with `oauth: false`. | Unverified. `POST /mcp` adds a server at runtime; whether it replaces one of the same name was not checked. |

## C. What this means for a central broker design

Facts only. Each option lists where it works and its known sharp edges.

### Option 1: the controller is an MCP gateway

One Streamable HTTP endpoint per session or per server on the controller. The session presents a session token. The controller holds the upstream OAuth tokens and calls the upstream servers.

- **Works on:** Claude Agent SDK (`type: "http"` plus `headers`), Codex (`url` plus `bearer_token_env_var` or `http_headers`), pi 0.99 and later (`url` plus `headers`, by `registerMcpServer`), opencode (`remote` plus `headers`). All four also take a stdio command, so a small stdio program on the runner that relays to the controller works too.
- **Does not work on pi 0.85.1 as is.** There the only route is tools that Hercule's pi extension registers itself with `pi.registerTool`, or the third-party `pi-mcp-adapter`.
- **Spec fit:** this is the "MCP proxy server" role. The gateway must issue and validate its own token for the session and must never forward it upstream (A3, A4).
- **Sharp edges:**
  - **Two protocol eras.** The harness clients are mostly legacy: Codex 0.154 defaults to `2025-06-18` with `initialize`, pi 1.5.2 speaks `2025-11-25`, Claude Code's v1 runtime speaks up to `2025-11-25`, opencode defaults to legacy. A gateway that serves only `2026-07-28` fails all of them. Upstream servers may be of either era. The TypeScript SDK's `createMcpHandler` serves both from one endpoint, and by default serves a legacy client statelessly, with no sessions ([typescript-sdk `docs/serving/legacy-clients.md`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/legacy-clients.md)).
  - **Server-to-client traffic must be relayed.** In the legacy era an upstream server sends elicitation, sampling and roots requests to its client, which here is the gateway. In `2026-07-28` these are `input_required` results. Either way the gateway has to pass them on to the harness or answer them.
  - **Sign-in and step-up happen at the controller.** A 401, or a 403 `insufficient_scope`, from upstream reaches the controller, not the harness. The harness sees only a failed tool call unless the gateway turns it into something the harness can show.
  - **Tool names.** One aggregated endpoint needs a prefix to keep tool names unique (A4). One endpoint per upstream server keeps the harness's own `mcp__<server>__<tool>` naming.
  - **Tool filtering is allowed.** `tools/list` may vary by the token presented.
  - **stdio-only upstream servers** have to run somewhere. Started by the controller, their file and process access is the controller's, not the runner's workspace. The spec names a proxy that starts stdio servers as a command-execution risk (A4).
  - **Every tool call crosses the controller.** Today a runner dials the controller over one WebSocket; an HTTP endpoint for sessions is a second path that the runner machine must be able to reach.
  - **Tool search keeps working.** Claude Code and Codex defer the gateway's tools like any other MCP server's (B1, B2).
  - **Codex approvals depend on annotations.** A tool that reaches Codex without `readOnlyHint` asks for approval under `auto` (B2), so the gateway must pass annotations through unchanged for Codex to behave as it would against the upstream server.

### Option 2: the controller mints and refreshes upstream tokens and ships them in session config

The controller is the OAuth client. The runner gets an access token and puts it in the harness's MCP config. The harness talks to the upstream server directly.

- **Works on:** Claude Agent SDK (`headers`), Codex (`bearer_token_env_var`, `http_headers`, `http_headers_helper`), pi 0.99 and later (`headers`), opencode (`headers` with `oauth: false`). Not on pi 0.85.1.
- **Spec fit:** no text for or against (A4). The token still goes only to the server it was issued for. The refresh token can stay on the controller.
- **Sharp edges:**
  - **Token lifetime is not the controller's choice.** The upstream authorization server sets it. The token works from the runner for its whole lifetime, with every granted scope.
  - **Refresh has to reach a running session** (B5):
    - Claude: `setMcpServers()`, or a `headersHelper` that asks the runner for a fresh token.
    - Codex: `http_headers_helper`, or a config rewrite plus `config/mcpServer/reload`. A `bearer_token_env_var` cannot be refreshed.
    - pi: `registerMcpServer()` again.
  - **Refresh tokens rotate for public clients** (A3). Refresh must run once at a time per sign-in on the controller, and the new pair must be stored before any session uses it.
  - **Where the token rests on the runner.** For Codex it is in the app-server's environment, in `config.toml` under `CODEX_HOME`, or in `-c` arguments. For Claude it is in the options passed to the CLI child process. How the SDK passes `headers` to the child (arguments or stdin) is unverified.
  - **A static header disables the harness's own recovery.** Claude Code marks the server `failed` when the header is rejected. Codex does not re-run the helper on `insufficient_scope`. So step-up consent cannot start from the session.
  - **stdio upstream servers are not covered.** They have no bearer token.
  - **Runners need network access to every upstream server**, and upstream servers see the runners' addresses.
  - **Elicitation goes straight to the harness.** Claude: `onElicitation`. Codex: `mcpServer/elicitation/request`. The controller is not in that path.

### Option 3: stdio servers started on the runner, with secrets injected as environment

- **Works on:** Claude Agent SDK (`command`, `args`, `env`), Codex (`command`, `args`, `env`, `env_vars`), pi 0.99 and later (`command`, `args`, `env`), opencode (`command`, `environment`). Not on pi 0.85.1.
- **Spec fit:** this is what the spec says stdio servers do: they "retrieve credentials from the environment" and do not use the OAuth flow (A3).
- **Sharp edges:**
  - **"Install once" does not cover the program.** The command and its runtime (`npx`, `uvx`, a binary) must exist on each runner.
  - **The secret is long-lived and sits in a process on the runner** for as long as the server runs. Changing it means restarting the server.
  - **OAuth-only remote servers do not fit** unless a stdio program on the runner does the HTTP and token work, which is option 1 or 2 by another route.
  - **One server process per session** is how the harnesses run stdio servers today. The `2026-07-28` text says a client should not tie a stdio process to one conversation (A2), but nothing enforces that.
  - **Startup time counts against a limit.** Claude Code holds the first turn up to `MCP_TIMEOUT` (30 seconds). Codex gives a server `startup_timeout_sec` (10 seconds by default).
  - **A stdio server acts with the runner user's rights**, in the runner's file system. For tools that should work on the workspace this is the point; for others it is exposure.

## Unverified

- Which clients implement the Enterprise-Managed Authorization and Client Credentials extensions. The support matrix's cells did not survive the Markdown export.
- Whether Claude Code 2.1.263 accepts `headersHelper` on a server passed through the SDK's `mcpServers`. The docs imply it; the SDK type omits the field.
- Whether Claude Code stores MCP sign-ins under `CLAUDE_CONFIG_DIR`, as it does its own login.
- How the Claude Agent SDK passes `mcpServers` headers to the CLI child process.
- Whether Codex replaces a loaded thread's `mcp_servers` overrides on `thread/resume` with a new `config`.
- What Codex's enterprise-managed authorization code does. Files named `ema_*.rs` exist in `codex-rs/rmcp-client/src` at the pinned tag; they were not read.
- Whether pi's RPC mode loads the built-in MCP extension, and whether pi reconnects (and so re-resolves headers) after a 401.
- Which config shape opencode 1.18.19 reads, and whether opencode re-reads headers or replaces a server on `POST /mcp`.
- Behaviour of `pi-mcp-adapter`.
- Nothing here was tried against a running harness or a real MCP server. Every behaviour claim is from documentation or source.
