# Can a Connection's token sign in to the vendor's MCP server?

Hercule holds Connections: OAuth sign-ins made through Hercule's own public applications on Sentry, Linear and GitHub. Agent sessions should also get each vendor's MCP tools, without the user signing in a second time. This note records, per vendor, whether the Connection's access token is accepted by the vendor's MCP server, and what else works when it is not.

These facts come from vendor documentation, the source of `getsentry/sentry-mcp` and `github/github-mcp-server`, the servers' live OAuth metadata, and Hercule's own notes and code. Everything was read on 2026-11-17. No sign-in was made and no credential was sent anywhere, so nothing here is proven by a real authenticated call. Each claim says where it comes from.

## Method

- **Live metadata.** Plain `curl` requests without credentials to each server: `/.well-known/oauth-protected-resource` (also with the MCP path appended), `/.well-known/oauth-authorization-server`, and an `initialize` POST to the MCP endpoint to read the `WWW-Authenticate` header. Marked "live" below.
- **One extra probe on Sentry.** A POST to `https://mcp.sentry.dev/mcp` with the header `Authorization: Sentry-Bearer` and no token after it. It shows that the deployed server knows the scheme. No token, real or made up, was sent.
- **Source.** Shallow clones into a scratch directory outside the repository, read and not run, deleted afterwards: `getsentry/sentry-mcp` at commit `a5bd7ec` (2026-11-17) and `github/github-mcp-server` at commit `67d4dc4` (2026-11-16). Source links below point at those commits.
- **Linear's server is closed source**, so Linear's facts are from its documentation and live metadata only.
- **Hercule's side** is read from `plugins/*/src/connection-type.ts`, spec 05 section 10.1, spec 08 section 9, spec 13 section 9, and the two notes `sentry-api.md` and `linear-api.md`.
- **Not tested**: whether a real Connection token is accepted. The "yes" answers below rest on documentation and source, and the first build ticket should confirm each with one real call.

## What Hercule's Connections hold today

| Vendor | Flow | Client | Scopes | Token life | What a refresh does |
|---|---|---|---|---|---|
| Sentry | device flow | public application `12818eb0...` | `org:read project:read team:read member:read event:read event:write` | 30 days | rotates both tokens; the old access token and the old refresh token stop working at once (recorded, [`sentry-api.md`](./sentry-api.md)) |
| Linear | redirect flow with PKCE, loopback | public application `900702e5...` | `read write` | 24 hours | new token pair; the old access token keeps working, the old refresh token works 30 more minutes (recorded, [`linear-api.md`](./linear-api.md)) |
| GitHub | device flow | OAuth App `Ov23liAQ...` | `repo read:org notifications workflow` | about 8 hours | new token pair; "that refresh token and the old access token will no longer work" ([GitHub: authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)) |

From `plugins/sentry/src/connection-type.ts`, `plugins/linear/src/connection-type.ts`, `plugins/github/src/connection-type.ts`, and spec 08 sections 9.3, 9.5 and 9.6. Each type also accepts a pasted token (Sentry auth token, Linear personal API key, GitHub PAT), which never expires and is never refreshed.

The controller is the only refresher: one refresh at a time per Connection, 10 minutes before expiry, stored before anyone uses it (spec 05 section 10.1).

## Sentry

### The servers

