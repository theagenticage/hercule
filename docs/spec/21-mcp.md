# MCP Servers and the MCP Gateway

*(Added 2026-11-20, [#1207](https://github.com/theagenticage/hercule/issues/1207); [ADR 0059](../adr/0059-sessions-reach-mcp-servers-through-a-gateway-in-the-controller.md). First build: [#1208](https://github.com/theagenticage/hercule/issues/1208).)*

An **MCP Server** is a record on the controller: a remote server that offers tools to sessions, and what it is reached with. The **MCP Gateway** is the controller's one MCP endpoint. Every session's harness is given the gateway as its one MCP server, with the session's own Session Token. The gateway lists the tools of the MCP Servers in that session's list and forwards each call with a credential the controller holds. No vendor token reaches a runner.

This is the "agent-tools extension point" that [./01-overview-and-scope.md](./01-overview-and-scope.md) and [./05-plugins.md](./05-plugins.md) deferred, for MCP servers. Skills stay deferred.

This document owns the behaviour of the catalogue and the gateway: how a server is named, listed and checked, what a session sees, what a call does and what a refusal looks like, and what credentials the controller uses upstream. Other documents own the pieces below and are linked, not restated:

- the record's fields, the `Project`, `Session` and setting fields that name servers, and the `McpServerLeftOutReason` enum: [./02-domain-model.md](./02-domain-model.md#mcp-server);
- the plugin side (`registerMcpServer`, `McpServerContribution`, the `mcp-servers` capability): [./05-plugins.md](./05-plugins.md);
- `SessionSpec.mcpServers`, the harness capability `mcpPassthrough`, the adapter mappings and how a gateway call reads in the event stream: [./06-providers.md](./06-providers.md#4-harnessadapter);
- the operations, their CLI rows, the `mcpServer` live topic and the gateway route as a transport: [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md);
- the grant family `mcp`, the shipped profiles, the secrets table and its owners, and the audit entry: [./13-security.md](./13-security.md);
- the screens: [./14-web-app.md](./14-web-app.md) and [./17-desktop-app.md](./17-desktop-app.md).

Terms are [GLOSSARY.md](../../GLOSSARY.md)'s: **MCP Server**, **MCP Gateway**, **Session Token**, **Connection**, **Project**, **Thread**, **Session**, **Access Mode**, **Notification**.

## 1. The idea and the module map

### 1.1 The idea

- A server is set up once, on the controller. It is a plugin's server, reached with the plugin's Connection, or a server the user added by URL, reached with its own sign-in.
- A session's harness is given one MCP server: the gateway, at the fixed address `<controller>/mcp`, with the session's Session Token as bearer. Every session on every runner gets the same address.
- The gateway knows the session from the token. It lists the tools of the servers in that session's own list, each tool named `<server name>__<tool>`, from lists the controller stored.
- A call goes to the gateway. The gateway checks the grant and the list, takes a fresh credential, sends the call to the server and returns the answer.
- A session's list can change while it runs, because the address stays the same and the gateway answers from the list as it is now ([section 3.7](#37-list-changes)).

The options that were not chosen, and why, are in ADR 0059.

### 1.2 Domains and the route

Two new controller domains, one new route.

| Piece | Owns |
|---|---|
| `mcp-servers` (domain) | The catalogue. The MCP Server records and their stored tool lists. The status of a server and how it is checked. The upstream MCP client. The sign-in of a server added by URL. The `mcpServer` operations |
| `mcp-gateway` (domain) | The session-facing side. Who is calling. The `mcp.use` check. The session's served list. The protocol. Open streams and `notifications/tools/list_changed`. Refusal lines on the thread. The audit entry for a call |
| `http/mcp.ts` (route) | `POST /mcp`, `GET /mcp` and `DELETE /mcp`, beside `/api/v1`. It resolves the bearer and hands the request to `mcp-gateway` in one line. It is not derived from the contract ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)) |

`mcp-servers` knows nothing about projects or threads. The gateway is a domain of its own, and not part of `mcp-servers`, because it needs a session's list and writes to a session's stream. It is not part of `sessions` because it is a protocol endpoint with its own state (open streams) and its own tests.

### 1.3 The domain graph

The controller's domains form a DAG, checked by `pnpm dep-lint` with no allowlist of edges ([ADR 0033](../adr/0033-source-is-organized-by-domain-and-tests-are-colocated.md)). The new edges:

- `projects`, `sessions`, `settings` and `mcp-gateway` import `mcp-servers`. `mcp-servers` imports none of them. A list of server ids is validated against the catalogue by the domain that holds the list.
- `mcp-gateway` imports `sessions`, to read a session's list and to write a line on its thread. `sessions` never imports `mcp-gateway`.
- `mcp-servers` imports `connections`, `secrets`, `plugins` and `notifications`. `connections` never imports `mcp-servers`. Two things cross that boundary the other way, by the two seams `connections` already has:
  - **A Connection's status change** reaches `mcp-servers` through the Connection observer (`connections/observer.ts`), which the controller daemon implements at boot. The observer gains a report of a status change. A Connection that needs sign-in moves its servers to `needs-sign-in`, and a reconnect makes them list again ([section 5.3](#53-status)).
  - **Deleting a Connection** is guarded through `ConnectionReferences` (`connections/references.ts`). It gains a `ConnectionReference` kind, `mcpServer`. The controller daemon provides it from `mcp-servers`, as it does for resources and workflows. A delete is refused while a server uses the Connection, with a message to remove the server first.
- The start of a session (the shared path where the start is claimed and the frame is built) is in the controller daemon, which may import both `sessions` and `mcp-servers`. It records which servers a start left out ([section 3.8](#38-left-out-at-the-last-start)).

The gateway hears of each change that alters what a session is served ([section 3.7](#37-list-changes)) after its commit. The means is an implementer's choice. The `mcpServer` live topic and the session topic announce the same changes to clients.

## 2. MCP Servers

### 2.1 What a record is

The fields are in [./02-domain-model.md](./02-domain-model.md#mcp-server). In short, a server has:

- a `name`, fixed at creation ([section 2.2](#22-names));
- a `source`: a plugin's contribution with the Connection it is reached with, or a URL with how the user signs in (none, a pasted token, or OAuth);
- `enabled`, the user's switch. Off is `enabled: false`, never a delete;
- a `status` and a `statusDetail`, in words a person can act on ([section 5.3](#53-status));
- `tools`: the name, title and description of each tool, as of the last successful list. Read only.

There is no `disabled` status. `enabled` says it, and a client shows "Off" when `enabled` is false.

Stored with the record but not on it:

- each tool's full definition (input schema, output schema, annotations). `tools/list` is answered from it ([section 3.3](#33-what-a-session-sees));
- for a URL server, its sign-in: a pasted token or OAuth tokens, in the secrets table, owned by the MCP Server ([section 5.2](#52-a-url-servers-sign-in)).

### 2.2 Names

A `name` matches `^[a-z0-9]+(_[a-z0-9]+)*$`, is 1 to 16 characters, and is not `hercule`. Why:

- `-` and `.` are not allowed, because Codex turns them into `_`.
- `__` separates the name from the tool in a tool name ([section 3.4](#34-tool-names)), so a name holds no double underscore.
- `hercule` is kept for Hercule's own tools, which are not in v1 ([Post-v1](#post-v1)).

A name is never renamed. The default:

- a plugin server takes its contribution's bare word (`sentry`);
- a URL server takes the name the user gives, or else the host's first label that is not `mcp`, `www` or `api` (`notion`).

Two servers may share a name: work and hobby Sentry are both `sentry`. One list never holds two servers of one name ([section 4.1](#41-the-lists)).

### 2.3 One server per address and account

- **A plugin server:** one per contribution and external account. The account is the Connection's `accountId` ([./08-events-and-connections.md](./08-events-and-connections.md#81-record)), not its id. A second is refused `conflict`, and the message names the existing server.
- **A URL server:** one per normalized URL in v1. A second account at the same URL is refused `conflict`.

  **Open:** two accounts at one URL. The controller cannot know the external account behind a pasted token or a sign-in, so v1 refuses a second server at one URL. [#1218](https://github.com/theagenticage/hercule/issues/1218) decides how; Rogier made it a required follow-up.
- **A URL on a plugin's origin:** adding by URL an address on the `origin` of a plugin's contribution (any URL on `https://mcp.sentry.dev`) is refused `conflict`. The message points at that Connection's row in Settings > MCP servers.
- **Replace.** When the user switches on a plugin's server and a URL server on that contribution's origin exists, the client offers "Replace". Replace is `mcpServer.update { source: { kind: "plugin", ... } }` on the URL server. The record keeps its id, its name and every list that names it. It moves to the plugin's Connection, and its own sign-in secrets are deleted. ([#1210](https://github.com/theagenticage/hercule/issues/1210).)

### 2.4 What deleting does

Deleting an MCP Server removes it from every project's list, every session's list and the default list. (The default list drops ids it does not know when it is read.) Sessions that are running get `notifications/tools/list_changed` ([section 3.7](#37-list-changes)).

Deleting a Connection that an MCP Server uses is refused ([section 1.3](#13-the-domain-graph)).

## 3. The MCP Gateway

### 3.1 The route and who may call

The route is `POST /mcp`, `GET /mcp` and `DELETE /mcp` on the controller. It is a transport of its own. [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) owns it as a transport. This section owns what it does.

- **Only a Session Token.** The route resolves the bearer as a Session Token itself. A user credential, an API key, a missing token and the token of an ended session all get HTTP 401. The `WWW-Authenticate` header carries no `resource_metadata`, so no harness starts an OAuth sign-in. The token is never logged.
- **No browsers.** A request with an `Origin` header is refused 403.
- **The promotion gate.** The route passes it like other session calls.
- **Streams end** when the session ends, when the controller freezes or seals, and at shutdown.
- **The grant.** Every call needs `mcp.use` in the session's profile ([./13-security.md](./13-security.md#61-grant-families)). `mcp.use` alone allows acting through the server's Connection. `connection.use` is not also required, because the user put that server on that thread.
- **The list.** A call is allowed only for a server in the session's own list ([section 3.5](#35-a-call)).

**A direct call is like the CLI.** The harness is given the Session Token, and so is the agent's shell. An agent can send a call to the gateway with `curl`, and then the harness's approval card is not shown. That command is itself under the Access Mode. So the controller's guard on a call is `mcp.use` plus the session's list. The Access Mode guards the harness's tool calls as for every other tool. The gateway has no approval mechanism of its own.

**Risk:** a call sent directly with the Session Token skips the harness's approval card, as the CLI does.

**Risk:** every tool call passes the controller. A controller that is down takes MCP tools with it, as it does the CLI.

### 3.2 Protocol revisions and what is spoken

The gateway speaks every revision that Effect 4.0.7 implements: `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25` and `2026-07-28`. That covers both handshakes:

- the older one: `initialize`, the `Mcp-Session-Id` header, the GET stream and DELETE;
- the stateless 2026-07-28 one: `server/discover` and `subscriptions/listen`.

Effect picks one per client from its first message. No harness capability is needed. Claude Code 2.1.329 sends the new handshake first. Codex and pi send the old one.

Only tools: `tools/list` and `tools/call`. There are no resources, no prompts and no completions. A server's sampling or elicitation request is answered "not supported".

The `instructions` of the server are one first line of at most 250 characters that names the servers inside, because Codex shows the model that line and no tool names.

### 3.3 What a session sees

One live rule decides what a session sees:

> `tools/list` answers the tools of every server in the session's list that is switched on and has a stored tool list (`checkedAt` is set). It answers from the stored lists, whatever the server's status is now.

- Nothing calls an outside server to answer `tools/list`.
- A session whose profile lacks `mcp.use` gets an empty list, and the `instructions` line says why.
- A server that is not `ready` but has a stored list is still listed. A call to it is refused with the reason ([section 3.6](#36-a-refused-call)).
- The record of what the last start left out ([section 3.8](#38-left-out-at-the-last-start)) does not change what `tools/list` answers.

### 3.4 Tool names

A tool is named `<server name>__<tool name>`. The harness puts the gateway's own name in front, so the model sees `mcp__tools__sentry__search_issues` ([./06-providers.md](./06-providers.md#4-harnessadapter)).

- The tool's own name is normalized to `[A-Za-z0-9_]`. Other characters become `_`.
- If `mcp__tools__` (12 characters) plus the full name passes 64 characters, the tool part is cut. It ends in `_` plus 6 hex characters of a hash of the original name. 64 is pi's limit. Claude Code drops a tool above 128.
- Uniqueness is checked over the whole list a session is sent. A clash also gets a hash suffix.
- The gateway maps every name it sends back to the server and the original tool name.

### 3.5 A call

1. The name must map to a tool in the stored list of a server the session is served ([section 3.3](#33-what-a-session-sees)). Anything else is refused without contacting a server.
2. The session's profile must hold `mcp.use`.
3. The server must be `ready`. Else the call is refused with the reason.
4. The gateway takes a fresh credential ([section 5.1](#51-a-plugin-servers-credential)), sends the call upstream ([section 3.10](#310-upstream-sessions)) and returns the server's answer.
5. A call with no answer within 60 seconds is refused as a timeout.

Answers have a size cap. Its size is an implementer's choice ([./16-open-items.md](./16-open-items.md), class B); [#1208](https://github.com/theagenticage/hercule/issues/1208) states it here.

### 3.6 A refused call

A call is refused when:

- the session's profile lacks the grant;
- the server is not in the session's list;
- the server is not `ready`;
- the sign-in failed;
- the call timed out.

What happens:

- **The agent** gets a tool result with `isError: true` and a message that says what the user can do: "Sentry (work) needs sign-in. Ask the user to reconnect it in Settings > Connections."
- **The thread** gets a `runtime.warning` line, at most once per server and reason in a turn. The warning carries the server's id and the reason, so the apps draw a button that fixes it: "Reconnect <Connection>", "Sign in…" or "Open server" ([./14-web-app.md](./14-web-app.md), [./17-desktop-app.md](./17-desktop-app.md)).
- **The audit log** gets the entry of [section 3.9](#39-audit).

Three kinds of failure stay apart:

| Kind | How it is returned |
|---|---|
| HTTP level: a bad token, a bad `Origin`, a wrong method | An HTTP error, before any JSON-RPC |
| A protocol fault | A JSON-RPC error |
| A refusal the model can act on | A tool result with `isError: true` |

### 3.7 List changes

After the commit of any change that alters what a session is served, the gateway sends `notifications/tools/list_changed` on that session's open stream. That is the GET stream, or `subscriptions/listen` in 2026-07-28. A change is:

- the session's list changed (`session.update`);
- a server was switched on or off, or deleted;
- a server has a new stored tool list.

A harness lists again when it opens its stream, so a change before that is not missed.

What each harness does with it:

- **A server taken away** stops working at once on every harness, because the call is refused.
- **A server added** is usable at once on Claude Code. On Codex it is usable only with Codex's `mcp_tool_list_changed` feature, and until then from the next start. On pi it waits for [#1212](https://github.com/theagenticage/hercule/issues/1212).

**Open:** Codex reads a changed tool list only with its `mcp_tool_list_changed` feature, which is under development and off by default. [#1209](https://github.com/theagenticage/hercule/issues/1209) turns it on and finds out whether the config of `thread/start` can set it. If it cannot, #1209 adds a harness capability so the composer can say that a server added now is usable from the next start.

### 3.8 Left out at the last start

At every start of a session, the controller records for each server in the session's list whether it can be called at that start and, if not, the `McpServerLeftOutReason` ([./02-domain-model.md](./02-domain-model.md#mcp-server)). A start is the shared path where the start is claimed and the frame is built, so a resume records it too. A server is left out when it cannot be called at that start:

| Reason | When |
|---|---|
| `switched-off` | `enabled` is false |
| `checking` | its first list has not ended |
| `needs-sign-in`, `unreachable`, `error` | its status at the start |
| `runner-too-old` | the runner lacks the `mcpServers` capability |
| `harness-unsupported` | the harness's `mcpPassthrough` is `unsupported` |

The controller writes one `runtime.warning` for the servers left out. It names each with its reason and fix.

This record is a diagnostic. It is never changed while the session runs. What the gateway serves is decided by the live rule ([section 3.3](#33-what-a-session-sees)). So a server that was `needs-sign-in` at the start but has a stored list is listed, and a call to it is refused with the reason, until it is `ready` again. A server left out because it had no stored list yet is listed as soon as it has one (`list_changed`), and one left out because it was not `ready` can be called as soon as it is.

### 3.9 Audit

The gateway writes one audit entry per `tools/call`. Its home is [./13-security.md](./13-security.md#11-audit). It holds:

- the actor and the session;
- the MCP Server and the tool's original name;
- the outcome: answered, refused with a reason, or failed;
- the duration.

It never holds the arguments or the result.

### 3.10 Upstream sessions

The gateway speaks to each server in the revision that Effect's client negotiates with it.

- A server on the older handshake gets one MCP session per Hercule session and server. It is opened at that session's first call to that server and closed when the session ends. So a server that keeps state per MCP session never mixes two threads.
- A stateless server needs nothing kept.
- The gateway keeps no open connection to an outside server and does not listen for its own `list_changed` in v1. A changed list is found by the checks of [section 5.4](#54-when-a-server-is-listed).

### 3.11 Build-time verifications

**Verify at build time:** that Effect's MCP server can answer each session its own tool list, and can send `list_changed` to one session only. If it cannot, the gateway writes that part on Effect's protocol modules. [#1208](https://github.com/theagenticage/hercule/issues/1208).

**Verify at build time:** that each harness opens a new MCP session after a 404 when the controller restarted, on the older handshake. [#1208](https://github.com/theagenticage/hercule/issues/1208) for Claude Code, [#1209](https://github.com/theagenticage/hercule/issues/1209) for Codex, [#1212](https://github.com/theagenticage/hercule/issues/1212) for pi.

Facts behind these, from the exploration: [how each harness caches and re-reads a tool list](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-tool-list-changes.md) and [the protocol and the harnesses](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-protocol-and-harnesses.md).

## 4. Which servers a session gets

### 4.1 The lists

Three lists name servers. The fields are in [./02-domain-model.md](./02-domain-model.md).

- **A Project's `mcpServerIds`:** what a new thread in the project starts with. It is a default only. Changing it never touches threads that exist.
- **The setting `thread.mcpServerIds`:** what a Thread with no project starts with. Unset or empty means no servers.
- **A Session's `mcpServers`:** the session's own list. Each entry holds the server's id and name, and whether the last start left it out and why ([section 3.8](#38-left-out-at-the-last-start)). Changing a thread's list never touches its project.

Every session kind has the field. Only a Thread's can be non-empty in v1. An Agent's session, a workflow step and an assistant's session have an empty list until [#222](https://github.com/theagenticage/hercule/issues/222).

No list may hold two servers with the same name. The write is refused `validation`, and the message names both.

### 4.2 Who sets a list

Every list write needs the grant `mcp.manage`, checked inside the operation in addition to the operation's own grant. The writes are:

- `project.create` and `project.update` with `mcpServerIds`;
- `session.spawn` with `mcpServerIds`;
- `session.update` with `mcpServerIds`;
- `settings.update` of `thread.mcpServerIds`, which only the user can call already.

`mcp.manage` is a grant only the user gives, like `skill.write` and `skill.apply`. The `unrestricted` profile leaves it out. An MCP Server reaches an outside account, and its tool descriptions steer every thread that has it. The family, the shipped profiles and the migration are in [./13-security.md](./13-security.md#61-grant-families).

### 4.3 What a new session starts with

- **A Thread the user starts:** the spawn's `mcpServerIds` if given. An explicit empty list is kept as empty. Else its project's list. Else the setting `thread.mcpServerIds`. On the Draft Thread the composer shows the list the thread will start with, and the user changes it there.
- **A Thread a session starts, and a fork a session makes (`session.continue`):** a copy of the calling session's own list. A session never gives a thread more servers than it has.
- **A fork the user makes:** a copy of its parent's list.
- **An Agent's session, a workflow step, an assistant's session:** an empty list until #222.

`session.update { mcpServerIds }` works on a queued, running or exited Thread, and not on an archived one. It leaves model selection alone. On a running session the gateway sends `notifications/tools/list_changed` ([section 3.7](#37-list-changes)).

### 4.4 What the harness is given

[./06-providers.md](./06-providers.md#4-harnessadapter) owns `SessionSpec.mcpServers` and the adapters. In short:

- Every session gets one entry, the gateway's, named `tools`, when its runner lists the capability `mcpServers` and its harness declares `mcpPassthrough: "native"`. It gets the entry also with an empty list, so a server added later works without a restart.
- The cost is one idle connection per session to the controller. Codex also shows the model one line about the server.
- A runner without the capability gets a spec without the field. Every server in the session's list is left out with `runner-too-old`, and the thread says so. A harness without `mcpPassthrough: "native"` leaves every server out with `harness-unsupported`. pi is `unsupported` until [#1212](https://github.com/theagenticage/hercule/issues/1212).
- Tool search is the harness's own. The gateway offers no search tool.

## 5. Credentials and status

### 5.1 A plugin server's credential

A plugin server is reached with its Connection's credential, fresh: the existing refresh runs 10 minutes before expiry. The plugin's pure `buildUpstreamRequest` turns the credential into the URL and the headers ([./05-plugins.md](./05-plugins.md)).

On an HTTP 401 from the server, before the tool ran, if the token sent is still the stored one, the gateway asks `connections` to refresh now and retries once. If a newer token is already stored, it uses that. It never refreshes on a timeout and never on a tool error. Then:

- **The refresh fails.** The Connection is marked `needs-reauth`, as today, and its servers move to `needs-sign-in`. The fix is "Reconnect <Connection>".
- **The refresh works and the server still refuses the fresh token.** The MCP Server goes to `error`, with the reason ("Sentry's MCP server refused the Connection's token"). The Connection is left alone. Reconnecting gives a token of the same kind, and marking the Connection would stop the Inbox polls for nothing.

### 5.2 A URL server's sign-in

A URL server keeps its own sign-in: none, a pasted token, or OAuth tokens. It is stored as secrets owned by the MCP Server. Their owner kind in the secrets table is `mcp-server`, and the generic `secret.set` and `secret.delete` refuse it ([./13-security.md](./13-security.md#2-secrets-at-rest)). It is not a Connection.

Its OAuth tokens are refreshed one at a time, by the refresh code `connections` has. That code moves below both domains and is shared. A failed refresh, or a 401 after a refresh, moves the server to `needs-sign-in`. Only a URL server can be in `needs-sign-in` on its own account. [#1210](https://github.com/theagenticage/hercule/issues/1210) builds this.

**Open:** which OAuth client registration a URL server uses: a Client ID Metadata Document, Dynamic Client Registration, or a pre-registered client. [#1210](https://github.com/theagenticage/hercule/issues/1210).

**Open:** a return page on hercule.sh, so the web app's sign-in needs no pasted address. It would change [./13-security.md](./13-security.md#31-policy)'s "hosts no OAuth relay". [#1206](https://github.com/theagenticage/hercule/issues/1206).

### 5.3 Status

| Status | Meaning |
|---|---|
| `checking` | From creation, or from switching on, until the first list ends. A later check does not go back to `checking`. Its result sets the status |
| `ready` | The last list or call succeeded |
| `needs-sign-in` | The credential is not usable ([sections 5.1](#51-a-plugin-servers-credential) and [5.2](#52-a-url-servers-sign-in)) |
| `unreachable` | No answer: a connection failure or a timeout. Checked again with backoff |
| `error` | The server answers but refuses or fails: a 401 after a working refresh, a 403, a protocol error, a revision Effect cannot speak, or the plugin switched off |

- A server keeps its last stored tools in every status.
- A plugin server follows its Connection. A Connection that moves to `needs-reauth` moves its servers to `needs-sign-in`. This reaches `mcp-servers` through the Connection observer ([section 1.3](#13-the-domain-graph)).
- A plugin that is switched off does not serve its servers. They are `error`, with the reason ("The Sentry plugin is switched off").

The backoff schedule for `unreachable` is an implementer's choice ([./16-open-items.md](./16-open-items.md), class B); [#1208](https://github.com/theagenticage/hercule/issues/1208) states it here.

### 5.4 When a server is listed

The controller lists a server's tools:

- on creation;
- on switching on;
- when its Connection is reconnected, or its own sign-in is done;
- on `mcpServer.check`;
- once a day for every enabled server.

A list that differs from the stored one triggers `list_changed` for the sessions that have the server ([section 3.7](#37-list-changes)).

### 5.5 Notifications

Entering `needs-sign-in`, `unreachable` or `error` raises one Notification per episode, never for a server that is switched off. A plugin server never raises one for `needs-sign-in`, because its Connection already does. The Notification subject gains MCP Server ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)).

### 5.6 Outbound rules

- A URL is `http` or `https` and holds no user name or password.
- A redirect is not followed with a credential to another origin.
- The URL that a plugin's `buildUpstreamRequest` returns must be on the `origin` the contribution declared.
- Private addresses are allowed. Hercule is single-user on a LAN or tailnet, and only the user adds a URL.

## 6. The plugin servers

Three plugins offer a server in v1. Each is reached with the plugin's Connection, and the plugin's `buildUpstreamRequest` builds the request. The vendor facts are from [the exploration](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-vendor-auth.md).

### 6.1 Sentry

- URL: `https://mcp.sentry.dev/mcp?disable-skills=project-management`. The query drops 18 tools that the Connection's scopes do not cover.
- Header: `Authorization: Sentry-Bearer <token>`.

**Verify at build time:** that `mcp.sentry.dev` accepts a Hercule Sentry Connection's token as `Sentry-Bearer`. This is unproven. A proof call is the first acceptance criterion of [#1208](https://github.com/theagenticage/hercule/issues/1208). If it fails, that slice stops and reports, because it then needs another route to "no second sign-in".

Sentry kills the old access token the moment it is refreshed. The gateway never hands a token out, so a refresh cannot break a running session.

### 6.2 Linear

- URL: `https://mcp.linear.app/mcp`.
- Header: `Authorization: Bearer <token>`. A pasted API key works too.

**Verify at build time:** that Linear accepts the Connection's token as `Bearer`. [#1209](https://github.com/theagenticage/hercule/issues/1209).

### 6.3 GitHub

- URL: `https://api.githubcopilot.com/mcp/`.
- Header: `Authorization: Bearer <token>`. `X-MCP-Toolsets` is limited to what the Connection's scopes cover.

**Verify at build time:** that GitHub accepts the Connection's token as `Bearer`, with that `X-MCP-Toolsets`. [#1209](https://github.com/theagenticage/hercule/issues/1209).

**GitHub has no special rule.** A GitHub MCP server is a plugin server like any other, reached with its own Connection. No code compares it with the workspace's account. A thread whose GitHub server acts as another account than the one its repository pushes as may meet a mismatch, which the agent reports.

**Open:** a plugin-neutral fix, for example a plugin server that declares it acts through "the session's Connection of my type", so GitHub's account matches the workspace's. [#1219](https://github.com/theagenticage/hercule/issues/1219) decides.

## 7. Flows

### 7.1 Switching on a plugin's server

1. The user switches on a Connection's server in Settings > MCP servers. The client calls `mcpServer.create` with `source: { kind: "plugin", contributionId, connectionId }`.
2. The controller refuses a second server for one contribution and account (`conflict`, naming the existing one). If a URL server on that contribution's origin exists, the client has offered "Replace" instead ([section 2.3](#23-one-server-per-address-and-account)).
3. The record is committed in `checking` and returned at once. The `mcpServer` topic announces it.
4. After the commit, the controller builds the request with the plugin's `buildUpstreamRequest` and a fresh credential, and lists the server's tools.
5. On success it stores each tool's full definition, sets `checkedAt` and the status `ready`, and announces the record. Sessions that have the server get `list_changed`. On failure it sets `needs-sign-in`, `unreachable` or `error` with the reason ([section 5.3](#53-status)).

### 7.2 A session starts

1. The controller works out the session's list ([section 4.3](#43-what-a-new-session-starts-with)). The list is stored on the session.
2. At the start, it records for each server whether it can be called and, if not, why. It writes one `runtime.warning` for the servers left out ([section 3.8](#38-left-out-at-the-last-start)).
3. The frame carries the gateway's entry when the runner and the harness support it ([section 4.4](#44-what-the-harness-is-given)). The runner resolves it against the controller's URL and adds the session's token.
4. The harness connects to `/mcp`, lists tools, and the gateway answers from the stored lists ([section 3.3](#33-what-a-session-sees)).

### 7.3 The agent calls a tool

1. The model calls `mcp__tools__sentry__search_issues`. The harness applies the Access Mode, and sends `sentry__search_issues` to the gateway with the session's token.
2. The gateway resolves the token, checks `mcp.use`, maps the name to a server in the session's list and a tool in its stored list, and checks that the server is `ready` ([section 3.5](#35-a-call)).
3. It takes a fresh credential, sends the call upstream, and returns the answer. On a 401 it refreshes once and tries again ([section 5.1](#51-a-plugin-servers-credential)).
4. It writes the audit entry. A refused call also gets a tool result with `isError: true` and a `runtime.warning` on the thread ([section 3.6](#36-a-refused-call)).

### 7.4 A list changes while a thread runs

1. The user changes the thread's list, or switches a server on or off, or a daily check finds a new tool list.
2. After the commit, the gateway sends `notifications/tools/list_changed` on the open stream of each session the change touches ([section 3.7](#37-list-changes)).
3. The harness lists again and the gateway answers from the stored lists. A server taken away is already refused at the next call.
4. A Codex thread without the `mcp_tool_list_changed` feature does not list again. A server added now is usable from the next start.

## Post-v1

- **Hercule's own tools over MCP.** Spec 11 section 10 parks a "Hercule MCP server" ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)): Hercule's own API as MCP tools. It stays post-v1, because a measurement of 280 runs found no success gap and the CLI costs the least context. The name `hercule` is kept for it ([section 2.2](#22-names)). The CLI stays the agent surface for Hercule's own operations ([ADR 0013](../adr/0013-agents-operate-hercule-through-the-public-api.md) stands for that).
- **Local MCP servers (stdio) on runners:** [#1213](https://github.com/theagenticage/hercule/issues/1213). A local server the harness starts would be a second kind of entry in `SessionSpec.mcpServers`, next to the gateway's, with no redesign.
- **Which tools of a server a session may call**, and overrides per project: [#1214](https://github.com/theagenticage/hercule/issues/1214). v1 stores and shows the tool list, and every tool of a served server is callable.
- **Agents and workflow steps naming MCP Servers:** [#222](https://github.com/theagenticage/hercule/issues/222). Until then only a Thread has a list.
- **Two accounts at one URL**, and a plugin server that follows the session's Connection of its type: [#1218](https://github.com/theagenticage/hercule/issues/1218) and [#1219](https://github.com/theagenticage/hercule/issues/1219) ([section 2.3](#23-one-server-per-address-and-account), [section 6.3](#63-github)).
- **Codex's changed lists, pi's built-in MCP, URL servers and the screens:** [#1209](https://github.com/theagenticage/hercule/issues/1209), [#1212](https://github.com/theagenticage/hercule/issues/1212), [#1210](https://github.com/theagenticage/hercule/issues/1210), [#1211](https://github.com/theagenticage/hercule/issues/1211). They are part of the design, built after the first slice.

## Sources

- [MCP support: ADR, spec and glossary for the gateway design (#1207)](https://github.com/theagenticage/hercule/issues/1207)
- [MCP gateway: Sentry's tools in a Claude Code thread, with no second sign-in (#1208)](https://github.com/theagenticage/hercule/issues/1208)
- [MCP gateway: Codex sessions, and the Linear and GitHub servers (#1209)](https://github.com/theagenticage/hercule/issues/1209)
- [MCP servers added by URL: no sign-in, a pasted token, then OAuth (#1210)](https://github.com/theagenticage/hercule/issues/1210)
- [Desktop and web: Settings › MCP servers, and a thread's servers in the composer (#1211)](https://github.com/theagenticage/hercule/issues/1211)
- [pi: switch on its built-in MCP and tool search, so pi sessions get the gateway (#1212)](https://github.com/theagenticage/hercule/issues/1212)
- [Local MCP servers (stdio) on runners: design (#1213)](https://github.com/theagenticage/hercule/issues/1213)
- [Look into: which tools of an MCP server a session may call, and overrides per project (#1214)](https://github.com/theagenticage/hercule/issues/1214)
- [Agent-level MCP server passthrough (#222)](https://github.com/theagenticage/hercule/issues/222)
- [MCP sign-in: look into a return page on hercule.sh, so the web app needs no pasted address (#1206)](https://github.com/theagenticage/hercule/issues/1206)
- [ADR 0059 - Sessions reach MCP servers through a gateway in the controller](../adr/0059-sessions-reach-mcp-servers-through-a-gateway-in-the-controller.md)
- [ADR 0013 - Agents operate Hercule through the public API](../adr/0013-agents-operate-hercule-through-the-public-api.md)
- [ADR 0016 - Git credentials derive from Connections](../adr/0016-git-credentials-derive-from-connections.md)
- [ADR 0030 - Sessions copy their configuration and a thread has no agent](../adr/0030-sessions-copy-their-configuration-and-a-thread-has-no-agent.md)
- [ADR 0031 - The backend is written on Effect](../adr/0031-the-backend-is-written-on-effect.md)
- [ADR 0033 - Source is organized by domain and tests are colocated](../adr/0033-source-is-organized-by-domain-and-tests-are-colocated.md)
- The exploration, at commit `9b9b82a25`: [architecture page](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/design/mcp/index.html), [benchmark](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/design/mcp/benchmark/), and the research notes [protocol and harnesses](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-protocol-and-harnesses.md), [vendor auth](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-vendor-auth.md), [t3code](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-t3code.md), [CLI versus MCP](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-cli-vs-mcp.md), [OAuth redirect](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-oauth-redirect.md) and [tool list changes](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-tool-list-changes.md)
- The screens prototype, at commit `f00bb9d62`: [prototype-mcp](https://github.com/theagenticage/hercule/tree/f00bb9d62/apps/desktop/src/renderer/specimens/prototype-mcp)
