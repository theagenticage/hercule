# MCP Servers and the MCP Gateway

*(Added 2026-11-20, [#1207](https://github.com/theagenticage/hercule/issues/1207); [ADR 0059](../adr/0059-sessions-reach-mcp-servers-through-a-gateway-in-the-controller.md). First build: [#1208](https://github.com/theagenticage/hercule/issues/1208).)*

An **MCP Server** is a record on the controller: a remote server that offers tools to sessions. The record stores the server's source and how the controller signs in to it. The **MCP Gateway** is the controller's one MCP endpoint. Every session on a runner and harness that support it is given the gateway as its one MCP server, with the session's own Session Token. The gateway lists the tools of the MCP Servers in that session's list and forwards each call with a credential the controller holds. No vendor token reaches a runner.

This is the "agent-tools extension point" that [./01-overview-and-scope.md](./01-overview-and-scope.md) and [./05-plugins.md](./05-plugins.md) deferred, for MCP servers. Skills stay deferred.

This document owns the behaviour of the catalogue and the gateway: how a server is named, listed and checked, what a session sees, what a call does and what a refusal looks like, and what credentials the controller uses upstream. Other documents own the pieces below and are linked, not restated:

- the record's fields, the `Project`, `Session` and setting fields that name servers, and the `McpServerLeftOutReason` enum: [./02-domain-model.md](./02-domain-model.md#mcp-server);
- the plugin side (`registerMcpServer`, `McpServerContribution`, the `mcp-servers` capability): [./05-plugins.md](./05-plugins.md);
- `SessionSpec.mcpServers`, the harness capability `mcpPassthrough`, the adapter mappings, how a gateway call reads in the event stream and the shape of the `runtime.warning` that names MCP Servers: [./06-providers.md](./06-providers.md#4-harnessadapter);
- the operations, their CLI rows, the `mcpServer` live topic and the gateway route as a transport: [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md);
- the grant family `mcp`, the shipped profiles, the secrets table and its owners, and the audit entry: [./13-security.md](./13-security.md);
- the screens: [./14-web-app.md](./14-web-app.md) and [./17-desktop-app.md](./17-desktop-app.md).

Terms are [GLOSSARY.md](../../GLOSSARY.md)'s: **MCP Server**, **MCP Gateway**, **Session Token**, **Connection**, **Project**, **Thread**, **Session**, **Access Mode**, **Notification**.

## 1. The idea and the module map

### 1.1 The idea

- A server is set up once, on the controller. It is a plugin's server, reached with the plugin's Connection, or a server the user added by URL, reached with its own sign-in.
- A session's harness is given one MCP server: the gateway, at the fixed address `<controller>/mcp`, with the session's Session Token as bearer. Every session on a runner and harness that support it gets the same address.
- The gateway knows the session from the token. It lists the tools of the servers in that session's own list, each tool named `<server name>__<tool>`, from lists the controller stored.
- A call goes to the gateway. The gateway checks the grant and the list, takes a fresh credential, sends the call to the server and returns the answer.
- A session's list can change while it runs, because the address stays the same and the gateway answers from the list as it is now ([section 3.7](#37-list-changes)).

The options that were not chosen, and why, are in ADR 0059.

### 1.2 Domains and the route

Two new controller domains, one new route.

| Piece | Owns |
|---|---|
| `mcp-servers` (domain) | The catalogue. The MCP Server records and their stored tool lists. The status of a server and how it is checked. The upstream MCP client. The sign-in of a server added by URL. The `mcpServer` operations |
| `mcp-gateway` (domain) | The session-facing side. Session Token authentication. The `mcp.use` check. The session's served list. The protocol. Open streams and `notifications/tools/list_changed`. Refusal lines on the Thread. The audit entry for a call |
| `http/mcp.ts` (route) | `POST /mcp`, `GET /mcp` and `DELETE /mcp`, beside `/api/v1`. It resolves the bearer and hands the request to `mcp-gateway` in one line. It is not derived from the contract ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)) |

`mcp-servers` knows nothing about Projects or Threads. The gateway is a domain of its own, and not part of `mcp-servers`, because it needs a session's list and writes to a session's stream. It is not part of `sessions` because it is a protocol endpoint with its own state (open streams) and its own tests.

### 1.3 The domain graph

The controller's domains form a DAG, checked by `pnpm dep-lint` with no allowlist of edges ([ADR 0033](../adr/0033-source-is-organized-by-domain-and-tests-are-colocated.md)). The new edges:

- `projects`, `sessions`, `settings` and `mcp-gateway` import `mcp-servers`. `mcp-servers` imports none of them. A list of server ids is validated against the catalogue by the domain that holds the list.
- `mcp-gateway` imports `sessions`, to read a session's list and to write a line on its Thread. `sessions` never imports `mcp-gateway`.
- `mcp-servers` imports `connections`, `secrets`, `plugins` and `notifications`. `connections` never imports `mcp-servers`. Two things cross that boundary the other way:
  - **A Connection's status and credential changes** are published by `connections` after the commit, and `mcp-servers` subscribes to them at boot. A slow or failed subscriber never touches the change that is already committed. A Connection that needs sign-in moves its servers to `needs-sign-in`, and a reconnect makes them list again ([section 5.3](#53-status)).
  - **Deleting a Connection** is guarded through `ConnectionReferences` (`connections/references.ts`). It gains a `ConnectionReference` kind, `mcpServer`. The controller daemon provides it from `mcp-servers`, as it does for resources and workflows. A delete is refused while a server uses the Connection, with a message to remove the server first.
- The start of a session is claimed and its frame is built in the `sessions` domain (`sessions/service.ts`), which imports `mcp-servers`. The record of which servers a start left out is written there, in the claim's transaction ([section 3.8](#38-left-out-at-the-last-start)). The gateway entry is added to the frame's `SessionSpec` when each start's frame is built, from the runner's capabilities and the harness. It is not read from an older stored spec ([./06-providers.md](./06-providers.md#4-harnessadapter)).

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
- **A URL server:** one per normalized URL in v1. A second account at the same URL is refused `conflict`. A normalized URL has the scheme and host in lower case, the default port dropped and a trailing `/` dropped. The path and the query are kept.

  **Open:** two accounts at one URL. The controller cannot know the external account behind a pasted token or a sign-in, so v1 refuses a second server at one URL. [#1218](https://github.com/theagenticage/hercule/issues/1218) decides how; Rogier made it a required follow-up.
- **A URL on a plugin's origin:** adding by URL an address on the `origin` of a plugin's contribution (any URL on `https://mcp.sentry.dev`) is refused `conflict`. The message points at that Connection's row in Settings > MCP servers.

  **Open:** what the refusal points at when the user has no Connection of that plugin, or the plugin is switched off: then there is no row in Settings > MCP servers. Nobody decided it in the grilling. Recommendation: refuse in every case, because the plugin is compiled in and its server is reached with no second sign-in once a Connection exists. With no Connection, the message says to connect the plugin first and points at Settings > Connections. With the plugin switched off, it says so and points at where plugins are switched on. [#1210](https://github.com/theagenticage/hercule/issues/1210) decides.
- **Replace.** When the user switches on a plugin's server and a URL server on that contribution's origin exists, the client offers "Replace". Replace is `mcpServer.update { source: { kind: "plugin", ... } }` on the URL server. The record keeps its id, its name and every list that names it. It moves to the plugin's Connection, and its own sign-in secrets are deleted. When several URL servers sit on the plugin's origin, the Replace dialog lets the user pick one. Replace closes the server's upstream MCP sessions ([section 3.10](#310-upstream-sessions)). ([#1210](https://github.com/theagenticage/hercule/issues/1210).)

### 2.4 What deleting does

Deleting an MCP Server removes it from every project's list and every session's list. The default list is not rewritten: it drops ids it does not know when it is read. Sessions that are running get `notifications/tools/list_changed` ([section 3.7](#37-list-changes)).

Deleting a Connection that an MCP Server uses is refused ([section 1.3](#13-the-domain-graph)).

## 3. The MCP Gateway

### 3.1 The route and who may call

The route is `POST /mcp`, `GET /mcp` and `DELETE /mcp` on the controller. It is a transport of its own. [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) owns it as a transport. This section owns what it does.

- **Only a Session Token.** The route resolves the bearer as a Session Token itself. A user credential, an API key, a missing token and the token of an ended session all get HTTP 401. The `WWW-Authenticate` header carries no `resource_metadata`, so no harness starts an OAuth sign-in. The token is never logged.
- **No browsers.** A request with an `Origin` header is refused 403.
- **Frozen or sealed controller.** The Origin check and the gates sit in the controller's request handling, before the MCP layer. While the controller is frozen or sealed, the gateway sends nothing upstream and starts no check:
  - a `tools/call` is refused with the gate's error;
  - `tools/list` still answers from the stored lists;
  - a call already sent may finish;
  - scheduled checks and refresh writes wait for the phase to end.
- **Streams end** when the session ends, when the controller freezes or seals, and at shutdown.
- *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **A session running across a promotion keeps the old address until its next start.** The runner binds the gateway's address and the token when a session starts, from the `HERCULE_API_URL` it gives the session ([./06-providers.md](./06-providers.md#4-harnessadapter)). The session's `hercule` CLI reads the same variable, and it does not follow a promotion either: after the seal, A answers its calls with `controller_sealed` and the new address, and the CLI prints that error. So once A seals, a session that started on A reaches only A's gateway: `tools/list` still answers from A's stored lists while A runs, every `tools/call` is refused with A's `controller_sealed` message, and once A stops, the harness cannot reach the gateway at all. The tools work again from the session's next start, a resume included, because the runner, which has followed the forwarding pointer to B, binds B's address then. A proxy on the runner that would let a running session follow the move is a follow-up ticket, not part of v1.
- **An `Mcp-Session-Id` belongs to one token.** An `Mcp-Session-Id` the gateway issues is bound to the Session Token it was created with. A request that names it with any other token gets 404. `DELETE` ends that MCP session only, never the Thread or its token. A resume mints a new token, so the old token's streams end with it.
- *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **What a request names is checked on every message.** A named `Mcp-Session-Id` that this token does not own gets 404, whatever the message is: `initialize` and a JSON-RPC response too. A legacy MCP session keeps the revision it negotiated. A later request of it that names another `MCP-Protocol-Version` is refused with HTTP 400 (the header mismatch error, or the unsupported-version error for a revision the gateway does not offer). A request with no such header is accepted, as the transport specification asks. A `2026-07-28` request must carry `MCP-Protocol-Version`, `Mcp-Method` and, for `tools/call`, `Mcp-Name`, and each must agree with the JSON-RPC payload, as Effect's own transport checks them.
- *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **Who is calling is read after the body.** The route checks the bearer first. The gateway reads the Session Token and the profile's grants again from the database after the body has been read, and that reading serves the request, so a Thread that ended, resumed or lost `mcp.use` while the body arrived is not served by an older reading. The body is counted as it is read and refused with 413 at 1 MiB, with no `Content-Length` needed.
- *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **A stream opens only when its body is read.** The GET stream and `subscriptions/listen` check the phase, the token and the MCP session again at that moment, and a stream that may not open ends with an empty body. A new GET stream of an MCP session replaces the one it had, one at a time. At shutdown the controller closes every stream and refuses new ones before the listener starts to drain, because the listener waits for open responses.
- **The grant.** Every call needs `mcp.use` in the session's profile ([./13-security.md](./13-security.md#61-grant-families)). `mcp.use` alone allows acting through the server's Connection. `connection.use` is not also required, because the user put that server on that Thread.
- **The list.** A call is allowed only for a server in the session's own list ([section 3.5](#35-a-call)).

**A direct call is like the CLI.** The harness is given the Session Token, and so is the agent's shell. An agent can send a call to the gateway with `curl`, and then the harness's approval card is not shown. That command is itself under the Access Mode. So the controller's guard on a call is `mcp.use` plus the session's list. The Access Mode guards the harness's tool calls as for every other tool. The gateway has no approval mechanism of its own.

**Risk:** a call sent directly with the Session Token skips the harness's approval card, as the CLI does.

**Risk:** every tool call passes the controller. A controller that is down takes MCP tools with it, as it does the CLI.

### 3.2 Protocol revisions and what is spoken

Towards sessions, the gateway serves two protocol eras:

- the Streamable HTTP transport of `2025-03-26`, `2025-06-18` and `2025-11-25`: `initialize`, the `Mcp-Session-Id` header, the GET stream and DELETE;
- the stateless `2026-07-28`: `server/discover` and `subscriptions/listen`.

`2024-11-05`, the old two-endpoint HTTP+SSE transport, is not offered. Where Effect's HTTP layer lacks a part, the gateway's route supplies it on Effect's protocol modules. Effect 4.0.7 has no GET stream and answers GET with 405, so the route supplies the GET stream. The era is chosen per client from its first message. No harness capability is needed.

Claude Code 2.1.329 tries modern discovery first and then falls back to the older handshake. Codex and pi use the older one. That Claude Code works on the modern path, and on the older one when `server/discover` is refused, is verified ([section 3.11](#311-build-time-verifications)).

Only tools: `tools/list` and `tools/call`. There are no resources, no prompts and no completions. A server's sampling or elicitation request is answered "not supported".

The `instructions` of the server are one first line that names the servers inside, because Codex shows the model that line and no tool names. The names are in a fixed order (by server name), and the line is cut at 250 characters.

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
- Uniqueness is checked over the whole list a session is sent. Names are given in a fixed order: by server name, then by the tool's original name. A clash gets a suffix, `_` plus 6 hex characters of a hash of the server's name and the original tool name. A second clash leaves the tool out, and the gateway writes that to the controller's log.
- The gateway maps every name it sends back to the server's name and the original tool name. Within one Session Token, a name the gateway has sent keeps its meaning: a later change to the list never gives it to another tool. Which server of that name it reaches is the one the list holds when the call is dispatched ([section 3.5](#35-a-call)).

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **A call is accepted only under a name this controller process has sent to that Session Token** in a `tools/list` answer. The gateway keeps what it sent in memory only, and a controller restart drops it, while a Session Token survives a restart. Names are worked out from the whole list, so after a restart a new collision could give a name the harness remembers to a different tool than the one it showed. The gateway never works a name out again for a call. A call under a name it has not sent since it started, whether the harness remembers it from before a restart or made it up, gets a tool result with `isError: true` that asks the agent to list the tools again, and `notifications/tools/list_changed` goes to the token's open streams. A name that was sent keeps its meaning, so no name is ever dispatched to a tool other than the one it was sent for. The result and the Thread's warning name the tool the caller wrote only after the name is cut to 64 characters and every character a tool name cannot have is replaced by `?`.

### 3.5 A call

1. The name must map to a tool in the stored list of a server the session is served ([section 3.3](#33-what-a-session-sees)). A call goes to the server that the session's list holds when the call is dispatched. Anything else is refused without contacting a server.
2. The session's profile must hold `mcp.use`.
3. The server must be `ready`. Else the call is refused with the reason.
4. The gateway takes a fresh credential ([section 5.1](#51-a-plugin-servers-credential)), sends the call upstream ([section 3.10](#310-upstream-sessions)) and returns the server's answer.
5. A call with no answer within 60 seconds is refused as a timeout. The 60 seconds cover the whole call: opening the upstream MCP session, the refresh, the retry and the tool.

Answers have a size cap. Its size is an implementer's choice ([./16-open-items.md](./16-open-items.md), class B); [#1208](https://github.com/theagenticage/hercule/issues/1208) states it here.

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **The cap is 4 MiB per message from a server**: one JSON answer, or one event of an SSE answer. It is large enough for a screenshot in an image block (Sentry's `get_snapshot_image`), and it bounds what one call can hold in the controller's memory. An answer over it is refused as a tool result with `isError: true` ("the answer was larger than 4 MiB"). A tool list is bounded the same way per message, and also by the client's own limits of 100 pages and 10,000 tools; a server's stored tool definitions are refused above 4 MiB in all, which sets the server to `error`.

### 3.6 A refused call

A call is refused when:

- the session's profile lacks the grant;
- the server is not in the session's list;
- the server is not `ready`;
- the sign-in failed;
- the call timed out.

What happens:

- **The agent** gets a tool result with `isError: true` and a message that says what the user can do: "Sentry (work) needs sign-in. Ask the user to reconnect it in Settings > Connections."
- **The Thread** gets a `runtime.warning` line, at most once per server and reason in a turn, or once per minute outside a turn. The warning's optional field `mcpServers` is an array of `{ mcpServerId, reason }` ([./06-providers.md](./06-providers.md#4-harnessadapter)), so one line can name several servers and each gets its own button that fixes it: "Reconnect <Connection>", "Sign in…" or "Open server" ([./14-web-app.md](./14-web-app.md), [./17-desktop-app.md](./17-desktop-app.md)). A client draws no button when the server no longer exists or the reason has no fix.
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
- a server has a new stored tool list;
- the session's profile gained or lost `mcp.use`. The next `tools/list` answers by the new grant.

The gateway also sends `list_changed` once when a stream opens, so a change between a session's first list and its stream is not missed.

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* Each stream is told about a change against the tool list that stream was last told about, not against what some `tools/list` last returned. So one client's `tools/list` never hides a change from another client of the same token. `subscriptions/listen` decodes its parameters with the schema of the `2026-07-28` protocol, refuses invalid ones, and acknowledges and sends only the notifications it asked for that the gateway serves (the tools' `list_changed`). When a server leaves a session's served list, the gateway closes that Session Token's upstream session to it ([section 3.10](#310-upstream-sessions)).

What each harness does with it:

- **A server taken away** stops working at once on every harness, because the call is refused.
- **A server added** is usable at once on Claude Code. On Codex it is usable only with Codex's `mcp_tool_list_changed` feature, and until then from the next start. On pi it waits for [#1212](https://github.com/theagenticage/hercule/issues/1212).

**Open:** Codex reads a changed tool list only with its `mcp_tool_list_changed` feature, which is under development and off by default. [#1209](https://github.com/theagenticage/hercule/issues/1209) turns it on and finds out whether the config of `thread/start` can set it. If it cannot, #1209 adds a harness capability so the composer can say that a server added now is usable from the next start.

### 3.8 Left out at the last start

At every start of a session, the controller records for each server in the session's list whether it can be called at that start and, if not, the `McpServerLeftOutReason` ([./02-domain-model.md](./02-domain-model.md#mcp-server)). A start is the claim and the frame it builds ([section 1.3](#13-the-domain-graph)), so a resume records it too. `leftOut` is written only at a start. An entry added since keeps `null`, and a client reads `null` as "not checked at a start yet". A server is left out when it cannot be called at that start:

| Reason | When |
|---|---|
| `runner-too-old` | the runner lacks the `mcpServers` capability |
| `harness-unsupported` | the harness's `mcpPassthrough` is `unsupported` |
| `missing-grant` | the session's profile lacks `mcp.use` |
| `switched-off` | `enabled` is false |
| `checking` | its first list has not ended |
| `needs-sign-in`, `unreachable`, `error` | its status at the start |

The rows are in the order of precedence. When several reasons apply to one server, the first one in this table is the one recorded.

The controller writes one `runtime.warning` for the servers left out, with the field `mcpServers` naming each server and its reason ([section 3.6](#36-a-refused-call)).

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* Four rules for that warning and the reasons behind it:

- **The status is the current one.** A server's `needs-sign-in` and `error` come from its Connection and its plugin as they are at the start, not only from the status the checks last wrote, because the follower writes a status some time after the Connection or the plugin changes. A Connection that is switched off or gone, or a plugin that is stopped, gives `error`. A Connection that needs sign-in gives `needs-sign-in`. Both come after the reasons above them in the table: a server whose first list has not ended is still `checking`, and a switched-off server is still `switched-off`.
- **The field holds every server up to the wire limit.** The `mcpServers` field holds up to 64 entries, so each server of a list of up to 64 left-out servers gets its fix button. The message names the first 20 servers in words and ends with "and N more" for the rest.
- **A list of more than 64 left-out servers** puts the first 64 in the field, and the message says how many of the servers it counts are not in it, as in "and 50 more (6 of them are not given a fix button)". Those servers are still recorded in the session's `leftOut`.
- **Only the controller writes the field.** A `runtime.warning` a runner reports has `mcpServers` removed before it is stored. A runner cannot attach a fix button to its own warning.

This record is a diagnostic. It is never changed while the session runs. The reasons `runner-too-old` and `harness-unsupported` describe delivery only: the gateway still answers a live Session Token by the live rule ([section 3.3](#33-what-a-session-sees)). So a server that was `needs-sign-in` at the start but has a stored list is listed, and a call to it is refused with the reason, until it is `ready` again. A server left out because it had no stored list yet is listed as soon as it has one (`list_changed`), and one left out because it was not `ready` can be called as soon as it is.

### 3.9 Audit

The gateway writes one audit entry per `tools/call`. Its home is [./13-security.md](./13-security.md#11-audit). It holds:

- the actor and the session;
- the MCP Server and the tool's original name, both empty when the call named none (an unknown tool name, a missing grant);
- the outcome: answered, refused with a reason, or failed;
- the duration.

It never holds the arguments or the result.

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **While the controller is frozen or sealed, a refused call is not audited** (decided by Rogier, 2026-11-20). The database refuses writes then, so the gateway can write neither the audit entry nor the `runtime.warning` of section 3.6 on the Thread. It writes one line to the controller's log instead: the session, the MCP Server, the tool's original name and the reason. The agent still gets its tool result with `isError: true` and the gate's message. Outside that window every `tools/call` gets its audit entry.

### 3.10 Upstream sessions

Towards servers, the gateway tries `2026-07-28` first and falls back to the older handshake by MCP's versioning rules. It remembers per server what worked.

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* The revisions are tried in the order `2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26`. The next one is tried only when the server shows it does not speak the revision:

- **The modern handshake, `server/discover`, falls back to the older `initialize` handshake whenever the server shows it does not know it.** Servers say so in different ways, and the official TypeScript SDK's does not use MCP's unsupported-version error: it answers a request before `initialize` with HTTP 400 and code -32000 ("Bad Request: Server not initialized"), and a request with a version it does not support with HTTP 400 and code -32000 ("Unsupported protocol version"). So the fallback happens on an HTTP 400, 404 or 405 to `server/discover`, and on a JSON-RPC error to it with the code method not found (-32601), invalid request (-32600), -32000 or MCP's unsupported-version code (-32022).
- **Within the older handshake**, an `initialize` answered with another revision, or with HTTP 400 and the unsupported-version code, tries the next older revision.
- **Nothing else falls back.** A 401, a 403, a 429, an HTTP 5xx, no connection, a connection that closes in the middle of the exchange, and a timeout end the attempt with their own status ([section 5.3](#53-status)), because another revision would not change them.

Effect 4.0.7's `McpClient` speaks only `2025-11-25` and `2026-07-28` and refuses a server that answers an older revision, but Sentry answered `2025-06-18`. Effect's own protocol modules for `2025-06-18` and `2025-03-26` work with the same client, so the gateway passes those to it. A server that speaks none of the four is `error`. An older server can be left with one upstream MCP session from a refused `initialize`, which it ends itself; because the revision that worked is remembered, this happens once per server.

- **Scope.** An upstream MCP session belongs to one Session Token (one harness incarnation) and one server. So a server that keeps state per MCP session never mixes two Threads, and a resume starts with fresh remote state.
- **Opening and closing.** Its first call opens it. Concurrent first calls share one opening. It closes when the token ends, or when the server is switched off, deleted or replaced.
- **A destination that is lost.** Replace, a swap of accounts in a list, switching off and deleting close every upstream MCP session of the server that lost the destination. The next call opens a new one with the new credential. A swap is the user's explicit act in the composer, so a name stays valid: a call goes to the server the list holds when the call is dispatched ([section 3.5](#35-a-call)).
- **A check** uses a short-lived connection of its own.
- **The credential is per request.** Every request upstream carries the credential current when it is sent, and an upstream MCP session survives a credential refresh. If Effect's client fixes its headers when it is built, the gateway gives it a transport that adds the credential per request.
- **An expired upstream MCP session.** When the server answers 404 for an MCP session that has expired, the gateway opens a new upstream session and sends the call once more, because a 404 for an unknown session means the call did not run. Nothing else is ever sent twice when it may have run.
- A stateless server needs nothing kept.
- The gateway keeps no open connection to an outside server and does not listen for its own `list_changed` in v1. A changed list is found by the checks of [section 5.4](#54-when-a-server-is-listed).

### 3.11 Build-time verifications

~~**Verify at build time:** that Effect's MCP server can answer each session its own tool list, and can send `list_changed` to one session only. If it cannot, the gateway writes that part on Effect's protocol modules, as it does for the GET stream ([section 3.2](#32-protocol-revisions-and-what-is-spoken)). [#1208](https://github.com/theagenticage/hercule/issues/1208).~~ *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **Checked: it cannot.** Effect 4.0.7's `McpServer` keeps one tool registry per server. Whether a tool is listed depends only on the client's protocol revision, capabilities and name (its `EnabledWhen` annotation), never on the request or its token, and `notifications/tools/list_changed` goes to every connected client. So the gateway writes its session-facing protocol itself: the JSON-RPC methods of section 3.2, on the message schemas of Effect's `McpSchema`.

**Verify at build time:** that each adapter works on the wire paths the gateway serves, with the real harness: ~~Claude Code on the modern path (`server/discover`, `subscriptions/listen`) and on the older one,~~ Codex and pi on the older one. ~~Claude Code's probe showed that it tries modern discovery first and then falls back. That it works on the modern path, and sees `list_changed` there, is not proven.~~ ~~[#1208](https://github.com/theagenticage/hercule/issues/1208) for Claude Code,~~ [#1209](https://github.com/theagenticage/hercule/issues/1209) for Codex, [#1212](https://github.com/theagenticage/hercule/issues/1212) for pi.

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **Claude Code 2.1.329 is checked: it works on both paths and sees `list_changed` on each.** The test is `http/mcp-claude-code.integration.test.ts`. It starts the real CLI the way the adapter does, against the real gateway through a recording proxy, and asks the CLI what it lists with the `mcp_status` control request, so no login and no real model is involved. It runs on every machine that has a `claude` binary.

- **Modern path.** The CLI sends `server/discover` first (revision `2026-07-28`, with the `Mcp-Method` header), then opens `subscriptions/listen`, and lists with `tools/list`. It never sends `initialize` and no request has an `Mcp-Session-Id`. The listen stream gets its acknowledgement and then the opening `list_changed`. When a server is added to the session's list, `list_changed` goes out on the listen stream, the CLI lists again, and `mcp_status` shows the new tools. A `tools/call` is a plain POST with the revision header.
- **Older path.** Claude Code chooses the modern path by itself whenever the server answers `server/discover`, so the gateway cannot be made to speak the older one to it. The test puts a proxy in front of the gateway that answers `server/discover` the way a server on the official TypeScript SDK does (HTTP 400, JSON-RPC `-32000`). The CLI then falls back at once: `initialize` (revision `2025-11-25`, no session id yet), `notifications/initialized`, the GET stream and `tools/list`, all but the first with the `Mcp-Session-Id` and `Mcp-Protocol-Version: 2025-11-25`. `list_changed` goes out on the GET stream and the CLI lists again.
- **Not checked.** The test does not remove the gateway's per-token state, so it cannot show that a call under a name the restarted controller has not sent is refused as [section 3.4](#34-tool-names) says. It does not check what the CLI does when the stream of the modern path ends, because the gateway has no way to end only that stream.

~~**Verify at build time:** that Effect's MCP client keeps an upstream MCP session across a credential refresh when the credential is supplied per request ([section 3.10](#310-upstream-sessions)). If it cannot, the gateway writes the transport. [#1208](https://github.com/theagenticage/hercule/issues/1208).~~ *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **Checked: it does.** Effect's `McpClient` sends through the HTTP client it is given, so a client that adds the current credential to each request carries a new credential on the same `Mcp-Session-Id`. A probe against a fake server showed two calls on one upstream session with two different tokens. The gateway writes no transport of its own.

**Verify at build time:** that each harness opens a new MCP session after a 404 when the controller restarted, on the older handshake. ~~[#1208](https://github.com/theagenticage/hercule/issues/1208) for Claude Code,~~ [#1209](https://github.com/theagenticage/hercule/issues/1209) for Codex, [#1212](https://github.com/theagenticage/hercule/issues/1212) for pi.

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **Claude Code 2.1.329 opens a new MCP session after a 404, but only when it next sends a POST.** The test makes the gateway forget one MCP session with `DELETE /mcp`, which leaves the gateway as a restart does for that session (its id is unknown, the Session Token still resolves), and the CLI is not told.

- **A stream that gets 404 does not recover alone.** The CLI's GET stream reconnects with the old session id, gets 404, and gives up after two tries. It does not open a new MCP session by itself, so until its next POST it receives no `list_changed`. A Claude Code session that sits idle across a controller restart is not told about a changed list until it next makes a call.
- **A POST that gets 404 does recover.** The next `tools/call` gets 404. The CLI handshakes again (`server/discover`, then `initialize` on the older path), sends the same call once more on the new session, and the call succeeds. In the runs made it opened two or three new MCP sessions in a row, each with its own GET stream, and left the unused ones open: the gateway keeps at most sixteen MCP sessions per token and closes the oldest past that. `list_changed` then reaches the CLI on the new streams.
- **What a real restart adds.** On the new session the CLI sent the repeated call before its first `tools/list`. After a real restart, when the gateway has forgotten the names it sent, that call would be refused once with the "list the tools again" result of [section 3.4](#34-tool-names), and the CLI would then list. This is read from the order of requests, not run.

Facts behind these, from the exploration: [how each harness caches and re-reads a tool list](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-tool-list-changes.md) and [the protocol and the harnesses](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-protocol-and-harnesses.md).

## 4. Which servers a session gets

### 4.1 The lists

Three lists name servers. The fields are in [./02-domain-model.md](./02-domain-model.md).

- **A Project's `mcpServerIds`:** what a new Thread in the project starts with. It is a default only. Changing it never touches Threads that exist.
- **The setting `thread.mcpServerIds`:** what a Thread with no project starts with. Unset or empty means no servers.
- **A Session's `mcpServers`:** the session's own list. Each entry holds the server's id and name, and whether the last start left it out and why ([section 3.8](#38-left-out-at-the-last-start)). Changing a Thread's list never touches its project.

Every session kind has the field. Only a Thread's can be non-empty in v1. An Agent's session, a workflow step and an assistant's session have an empty list until [#222](https://github.com/theagenticage/hercule/issues/222).

A list write is refused `validation` when:

- it holds two servers with the same name (the message names both);
- it names an id that is unknown or was deleted;
- it names one id twice;
- it is `mcpServerIds` on a `session.spawn` with `agentId`, until [#222](https://github.com/theagenticage/hercule/issues/222).

The default list is not rewritten when a server is deleted. It drops ids it does not know when it is read.

### 4.2 Who sets a list

Every list write needs the grant `mcp.manage`, checked inside the operation in addition to the operation's own grant. The writes are:

- `project.create` and `project.update` with `mcpServerIds`;
- `session.spawn` with `mcpServerIds`;
- `session.update` with `mcpServerIds`;
- `settings.update` of `thread.mcpServerIds`, which only the user can call already.

`mcp.manage` is a grant only the user gives, like `skill.write` and `skill.apply`. The `unrestricted` profile leaves it out. A session holds it only when the user put it on the session's profile or approved a Permission Request for it. A session that holds it may write lists like the user, including an explicit list on `session.spawn`. An MCP Server reaches an outside account, and its tool descriptions steer every Thread that has it. The family, the shipped profiles and the migration are in [./13-security.md](./13-security.md#61-grant-families).

### 4.3 What a new session starts with

- **A Thread the user starts:** the spawn's `mcpServerIds` if given. An explicit empty list is kept as empty. Else its project's list. Else the setting `thread.mcpServerIds`. On the Draft Thread the composer shows the list the Thread will start with, and the user changes it there. A Draft Thread sends `mcpServerIds` only when the user changed the list.
- **A Thread a session starts, and a fork a session makes (`session.continue`):** a copy of the calling session's own list, when the call has no `mcpServerIds`. A session that holds `mcp.manage` may give an explicit list ([section 4.2](#42-who-sets-a-list)).
- **A fork the user makes:** a copy of its parent's list.
- **An Agent's session, a workflow step, an assistant's session:** an empty list until #222.

`session.update { mcpServerIds }` works on a queued, running or exited Thread, and not on an archived one. It leaves model selection alone. On a running session the gateway sends `notifications/tools/list_changed` ([section 3.7](#37-list-changes)).

### 4.4 What the harness is given

[./06-providers.md](./06-providers.md#4-harnessadapter) owns `SessionSpec.mcpServers` and the adapters. In short:

- Every session on a runner and harness that support it gets one entry, the gateway's, named `tools`: its runner lists the capability `mcpServers` and its harness declares `mcpPassthrough: "native"`. It gets the entry also with an empty list, so a server added later works without a restart.
- The cost is one idle connection per session to the controller. Codex also shows the model one line about the server.
- A runner without the capability gets a spec without the field. Every server in the session's list is left out with `runner-too-old`, and the Thread says so. A harness without `mcpPassthrough: "native"` leaves every server out with `harness-unsupported`. pi is `unsupported` until [#1212](https://github.com/theagenticage/hercule/issues/1212). *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* Codex is `unsupported` until [#1209](https://github.com/theagenticage/hercule/issues/1209) maps the entry in its adapter ([./06-providers.md](./06-providers.md#4-harnessadapter), decided by Rogier, 2026-11-20).
- Tool search is the harness's own. The gateway offers no search tool.

## 5. Credentials and status

### 5.1 A plugin server's credential

A plugin server is reached with its Connection's credential, fresh: the existing refresh runs 10 minutes before expiry. The plugin's pure `buildUpstreamRequest` turns the credential into the URL and the headers ([./05-plugins.md](./05-plugins.md)).

On an HTTP 401 from the server, before the tool ran, if the token sent is still the stored one, the gateway asks `connections` to refresh now and retries once. If a newer token is already stored, it uses that. It never refreshes on a timeout and never on a tool error. Then:

- **The provider refuses the refresh.** The refresh follows the existing Connection rules ([./05-plugins.md](./05-plugins.md#101-the-setup-flow-contribution)). The Connection is marked `needs-reauth`, and its servers move to `needs-sign-in`. The fix is "Reconnect <Connection>".
- **The provider cannot be reached.** The Connection is left as it is, and the call is refused as `unreachable`, for this call only.
- **There is nothing to refresh.** A pasted credential has no refresh, and neither do OAuth tokens with no refresh token or a Connection type with no refresh endpoint. *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* A 401 then moves the **server** to `error` ("refused the Connection's token") and leaves the **Connection** alone, with no Notification: the Connection's own sign-in may be fine, and the server may refuse for a reason a new sign-in does not cure. This differs from a stale token that cannot be refreshed, which the Connection rules above already mark `needs-reauth`, because there nothing at all is known to work.
- **The Connection changed while its token was being refreshed.** If the user reconnected twice in a row while a refresh and its repeat were in flight, the server is `unreachable` and is checked again with the backoff of [section 5.3](#53-status). The Connection is not marked.
- **The Connection is not `needs-reauth` but holds no credentials** (a Connection of a type with no sign-in flow, whose secrets are gone). The server is `error` ("The Connection <label> holds no credentials"), not `needs-sign-in`, because the Connection does not say it needs signing in.
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
| `unreachable` | No usable answer, and trying again later may cure it: no connection, a connection that closes in the middle of an exchange, a timeout on a check, an HTTP 5xx, or an HTTP 429. Checked again with backoff |
| `error` | The server answers but refuses or fails: a 401 after a working refresh, a protocol error (an answer that is not MCP, or an HTTP 4xx other than 401, 429 and the fallback cases of [section 3.10](#310-upstream-sessions)), a revision the gateway cannot speak, or the plugin switched off |

- A server keeps its last stored tools in every status.
- **Server-wide failures change the status:** no connection, a connection that closes mid-exchange, a timeout on a check, an HTTP 5xx or 429, a 401 after a working refresh, a protocol error and an unsupported revision. A tool result with `isError: true`, a tool-level error, or a 403 on one tool is that call's answer and changes nothing.
- A check's result never overwrites a newer change: switching off, a reconnect, Replace or a delete.
- The remedy for `error` is "Check now" and the detail. It is never "Reconnect".
- A plugin server follows its Connection. A Connection that moves to `needs-reauth` moves its servers to `needs-sign-in`. This reaches `mcp-servers` through the Connection observer ([section 1.3](#13-the-domain-graph)).
- A plugin that is switched off does not serve its servers. They are `error`, with the reason ("The Sentry plugin is switched off"). *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* A plugin that is enabled but failed to start does not serve them either, and the reason says so, because the remedy differs ("The Sentry plugin failed to start: see Settings > Plugins").
- *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **A Connection that is switched off is like a plugin that is switched off** (decided by Rogier, 2026-11-20). Its servers are `error`, with the reason ("The Connection Sentry (work) is switched off"), and they are not served: `tools/list` leaves them out and a call is refused. Switching the Connection on lists the servers again.

The backoff schedule for `unreachable` is an implementer's choice ([./16-open-items.md](./16-open-items.md), class B); [#1208](https://github.com/theagenticage/hercule/issues/1208) states it here.

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **The backoff for `unreachable`:** the server is checked again after 1 minute, then 5 minutes, then 15 minutes, then 1 hour, and then every hour until a check succeeds. A success, a reconnect of its Connection, switching it on and `mcpServer.check` start the schedule over. The daily list of section 5.4 goes on beside it.

### 5.4 When a server is listed

The controller lists a server's tools:

- on creation;
- on switching on;
- when its Connection is reconnected, or its own sign-in is done;
- on `mcpServer.check`;
- once a day for every enabled server.

A list that differs from the stored one triggers `list_changed` for the sessions that have the server ([section 3.7](#37-list-changes)).

### 5.5 Notifications

Entering `needs-sign-in`, `unreachable` or `error` raises one Notification per episode, never for a server that is switched off. An episode ends when the server is `ready` again. A plugin server never raises one for `needs-sign-in`, because its Connection already does. The Notification subject gains MCP Server ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)). *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* The kind is `core.mcp-server-failed`, informational, raised in the transaction that writes the status, with the server as subject. A plugin that is not in this build counts as a plugin that is switched off: the server is `error` with cause `plugin`, and it is checked again when the plugin is back.

### 5.6 Outbound rules

These rules cover every URL the controller follows for a server, sign-in included: discovery, metadata, registration, exchange and refresh.

- A URL is `http` or `https` and holds no user name or password.
- A redirect is not followed with a credential to another origin.
- The URL that a plugin's `buildUpstreamRequest` returns must be on the `origin` the contribution declared.
- Private addresses are allowed. Hercule is single-user on a LAN or tailnet, and only the user adds a URL.

## 6. The plugin servers

Three plugins offer a server in v1. Each is reached with the plugin's Connection, and the plugin's `buildUpstreamRequest` builds the request. The vendor facts are from [the exploration](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-vendor-auth.md).

### 6.1 Sentry

- URL: `https://mcp.sentry.dev/mcp?disable-skills=project-management`. The query drops ~~18~~ 19 tools that the Connection's scopes do not cover, and 55 remain *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* The server does not filter its list by the token's scopes: without the query it lists 74 tools. So the query is what keeps the unusable tools out, and a scope the token lacks would show only when such a tool is called, as that call's own answer.
- Header: `Authorization: Sentry-Bearer <token>`.

~~**Verify at build time:** that `mcp.sentry.dev` accepts a Hercule Sentry Connection's token as `Sentry-Bearer`. This is unproven. A proof call is the first acceptance criterion of [#1208](https://github.com/theagenticage/hercule/issues/1208). If it fails, that slice stops and reports, because it then needs another route to "no second sign-in".~~ *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **Proven on 2026-11-20** ([the proof](https://github.com/theagenticage/hercule/issues/1208#issuecomment-7041913349)). A token from Hercule's Sentry application, made by the Connection's device flow with its six scopes, was accepted as `Sentry-Bearer` (`initialize`, `tools/list` and a `whoami` call all answered 200), and the same token as plain `Bearer` got 401. Sentry answered the older revision `2025-06-18` it was asked for.

Sentry kills the old access token the moment it is refreshed. The gateway never hands a token out, so a refresh cannot break a running session.

### 6.2 Linear

- URL: `https://mcp.linear.app/mcp`.
- Header: `Authorization: Bearer <token>`. A pasted API key works too.

**Verify at build time:** that Linear accepts the Connection's token as `Bearer`. [#1209](https://github.com/theagenticage/hercule/issues/1209).

### 6.3 GitHub

- URL: `https://api.githubcopilot.com/mcp/`.
- Header: `Authorization: Bearer <token>`. `X-MCP-Toolsets` is limited to what the Connection's scopes cover.

**Verify at build time:** that GitHub accepts the Connection's token as `Bearer`, with that `X-MCP-Toolsets`. [#1209](https://github.com/theagenticage/hercule/issues/1209).

**GitHub has no special rule.** A GitHub MCP server is a plugin server like any other, reached with its own Connection. No code compares it with the workspace's account. A Thread whose GitHub server acts as another account than the one its repository pushes as may meet a mismatch, which the agent reports.

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
4. It writes the audit entry. A refused call also gets a tool result with `isError: true` and a `runtime.warning` on the Thread ([section 3.6](#36-a-refused-call)).

### 7.4 A list changes while a Thread runs

1. The user changes the Thread's list, or switches a server on or off, or a daily check finds a new tool list.
2. After the commit, the gateway sends `notifications/tools/list_changed` on the open stream of each session the change touches ([section 3.7](#37-list-changes)).
3. The harness lists again and the gateway answers from the stored lists. A server taken away is already refused at the next call.
4. A Codex Thread without the `mcp_tool_list_changed` feature does not list again. A server added now is usable from the next start.

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