- **Remote**: `https://mcp.sentry.dev/mcp`, also `https://mcp.sentry.dev/mcp/{organizationSlug}` and `/mcp/{organizationSlug}/{projectSlug}` to limit a connection to one organization or project ([mcp.sentry.dev](https://mcp.sentry.dev/)). It runs on Cloudflare Workers; the source is [`getsentry/sentry-mcp`](https://github.com/getsentry/sentry-mcp).
- **Local (stdio)**: `sentry mcp`, a command of the Sentry CLI. `npx @sentry/mcp-server` is the same server under its old name, called "Legacy" in the README ([README](https://github.com/getsentry/sentry-mcp/blob/a5bd7ec29faf74594ceb43e28ffec694dbdc8dfc/README.md)).

### What the remote server accepts

- **`Authorization: Bearer` is an MCP token, not a Sentry token.** The server is its own authorization server. Live: the protected-resource metadata at `/.well-known/oauth-protected-resource/mcp` names `authorization_servers: ["https://mcp.sentry.dev"]`, and the unauthenticated POST answers 401 with `WWW-Authenticate: Bearer realm="OAuth", resource_metadata=".../.well-known/oauth-protected-resource/mcp"`.
- **Two tokens exist in that mode.** The server signs the user in to Sentry through its own Sentry application, keeps that upstream Sentry token inside the grant, and gives the MCP client a different token: "Issued by our OAuth provider (`@cloudflare/workers-oauth-provider`)". The upstream token is "Never sent directly to the MCP client" ([`docs/operations/security.md`](https://github.com/getsentry/sentry-mcp/blob/a5bd7ec29faf74594ceb43e28ffec694dbdc8dfc/docs/operations/security.md)). So a Hercule Connection token sent as `Bearer` is refused.
- **Dynamic client registration and Client ID Metadata Documents are both supported.** Live: the authorization-server metadata has `registration_endpoint: https://mcp.sentry.dev/oauth/register`, `client_id_metadata_document_supported: true`, `code_challenge_methods_supported: ["S256"]`, and `token_endpoint_auth_methods_supported` including `none`.
- **A second scheme takes a plain Sentry API token: `Authorization: Sentry-Bearer <sentry_api_token>`.** The README calls it "Remote with an Explicit Sentry Token". The server "does not store, validate, exchange, or refresh the upstream token. It forwards the token through the same Sentry API calls used by OAuth-backed sessions, and the client or upstream provider remains responsible for token lifetime and refresh" ([README](https://github.com/getsentry/sentry-mcp/blob/a5bd7ec29faf74594ceb43e28ffec694dbdc8dfc/README.md)).
- **That scheme was made for this case.** Its spec gives the reason: remote clients "had to use MCP OAuth, even when an upstream provider had already obtained and refreshed a Sentry token", and the goal is "a remote equivalent of stdio `--access-token`" ([`docs/specs/sentry-bearer-cloudflare-auth.md`](https://github.com/getsentry/sentry-mcp/blob/a5bd7ec29faf74594ceb43e28ffec694dbdc8dfc/docs/specs/sentry-bearer-cloudflare-auth.md)).
- **It is deployed.** Source: the entry point matches `Sentry-Bearer` on `/mcp...` before the OAuth provider runs ([`packages/mcp-cloudflare/src/server/index.ts`](https://github.com/getsentry/sentry-mcp/blob/a5bd7ec29faf74594ceb43e28ffec694dbdc8dfc/packages/mcp-cloudflare/src/server/index.ts)). Live: the probe with an empty `Sentry-Bearer` header answered 401 with `WWW-Authenticate: Sentry-Bearer realm="Sentry MCP", error="invalid_token", error_description="Missing or invalid Sentry-Bearer token"`, which is the exact text in that source file.
- **The token is treated as opaque.** Nothing in the direct path checks which application issued it or what kind of token it is. Sentry's API decides what it may do (same spec: "rely on Sentry API responses for token validity and permissions"). So a token from Hercule's own Sentry application should work. **Not tested with a real token.**
- **The public landing page does not mention it**: it says "All connections use OAuth" ([mcp.sentry.dev](https://mcp.sentry.dev/)). The scheme is documented in the repository only.
- **Direct mode turns every skill on.** "Direct remote auth defaults to all active MCP skills. You can narrow the exposed tools with `?skills=inspect,triage` or `?disable-skills=seer`" (README). There is no consent screen to pick skills on.

### The local server

- It takes a plain Sentry token in `SENTRY_AUTH_TOKEN`; `--access-token` and `SENTRY_ACCESS_TOKEN` still work as deprecated aliases ([`docs/operations/stdio-auth.md`](https://github.com/getsentry/sentry-mcp/blob/a5bd7ec29faf74594ceb43e28ffec694dbdc8dfc/docs/operations/stdio-auth.md)).
- "An env token is never refreshed" (same file). A process started with a Connection's token keeps that one token until it is restarted.
- The README lists the scopes for such a token: `org:read project:read project:write team:read team:write event:write`.
- The search tools need a model: `search_errors`, `search_traces`, `search_issues` and the others "require an LLM provider (OpenAI, Azure OpenAI, Anthropic, or OpenRouter)", given as an API key in the server's environment (README). The remote server brings its own.

### Scopes

- The remote server's own sign-in asks Sentry for `org:read project:write team:write event:write alerts:write` ([`packages/mcp-core/src/scopes.ts`](https://github.com/getsentry/sentry-mcp/blob/a5bd7ec29faf74594ceb43e28ffec694dbdc8dfc/packages/mcp-core/src/scopes.ts)).
- Each tool declares the scopes it needs ([`packages/mcp-core/src/toolDefinitions.json`](https://github.com/getsentry/sentry-mcp/blob/a5bd7ec29faf74594ceb43e28ffec694dbdc8dfc/packages/mcp-core/src/toolDefinitions.json)). The source marks this field as legacy, so read the counts as a guide. Of 77 tools, 59 declare only scopes Hercule's Connection has. That covers reading issues, events, traces and releases, and `update_issue`, `add_issue_note` and `link_issue`, which need `event:write`.
- **18 tools need a scope the Connection lacks**, all in the `project-management` skill: `project:write` (create or update a project, a DSN, an uptime monitor, team membership of a project), `team:write` (`create_team`) and `alerts:write` (alert rules and monitors).
- So with today's scopes, connect with `?disable-skills=project-management`. To offer those tools too, the device flow would have to ask for `project:write team:write alerts:write`, and every user would reconnect.
- **Unverified**: which Sentry scope the Seer tool (`analyze_issue_with_seer`) needs. It declares none.

### Token life and rotation

- In direct mode and in the local server, the MCP side only ever sees the access token. It never gets the refresh token, so it cannot race the controller.
- **The risk is a stale access token.** Sentry kills the old access token the moment the controller refreshes (recorded). A session that holds the old token in a fixed header gets 401 from then on. This happens once per 30 days per Connection, 10 minutes before expiry. A session needs a way to pick up the new token; see "Getting a fresh token into a running session" below.
- The remote server's own OAuth mode is worse on this point: "The system only refreshes MCP tokens. It does not rotate upstream Sentry OAuth tokens anymore", and "Once the cached Sentry access token is no longer usable, the client must complete OAuth again" ([`docs/cloudflare/oauth-architecture.md`](https://github.com/getsentry/sentry-mcp/blob/a5bd7ec29faf74594ceb43e28ffec694dbdc8dfc/docs/cloudflare/oauth-architecture.md)). A Sentry token lasts 30 days, so that mode asks for a new sign-in about once a month.

### Options

- **Passthrough: yes**, as `Authorization: Sentry-Bearer <token>`, not `Bearer`. Documented in the repository and deployed. Not tested with a real token.
- **(a) A central MCP sign-in by the controller: possible, and it is a second sign-in.** The controller could register by DCR or CIMD and run the flow once. The user approves the MCP server's consent page and then Sentry's page for the MCP server's own application, and repeats it about every 30 days.
- **(b) The local server with the Connection's token: possible.** Needs the Sentry CLI on the runner, a restart to pick up a rotated token, and an LLM key for the search tools.
- **(c) Tools in Hercule's own plugin: possible.** The Sentry plugin already calls the same REST API with the Connection (`plugins/sentry/src/actions`).

## Linear

### The servers

- **Remote**: `https://mcp.linear.app/mcp`. `https://mcp.linear.app/mcp/readonly` "only ever exposes read tools". `https://mcp.linear.app/sse` is "a deprecated fallback" ([Linear: MCP server](https://linear.app/docs/mcp)).
- **Local: none.** The documentation offers only `npx -y mcp-remote https://mcp.linear.app/mcp`, a bridge to the remote server for clients that cannot speak HTTP (same page). It signs in by its own OAuth flow.
- The server is closed source.

### What the remote server accepts

- **It is its own authorization server.** Live: the protected-resource metadata names `authorization_servers: ["https://mcp.linear.app"]` and `scopes_supported: ["read","write"]`. The unauthenticated POST answers 401 with `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", scope="read write"`.
- **DCR and CIMD are both supported.** Live: `registration_endpoint: https://mcp.linear.app/register` and `client_id_metadata_document_supported: true`. The documentation: "The interactive setup flow uses OAuth 2.1 with dynamic client registration" ([Linear: MCP server](https://linear.app/docs/mcp)).
- **A client registered there is not a Linear API client.** Hercule already recorded that such clients are unknown to `api.linear.app` (`invalid_client`, [`linear-api.md`](./linear-api.md)). So the MCP sign-in and the API sign-in are two separate grants.
- **It also accepts a normal Linear credential as `Bearer`, and says so.** From the FAQ "Can I authenticate with my own API keys or OAuth access tokens?": "The MCP server supports passing OAuth token and API keys directly in the `Authorization: Bearer <yourtoken>` header instead of using the interactive authentication flow. You can use this to interact with the MCP server as an app user, provide read-only access through a restricted API key, or integrate with an existing Linear OAuth application without an extra authentication hop" ([Linear: MCP server](https://linear.app/docs/mcp)).
- "Integrate with an existing Linear OAuth application" is Hercule's case exactly. **Not tested with a real token.** Because the server is closed, how it validates such a token is unknown.
- **A pasted personal API key needs a different header here.** Linear's GraphQL API takes a key as `Authorization: <key>` with no `Bearer` ([`linear-api.md`](./linear-api.md)); the MCP server takes it as `Authorization: Bearer <key>` (the quote above).

### Scopes

- The MCP server's scopes are `read` and `write` (live metadata). Hercule's Connection asks for `read write`. Nothing is missing.
- A token with `read` alone gives read-only tools: "Clients that request `read` are granted read-only access" ([Linear: MCP server](https://linear.app/docs/mcp)).

### Token life and rotation

- The MCP server gets only the access token, so it cannot race the controller's refresh.
- A Linear access token lasts 24 hours, and the old one keeps working after a refresh until its own expiry (recorded, [`linear-api.md`](./linear-api.md)). So a session's token never dies early, but a session that outlives it needs a new one. A token handed out just before the controller's refresh has about 10 minutes left.

### Options

- **Passthrough: yes**, as `Authorization: Bearer <token>`. Documented. Not tested.
- **(a) A central MCP sign-in by the controller: possible, and it is a second sign-in** (DCR or CIMD, then Linear's approval page again).
- **(b) A local server: no.** Linear ships none.
- **(c) Tools in Hercule's own plugin: possible**, over the GraphQL API the plugin already calls.

## GitHub

### The servers

- **Remote**: `https://api.githubcopilot.com/mcp/`. A toolset is chosen by path (`/mcp/x/issues`, `/mcp/x/all`, `/mcp/readonly`) or by the headers `X-MCP-Toolsets`, `X-MCP-Tools` and `X-MCP-Readonly` ([`docs/remote-server.md`](https://github.com/github/github-mcp-server/blob/67d4dc489700ec955ad255d098396dd86c729523/docs/remote-server.md)). "The GitHub MCP server is available to all GitHub users regardless of plan type" ([GitHub: set up the GitHub MCP server](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server)).
- **Local**: the `github-mcp-server` binary or the `ghcr.io/github/github-mcp-server` image, from [`github/github-mcp-server`](https://github.com/github/github-mcp-server). `github-mcp-server stdio` reads `GITHUB_PERSONAL_ACCESS_TOKEN`. `github-mcp-server http` serves HTTP on a local port and reads the token from each request's `Authorization` header ([`docs/streamable-http.md`](https://github.com/github/github-mcp-server/blob/67d4dc489700ec955ad255d098396dd86c729523/docs/streamable-http.md)).

### What the remote server accepts

- **It has no authorization server of its own. GitHub's normal one issues its tokens.** Live: the protected-resource metadata at `/.well-known/oauth-protected-resource/mcp/` names `authorization_servers: ["https://github.com/login/oauth"]`. GitHub's own metadata at `https://github.com/.well-known/oauth-authorization-server/login/oauth` lists the usual `authorize` and `access_token` endpoints and the device endpoint `https://github.com/login/device/code`, the same ones Hercule's device flow uses.
- **No DCR and no CIMD.** Live: GitHub's metadata has no `registration_endpoint` and no `client_id_metadata_document_supported`. The repository: "Dynamic Client Registration is NOT supported by Remote GitHub MCP Server at this time" ([`docs/host-integration.md`](https://github.com/github/github-mcp-server/blob/67d4dc489700ec955ad255d098396dd86c729523/docs/host-integration.md)).
- **Any valid GitHub token is accepted as `Bearer`.** "The Remote GitHub MCP Server itself does not provide Authentication services. Your client application must obtain valid GitHub access tokens", and "you may also supply any valid access token. For example, you may supply a pre-generated Personal Access Token (PAT)" (same file).
- **A host is expected to bring its own app.** "Each MCP host application needs to configure a GitHub App or OAuth App to support remote access via OAuth" ([README](https://github.com/github/github-mcp-server/blob/67d4dc489700ec955ad255d098396dd86c729523/README.md)). Hercule's OAuth App is such an app, and its device-flow token is such a token.
- **Source confirms it.** The header parser accepts a token by its prefix: `ghp_` (classic PAT), `github_pat_` (fine-grained PAT), `gho_` (OAuth App token), `ghu_` (GitHub App user token) and `ghs_` (installation token), with or without the word `Bearer` ([`pkg/utils/token.go`](https://github.com/github/github-mcp-server/blob/67d4dc489700ec955ad255d098396dd86c729523/pkg/utils/token.go)). The MCP token is the GitHub API token; nothing is exchanged. **Not tested with a real token.**
- **Organization rules still apply**, the same ones the Connection already lives under: an organization that restricts OAuth Apps must have approved Hercule's ([`docs/policies-and-governance.md`](https://github.com/github/github-mcp-server/blob/67d4dc489700ec955ad255d098396dd86c729523/docs/policies-and-governance.md)).

### The local server

- `GITHUB_PERSONAL_ACCESS_TOKEN` holds any GitHub token, not only a PAT. Only a `ghp_` token gets its scopes read to hide tools; for other tokens the server logs "skipping scope filtering for non-PAT token" and shows every tool ([`internal/ghmcp/server.go`](https://github.com/github/github-mcp-server/blob/67d4dc489700ec955ad255d098396dd86c729523/internal/ghmcp/server.go)).
- The token is read once at start ([`cmd/github-mcp-server/main.go`](https://github.com/github/github-mcp-server/blob/67d4dc489700ec955ad255d098396dd86c729523/cmd/github-mcp-server/main.go)). A device-flow token dies after about 8 hours, so a `stdio` process must be restarted to get a new one. The `http` command has no such problem, because the token comes with each request.
- The official builds also offer their own OAuth login with a GitHub application baked into the binary ([`docs/oauth-login.md`](https://github.com/github/github-mcp-server/blob/67d4dc489700ec955ad255d098396dd86c729523/docs/oauth-login.md)). That would be a second sign-in, so it is not an option here.

### Scopes

- The remote server advertises `repo read:org read:user user:email read:packages write:packages read:project project gist notifications` (live metadata). Hercule's Connection has `repo read:org notifications workflow`.
- Each tool in the [README](https://github.com/github/github-mcp-server/blob/67d4dc489700ec955ad255d098396dd86c729523/README.md) lists the scopes it may ask for. Most need `repo` alone (which includes `security_events`), a few `read:org`, `notifications` or `workflow`. The default toolset (context, repos, issues, pull requests, users) is covered.
- **Not covered**: Projects tools (`read:project`, `project`), gist tools (`gist`), enterprise and governance tools (`read:enterprise`, `admin:org`, `admin:enterprise`) and repository deletion (`delete_repo`).
- **What a missing scope looks like.** For a `gho_` token the remote server checks scopes before each tool call and answers 403 with a scope challenge when one is missing ([`pkg/http/middleware/scope_challenge.go`](https://github.com/github/github-mcp-server/blob/67d4dc489700ec955ad255d098396dd86c729523/pkg/http/middleware/scope_challenge.go), [`docs/scope-filtering.md`](https://github.com/github/github-mcp-server/blob/67d4dc489700ec955ad255d098396dd86c729523/docs/scope-filtering.md)). A client with a fixed header cannot answer the challenge, so the call fails. Limit the toolsets with `X-MCP-Toolsets` to the ones the Connection covers.

### Token life and rotation

- GitHub rotates like Sentry: after a refresh "that refresh token and the old access token will no longer work" ([GitHub: authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)). It happens about every 8 hours.
- The MCP server gets only the access token, so it cannot race the controller.
- Hercule already solved the stale-token problem for `gh`: the runner keeps a fresh copy and `hercule github-token` prints it (spec 13 section 9.3). The MCP header can come from the same place.

### Options

- **Passthrough: yes**, as `Authorization: Bearer <token>`. Documented and in the source. Not tested.
- **(a) A central MCP sign-in: not a separate thing.** There is no DCR and no MCP-only authorization server. An "MCP sign-in" to GitHub is a normal sign-in through one's own GitHub application, which is what the Connection already is.
- **(b) The local server with the Connection's token: possible**, with `stdio` (restart on rotation) or `http` (token per request).
- **(c) Tools in Hercule's own plugin: possible.** The GitHub plugin already calls the REST API with the Connection (`plugins/github/src/actions`), and sessions already have `gh` with `GH_TOKEN`.

## Getting a fresh token into a running session

This applies to every passthrough above. The token in the header expires or is rotated away while the session runs.

- **Claude Code** runs a command for an HTTP MCP server's headers: `headersHelper`. It "runs the helper fresh on each connection, at session start and on reconnect", and "If a tool call returns `401 Unauthorized` or `403 Forbidden`, Claude Code automatically re-runs the helper ..., reconnects with the fresh headers, and retries the call once" ([Claude Code: MCP](https://code.claude.com/docs/en/mcp)).
- **Codex** has the same: `http_headers_helper`, a "Local command that prints a JSON object of header names and string values". After a 401 or 403 it "refreshes the headers once and retries only if the helper returns changed values" ([Codex: MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)). Its `bearer_token_env_var` always sends `Bearer`, so Sentry's `Sentry-Bearer` needs the helper or `http_headers`.
- So a helper that asks the runner for the Connection's current access token, as `hercule github-token` does today, keeps the header fresh without the session ever holding a refresh token. **Not built and not tested.**
- A local proxy on the runner that adds the header would do the same for a harness with no helper.

## Does the controller stay the only refresher?

Yes, in every option that works.

- In passthrough and in the local servers, the vendor's MCP server receives an access token only. None of them is given a refresh token, and none refreshes: Sentry "does not ... refresh the upstream token" in direct mode, the Sentry CLI never refreshes an env token, and GitHub's server "does not provide Authentication services" (sources above).
- Sentry and GitHub kill the old tokens at once on refresh, so a second refresher would lose the Connection (spec 05 section 10.1). Never hand a refresh token to a session, a runner or an MCP server.
- Option (a) creates a second, MCP-only grant with its own refresh token. It does not race the Connection's, but it is one more credential the controller must refresh one at a time. Notion's rule shows the same hazard there: "Reusing a refresh token that has already been rotated away can revoke the entire connection" ([Notion: build an MCP client](https://developers.notion.com/guides/mcp/build-mcp-client.md)).

## Other vendors, briefly

A check on whether the three above are typical. Hercule has no Connection for Notion or Atlassian, and its Slack and Gmail Connections are described in spec 08 sections 9.2 and 9.4. Nothing here was tested with a token.

- **Notion: no passthrough.** `https://mcp.notion.com/mcp` is its own authorization server with DCR and CIMD (live: `authorization_servers: ["https://mcp.notion.com"]`, `registration_endpoint`, `client_id_metadata_document_supported: true`). Its tokens are MCP-only: "An MCP access token works only with Notion MCP" ([Notion: build an MCP client](https://developers.notion.com/guides/mcp/build-mcp-client.md)). The documentation names no way to use a REST API token on it. Without a browser there are "MCP tokens", which only a workspace owner on a Business or Enterprise plan can create ([Notion: get started with MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp)). The local server [`makenotion/notion-mcp-server`](https://github.com/makenotion/notion-mcp-server) takes an integration token in `NOTION_TOKEN`, and its README says it is "no longer actively maintained".
- **Atlassian: passthrough unverified, probably no.** The Rovo MCP server is `https://mcp.atlassian.com/v2/mcp` ([Atlassian: configuring OAuth 2.1](https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-oauth-2-1/)). Live: its tokens come from an issuer of its own on Atlassian's auth host, `https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3`, with DCR and CIMD, and its scopes are MCP-only names such as `read:jira:agent-interface`, not the REST API's. The documentation names two ways in: that OAuth 2.1 flow, or, "if enabled by your organization admin", "a personal API token or a service account API key" sent as `Authorization: Basic <base64(email:api_token)>` or `Authorization: Bearer <api_key>` ([Atlassian: authentication and authorization](https://developer.atlassian.com/cloud/rovo-mcp/guides/authentication-and-authorization/)). Whether a token from a normal OAuth 2.0 (3LO) app is accepted is not documented.
- **Slack: passthrough by design, but with a user token.** `https://mcp.slack.com/mcp` has no DCR: "MCP clients must be backed by a registered Slack app", and "If you're already using a Slack app for your integration, you can reuse it for MCP access" ([Slack: MCP server](https://docs.slack.dev/ai/slack-mcp-server/)). Live: its metadata points at Slack's normal user-token endpoints, `https://slack.com/oauth/v2_user/authorize` and `https://slack.com/api/oauth.v2.user.access`. It needs the app's client secret, and "Only directory-published apps or internal apps may use MCP". Hercule's Slack Connection holds a bot token and an app-level token, not a user token, so today's Connection does not fit; a user token from the user's own internal app would. Unverified.
- **Google (Gmail): passthrough likely, unverified.** `https://gmailmcp.googleapis.com/mcp/v1` is in the Google Workspace Developer Preview Program ([Google: configure the Workspace MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers)). Live: its protected-resource metadata names `authorization_servers: ["https://accounts.google.com/"]` and the normal Gmail scopes, so Google's ordinary authorization server issues its tokens, as with GitHub. The guide has the user create an OAuth client in their own Cloud project, enable the "Gmail MCP API" there, and ask for `gmail.readonly` and `gmail.compose`. Hercule's Gmail Connection already uses the user's own client (spec 08 section 9.2), so the same sign-in could cover both once the scopes and the API are added.

The pattern: a vendor whose MCP server trusts the vendor's ordinary authorization server (GitHub, Google, Slack) takes the ordinary token. A vendor whose MCP server is its own authorization server (Sentry, Linear, Notion, Atlassian) does not take it as a normal MCP `Bearer` token, and passthrough then depends on a side door the vendor chose to add: Sentry's `Sentry-Bearer` and Linear's documented `Bearer` passthrough exist, Notion's does not.

## Summary

"Passthrough" means the Connection's access token goes straight to the vendor's remote MCP server. "Central MCP OAuth" is option (a), "local server" is option (b), "plugin tools" is option (c). None of the "yes" cells was tested with a real token.

| Vendor | Passthrough | Central MCP OAuth (a) | Local server with the Connection's token (b) | Plugin tools over the vendor API (c) |
|---|---|---|---|---|
| Sentry | **yes** - as `Authorization: Sentry-Bearer <token>`, documented in the repository and deployed; `Bearer` is refused | yes, but a second sign-in - DCR and CIMD exist; needs a new sign-in about every 30 days | yes - `sentry mcp` with `SENTRY_AUTH_TOKEN`; fixed token, search tools need an LLM key | yes - the plugin already calls the REST API |
| Linear | **yes** - `Authorization: Bearer <token>`, documented for "an existing Linear OAuth application" | yes, but a second sign-in - DCR and CIMD exist | no - Linear ships no local server | yes - the plugin already calls the GraphQL API |
| GitHub | **yes** - "any valid access token"; the source accepts `gho_` tokens | no - no DCR, no CIMD; GitHub's normal sign-in is the only one | yes - `github-mcp-server stdio` with `GITHUB_PERSONAL_ACCESS_TOKEN`, or `http` with a header per request | yes - the plugin already calls the REST API; sessions have `gh` |
| Notion | no - MCP tokens are MCP-only; no documented use of an API token | yes - DCR and CIMD exist | yes - unmaintained local server with an integration token | yes in principle - no plugin exists |
| Atlassian | unverified - only MCP OAuth and admin-enabled API tokens are documented | yes - DCR and CIMD exist | unverified - no official local server found | yes in principle - no plugin exists |
| Slack | not with today's bot token; yes in principle with a user token of the user's own app (unverified) | no - no DCR; the app's own OAuth is the only sign-in | unverified - not checked | yes in principle |
| Google (Gmail) | unverified, likely yes - Google's normal authorization server issues the tokens; preview program | no - no DCR; the user's own OAuth client is the only sign-in | unverified - not checked | yes in principle |
