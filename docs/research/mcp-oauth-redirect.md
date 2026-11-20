# How does the browser get back to the controller after an MCP sign-in?

Hercule will let a user add any remote MCP server by URL. When the server needs OAuth, the controller is the OAuth client: it keeps the PKCE verifier and the tokens. The user signs in in a browser on their own machine. The MCP specification allows a redirect URI on `localhost` or on HTTPS only. A controller reached at `http://studio-mac.tailnet.ts.net:4937` is neither, so the first design has the user paste the redirected `http://localhost...` URL back into Hercule (`docs/design/mcp/index.html`, section 6.2). This note records the alternatives to that paste, and what each one needs.

Everything was read on 2026-11-19. No sign-in was started, no OAuth client was registered, and no `tailscale` or `cloudflared` command was run. So nothing here is proven by a real sign-in. Each claim says where it comes from.

## Method

- **Specifications** were fetched as text and read in full where quoted: the MCP specification pages (the `.md` form of each page), RFC 8252, RFC 8628, RFC 9700, the OAuth 2.1 draft (`-14` and `-17`), and the Client ID Metadata Document draft (`-00` and `-03`).
- **The MCP revision.** `2026-07-28` is still the current revision ([Versioning](https://modelcontextprotocol.io/specification/versioning)). The draft of the next revision was read too, and compared with it line by line.
- **Proposals** were searched with `gh` in `modelcontextprotocol/modelcontextprotocol` (issues, pull requests, the `seps/` folder) and in `modelcontextprotocol/ext-auth`.
- **Live metadata.** Plain `curl` requests without credentials to each vendor's `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`. Marked "live" below.
- **Public client documents.** The Client ID Metadata Documents of Claude Code, Claude, Codex and VS Code were fetched from their public URLs.
- **Source** was read, not run: `cloudflare/workers-oauth-provider` at commit `dbd149a` (2026-11-17, version 1.2.4), four files of `microsoft/vscode` at `main` (`6e3c2d3`), and one file of `openai/codex` at `main`. The installed Claude Code binary (2.1.326) was searched for one URL.
- **Not redone:** what the four harness CLIs do when the browser is on another machine. That is in [`mcp-protocol-and-harnesses.md`](./mcp-protocol-and-harnesses.md), section A4.
- "Unverified" marks a claim that no primary source confirmed. The list is at the end.

Short words used below: **AS** is the authorization server of an MCP server. **CIMD** is a Client ID Metadata Document. **DCR** is Dynamic Client Registration.

## What Hercule has today

- **A callback route on the controller.** `GET /oauth/callback` takes the browser back from the provider "with only a `state`", with no user credential (`apps/controller/src/http/server.ts`). The redirect URI is the browser's origin plus `/oauth/callback` (`apps/controller/src/connections/oauth.ts`).
- **A loopback flow that works on one machine only.** Linear's sign-in uses the fixed redirect URIs `http://127.0.0.1:4937/oauth/callback` and `http://localhost:4937/oauth/callback`. It works only when the browser runs on the controller's machine, and is refused anywhere else (spec 08 section 9.6, spec 05 section 10.1).
- **HTTPS by Tailscale is specified, not built.** Spec 13 section 1 says the controller "shells out to `tailscale cert`", stores the certificate under `<home>/tls/`, opens an HTTPS listener on a second port (default 4938) and renews before expiry. Section 3.3 says the controller derives the redirect URI from the origin the browser uses, and that the setup step tells the user that "MagicDNS and the tailnet's HTTPS toggle must be on". No code in `apps/` or `packages/` runs `tailscale cert`: the only Tailscale code is the bind warning in `apps/controller/src/http/perimeter.ts`.
- **Tailscale Funnel is ruled out by the spec as unneeded:** "Tailscale Funnel is not needed for anything in this document: the user's browser already reaches the controller" (spec 13 section 1).
- **No relay.** "Hercule ships no OAuth client secret and hosts no OAuth relay" (spec 13 section 3.1).
- **The desktop app** opens `http:` and `https:` links in the default browser through `shell.openExternal` (spec 17). It registers no URL scheme with the operating system.

## 1. Can a client on the user's machine catch the loopback redirect?

The idea: the desktop app's main process, or the `hercule` CLI, listens on `127.0.0.1:<port>` for the length of one sign-in. The controller builds the authorization URL with `redirect_uri=http://127.0.0.1:<port>/callback`. The browser lands on the local listener. The client hands `code` and `state` to the controller, which exchanges the code with the verifier it kept.

### 1.1 What the specifications say

- **MCP allows a localhost redirect.** "All redirect URIs MUST be either `localhost` or use HTTPS" ([Security Considerations, Communication Security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations#communication-security)). The spec's own example client document lists `http://127.0.0.1:3000/callback` ([Client Registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration#example-metadata-document)).
- **OAuth 2.1 says the same.** "All OAuth protocol URLs (URLs exposed by the AS, RS, and client) MUST use the https scheme except for loopback interface redirect URIs, which MAY use the http scheme" ([OAuth 2.1 draft-17, section 1.5](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-17#section-1.5)).
- **Any port must be accepted.** "The authorization server MUST allow any port to be specified at the time of the request for loopback IP redirect URIs, to accommodate clients that obtain an available ephemeral port from the operating system at the time of the request" ([RFC 8252 section 7.3](https://www.rfc-editor.org/rfc/rfc8252#section-7.3); the same sentence is in [OAuth 2.1 draft-17, section 8.4.2](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-17#section-8.4.2)).
- **The port is the only exception to exact matching.** "Authorization servers MUST reject authorization requests that specify a redirect URI that doesn't exactly match one that was registered, with an exception for loopback interface redirect URIs, where an exact match is required except for the port URI component" ([OAuth 2.1 draft-17, section 2.3.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-17#section-2.3.1)). RFC 9700 has the same rule: "The only exception is native apps using a localhost URI: In this case, the authorization server MUST allow variable port numbers" ([RFC 9700 section 4.1.3](https://www.rfc-editor.org/rfc/rfc9700#section-4.1.3)).
- **MCP's own sentence has no exception.** "Authorization servers MUST validate exact redirect URIs against pre-registered values" ([Security Considerations, Open Redirection](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations#open-redirection)). The maintainers' reading is that the spec "defers to the underlying RFCs rather than restating them" (a maintainer's closing comment on [issue 3224](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3224), 2026-09-28).
- **Use `127.0.0.1`, not `localhost`.** "The use of localhost is NOT RECOMMENDED" ([RFC 8252 section 8.3](https://www.rfc-editor.org/rfc/rfc8252#section-8.3)). The MCP draft changed its example from `localhost` to `127.0.0.1` and `[::1]` for this reason ([pull request 3384](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3384), merged 2026-09-22). In practice both are needed: see section 1.4.
- **How to run the listener.** "Clients should open the network port only when starting the authorization request and close it once the response is returned", and "Clients should listen on the loopback network interface only" ([RFC 8252 section 8.3](https://www.rfc-editor.org/rfc/rfc8252#section-8.3)).
- **Nothing says the receiver of the redirect and the exchanger of the code must be one process or one machine.** No text for or against was found in the MCP authorization pages. What the sources do say:
  - A client is not tied to a place. "The term 'client' does not imply any particular implementation characteristics (e.g., whether the application executes on a server, a desktop, or other devices)" ([OAuth 2.1 draft-17, section 1.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-17#section-1.1)).
  - A backend that does the OAuth work for an app on the user's device is a named pattern. For a native application, "it is recommended to use the backend for frontend pattern" when the app wants client credentials; in that pattern "a backend component becomes the OAuth client" (same draft, sections 2.1 and 9.1). The draft describes it for browser apps and does not describe a loopback listener that forwards a code.
  - PKCE is what binds the two halves. It ensures "that only the original requestor can exchange an authorization code for tokens" ([Security Considerations, Authorization Code Protection](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations#authorization-code-protection)). In this design the verifier never leaves the controller, so the local listener holds nothing that can be exchanged.
- **The client must pass on more than `code` and `state`.** The MCP client must check the `iss` parameter of the authorization response "before transmitting the authorization code to any token endpoint" ([Authorization, Authorization Response Validation](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#authorization-response-validation)). So the listener has to hand the controller the whole query string: `code`, `state`, `iss`, or `error`.
- **Security concerns the sources name:**
  - **Another local app can take the code.** "Loopback IP-based redirect URIs may be susceptible to interception by other apps accessing the same loopback interface on some operating systems" ([RFC 8252 section 8.1](https://www.rfc-editor.org/rfc/rfc8252#section-8.1)). PKCE is the answer to this, and here the verifier is on another machine.
  - **Any local app can claim to be the client.** "Client ID Metadata Documents cannot prevent `localhost` URL impersonation by themselves." Authorization servers "SHOULD display additional warnings for `localhost`-only redirect URIs" and "MUST clearly display the redirect URI hostname during authorization" ([Security Considerations, Localhost Redirect URI Risks](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations#localhost-redirect-uri-risks)). So a user may see a warning on the consent page. Cloudflare's library shows this one: "This sends access to an app on your computer. Continue only if you just started signing in from it." ([`docs/consent-page.md`](https://github.com/cloudflare/workers-oauth-provider/blob/dbd149a21962f02d732dfa98ae7b2316a814d6ba/docs/consent-page.md)).
  - **The hop from the client to the controller** is not covered by any text. Today it would cross the tailnet over plain HTTP. The code is single-use and useless without the verifier.

### 1.2 The port, per registration method

- **CIMD, in the revision MCP `2026-07-28` cites (draft `-00`): exact match, no loopback exception written down.** The AS "MUST ensure that the redirect URI in a request is an exact match of a registered redirect URI" ([CIMD draft-00, section 4.5](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00#section-4.5)).
- **CIMD, in the newest draft (`-03`, November 2026): the port exception is written in.** "An exception is made for redirect URIs on the loopback network interface, which allow for randomly assigned ports" ([CIMD draft-03, section 4.2](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-03#section-4.2)). The MCP draft for the next revision already requires `-03` ([draft changelog](https://modelcontextprotocol.io/specification/draft/changelog)).
- **What the big clients publish.** Their documents list loopback URIs with no port, and rely on the AS ignoring the port:
  - Claude Code: `"redirect_uris":["http://localhost/callback","http://127.0.0.1/callback"]` (live, [claude.ai/oauth/claude-code-client-metadata](https://claude.ai/oauth/claude-code-client-metadata); the URL is in the Claude Code 2.1.326 binary).
  - Codex: `"redirect_uris":["http://127.0.0.1/callback","http://localhost/callback"]` (live, [chatgpt.com/oauth/codex/client.json](https://chatgpt.com/oauth/codex/client.json); the URL is in [`oauth_client_registration.rs`](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/oauth_client_registration.rs)).
  - VS Code lists a fixed port and a hosted page: `"redirect_uris":["http://127.0.0.1:33418/","https://vscode.dev/redirect"]` (live, [vscode.dev/oauth/client-metadata.json](https://vscode.dev/oauth/client-metadata.json)).
- **So one static public document, the same for every Hercule install, can cover the loopback route.** It lists `http://127.0.0.1/callback` and `http://localhost/callback`, and may add one fixed port for servers that match exactly, as VS Code does.
- **DCR: both ways are in use.**
  - Register once, with a loopback URI, and rely on the port rule. The client must send `application_type: "native"`: "Native applications (desktop applications, mobile apps, CLI tools, and locally-hosted web applications accessed via `localhost`) SHOULD use `application_type: "native"`" ([Client Registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration#application-type-and-redirect-uri-constraints)).
  - Register for each sign-in, with the exact URI and port. This does not depend on the port rule. Anthropic says of its own hosted client: "DCR causes Claude to register a new client on every fresh connection, which can result in very large numbers of registered clients on your authorization server" ([Claude: authentication for connectors](https://claude.com/docs/connectors/building/authentication)).
  - Registrations may expire. Cloudflare's library deletes a DCR client after 90 days without use ([`docs/authorization-server.md`](https://github.com/cloudflare/workers-oauth-provider/blob/dbd149a21962f02d732dfa98ae7b2316a814d6ba/docs/authorization-server.md)).
- **Pre-registered clients: it depends on the vendor.**
  - GitHub ignores the port: "The `redirect_uri` does not need to match the port specified in the callback URL for the app" ([GitHub: loopback redirect urls](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#loopback-redirect-urls)).
  - Linear's API application matches the port exactly, which is why Hercule's Linear flow is fixed to port 4937 (spec 08 section 9.6).
  - Clients keep a fixed-port option for this case. Claude Code: "Some MCP servers require a specific redirect URI registered in advance", so `--callback-port` fixes it ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp#use-a-fixed-oauth-callback-port)).

### 1.3 What real authorization servers do

Live metadata, 2026-11-19. "Device" is `device_authorization_endpoint`.

| Server | Authorization server | CIMD | DCR | Device | Loopback redirect with any port |
|---|---|---|---|---|---|
| Notion `mcp.notion.com` | itself | yes | yes | no | not documented; see below |
| Linear `mcp.linear.app` | itself | yes | yes | no | not documented; see below |
| Sentry `mcp.sentry.dev` | itself | yes | yes | no | yes in the library it runs; one user report of a failure |
| GitHub `api.githubcopilot.com/mcp/` | `github.com/login/oauth` | no | no | **yes** | yes, documented |
| Atlassian `mcp.atlassian.com/v2/mcp` | `auth.atlassian.com/VCeDsk8...` | yes | yes | no | yes, documented, by default |
| Figma `mcp.figma.com/mcp` | `api.figma.com` | no | endpoint listed | no | not open to new clients |
| Stripe `mcp.stripe.com` | `access.stripe.com/mcp` | no | yes | no | unverified |
| Cloudflare `mcp.cloudflare.com` | itself | yes | yes | no | yes in the library it runs |
| Cloudflare `observability.mcp.cloudflare.com` | itself | `false` | yes | no | yes in the library it runs |

- **Cloudflare's library ignores the port on loopback, for DCR and CIMD clients alike.** `isValidRedirectUri` compares scheme, host, path and query and skips the port when both URIs are loopback: "For loopback URIs (127.x.x.x, ::1, localhost), any port is allowed" ([`src/oauth-provider.ts`](https://github.com/cloudflare/workers-oauth-provider/blob/dbd149a21962f02d732dfa98ae7b2316a814d6ba/src/oauth-provider.ts)). Its docs list "Exact authorization-request redirect URI validation, with RFC 8252 loopback port handling" under CIMD ([`docs/authorization-server.md`](https://github.com/cloudflare/workers-oauth-provider/blob/dbd149a21962f02d732dfa98ae7b2316a814d6ba/docs/authorization-server.md)). The rule has been there since version 0.2.4 for IP addresses and 0.3.1 for `localhost` (`CHANGELOG.md`).
- **Who runs that library.** Sentry's server pins version 0.10.3 with a patch (`pnpm-workspace.yaml` of `getsentry/sentry-mcp`). Cloudflare's own servers depend on it (`package.json` of `cloudflare/mcp` and `cloudflare/mcp-server-cloudflare`). Notion and Linear are closed source. Both answer from Cloudflare's network, and their metadata has the fields this library writes (`protected_resources`, `authorization_grant_profiles_supported`), which fits but proves nothing.
- **Sentry, one report against.** A user reported in July 2026 that Claude Code's sign-in to `mcp.sentry.dev` with its CIMD client failed with "Invalid redirect URI". The issue was closed for inactivity without a stated cause ([anthropics/claude-code issue 81643](https://github.com/anthropics/claude-code/issues/81643)). Whether it still happens is unverified.
- **Atlassian allows loopback by default, and nothing else that is unknown.** Its list of allowed redirect targets has `127.0.0.1` and `localhost` for HTTP, and named products for HTTPS. "Port (`:*/`, `:**`) and path (`/**`) wildcards allow local clients to use any port and path on that device." An organization admin can remove these or add a domain ([Atlassian: available MCP server domains](https://support.atlassian.com/security-and-access-policies/docs/available-atlassian-rovo-mcp-server-domains/)). So an HTTPS redirect to a host Atlassian does not know, such as a tailnet name, needs an admin to add it first.
- **GitHub** has neither DCR nor CIMD. A client there is Hercule's own GitHub application, and the port rule is the quote in section 1.2.
- **Figma is closed to new clients.** "Only clients listed in the Figma MCP catalog, such as VS Code, Cursor, and Claude Code, can connect to the Figma MCP server. If you're a developer who wants to connect a new MCP client, join the waitlist" ([Figma: remote server](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)). No redirect design changes that.
- **Stripe may keep an allowlist.** Stripe's listing on AWS Marketplace carries a copy of its MCP documentation with the section "Allowlist of client redirect URIs": "Stripe maintains an allowlist of vetted MCP client redirect URIs to protect our users from malicious phishing attacks" ([AWS Marketplace listing](https://aws.amazon.com/marketplace/pp/prodview-bmcz2yd35w5xk)). The page at [docs.stripe.com/mcp](https://docs.stripe.com/mcp) no longer has that section. Whether the allowlist still applies, and whether it lets a loopback URI through, is unverified.
- **Notion's guide** names no redirect rule beyond "Always use HTTPS for redirect URIs in production" and "Never use HTTP except for localhost development" ([Notion: build an MCP client](https://developers.notion.com/guides/mcp/build-mcp-client.md)).
- **The clients' own experience says the rule is not universal.** VS Code keeps a fixed port because "some servers do not follow the spec and require an exact match" ([`src/vs/base/common/oauth.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/base/common/oauth.ts)). Anthropic tells server authors to "accept a loopback redirect on any port" and to "apply the same port-agnostic match to `localhost`" ([Claude: authentication for connectors](https://claude.com/docs/connectors/building/authentication#callback-urls)).

### 1.4 What other clients do

Paste-back by the four harness CLIs is in [`mcp-protocol-and-harnesses.md`](./mcp-protocol-and-harnesses.md), section A4. What that note does not have:

| Client | Port | When the browser is elsewhere |
|---|---|---|
| Claude Code | random by default; `--callback-port` fixes it | detects that no local browser is available, "such as during an SSH session or on Linux without a display server", prints the URL, and takes the pasted redirect URL |
| Claude on the web, Desktop and mobile | none: one hosted callback, `https://claude.ai/api/mcp/auth_callback` | does not matter, the redirect goes to Anthropic's servers |
| Claude Desktop, managed MCP servers | fixed: `http://127.0.0.1:53280/callback` | not stated |
| Codex | "an ephemeral port chosen by the OS"; `mcp_oauth_callback_port` fixes it | `--no-browser` paste-back, or `mcp_oauth_callback_url` set to an ingress URL |
| VS Code | tries 33418, then a random port | uses `https://vscode.dev/redirect`, or the device grant when the server offers one |
| Cursor | fixed: `http://localhost:8787/callback` | a hosted page, `https://www.cursor.com/agents/mcp/oauth/callback`, that "hands the sign-in back to the desktop app" |

- **Claude Code** ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp#use-a-fixed-oauth-callback-port)): "By default, Claude Code picks a random available port for the OAuth callback." It uses the `localhost` form: version 2.1.229 switched to `127.0.0.1`, "servers that exact-match the registered redirect URI rejected the sign-in", and 2.1.231 "restored the `localhost` form".
- **Claude's hosted apps** ([Claude: authentication for connectors](https://claude.com/docs/connectors/building/authentication#callback-urls)): "claude.ai on the web, Desktop, mobile, and Cowork" share one client and one redirect URI, and "Claude Code doesn't use it".
- **Claude Desktop's managed servers** ([Claude Desktop: MCP sign-in](https://claude.com/docs/third-party/claude-desktop/mcp-sign-in)): the admin registers "a public OAuth client (native or desktop application type) with redirect URI `http://127.0.0.1:53280/callback`". "Callback host" and "Callback port" change it. This is a desktop app with a loopback listener.
- **Codex** ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)): `mcp_oauth_callback_port` is an "optional global fixed port for the local HTTP callback server"; "when neither is set, Codex binds to an ephemeral port chosen by the OS". The default callback is `http://127.0.0.1/callback` ([Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)).
- **VS Code** has three flows in a fixed order ([`extHostAuthentication.ts` (node)](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/node/extHostAuthentication.ts), [`loopbackServer.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/node/loopbackServer.ts)):
  - A loopback server, only "if we are not in a remote environment". It listens on `127.0.0.1:33418`, and on "address in use" falls back to a random port.
  - A URL handler with `redirect_uri=https://vscode.dev/redirect` (section 4).
  - The device grant, added last "since it's not as streamlined", and only when the metadata has `device_authorization_endpoint`.
- **Cursor** ([Cursor MCP docs](https://cursor.com/docs/mcp)): "Cursor uses fixed OAuth redirect URLs for MCP servers", one for the web and one for the desktop app. Older versions registered a custom scheme, `cursor://anysphere.cursor-mcp/oauth/callback` (named in Cloudflare's [`CHANGELOG.md`](https://github.com/cloudflare/workers-oauth-provider/blob/dbd149a21962f02d732dfa98ae7b2316a814d6ba/CHANGELOG.md)).

### 1.5 Electron, and a custom scheme

- **A loopback listener in a desktop app is the pattern RFC 8252 describes.** "Native apps that are able to open a port on the loopback network interface without needing special permissions (typically, those on desktop operating systems) can use the loopback interface to receive the OAuth redirect" ([section 7.3](https://www.rfc-editor.org/rfc/rfc8252#section-7.3)). For Linux: "The loopback redirect is the recommended redirect choice for desktop apps on Linux". For macOS: "Loopback IP redirects are another viable option, and listening on the loopback interface is allowed by default firewall rules" ([Appendix B](https://www.rfc-editor.org/rfc/rfc8252#appendix-B.4)).
- **Google recommends it for desktop apps.** For "macOS, Linux, and Windows desktop apps": "if your platform supports it, this is the recommended mechanism for obtaining the authorization code" ([Google: OAuth 2.0 for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)).
- **AppAuth names Electron.** AppAuth for JavaScript follows RFC 8252 and "is designed for use in Web Apps, Node.js CLI applications, Chrome Apps and applications that use Electron or similar frameworks" ([AppAuth-JS README](https://github.com/openid/AppAuth-JS)).
- **Electron's own documentation has no page on this.** None was found. An Electron main process is a Node process, so the listener is Node's `http` module; nothing of Electron is involved.
- **Cost in the desktop app.** RFC 8252's rule, open the port only for the sign-in and close it after, means no process, no timer and no listener while idle. This follows from the rule, and was not measured.
- **A custom scheme (`hercule://`) is not allowed by the MCP text.** The rule is "`localhost` or ... HTTPS". RFC 8252 section 7.1 allows such schemes, but MCP servers follow the MCP rule:
  - Cloudflare's library refuses them by default since 1.2: "RFC 8252 private-use schemes are accepted only when the server enables `allowPrivateUseRedirectUris`" ([`src/oauth-client-metadata.ts`](https://github.com/cloudflare/workers-oauth-provider/blob/dbd149a21962f02d732dfa98ae7b2316a814d6ba/src/oauth-client-metadata.ts)).
  - Atlassian allows two by name, `cursor:` and `raycast:`, and no others without an admin ([Atlassian: available MCP server domains](https://support.atlassian.com/security-and-access-policies/docs/available-atlassian-rovo-mcp-server-domains/)).
  - Google dropped them: "Custom URI schemes are no longer supported due to the risk of app impersonation" ([Google: OAuth 2.0 for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)).
- **A custom scheme also costs more in Electron.** "On macOS and Linux, this feature will only work when your app is packaged", it needs the `Info.plist` and the Linux `.desktop` file changed, and Windows and Linux deliver the link through `second-instance` where macOS uses `open-url` ([Electron: deep links](https://github.com/electron/electron/blob/main/docs/tutorial/launch-app-from-url-in-another-app.md)).

## 2. Is there a device-code option?

- **Not in the MCP specification.** No revision mentions the Device Authorization Grant ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)). The `2026-07-28` authorization pages and the draft contain the word "device" nowhere. The two official authorization extensions are OAuth Client Credentials and Enterprise-Managed Authorization ([Extensions Overview](https://modelcontextprotocol.io/extensions/overview)).
- **One proposal, closed.** [SEP-2059, "OAuth Device Flow for stdio MCP Servers"](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2059), was closed on 2026-01-09. It was about stdio servers, not remote ones. A maintainer objected that the device flow "is highly phishable and likely not something we'd necessarily want to promote as the de-facto auth modality".
- **One open request, with no proposal behind it.** [ext-auth issue 18, "Support for Device Code Flow for MCP OAuth authentication"](https://github.com/modelcontextprotocol/ext-auth/issues/18), open since 2026-02-24, has no maintainer reply and no pull request. No SEP file in `seps/` and no open SEP pull request is about the device grant.
- **Of the vendors checked, only GitHub advertises a device endpoint.** Live: `device_authorization_endpoint: https://github.com/login/device/code`, with `urn:ietf:params:oauth:grant-type:device_code` in `grant_types_supported`. The metadata of Notion, Linear, Sentry, Atlassian, Figma, Stripe and both Cloudflare servers has neither.
- **GitHub is the one case Hercule already covers.** Its MCP server takes the token of Hercule's own GitHub application, which signs in by device flow today ([`mcp-vendor-auth.md`](./mcp-vendor-auth.md)).
- **A client can use it where it exists.** VS Code does, as its last choice (section 1.4), and its client document lists the device grant.
- **Answer: not available today for a server the user adds by URL.** It works only where the vendor's AS offers it, and among the servers checked that is GitHub alone.

## 3. Giving the controller a real HTTPS origin

Then the redirect returns to the controller itself, in every client, the web app included.

### 3.1 Tailscale

- **`tailscale cert`** gives a Let's Encrypt certificate for `https://<machine>.<tailnet>.ts.net` ([Tailscale: HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates)).
  - **By hand, once per tailnet,** in the admin console: "Enable MagicDNS if not already enabled", then "Under HTTPS Certificates, select Enable HTTPS", and "acknowledge that your machine names and your tailnet DNS name will be published on a public ledger".
  - **The machine name becomes public.** "Do not enable the HTTPS feature if any of your machine names contain sensitive information." The device itself stays private: "access to your devices is still restricted by Tailscale as normal".
  - **Renewal is the caller's job.** The certificates "have a 90 day expiry", and "for any certificates that you create using `tailscale cert`, you are responsible for renewing the certificate". Asking too often can hit Let's Encrypt's limits and mean "waiting 34 hours".
  - **Root:** the page says "using `tailscale cert` (with sudo as needed)". Which setups need it is unverified.
  - This is the route spec 13 already describes.
- **`tailscale serve`** puts an HTTPS proxy in front of a local port, inside the tailnet only, and Tailscale manages the certificate ([Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [`tailscale serve` command](https://tailscale.com/docs/reference/tailscale-cli/serve)).
  - It "requires you to enable HTTPS certificates in your tailnet". When that is missing, the command "prompts you as needed and sends you to a web consent page".
  - "Forwarding a port does not require root." On Linux a user other than root must have been made the operator: "The operator can manage Serve and Funnel port targets" ([`tailscale up --operator`](https://tailscale.com/docs/reference/tailscale-cli)).
  - With `--bg` it "runs persistently in the background", and "when you reboot the device ... Serve automatically resumes sharing".
  - `--set-path` mounts one path only.
  - It adds identity headers (`Tailscale-User-Login`) to each request. The page advises that a service which trusts these headers listens on localhost only.
- **`tailscale funnel`** is the same proxy, open to the internet ([Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)).
  - It needs "MagicDNS enabled", "HTTPS enabled and valid HTTPS certificates", and "a `funnel` node attribute in your tailnet policy file", which only "an Owner, Admin, or Network admin" can add.
  - "Funnel can only listen on ports 443, 8443, and 10000."
  - "Traffic sent over a Funnel is subject to non-configurable bandwidth limits."
  - "Public DNS records can take up to 10 minutes to show up."
  - "The same port number cannot be used for Serve ... and Funnel ... at the same time."
  - On macOS the page says both that Funnel needs "one of the open source variants" and that the App Store and Standalone variants can "share ports". Which is right for a port proxy is unverified.

### 3.2 Which registration methods work with a tailnet-only HTTPS origin

The user's browser reaches `https://<machine>.<tailnet>.ts.net`. The vendor's authorization server does not: Serve is "available only within the tailnet".

- **DCR works.** The redirect URI is data in the registration request, and the AS never calls it. The client registers as `application_type: "web"` ("remote browser-based applications served from a non-local host"). Two limits:
  - DCR is deprecated, with removal no earlier than the first revision on or after 2027-07-28 ([`mcp-protocol-and-harnesses.md`](./mcp-protocol-and-harnesses.md), A1).
  - An AS may restrict redirect hosts. Atlassian's default list would refuse an unknown HTTPS host (section 1.3).
- **A pre-registered client works** when the user registers that exact URI with the vendor. This is the bring-your-own-client route Google uses today (spec 13 section 3.2).
- **CIMD does not work with a document served from the tailnet.** The AS must fetch the `client_id` URL, and it cannot reach it. The newest draft also forbids the fetch: "Authorization servers MUST NOT fetch a Client ID Metadata Document URL ... that resolve to special-use IP addresses as defined in [RFC6890]" ([CIMD draft-03, section 10.7](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-03#section-10.7)). Cloudflare's library advertises CIMD only when the Worker runs with the `global_fetch_strictly_public` flag, "which is necessary for SSRF protection" ([`docs/authorization-server.md`](https://github.com/cloudflare/workers-oauth-provider/blob/dbd149a21962f02d732dfa98ae7b2316a814d6ba/docs/authorization-server.md)).
- **One static public document cannot list a redirect URI that differs per install.** The match is exact: "an exact match (using simple string comparison) of a registered redirect URL", with the loopback port as the only exception ([CIMD draft-03, section 4.2](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-03#section-4.2)). `https://studio-mac.tail1234.ts.net/oauth/callback` is a different string for every install.
- **A service that writes a document per install can.** OpenAI runs one for Codex: `https://chatgpt.com/oauth/codex/<id>/client.json` answers with `redirect_uris` that end in `/callback/<id>` (live; the URL pattern is in [`oauth_client_registration.rs`](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/oauth_client_registration.rs)). OpenAI's service varies only the path of a loopback URI. A Hercule service that put any host into a document named "Hercule" would let anyone send codes to a host of their choice under Hercule's name. It would also be a service the project runs, which is the subject of section 4.
- **An AS may tie the redirect to the document's origin.** "Authorization servers MAY impose restrictions on functional URIs, such as restricting the `redirect_uris` to the same origin as the `client_id`" ([CIMD draft-03, section 4.4](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-03#section-4.4)). On such a server, a document on one host with a redirect to another host is refused, whoever serves it.

### 3.3 cloudflared

- **A quick tunnel** needs no account: `cloudflared tunnel --url http://localhost:8080` prints a random `trycloudflare.com` address ([Cloudflare: Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)).
  - **What it is for.** "Quick Tunnels are for testing and development. For production, create a Cloudflare Tunnel."
  - **Limits.** "Quick Tunnels have no uptime guarantee." "Each Quick Tunnel supports up to 200 in-flight requests." "Quick Tunnels do not support Server-Sent Events (SSE)."
  - **The name changes.** "The hostname changes each time you create a Quick Tunnel", and "the URL stops working when you stop the `cloudflared` process". A registered redirect URI and a CIMD URL both die with it.
  - **It is public.** "Anyone with the URL can access your local service." The `--allowed-mail` option puts an email check in front, which "does not support non-interactive clients", so an AS could not fetch a client document through it.
  - **One path only?** The quick tunnel page shows no path rule. Pointing `--url` at a small listener that serves only the callback, and not at the controller's port, would limit it. Not tested.
- **A named tunnel** has a stable hostname. It needs "a Cloudflare account" and "a domain on Cloudflare" ([Cloudflare: get started](https://developers.cloudflare.com/tunnel/get-started/)); the locally managed form asks to "change your domain nameservers to Cloudflare" ([create a locally-managed tunnel](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/)).
  - **It can expose single paths.** Ingress rules "can match the request's path to a regular expression", and the file ends in a catch-all such as `http_status:404` ([configuration file](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/)).
- **Exposing the whole controller** would put its API and its login on the internet. Spec 13 section 1 says v1 has no "rate limiting of login attempts, brute-force lockout, CSRF machinery, and similar public-exposure defences". So a tunnel, like a Funnel, would have to carry the callback path and the client document only.

### 3.4 What must be public, and for how long

- **The redirect target is never called by the vendor.** Only the user's browser goes there. It needs to be reachable by that browser, for the minutes of a sign-in.
- **With DCR, nothing of the controller needs to be public at any time.**
- **With CIMD, the client document must be public, and not only during sign-in.**
  - The AS fetches it when it meets the `client_id`: authorization servers "SHOULD fetch metadata documents when encountering URL-formatted client_ids" and "SHOULD cache metadata respecting HTTP cache headers" ([Client Registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration#implementation-requirements)).
  - It comes back for it later: "Authorization servers SHOULD periodically re-fetch the Client ID Metadata Document as the contents may change over time" ([CIMD draft-03, section 6](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-03#section-6)).
  - A missing document should not end a sign-in at once: "A transient failure SHOULD NOT by itself invalidate a Client Identifier URL's previously established trust or outstanding refresh tokens" (same draft, section 6.1). That is a SHOULD.
  - One real implementation gives a day. Cloudflare's library caches a document "according to their `Cache-Control` headers, capped at 7 days", and keeps a last good copy "so clients stay signed in while the document's host is down"; that copy "expires 24 hours after the last successful fetch" ([`docs/authorization-server.md`](https://github.com/cloudflare/workers-oauth-provider/blob/dbd149a21962f02d732dfa98ae7b2316a814d6ba/docs/authorization-server.md)).
  - A new URL is a new client: "a client that changes its Client Identifier URL is, as far as any authorization server is concerned, a brand new client with no relationship to the previous one" ([CIMD draft-03, section 10.4](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-03#section-10.4)).
- **So a tunnel opened only for the minutes of a sign-in fits DCR, and does not fit CIMD.** With CIMD the document has to stay at one address for as long as the tokens are refreshed. Claude Code's and Codex's documents are served with `cache-control: public, max-age=300` (live).

## 4. A hosted relay

- **The pattern.** The project runs one public HTTPS page. Every install uses that page as its redirect URI. The page reads where to send the browser next from the `state` parameter and forwards the code there: to a loopback listener, to an app's URL scheme, or to the install's own address.
- **It is a known pattern, and the common one for clients with a web or remote form:**
  - **VS Code.** `redirect_uri` is `https://vscode.dev/redirect`, and `state` is a `vscode://` address that the page opens ([`extHostAuthentication.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/common/extHostAuthentication.ts)). The page answers a request without it with "No state or url query parameter provided" (live).
  - **Cursor.** The web callback page "hands the sign-in back to the desktop app" ([Cursor MCP docs](https://cursor.com/docs/mcp)).
  - **Claude.** `https://claude.ai/api/mcp/auth_callback` is not a relay but the client itself: Anthropic's servers hold the tokens ([Claude: authentication for connectors](https://claude.com/docs/connectors/building/authentication)).
- **What it would give Hercule.** One redirect URI for every install, so one static client document works with CIMD, and one URI to register works with DCR and with pre-registered clients. It works in the desktop app, the web app and the CLI. The user sets up nothing.
- **What it would cost:**
  - A page and a domain that the project runs, and that every sign-in of every install depends on.
  - Every authorization code passes through the project's page. PKCE keeps a code useless without the verifier, which stays on the controller.
  - The page forwards to an address taken from `state`, so it must be built so that it cannot send a code to an address an attacker chose.
  - Vendors with an allowlist (Atlassian, perhaps Stripe) would have to add the project's domain; loopback is on Atlassian's default list and an unknown domain is not.
- **Spec 13 section 3.1 says Hercule "hosts no OAuth relay".** Building this would change that sentence. A static client document is a smaller thing than a relay: the design already says it "is neither, but it is the first thing Hercule would host" (`docs/design/mcp/index.html`, decision 6).

## Summary

"Loopback any port" means the AS follows RFC 8252 section 7.3. Where an AS matches exactly, a loopback option needs a fixed port.

| Option | Desktop app | Web app | CLI | The user must set up | CIMD | DCR | Pre-registered | What becomes public | Main risk |
|---|---|---|---|---|---|---|---|---|---|
| Desktop app catches loopback | yes | no | - | nothing | yes - one static document with loopback URIs, shared by all installs | yes, as `native` | yes where the vendor allows loopback (GitHub: any port) | nothing of the install | an AS that matches the port exactly; a consent warning for localhost |
| CLI catches loopback | - | no | yes, when the CLI runs on the browser's machine | nothing | same | same | same | nothing of the install | the same; over SSH the listener is on the wrong machine, so paste-back remains |
| Controller HTTPS inside the tailnet (`tailscale cert` or Serve) | yes | yes | yes | MagicDNS and HTTPS on in the admin console, once | no | yes, as `web` | yes, if the user registers the URI | the machine name, in the certificate ledger | DCR only, and DCR is deprecated; an AS that restricts redirect hosts (Atlassian) |
| Tailscale Funnel | yes | yes | yes | the above, plus the `funnel` attribute by an admin; port 443, 8443 or 10000 | yes, a document per install | yes | yes | every path the Funnel carries | the controller has no defences for the open internet |
| cloudflared quick tunnel | yes | yes | yes | install `cloudflared` | no - the name changes, and the document must outlive the sign-in | yes, a new registration per sign-in | no | the tunnelled port, while it runs | "for testing and development", no uptime guarantee |
| cloudflared named tunnel | yes | yes | yes | a Cloudflare account and a domain on Cloudflare | yes | yes | yes | the paths the ingress rules allow | heavy setup; public exposure |
| Hosted relay | yes | yes | yes | nothing | yes - one static document | yes | yes | a page and a document run by the project | contradicts spec 13 section 3.1 as written; every install depends on it |
| Device code | - | - | - | - | no | no | GitHub only | nothing | not in MCP; no other vendor checked offers it |
| Paste-back | yes | yes | yes | nothing | yes | yes | yes | nothing | the user copies a URL by hand |

One case needs none of this: a browser on the controller's own machine. There the controller's own address is a loopback address, as in the Linear flow today.

## What this means for Hercule

- **The evidence supports the loopback listener as the main route, in the desktop app and the CLI.**
  - It is the form the MCP text allows by name, and the one RFC 8252 and OAuth 2.1 require every authorization server to accept on any port.
  - Claude Code, Codex and VS Code all do it, and Claude Desktop does it from a desktop app.
  - It works with all three registration methods.
  - It is the only redirect target Atlassian accepts from an unknown client without an admin.
  - It makes nothing of the install public.
- **It makes the client document simple.** With loopback URIs, one static file is right for every install: `http://127.0.0.1/callback`, `http://localhost/callback`, and one fixed port for servers that match exactly. That file must stay at one public address for as long as tokens are refreshed. Hosting it is still decision 6 of the design.
- **Keep a fixed port to fall back on.** VS Code, Cursor and Claude Desktop each have one, because some servers match the port. With DCR, registering the exact URI for each sign-in avoids the question.
- **Hand over the whole query string,** not only `code` and `state`: the controller must check `iss` before it exchanges the code.
- **The web app is the gap.** A web page cannot listen on a port. For it the evidence leaves:
  - paste-back, which works everywhere;
  - HTTPS on the controller inside the tailnet, which spec 13 already describes. It works with DCR and with pre-registered clients only, and needs the two switches in the Tailscale admin console.
- **Paste-back stays** as the last resort, as in every client looked at: for the web app without HTTPS, and for a CLI run over SSH.
- **Device code is not an option** beyond GitHub, which Hercule already covers.
- **A public tunnel is not supported by the evidence as a default.** A quick tunnel's name changes and Cloudflare calls it a testing tool. Funnel and a named tunnel need an admin or a domain, and put a controller with no internet defences behind a public name.
- **A hosted relay would close the web app gap** with no setup for the user. It contradicts spec 13 section 3.1 as written, so it is a decision for Rogier, not a finding.

Still unproven:

- That Notion, Linear and Stripe accept a loopback redirect on any port. It is inferred from Claude Code's and Codex's port-less client documents and from the library Cloudflare publishes, not from their documentation.
- That Sentry accepts it for a CIMD client today, given the one report against.
- That the forwarding step works as designed. No client looked at splits the listener and the exchange over two machines; the specifications do not forbid it, and none describes it.
- How each browser treats the last redirect, from an HTTPS consent page to `http://127.0.0.1:<port>`. Every CLI above relies on it. It was not tested here.

## Unverified

- Whether `mcp.notion.com`, `mcp.linear.app` and `access.stripe.com/mcp` ignore the port of a loopback redirect URI, for DCR and for CIMD clients.
- Whether Notion and Linear run Cloudflare's `workers-oauth-provider`. Their metadata fits; their source is closed.
- The cause and the present state of the Sentry failure in `anthropics/claude-code` issue 81643.
- Whether Stripe still keeps an allowlist of redirect URIs, and what is on it.
- Whether Figma's registration endpoint refuses a client outside its catalog. The documentation says only listed clients can connect; registering was not tried.
- Which authorization servers show a warning for a localhost redirect, apart from the text in Cloudflare's library.
- When `tailscale cert` needs root, and whether Funnel can proxy a port on the App Store and Standalone variants of Tailscale for macOS.
- Whether a quick tunnel can be limited to one path by `cloudflared` itself.
- Cloudflare's terms for `trycloudflare.com` beyond the Quick Tunnels page.
- Whether Claude Code and Codex register by DCR once or for each sign-in. Only Anthropic's statement about its hosted client was found.
- The cost of a short-lived listener in the desktop app's main process. It was reasoned from RFC 8252, not measured.
- Nothing here was tried against a live authorization server.

## Follow-up, 2026-11-19: three questions from Rogier

### Is missing HTTPS the only thing that stops the web app?

Yes, when the browser is on another machine than the controller.

- The controller does listen. Its address, as that browser sees it, is plain HTTP on another machine, such as `http://studio-mac.<tailnet>.ts.net:4937`. The rule allows two kinds of return address only: "All redirect URIs MUST be either `localhost` or use HTTPS" (section 1.1). The controller's address is neither, so an authorization server refuses it.
- `localhost` in that rule means the machine the browser runs on. In the web app, nothing of Hercule runs there but a page in a browser tab, and a page cannot open a port. The desktop app and the CLI can. That is the whole difference between the clients.
- With the browser on the controller's own machine there is no problem: the controller's address is then a `localhost` address (end of the summary).

### Is a self-signed certificate good enough?

Reasoned from the protocol, not tested.

- **The authorization server never connects to the redirect URI.** It compares it as text and sends the browser there (section 3.2). So it cannot see who signed the certificate, and `https://` in the URI is all it checks.
- **Only the user's browser checks the certificate,** when it follows the redirect to the controller. With a self-signed certificate it shows its warning page. The sign-in completes only when the user clicks through, or has trusted the certificate on that device beforehand. Each device that signs in needs that.
- **It has the same limits as HTTPS inside the tailnet** (section 3.2): it works with Dynamic Client Registration and with a client the user registered by hand, not with a Client ID Metadata Document, and a server that restricts redirect hosts refuses it.
- **So it is no better than `tailscale cert`,** which gives a certificate every browser already trusts, for the same reach. It only helps an install with no Tailscale.

### How far does a free Cloudflare Worker go for a relay on hercule.sh?

A relay needs two things at one public HTTPS address: the client document (a JSON file) and the page the browser returns to. Both can be static files. The page reads `state` in the browser and sends the browser on.

- **Static files cost nothing, without a cap.** "Requests to static assets are free and unlimited" ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Static assets: billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)). A request that matches a static file does not run the Worker's script.
- **If the page ran code on the server instead,** the Free plan allows "100,000 per day" requests with "10 milliseconds of CPU time per invocation", and the count resets "at midnight UTC" ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). One sign-in is one request to the page, and at most one more by the vendor for the client document. Past the limit, Cloudflare answers "Error 1027" until the reset.
- **So cost is not the constraint.** The constraints are the ones in section 4: every install's sign-in depends on that page being up, and the page must be built so it cannot send a code to an address an attacker chose. PKCE keeps a code useless without the verifier on the controller, but a page that forwards anywhere would let a stranger start a sign-in under Hercule's name and receive its result.
- Not checked: whether a custom domain for a Worker is free (the pages read do not say), and Cloudflare's terms for this use.
