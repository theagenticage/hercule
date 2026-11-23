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
- a URL server takes the name the user gives, or else the host's first label that is not `mcp`, `www` or `api` (`notion`). *(Amended 2026-11-21, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* That label is lower-cased, each run of other characters than `a-z` and `0-9` becomes one `_`, a `_` at either end is dropped, and it is cut to 16 characters. When the result breaks the name rule (it is empty, or it is `hercule`), `create` is refused `validation` and asks for a name.

Two servers may share a name: work and hobby Sentry are both `sentry`. One list never holds two servers of one name ([section 4.1](#41-the-lists)).

### 2.3 One server per address and account

- **A plugin server:** one per contribution and external account. The account is the Connection's `accountId` ([./08-events-and-connections.md](./08-events-and-connections.md#81-record)), not its id. A second is refused `conflict`, and the message names the existing server.
- **A URL server:** one per normalized URL in v1. A second account at the same URL is refused `conflict`. A normalized URL has the scheme and host in lower case, the default port dropped and a trailing `/` dropped. The path and the query are kept. *(Amended 2026-11-21, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* A bare `?` with nothing after it is no query. The server is stored and called at the address as the URL standard writes it (`https:example.com/mcp` is `https://example.com/mcp`), with its trailing slash kept, because some servers need it, and with two more spellings folded, in the stored address and the key alike: every trailing `.` on the host is dropped (`mcp.sentry.dev.` is `mcp.sentry.dev`), and a percent-escaped unreserved character in the path is decoded (`/%6Dcp` is `/mcp`; RFC 3986 section 6.2.2.2). Repeated slashes are not folded, because a server may tell them apart. ~~A reader of the record sees the address with its query values hidden (below).~~ *(Amended 2026-11-22, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* Decided by Rogier, 2026-11-22: (c). An address is not a secret: it is shown whole in the record to every reader with `mcp.read`, and in the audit entry to every reader with `event.read`, and nothing of it is removed from answers. A key belongs in the token.

  **Open:** two accounts at one URL. The controller cannot know the external account behind a pasted token or a sign-in, so v1 refuses a second server at one URL. [#1218](https://github.com/theagenticage/hercule/issues/1218) decides how; Rogier made it a required follow-up.
- **A URL on a plugin's origin:** adding by URL an address on the `origin` of a plugin's contribution (any URL on `https://mcp.sentry.dev`) is refused `conflict`. The message points at that Connection's row in Settings > MCP servers.

  ~~**Open:** what the refusal points at when the user has no Connection of that plugin, or the plugin is switched off: then there is no row in Settings > MCP servers. Nobody decided it in the grilling. Recommendation: refuse in every case, because the plugin is compiled in and its server is reached with no second sign-in once a Connection exists. With no Connection, the message says to connect the plugin first and points at Settings > Connections. With the plugin switched off, it says so and points at where plugins are switched on. [#1210](https://github.com/theagenticage/hercule/issues/1210) decides.~~ *(Amended 2026-11-21, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* **Decided: refused in every case**, as recommended. Only a contribution the plugin host knows reserves its origin: one whose registration failed does not. The refusal's `details` are `{ reason: "mcp-server-on-plugin-origin", contributionId, connectionId, pluginState }`, with `pluginState` one of `active`, `switched-off` and `failed-to-start`, and `connectionId` a Connection of the contribution's type or `null`. The message says what to do, by what the user has:
  - a plugin that is switched off: switch it on in Settings > Plugins, connect it when there is no Connection, then switch its server on in Settings > MCP servers;
  - a plugin that failed to start: see Settings > Plugins, and once it runs, the same. A client never offers to switch on a plugin that is on;
  - a plugin that runs and a connected Connection of the contribution's type: switch its server on in Settings > MCP servers, or run `hercule mcp-server create --plugin <contribution> --connection <id>`. A connected Connection is preferred over any other;
  - a plugin that runs and only a Connection that needs sign-in, or only a switched-off one: reconnect it, or switch it on, in Settings > Connections first. A Connection in `error`: check it in Settings > Connections. No command is suggested;
  - a plugin that runs and no Connection: connect the plugin in Settings > Connections first.
- **Replace.** When the user switches on a plugin's server and a URL server on that contribution's origin exists, the client offers "Replace". Replace is `mcpServer.update { source: { kind: "plugin", ... } }` on the URL server. The record keeps its id, its name and every list that names it. It moves to the plugin's Connection, and its own sign-in secrets are deleted. When several URL servers sit on the plugin's origin, the Replace dialog lets the user pick one. Replace closes the server's upstream MCP sessions ([section 3.10](#310-upstream-sessions)). *(Amended 2026-11-21, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* The server goes to `checking`, keeps its stored tools until the first check through the Connection ends (section 5.3), forgets the MCP revision it last used, and its revision goes up, so a check that started before cannot write its result. It is one transaction, and `enabled` may come in the same call. Replace is refused `invalid_state` for a server that is a plugin server already, `validation` on `source.contributionId` when the server's address is not on the contribution's origin, and `conflict` (`mcp-server-exists`) when the contribution already has a server for the Connection's account. ([#1210](https://github.com/theagenticage/hercule/issues/1210).)

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
- *(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **A Session Token holds a bounded amount at once.** An agent with a shell can send requests to the gateway directly, so the gateway bounds what one token may hold:
  - **8 `subscriptions/listen` streams** open at the same time. Claude Code opens one, and a few more when subagents connect on their own. The ninth is refused with HTTP 429 and a JSON-RPC error that says the session has 8 streams open, which is the most, and asks the agent to close one or reuse an open one. The bound counts only the `2026-07-28` listen streams. A stateful MCP session has one GET stream, which a new GET replaces, and a token keeps at most 16 MCP sessions.
  - **32 `tools/call` requests** running at the same time, of both eras. A harness runs the calls of one turn side by side, and subagents add a few. The 33rd gets a tool result with `isError: true` that says the session already has 32 calls running, which is the most, and asks the agent to wait for some to finish and call again. Each running call holds an upstream request on the user's credential for up to 45 seconds ([section 3.5](#35-a-call)), and a vendor's rate limit answer would otherwise take the server away from every Thread. *(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* The refused call is a refusal like any other ([section 3.6](#36-a-refused-call)): it gets its audit entry, with the reason `error`, and the Thread gets a `runtime.warning` under the same throttle, once per turn. The warning names no server, because the call is refused before it is read.
  - Neither bound limits a normal harness. Both are checked when the request is admitted, and a request that is refused holds nothing.
- *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **A session running across a promotion keeps the old address until its next start.** The runner binds the gateway's address and the token when a session starts, from the `HERCULE_API_URL` it gives the session ([./06-providers.md](./06-providers.md#4-harnessadapter)). The session's `hercule` CLI reads the same variable, and it does not follow a promotion either: after the seal, A answers its calls with `controller_sealed` and the new address, and the CLI prints that error. So once A seals, a session that started on A reaches only A's gateway: `tools/list` still answers from A's stored lists while A runs, every `tools/call` is refused with A's `controller_sealed` message, and once A stops, the harness cannot reach the gateway at all. The tools work again from the session's next start, a resume included, because the runner, which has followed the forwarding pointer to B, binds B's address then. A proxy on the runner that would let a running session follow the move is a follow-up ticket, not part of v1.
- **An `Mcp-Session-Id` belongs to one token.** An `Mcp-Session-Id` the gateway issues is bound to the Session Token it was created with. A request that names it with any other token gets 404. `DELETE` ends that MCP session only, never the Thread or its token. A resume mints a new token, so the old token's streams end with it.
- *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **What a request names is checked on every message.** A named `Mcp-Session-Id` that this token does not own gets 404, whatever the message is: `initialize` and a JSON-RPC response too. A legacy MCP session keeps the revision it negotiated. A later request of it that names another `MCP-Protocol-Version` is refused with HTTP 400 (the header mismatch error, or the unsupported-version error for a revision the gateway does not offer). A request with no such header is accepted, as the transport specification asks. A `2026-07-28` request must carry `MCP-Protocol-Version`, `Mcp-Method` and, for `tools/call`, `Mcp-Name`, and each must agree with the JSON-RPC payload, as Effect's own transport checks them.
- *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **Who is calling is read after the body.** The route checks the bearer first. The gateway reads the Session Token and the profile's grants again from the database after the body has been read, and that reading serves the request, so a Thread that ended, resumed or lost `mcp.use` while the body arrived is not served by an older reading. The body is counted as it is read and refused with 413 at 1 MiB, with no `Content-Length` needed.
- *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **A stream opens only when its body is read.** The GET stream and `subscriptions/listen` check the phase, the token and the MCP session again at that moment, and a stream that may not open ends with an empty body. A new GET stream of an MCP session replaces the one it had, one at a time. At shutdown the controller closes every stream and refuses new ones before the listener starts to drain, because the listener waits for open responses.
- **The grant.** Every call needs `mcp.use` in the session's profile ([./13-security.md](./13-security.md#61-grant-families)). `mcp.use` alone allows acting through the server's Connection. `connection.use` is not also required, because the user put that server on that Thread.
- **The list.** A call is allowed only for a server in the session's own list ([section 3.5](#35-a-call)).

**A direct call is like the CLI.** The harness is given the Session Token, and so is the agent's shell. An agent can send a call to the gateway with `curl`, and then the harness's approval card is not shown. That command is itself under the Access Mode. So the controller's guard on a call is `mcp.use` plus the session's list. The Access Mode guards the harness's tool calls as for every other tool. The gateway has no approval mechanism of its own.

**Risk:** a call sent directly with the Session Token skips the harness's approval card, as the CLI does. *(Amended 2026-11-21, [#1209](https://github.com/theagenticage/hercule/issues/1209).)* The same holds for code a trusted repository runs through the harness, such as a Codex hook: it inherits the session's environment, so it holds the token. A repository's harness configuration is therefore trusted code, and no check on it is a security boundary ([./06-providers.md](./06-providers.md#102-codex-app-server)).

**Risk:** every tool call passes the controller. A controller that is down takes MCP tools with it, as it does the CLI.

### 3.2 Protocol revisions and what is spoken

Towards sessions, the gateway serves two protocol eras:

- the Streamable HTTP transport of `2025-03-26`, `2025-06-18` and `2025-11-25`: `initialize`, the `Mcp-Session-Id` header, the GET stream and DELETE;
- the stateless `2026-07-28`: `server/discover` and `subscriptions/listen`.

`2024-11-05`, the old two-endpoint HTTP+SSE transport, is not offered. Where Effect's HTTP layer lacks a part, the gateway's route supplies it on Effect's protocol modules. Effect 4.0.7 has no GET stream and answers GET with 405, so the route supplies the GET stream. The era is chosen per client from its first message. No harness capability is needed.

Claude Code 2.1.329 tries modern discovery first and then falls back to the older handshake. Codex and pi use the older one. That Claude Code works on the modern path, and on the older one when `server/discover` is refused, is verified on a developer's machine, not in CI ([section 3.11](#311-build-time-verifications)).

*(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **JSON-RPC batches are refused** with HTTP 400 and a JSON-RPC error that asks for one message per request, in both eras. `2025-03-26` allows batches and `2025-06-18` removed them, but no harness the gateway serves is known to send one, and Effect's own stateless transport does not accept batches either. Supporting them would mean a response that is an array, partial answers, and a call bound that counts the calls of a batch, for no client that uses them. A client that does send one gets the refusal at once, and it is a protocol fault of [section 3.6](#36-a-refused-call).

*(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **Cancelling a call.** A `2025-03-26` to `2025-11-25` client stops a call with `notifications/cancelled`, which names the JSON-RPC id of a call of its MCP session. It stops every running call of that session with that id, because two calls can carry the same id, and the stopped call answers with the "request was cancelled" error. A `2026-07-28` client has no MCP session, and an id means something only inside its own request. It stops a call by closing the HTTP response, which is what the transport specification says, and the gateway ends the call and writes its audit entry as `failed`. So on the stateless path a `notifications/cancelled` is accepted and does nothing, as it does in Effect's own stateless server, and nothing is lost by that. This holds only because the `/mcp` route runs interruptibly: the HTTP server runs a request uninterruptibly and makes only its router's handlers interruptible, and the route sits outside the router, so the route makes itself interruptible. A test hangs up a stateless call while the fake upstream server holds it.

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

- ~~The tool's own name is normalized to `[A-Za-z0-9_]`. Other characters become `_`.~~
- ~~If `mcp__tools__` (12 characters) plus the full name passes 64 characters, the tool part is cut. It ends in `_` plus 6 hex characters of a hash of the original name. 64 is pi's limit. Claude Code drops a tool above 128.~~
- ~~Uniqueness is checked over the whole list a session is sent. Names are given in a fixed order: by server name, then by the tool's original name. A clash gets a suffix, `_` plus 6 hex characters of a hash of the server's name and the original tool name. A second clash leaves the tool out, and the gateway writes that to the controller's log. *(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* It writes one line for each `tools/list` that leaves tools out, with the session and the number of tools, and never the tools' names, because those names come from outside servers.~~
- ~~The gateway maps every name it sends back to the server's name and the original tool name. Within one Session Token, a name the gateway has sent keeps its meaning: a later change to the list never gives it to another tool. Which server of that name it reaches is the one the list holds when the call is dispatched ([section 3.5](#35-a-call)).~~

*(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* **A name is a pure function of the tool it names.** The gateway works it out from the server's name and the tool's original name and from nothing else: not from the other tools of the list, not from an order, not from anything it remembers. So a controller restart cannot change what a name means. **Decided by Rogier, 2026-11-22** ([#1257](https://github.com/theagenticage/hercule/pull/1257)): names are this pure function (option a), not a remembered allocation and not a refusal rule. The upgrade residual below is accepted with its rollout rule: restart the threads that were running at the upgrade.

- **The original name is kept** when all of these hold: it has only the characters `A-Z`, `a-z`, `0-9` and `_`, so a hyphen is not kept (see "Why a hyphen is not kept" below); it does not end in `_` plus six lowercase hex characters; and `<server name>__<tool name>` is at most 52 characters, which is 64 behind `mcp__tools__` (12 characters). 64 is pi's limit. Claude Code drops a tool above 128.
- **Otherwise the name is changed.** Every other character of the original, a hyphen included, becomes `_`, the result is cut so that the whole name fits, and `_` plus the first 6 hex characters of the SHA-256 of the original name is added. A changed name always has that ending, whether or not another tool would clash with it today.
- **A kept name never equals a changed name.** The ending `_` plus six lowercase hex characters belongs to changed names, which is why a tool whose own name ends so is changed too.
- **A name has one server.** A server's name holds no `__` ([section 2.2](#22-names)), so the text before the first `__` of a name is its server's name, whatever the tool's name holds. The gateway does not split a name: it keeps the server's name with the name when it offers it (below).
- **A tool is left out when its name is another tool's name in the same list.** Both tools are left out, decided by the names alone. That needs two tools of one server whose normalized names agree up to the cut and whose hashes agree on 24 bits. A tool that a server lists twice under one original name is one tool, and is offered once. The gateway writes one line to the controller's log for each `tools/list` that leaves tools out, with the session and the number of tools, and never the tools' names, because those names come from outside servers. The Thread is told too, because a tool that silently goes missing is a substitution the user never agreed to: a `runtime.warning` that names the server and how many of its tools are not offered and why, once for each Session Token and server until the set of those tools changes. It names no tool, for the same reason as the log.
- **A tool whose original name is not well-formed Unicode is left out.** An original name that holds a lone surrogate (what `String.prototype.isWellFormed` rejects) is offered in no list and matches in no lookup, because two different lone surrogates hash and normalize to the same text and so would share one name. It is counted with the tools left out for a clash, in the same log line and the same warning to the Thread.
- **A call finds its tool by the name.** The gateway takes the server of the name the call was offered under (below), by that server's name, from the session's list as it is when the call is dispatched ([section 3.5](#35-a-call)), and then the tool of that server whose name, worked out as above, equals the called name, from the tool names the server stores. When no tool has that name, because the tool is gone or because two tools share the name, the call is refused as a call to a tool the server no longer lists. When the tool found is another tool than the one the name was offered for, the call is refused as a call under a name no list offered, with "list the tools again" and `list_changed` (section 3.5, step 1).

Why: until now a name got its meaning from the order in which the tools of a list were named. A tool that clashed with an earlier one got a clash name, so which tool a name reached depended on which tools the list held, and the gateway had to remember what it had sent. A restart wipes that memory. Example: a server lists only `search_pages`, which is sent as `notion__search_pages`, and the harness shows the model that name. The server then adds `search-pages`. When names are given in the order of the original names, `search-pages` takes `notion__search_pages` and `search_pages` gets a clash name, so the harness's call reaches the wrong tool. No rule that tries to spot such a call can be airtight: pi lists the tools again before it sends a call again after a 404, and it runs the calls of one message at the same time, so a late call can arrive after the list. Now `search_pages` is `notion__search_pages`, `search-pages` is `notion__search_pages_f33805` and `search.pages` is `notion__search_pages_52ac82`, in every list and after every restart.

*(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* **Why a hyphen is not kept.** An earlier form of this rule kept `-`, so `search-pages` was `notion__search-pages` beside `notion__search_pages`. The real-binary tests of the twins `search_pages` and `search-pages` (`http/mcp-codex.integration.test.ts`, on Codex 0.169.0 and 0.171.0) showed what that does inside Codex. Codex shows the model `_` for `-`. It gives two tools that then look alike a suffix of its own, worked out from the current list alone, and it gives the plain folded name to whichever of the two is listed alone. It keeps nothing between lists. So when a server went from `search_pages` to `search-pages`, by a swap or by the twin coming and then the first one going, the name the model had already used, `notion__search_pages`, reached the other tool. That happens inside Codex: the gateway only receives the name Codex sends back, and both meanings carry the same name. pi 1.3.0 and 1.6.0 fold `-` in the same way, but they remember which tool owned a name and never move it, so pi refuses the old name. A name is one function for every harness, so `-` can no longer be a kept character. The alphabet of a gateway name is `A-Z`, `a-z`, `0-9` and `_`, which is the alphabet Codex and pi show the model, so no harness folds two gateway names into one and none gives a gateway name a suffix of its own. The tests run these changes of the server's tools with the real Codex (0.169.0, 0.171.0) and the real pi (1.3.0, 1.6.0): a twin added, a twin removed, a twin added and then removed, and one tool swapped for the other, each starting from either tool. In every case the name the model had used runs its own tool while that tool is listed, and is refused once it is not. It never runs the other tool.

What is left: two tools of the same server whose normalized names and 24-bit hashes agree are both left out. Across a change of that server's tools, such a name could then move from one of the two tools to the other, if the server removed one and added the other. That is no more than the server could do by changing a tool, and it concerns that one server only. The tools of another server are never affected. *(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* A call under such a name is refused, though: the record of names offered (below) holds the tool the name was offered for, and a call whose name now resolves to another tool of the server than that one is refused like a name no list offered (section 3.5, step 1). One comparison stops the call from reaching the other tool, without waiting for the client to list again.

Why the suffix is 24 bits and not more. The harness's 64 characters, less `mcp__tools__` (12) and a server name of up to 16 characters with its `__` (18), leave 34 characters for the tool. The suffix takes 7 of them (`_` and six hex characters), and each more hex character cuts one more character off the readable part of the name. A name too long to keep, and without a `-`, is cut and suffixed exactly as before this change (the same cut and the same first six hex characters of the SHA-256 of the original name, taken over its UTF-8 bytes), so a tool whose name is cut and has no `-` is not renamed at the upgrade. A longer suffix would rename every such tool. The odds of a clash, when every tool whose name is changed shares the same cut prefix (the worst case), are 0.12% for 200 such tools in one server, 11% for 2,000 and 95% for 10,000.

The harnesses accept these names, which the real-binary tests check (`http/mcp-claude-code.integration.test.ts`, `http/mcp-codex.integration.test.ts` and `http/mcp-pi.integration.test.ts`): each calls a tool whose name has a hyphen and one whose name has a dot, which the gateway changes to `_` and a hash, beside a tool whose name reads alike, and each call reaches its own upstream tool. Claude Code, Codex and pi show the model the gateway's names as they are. Codex and pi turn every character outside `A-Z`, `a-z`, `0-9` and `_` into `_` and give names that are alike after that a suffix of their own, but a gateway name holds no such character, so no two gateway names are alike to them and neither adds a suffix.

*(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* **pi's fallback name is never used for a gateway tool.** pi 1.x gives one of two tools whose names look alike after it folds a character a fallback name of eight hex characters, without checking that the fallback is free, so a server that also listed a tool named exactly like that fallback could make pi register one of its tools over another. The gateway's names hold no character pi folds, so no two of them look alike to pi and pi never needs the fallback. Codex 0.171 checks its candidates and never had the problem.

*(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* **The Thread shows a changed name in its changed form, until [#1259](https://github.com/theagenticage/hercule/issues/1259).** The runner sees only the name the harness used, so for Claude Code, Codex and pi the Thread shows `notion__search_pages_52ac82` for the tool `search.pages`, while the audit log and the gateway's warnings show the original, `search.pages`. [#1259](https://github.com/theagenticage/hercule/issues/1259) makes the Thread show the tool's own name. The agent folders a crashed pi runner leaves behind are a separate open item, [#1258](https://github.com/theagenticage/hercule/issues/1258) (06 section 10.4).

*(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* **At the upgrade, some names change once.** A tool whose name has a character other than `A-Z`, `a-z`, `0-9` and `_`, a hyphen included, or ends in `_` plus six lowercase hex characters, gets the hash ending once. Main folded `-` into `_` and added no hash, so every hyphenated tool is renamed: `notion__notion_search` becomes `notion__notion_search_042031` for the tool `notion-search`. That is harmless by itself: a harness that learned the old name from the old controller is refused once and lists again, and a Claude Code "allow always" rule on the old name no longer matches the tool, so the user is asked again. The names offered are kept per MCP session (below), which closes most of what a name that moved could do. "What the record does not cover" below says what is left.

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **A call is accepted only under a name this controller process has sent to that Session Token** in a `tools/list` answer. The gateway keeps what it sent in memory only, and a controller restart drops it, while a Session Token survives a restart. ~~Names are worked out from the whole list, so after a restart a new collision could give a name the harness remembers to a different tool than the one it showed. The gateway never works a name out again for a call.~~ A call under a name it has not sent since it started, whether the harness remembers it from before a restart or made it up, gets a tool result with `isError: true` that asks the agent to list the tools again, and `notifications/tools/list_changed` goes to the token's open streams. ~~A name that was sent keeps its meaning, so no name is ever dispatched to a tool other than the one it was sent for.~~ The result and the Thread's warning name the tool the caller wrote only after the name is cut to 64 characters and every character a tool name cannot have is replaced by `?`. *(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* "Sent to that Session Token" reads "offered on the MCP session the call arrives on" (to the token, in the stateless era), as the names offered per MCP session say below. The set of names offered does not decide what a name means: a name means what the rule above says, whether or not a list offered it. The set only proves that the gateway offered the name to this client, so a name the harness made up, or learned before a restart, is refused once and the harness lists again.

*(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* **The names offered are kept per MCP session, each with what it was offered for.** In the stateful era the record is the MCP session's own, and it ends with the session. The stateless era has no MCP session, so there the record is the token's. For each name the record holds what a `tools/list` answer offered it for: the server's id and name and the tool's original name, as `tools/list` named them. Names are only added: a later list does not remove a name, and offers the name again for what it stands for then. The record has no cap: a server that renames its tools at every check adds names until the MCP session or the token ends. The lists are bounded for each server (10,000 tools and 4 MiB, section 3.5), but not across names that came and went, and a cap would have to drop a name that a client may still hold, which turns its next call into a refusal. That was left as it is, and the growth is not a leak that outlives the token.

- **Admission.** A call is accepted only under a name offered on the MCP session it arrives on (to the token, in the stateless era). Else it is refused with "list the tools again", and `list_changed` goes to the token's open streams, as above. A name offered on a stateful MCP session is not accepted in the stateless era of the same token, and a name offered in the stateless era is not accepted on a stateful MCP session, because each keeps its own record.
- **Dispatch uses the session's list as it is then.** The server is the one of the offered server's name in the session's list when the call is dispatched, and the tool is the one of that server whose name, worked out as above, equals the called name, from the tool names the server stores.
- **A refusal decided before the call is sent names what the name was offered for.** This covers a name that no longer resolves: the server left the session's list, or the tool left the server. The Thread's warning (`mcpServers`) and the audit entry take the server's id and the tool's original name from the record, not from a lookup of the servers as they are now. So the refusal names the server the name was offered for, also when that server was deleted and another server of the same name exists, and it keeps the tool's original name when the tool left a server that is still in the list.
- **A refusal decided after dispatch names the server the call was sent to.** This covers a server that is not ready, a call that failed, and the like. That server is the one of that name in the session's list now, which may be another account than the one the name was offered for.
- **No call is refused only because its MCP session is new.** A call that comes after a 404 is judged like any other: it runs when the gateway offered the name on its MCP session, and it is refused once, with a `list_changed`, when it did not. After a 404 the client opens a new MCP session and sends its call again on it. When it lists first, as pi does, the recovery is transparent and the model sees nothing of it. When it sends the call first, as Claude Code and Codex do, the model sees one refusal. pi runs the calls of one model message at the same time and lists again before it resends: both are safe, because each name reaches the tool it stands for, in whatever order the calls and the lists arrive.

Why per MCP session. At the upgrade from the order-based names, a surviving client can hold an old name that now means another tool. Example: an old controller sent `notion__search_pages` for the tool `search-pages`, which the harness remembers. The new controller sends that name for `search_pages`. When another client of the same token lists first, a record kept per token would accept the old client's call, and it would run `search_pages`. Per MCP session, the old client's reopened session must list before it can call, and then it sees the new names.

What the record does not cover.

- **A client that lists again on its own new MCP session before it resends an old call.** pi does this, but pi had no gateway before this change, so it holds no old names.
- **The stateless era.** There the record is the token's, as for Claude Code on its default path, so a call the model chose before a list can arrive after the list.
- **A name that moved to another tool at the upgrade, in a session that outlives the upgrade (below).**

The upgrade residual, stated as it is.

- **Which servers.** Only a server that lists two tools whose names differ only in characters the old scheme changed. There is one exception, in which a name moves between two tools that do not differ only in such characters: a tool whose original name ends in the hash of its sibling. Example: a server lists `search.pages` and `search_pages_52ac82`. The old scheme kept `search_pages_52ac82` as `notion__search_pages_52ac82`. This build gives that name to `search.pages`, whose hash ending it is, and changes `search_pages_52ac82`, because it ends in `_` plus six hex characters. The effects and the fix below are the same. It needs an original name that ends in exactly the six hex characters of another tool's hash, so it is contrived. The old scheme turned every character outside `A-Z`, `a-z`, `0-9` and `_` into `_`, so such tools had the same plain name, and the first in the order of the original names got it. Example: `search-pages` sorts before `search_pages`, so main named `search-pages` `notion__search_pages`. This build gives that name to `search_pages`, the tool whose own name has that spelling, and `search-pages` becomes `notion__search_pages_f33805`. The residual pair therefore stays `search-pages` beside `search_pages`, and one of the two tools must have the plain spelling already. A server with no such pair is not affected: its names either did not change, or only gained a hash, and then the old name is refused (above).
- **Which sessions.** Sessions that started before the upgrade and still run after it, because their harness keeps the names it learned from the old controller. In practice these are sessions on runners other than the controller's own, because the controller's own runner restarts its sessions with the controller.
- **For how long.** For the rest of that session. A new session learns the new names.
- **Effect 1: a call reaches the sibling tool.** The model chose the old name, `notion__search_pages`, for `search-pages`. The gateway refuses it once, because the MCP session has not offered the name yet, and the harness lists again. The model then retries the old name, which is now offered, and the call reaches `search_pages`. This holds for Codex and for Claude Code alike. The model sees one refusal and no sign that the tool is another.
- **Effect 2: a Claude Code "allow always" rule now allows the sibling.** Claude Code suggests the rule, the runner redirects it to the session (`redirectRulesToSession` in `apps/runner/src/harnesses/claude-code.ts`), and Claude Code keeps it in its own process for the life of the session. The rule is keyed by the tool's full name, as Claude Code knows it: `mcp__tools__` plus the gateway's name, for example `{ toolName: "mcp__tools__notion__search_pages" }`, which a real run of Claude Code 2.1.325 showed. A rule granted under the old name for `search-pages` then allows `search_pages` with no approval card. Codex offers no "allow always" for a gateway tool, so it has no such rule.
- **The fix.** Restart such sessions at the upgrade. Nothing in the gateway can tell a call that means the old tool from one that means the new, because both carry the same name.

The cost. A session the gateway dropped itself (the limit of 16 MCP sessions per token) also lists again before its next call. And a client that resends before it lists, as Claude Code and Codex do after a 404, has that call refused once: the refusal sends `list_changed`, the client lists again, and the model sees the refusal and calls again. `http/mcp-claude-code.integration.test.ts` and `http/mcp-codex.integration.test.ts` run this with the real clients.

### 3.5 A call

1. ~~The name must map to a server and a tool the gateway sent to this session, and that server must be in the session's list ([section 3.3](#33-what-a-session-sees)).~~ *(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* The name must be one the gateway offered on the MCP session the call arrives on (to the token, in the stateless era), the server it was offered for, by that server's name, must be in the session's list ([section 3.3](#33-what-a-session-sees)), and the stored tool names of that server must hold a tool whose name is that name ([section 3.4](#34-tool-names)). A call goes to the server that the session's list holds when the call is dispatched. Anything else is refused without contacting a server. *(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* A call under the name of a tool that the server stores no more is refused with the reason `error` and says that the server no longer offers the tool. That refusal comes before the server's status is judged (step 3). *(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* A call is refused too when the tool that the stored tool names give for the name is another tool than the one the name was offered for. Two tools of one server whose names clash by the 24-bit hash can trade a name across a change of the server's tools, and the offer holds what the name was offered for, so one comparison stops the call from reaching the other tool before the client lists again. The refusal is the one for a name no list offered: it asks the agent to list the tools again, and `list_changed` goes to the token's open streams. *(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* ~~The gateway resolves only the name, to a server and a tool, and the membership. Whether the server still lists the tool is decided by the call path, right before it sends the call (step 4).~~ The gateway resolves the name to a server and a tool, and checks the membership. The call path checks the server's list again, right before it sends the call (step 4).
2. The session's profile must hold `mcp.use`.
3. The server must be `ready`. Else the call is refused with the reason. *(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* The gateway does not read the server's status itself. The call path decides it, right before it sends the call (step 4).
4. The gateway takes a fresh credential ([section 5.1](#51-a-plugin-servers-credential)), sends the call upstream ([section 3.10](#310-upstream-sessions)) and returns the server's answer.
5. A call with no answer within 45 seconds is refused as a timeout. The 45 seconds cover the whole call: opening the upstream MCP session, the refresh, the retry and the tool. *(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* The limit was 60 seconds, the same as the time a promotion freeze waits for running work. A call admitted just before a freeze could then run past it and fail the freeze, which uses up the promotion token. The limit is now the freeze's 60 seconds less 15, so every call has ended, or has been refused, before a freeze gives up. A refresh that has started still runs to its own end, up to its own 30-second timeout, and the freeze waits for it as it does for any refresh.

*(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **After the tool's own request went out, no refusal says "try again".** Once the request that carries the call has been sent, the server may have run the tool, whatever happens next. A timeout, a server that cannot be reached, a call that took too long and a broken exchange then all say that the call may have run, and ask the agent to check with the user before it repeats the call. Before that request went out, nothing ran, and "try again later" is right.

Answers have a size cap. Its size is an implementer's choice ([./16-open-items.md](./16-open-items.md), class B); [#1208](https://github.com/theagenticage/hercule/issues/1208) states it here.

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **The cap is 4 MiB per message from a server**: one JSON answer, or one event of an SSE answer. It is large enough for a screenshot in an image block (Sentry's `get_snapshot_image`), and it bounds what one call can hold in the controller's memory. An answer over it is refused as a tool result with `isError: true` ("the answer was larger than 4 MiB"). A tool list is bounded the same way per message, and also by the client's own limits of 100 pages and 10,000 tools; a server's stored tool definitions are refused above 4 MiB in all, which sets the server to `error`. *(Amended 2026-11-21, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* The list is bounded while it is read, not after: the client keeps every page until the last, so the controller counts each page as it arrives, with each tool measured whole as the client keeps it (its `_meta` and `icons` too), and ends the listing at the first page that takes the tools past 4 MiB. The client itself ends it at its 100th page when the server offers another, at its 10,000th tool, or at a cursor it was given twice. The check then ends `error` ("The server's tool list is larger than 4 MiB", or "... has more than 100 pages or 10,000 tools") and keeps the last good list. This holds for every server, so a server added by URL cannot make the controller hold 100 pages of 4 MiB. A tool that no longer fits the protocol's schema once the credential values are removed from it is left out of the stored list, as a tool whose name holds one is.

### 3.6 A refused call

A call is refused when:

- the session's profile lacks the grant;
- the server is not in the session's list;
- the server is not `ready`;
- the sign-in failed;
- the call timed out;
- *(Added 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* the session's token already runs the most calls it may ([section 3.1](#31-the-route-and-who-may-call)). The reason is `error`.

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

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* Each stream is told about a change against the tool list that stream was last told about, not against what some `tools/list` last returned. So one client's `tools/list` never hides a change from another client of the same token. `subscriptions/listen` decodes its parameters with the schema of the `2026-07-28` protocol, refuses invalid ones, and acknowledges and sends only the notifications it asked for that the gateway serves (the tools' `list_changed`). When a server leaves a session's served list, the gateway closes that Session Token's upstream session to it ([section 3.10](#310-upstream-sessions)). *(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* The gateway never waits on an upstream server while it follows changes: stopping the calls of a Session Token that ended and closing upstream sessions run in the background, so a server that answers a DELETE slowly delays no `list_changed`. A token with no open stream is not compared, and its tool lists are not read.

What each harness does with it:

- **A server taken away** stops working at once on every harness, because the call is refused.
- **A server added** is usable at once on Claude Code. On Codex it is usable only with Codex's `mcp_tool_list_changed` feature, and until then from the next start. ~~On pi it waits for [#1212](https://github.com/theagenticage/hercule/issues/1212).~~ *(Amended 2026-11-21, [#1209](https://github.com/theagenticage/hercule/issues/1209).)* On Codex 0.164.0 or newer the adapter turns the feature on, so it is usable at once: from the next turn, or within a turn before the next model request. With Hercule's Codex floor at 0.171.0, that is every Codex. *(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* On pi it is usable at once, with no setting: pi lists again on `list_changed`, and the tool is found by the next `tool_search` (06 §10.3). A pi that sits idle across a controller restart is told only at its next MCP call or its next start, as Claude Code and Codex are ([section 3.11](#311-build-time-verifications)).

~~**Open:** Codex reads a changed tool list only with its `mcp_tool_list_changed` feature, which is under development and off by default. [#1209](https://github.com/theagenticage/hercule/issues/1209) turns it on and finds out whether the config of `thread/start` can set it. If it cannot, #1209 adds a harness capability so the composer can say that a server added now is usable from the next start.~~ *(Amended 2026-11-21, [#1209](https://github.com/theagenticage/hercule/issues/1209).)* **Resolved:** the `config` of `thread/start` sets it, and the Codex adapter turns it on for Codex 0.164.0 or newer, the first release that has it. A Codex thread then lists again like Claude Code, so no harness capability is needed. ~~An older Codex gets one `runtime.warning` at the thread's start, saying that a server added while it runs is usable from its next start.~~ With Hercule's Codex floor raised to 0.171.0 in the same change, every Codex has the feature, and there is no such warning ([./06-providers.md](./06-providers.md#102-codex-app-server)).

### 3.8 Left out at the last start

At every start of a session, the controller records for each server in the session's list whether it can be called at that start and, if not, the `McpServerLeftOutReason` ([./02-domain-model.md](./02-domain-model.md#mcp-server)). A start is the claim and the frame it builds ([section 1.3](#13-the-domain-graph)), so a resume records it too. `leftOut` is written only at a start. An entry added since keeps `null`, and a client reads `null` as "not checked at a start yet". A server is left out when it cannot be called at that start:

| Reason | When |
|---|---|
| `harness-unsupported` | the harness's `mcpPassthrough` is `unsupported` *(Amended 2026-11-21, [#1209](https://github.com/theagenticage/hercule/issues/1209).)* whatever the runner lists |
| `runner-too-old` | the runner lacks the `mcpServers` capability *(Amended 2026-11-21, [#1209](https://github.com/theagenticage/hercule/issues/1209).)* for the session's harness, whose `mcpPassthrough` is `native` ([./03-controller-and-runners.md](./03-controller-and-runners.md)) |
| `missing-grant` | the session's profile lacks `mcp.use` |
| `switched-off` | `enabled` is false |
| `checking` | its first list has not ended |
| `needs-sign-in`, `unreachable`, `error` | its status at the start |

The rows are in the order of precedence. When several reasons apply to one server, the first one in this table is the one recorded. *(Amended 2026-11-21, [#1209](https://github.com/theagenticage/hercule/issues/1209).)* `harness-unsupported` now comes before `runner-too-old`. The runner capability is per harness ([./03-controller-and-runners.md](./03-controller-and-runners.md)), so no runner lists one for a harness that is not `native`. With the old order, pi on a current runner read `runner-too-old`. The same rule decides the warning for a server added to a running session.

*(Amended 2026-11-21, [#1209](https://github.com/theagenticage/hercule/issues/1209).)* ~~A known gap of the mixed upgrade~~: closed by [#1208](https://github.com/theagenticage/hercule/issues/1208)'s record of what each start decided (below). With the per-harness capability, that record is written from the same rule as the start's entry.

The controller writes one `runtime.warning` for the servers left out, with the field `mcpServers` naming each server and its reason ([section 3.6](#36-a-refused-call)).

*(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **A server added to a running session that has no gateway gets a warning at once.** A session that has started (starting, idle or busy) and has no gateway (its runner lacks `mcpServers`, or its harness is not `native`) cannot reach a server added to its list before its next start. When `session.update` adds servers to such a session, the controller writes one `runtime.warning` in the same transaction that names each added server and the reason, `runner-too-old` or `harness-unsupported`, in the words of the start's warning. It records no `leftOut`, which stays a record of starts. A session that is queued is judged at its start, and an exited one at its resume.

*(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **The warning follows what the last start decided.** Each start records whether it gave the harness the gateway entry, and if not, why (`sessions.mcp_gateway`). The warning reads that record, not the runner's capabilities and the harness's declaration as they are now. A session keeps running when the controller restarts, and a new controller build can offer the capability or declare a harness differently, so the answer now can differ from the one the session started with. A runner's own capabilities change only with its binary, and restarting the runner ends its sessions. A session with no record (it started before the record existed) is judged by its runner's capabilities now, and a runner that is gone counts as one that cannot reach MCP servers.

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

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **While the controller is frozen or sealed, a refused call is not audited** (decided by Rogier, 2026-11-20). The database refuses writes then, so the gateway can write neither the audit entry nor the `runtime.warning` of section 3.6 on the Thread. It writes one line to the controller's log instead: the session, the MCP Server, the tool's original name and the reason. The agent still gets its tool result with `isError: true` and the gate's message. Outside that window every `tools/call` gets its audit entry. *(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* A call that fails or is interrupted while the gateway is still deciding it, before it names a server and a tool, is audited as `failed` with both empty. A call refused because its token already runs the most calls it may ([section 3.1](#31-the-route-and-who-may-call)) is audited as refused, with the reason `error` and both empty.

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
- **The credential is per request.** Every request upstream carries the credential current when it is sent, and an upstream MCP session of a plugin server survives a credential refresh. *(Amended 2026-11-22, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* For a URL server a renewed token opens a new upstream session before its next tool call, because the session's later requests carry the token it opened with. If Effect's client fixes its headers when it is built, the gateway gives it a transport that adds the credential per request.
- **An expired upstream MCP session.** When the server answers 404 for an MCP session that has expired, the gateway opens a new upstream session and sends the call once more, because a 404 for an unknown session means the call did not run. Nothing else is ever sent twice when it may have run.
- A stateless server needs nothing kept.
- The gateway keeps no open connection to an outside server and does not listen for its own `list_changed` in v1. A changed list is found by the checks of [section 5.4](#54-when-a-server-is-listed).

### 3.11 Build-time verifications

~~**Verify at build time:** that Effect's MCP server can answer each session its own tool list, and can send `list_changed` to one session only. If it cannot, the gateway writes that part on Effect's protocol modules, as it does for the GET stream ([section 3.2](#32-protocol-revisions-and-what-is-spoken)). [#1208](https://github.com/theagenticage/hercule/issues/1208).~~ *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **Checked: it cannot.** Effect 4.0.7's `McpServer` keeps one tool registry per server. Whether a tool is listed depends only on the client's protocol revision, capabilities and name (its `EnabledWhen` annotation), never on the request or its token, and `notifications/tools/list_changed` goes to every connected client. So the gateway writes its session-facing protocol itself: the JSON-RPC methods of section 3.2, on the message schemas of Effect's `McpSchema`.

**Verify at build time:** that each adapter works on the wire paths the gateway serves, with the real harness: ~~Claude Code on the modern path (`server/discover`, `subscriptions/listen`) and on the older one,~~ Codex and pi on the older one. ~~Claude Code's probe showed that it tries modern discovery first and then falls back. That it works on the modern path, and sees `list_changed` there, is not proven.~~ ~~[#1208](https://github.com/theagenticage/hercule/issues/1208) for Claude Code,~~ [#1209](https://github.com/theagenticage/hercule/issues/1209) for Codex, ~~[#1212](https://github.com/theagenticage/hercule/issues/1212) for pi.~~ *(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* pi is checked on 1.6.0 and 1.3.0: the paragraph below.

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **Claude Code 2.1.329 is checked: it works on both paths and sees `list_changed` on each.** The test is `http/mcp-claude-code.integration.test.ts`. It starts the real CLI the way the adapter does, against the real gateway through a recording proxy, and asks the CLI what it lists with the `mcp_status` control request, so no login and no real model is involved. *(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* It runs where a `claude` binary is installed and is skipped where there is none. No CI job installs one, so CI does not run it, and "verified" here means verified on a developer's machine with CLI 2.1.329; a different CLI version is not checked until someone runs the test with it. The CLI gets the adapter's own `mcpServers` entry (`buildMcpServerEntries`, with the token in `HERCULE_TOKEN`). The test differs from production in two places, each commented where it is set: it allows the gateway's tools with `--allowedTools` (production asks the user through `canUseTool`, and nobody answers here), and it sets `ENABLE_TOOL_SEARCH=false` (otherwise the CLI sends the gateway's tools as deferred names, and the stand-in model, which cannot search, never sees a tool to call).

- **Modern path.** The CLI sends `server/discover` first (revision `2026-07-28`, with the `Mcp-Method` header), then opens `subscriptions/listen`, and lists with `tools/list`. It never sends `initialize` and no request has an `Mcp-Session-Id`. The listen stream gets its acknowledgement and then the opening `list_changed`. When a server is added to the session's list, `list_changed` goes out on the listen stream, the CLI lists again, and `mcp_status` shows the new tools. A `tools/call` is a plain POST with the revision header.
- **Older path.** Claude Code chooses the modern path by itself whenever the server answers `server/discover`, so the gateway cannot be made to speak the older one to it. The test puts a proxy in front of the gateway that answers `server/discover` the way a server on the official TypeScript SDK does (HTTP 400, JSON-RPC `-32000`). The CLI then falls back at once: `initialize` (revision `2025-11-25`, no session id yet), `notifications/initialized`, the GET stream and `tools/list`, all but the first with the `Mcp-Session-Id` and `Mcp-Protocol-Version: 2025-11-25`. `list_changed` goes out on the GET stream and the CLI lists again.
- **Not checked.** The test does not remove the gateway's per-token state, so it cannot show that a call under a name the restarted controller has not sent is refused as [section 3.4](#34-tool-names) says; the live run of 2026-11-20 below passed a real restart, but did not record that refusal. It does not check what the CLI does when the stream of the modern path ends, because the gateway has no way to end only that stream.

*(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **The Session Token's handling is checked in the same way, and has the same limit.** The test is "the MCP Gateway's token in a real Claude Code session" in `apps/runner/src/harnesses/claude-code.integration.test.ts`. It starts the real CLI through the adapter with a made-up token in `HERCULE_TOKEN`, and checks that the gateway receives the token as the bearer and that no file under the session's folders holds it, the SDK's debug file included. It is skipped where there is no `claude` binary, and no CI job has one, so CI does not run it. "Verified" for the token means verified on a developer's machine, with the CLI version run there.

~~**Verify at build time:** that Effect's MCP client keeps an upstream MCP session across a credential refresh when the credential is supplied per request ([section 3.10](#310-upstream-sessions)). If it cannot, the gateway writes the transport. [#1208](https://github.com/theagenticage/hercule/issues/1208).~~ *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **Checked: it does.** Effect's `McpClient` sends through the HTTP client it is given, so a client that adds the current credential to each request carries a new credential on the same `Mcp-Session-Id`. A probe against a fake server showed two calls on one upstream session with two different tokens. The gateway writes no transport of its own.

**Verify at build time:** that each harness opens a new MCP session after a 404 when the controller restarted, on the older handshake. ~~[#1208](https://github.com/theagenticage/hercule/issues/1208) for Claude Code,~~ [#1209](https://github.com/theagenticage/hercule/issues/1209) for Codex, ~~[#1212](https://github.com/theagenticage/hercule/issues/1212) for pi.~~ *(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* pi is checked on 1.6.0 and 1.3.0: it opens a new MCP session after a 404, and sends the call again after a list (the pi paragraph below).

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **Claude Code 2.1.329 opens a new MCP session after a 404, but only when it next sends a POST.** The test makes the gateway forget one MCP session with `DELETE /mcp`, which leaves the gateway as a restart does for that session (its id is unknown, the Session Token still resolves), and the CLI is not told.

What the test asserts (`http/mcp-claude-code.integration.test.ts`, on a machine with a `claude` binary):

- **A POST that gets 404 does recover.** After the `DELETE`, the next `tools/call` gets 404. The CLI handshakes again (`server/discover`, then `initialize` on the older path), sends the same call once more on a new MCP session, ~~and the call succeeds.~~ *(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* The CLI sends the call again on the new MCP session before it lists, and the gateway has offered no name on that session ([section 3.4](#34-tool-names)), so the resent call is refused once with "list the tools again". The model sees that refusal. The refusal sends `list_changed`, the CLI lists on its new session, and the next call runs. The test asserts the 404, the new session, the refused call, the list and the call that runs.

What was observed in the original runs, and the test does not assert:

- **A stream that gets 404 does not recover alone.** The CLI's GET stream reconnects with the old session id, gets 404, and gives up after two tries. It does not open a new MCP session by itself, so until its next POST it receives no `list_changed`. A Claude Code session that sits idle across a controller restart is not told about a changed list until it next makes a call. This was seen on the older path, which the test forces with a proxy.
- **Extra sessions.** The CLI opened two or three new MCP sessions in a row, each with its own GET stream, and left the unused ones open: the gateway keeps at most sixteen MCP sessions per token and closes the oldest past that. `list_changed` then reached the CLI on the new streams.
- **Order after a restart.** On the new session the CLI sent the repeated call before its first `tools/list`. ~~After a real restart, when the gateway has forgotten the names it sent, that call would be refused once with the "list the tools again" result of [section 3.4](#34-tool-names), and the CLI would then list. This is read from the order of requests, not run.~~ *(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* The gateway offered no name on the new MCP session, after a real restart as after the `DELETE` of the test, so that call is refused once with the "list the tools again" result of [section 3.4](#34-tool-names), and the CLI then lists. The test runs this.

*(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **Live run of 2026-11-20: the real Claude Code 2.1.329, the real Sentry server and a real controller restart.** It passed:

- On the controller's runner and on a remote runner, a Thread listed Sentry's tools and called `whoami`.
- A server added to a running Thread was usable without a restart of the Thread.
- A server taken away from a running Thread was refused at once, with a line on the Thread.
- A server left out when the Thread started was recorded, and the Thread was warned.
- After a real restart of the controller, the running Thread's next call worked.

The live run checked that the call after the restart worked. It did not record the order of the CLI's requests, so the idle stream and the order after a restart above stay observations of the original runs.

*(Amended 2026-11-21, [#1209](https://github.com/theagenticage/hercule/issues/1209).)* **Codex 0.169.0 and 0.171.0 are checked on the older path.** Two tests run the real binary with no login and a local stand-in for the Responses API, and are skipped where no `codex` is installed, so CI does not run them:

- `http/mcp-codex.integration.test.ts` starts `codex app-server --strict-config` with the adapter's own `buildMcpServerConfig`, against the real gateway through the recording proxy.
- `harnesses/codex/adapter-mcp.integration.test.ts` drives the adapter's own `startSession` against a fake MCP server. It covers the approvals per Access Mode, the item and its result, the start, resume and fork `config`, a repository that configures the gateway's name (a fresh Harness Home included), images in a result and the token on disk.
- Neither file runs in CI, because no CI job installs Codex. They pass on Codex 0.171.0, Hercule's floor, on a developer's machine; before the floor was raised they also passed on 0.154.0 and 0.169.0.

What the tests assert:

- **The older path.** Codex sends `initialize` at revision `2025-06-18`, then `notifications/initialized`, opens the GET stream and lists with `tools/list`. It never sends `server/discover`. The model sees one namespace tool `mcp__tools` holding `<server>__<tool>`, and a call reaches the outside server once.
- **A server added to a running thread** with its list empty at the start: `list_changed` goes out on the GET stream, Codex lists again before its next model request, and the new tool's call reaches the outside server once.
- **A server taken away.** With `list_changed` held back by the proxy, so that Codex still holds the old name, a call to the removed tool reaches the gateway, Codex reports it `failed`, and the outside server gets no call.
- **A 404 for a forgotten MCP session** (`DELETE /mcp`, as for Claude Code): the next `tools/call` gets 404. Codex opens a new MCP session (`initialize`) and sends the same call again on it before any `tools/list`, ~~and the call succeeds.~~ *(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* The gateway has offered no name on the new MCP session, so that call is refused once with "list the tools again": Codex reports it `failed`, and it never reaches the server. The refusal sends `list_changed`, Codex lists again, and the next call runs and completes.
- **Resume and fork** are asserted by the adapter's file: each carries the same `config`, and the new app-server process connects (06 §10.2: without it, nothing connects).
- **300 tools** are offered either directly in the `mcp__tools` namespace or behind tool search, as the model's data decides (0.154.0 deferred them; 0.169.0 and 0.171.0 offered them directly here). One reader of the model request covers both shapes, and where they are deferred the stand-in searches and calls a returned tool.

What was observed in probes, and no test asserts:

- **A GET stream that gets 404** retries with a growing wait (about 1, 3, 7 and 15 seconds) and never opens a new MCP session by itself. As with Claude Code, an idle Codex thread is told about a changed list after a restart only once it next sends a call.
- **A server taken away, with `list_changed` delivered:** Codex lists again at once and refuses the removed tool itself, so the call never reaches the gateway.
- **A graceful stop** sends `DELETE` for the MCP session.

**Not checked by a test: a real cold gateway.** The test controller cannot restart over one database, so the call that follows a restart is not tested. That call is sent before any `tools/list`, ~~so the gateway, which has forgotten the names it sent, refuses it once with "list the tools again" ([section 3.4](#34-tool-names)).~~ *(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* so the gateway, which has offered no name to the token since it started, refuses it once with "list the tools again" ([section 3.4](#34-tool-names)). That refusal is what the model sees after a real restart. It also sends `list_changed`, which reaches Codex's new GET stream, and Codex lists again before its next model request. This is reasoned from the order of requests above, and #1209's live sitting checks it with a real restart. *(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* The 404 test now runs the same refusal and the list that follows with the real Codex, on a new MCP session. What no test runs is a real controller restart.

*(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* **pi 1.6.0 and 1.3.0 are checked on the older path.** 06 §10.3 holds the full account: the launch, the registration, what pi sends, and what it shows the model. What the gateway needs to know:

- **The older path.** pi sends `initialize` at revision `2025-11-25` with no session id, then `notifications/initialized`, opens the GET stream and sends `tools/list` with no parameters at the same time. It never sends `server/discover`. It sends the `Authorization` header it was given on every request, `DELETE` included. It accepts an answer at `2025-11-25`, `2025-06-18`, `2025-03-26` or `2024-11-05`, and fails on `2026-07-28`. Both a JSON answer and an event-stream answer to a POST work, and a notification must be answered 202.
- **A server added to a running pi.** pi lists again on `list_changed` from the GET stream, or from the event stream of a `tools/call` answer. The next `tool_search` then finds the tool and pi can call it, with no restart. This was run with a stand-in MCP server on both pi versions, and against the real gateway by `http/mcp-pi.integration.test.ts`, which passes on both versions: the new tool is found and called once.
- **A server taken away.** With `list_changed` delivered, pi drops the tool from its own list and refuses the call itself, so the call never reaches the gateway. Without it, the call goes to the gateway, which refuses it ([section 3.4](#34-tool-names)).
- **A 404 for a forgotten MCP session.** The next `tools/call` gets 404. pi sends `initialize`, `notifications/initialized`, opens a new GET stream, sends `tools/list`, and then sends the same `tools/call` again on the new MCP session. The model sees no error. The call comes after a list on the new MCP session, so the gateway has offered the name on that session, and the name stands for its tool ([section 3.4](#34-tool-names)): the resent call runs and reaches the tool it named. This is the transparent recovery, and the model sees nothing of it. `http/mcp-pi.integration.test.ts` runs it against the real gateway on both versions. The test asserts: the 404 for the old `Mcp-Session-Id`; an `initialize` that opens a new MCP session; a `tools/list` on that session after the `initialize` and before the call is sent again; the call sent again on the new session, which reaches the same upstream tool; and that no tool result the model reads is a refusal. It does not assert `notifications/initialized` or the new GET stream, which the probes above saw. The test drops the MCP session at the gateway; it does not restart the controller. A real restart left pi in the same place in the live run of 2026-11-22 (pi kept running, got 404, opened a new MCP session and sent the call again), but that run was made before names stopped moving, under the rule that refused the resent call once, so it does not show the call running after a real restart.
- **A GET stream that gets 404** is tried once and not retried, and pi does not open a new MCP session by itself. As with Claude Code and Codex, an idle pi is told about a changed list after a restart only once it next sends a call, or starts again.
- **A GET stream that gets 405** is tried once and never again, and pi works without it. A 429 makes pi retry with a growing wait (1, 2, 4, 8 and 16 seconds, six tries in all), silently, and without delaying a list or a call.
- **A 401** is never followed by a sign-in, whatever `WWW-Authenticate` says: pi sends no request to `/.well-known/...`, because it was given an `Authorization` header. At start it marks the server failed, and a 401 on a later call comes back to the model as the text `MCP server requires authentication`.
- **The tools of a server that fails at start** are not found for the rest of the pi process. pi tries `initialize` three times, and does not try again until the user sends `/mcp reconnect tools`.
- **The names.** A gateway name reaches the model as `mcp__tools__<name>`, and pi sends the original name back. pi turns each character outside letters, digits and `_` into `_` in the name the model sees, and gives names that are alike after that a suffix of its own. A gateway name holds only letters, digits and `_`, so pi shows it as it is and adds no suffix. The gateway keeps every name within 64 characters together with the `mcp__tools__` prefix, so pi has no gateway name to cut. pi's own fallback for names that look alike could shorten a name to fit its suffix, which never arises for gateway names. The long-name test (`http/mcp-pi.integration.test.ts`) checks only this: the model sees at most 64 characters, and the right upstream tool is called with its full original name.

The two tests are `http/mcp-pi.integration.test.ts` and `harnesses/pi/adapter-mcp.integration.test.ts`, with the real pi, no login and a local stand-in for the model. They are skipped without a pi binary (`HERCULE_PI_TEST_BINARY`), and no CI job runs them. Both pass on pi 1.3.0, Hercule's floor, and on 1.6.0, five repeated runs each, with the same behaviour and the same request sequences on both versions. ~~The runs used no real model, so they do not show that a real model finds a gateway tool with `tool_search` and calls it. That is not checked yet.~~ *(Amended 2026-11-23, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* **Checked with a real model on 2026-11-23** in a live run with Rogier's Z.ai key: the real compiled Hercule on main `df0e8139d`, a controller with its runner and a second runner joined over loopback, both on pi 1.3.0, model `glm-5.3`, Access Mode `approval-required`, two MCP servers started for the run. On each runner the model used `tool_search`, found `alpha`'s ping tool and called it; the approval card was shown and allowed, and the call reached `alpha/pingalpha`. With a second server added to the running Thread, the model found and called `beta__ping_hyphen_b71335` and `beta__ping_dot_c515d1`, which reached `beta/ping-hyphen` and `beta/ping.dot`, without a restart of pi. After a real controller restart, with the Thread's pi on the second runner still running, its next call reached `alpha/pingalpha` with no refusal. The same run on pi 1.6.0 was not done with a real model. The details are in [./06-providers.md](./06-providers.md#103-pi-standalone-binary-rpc-mode).

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

- Every session on a runner and harness that support it gets one entry, the gateway's, named `tools`: its runner lists the capability `mcpServers` *(Amended 2026-11-21, [#1209](https://github.com/theagenticage/hercule/issues/1209).)* for that harness (`mcpServers:<qualified harness id>`, [./03-controller-and-runners.md](./03-controller-and-runners.md)) and its harness declares `mcpPassthrough: "native"`. It gets the entry also with an empty list, so a server added later works without a restart.
- The cost is one idle connection per session to the controller. Codex also shows the model one line about the server.
- A runner without the capability gets a spec without the field. Every server in the session's list is left out with `runner-too-old`, and the Thread says so. A harness without `mcpPassthrough: "native"` leaves every server out with `harness-unsupported`. ~~pi is `unsupported` until [#1212](https://github.com/theagenticage/hercule/issues/1212).~~ *(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* pi is `native`: Hercule's extension registers the entry with pi's built-in MCP client ([./06-providers.md](./06-providers.md#103-pi-standalone-binary-rpc-mode)). *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* ~~Codex is `unsupported` until [#1209](https://github.com/theagenticage/hercule/issues/1209) maps the entry in its adapter ([./06-providers.md](./06-providers.md#4-harnessadapter), decided by Rogier, 2026-11-20).~~ *(Amended 2026-11-21, [#1209](https://github.com/theagenticage/hercule/issues/1209).)* Codex is `native`: its adapter puts the entry in the `config` of `thread/start`, `thread/resume` and `thread/fork` ([./06-providers.md](./06-providers.md#102-codex-app-server)).
- Tool search is the harness's own. The gateway offers no search tool.

## 5. Credentials and status

### 5.1 A plugin server's credential

A plugin server is reached with its Connection's credential, fresh: the existing refresh runs 10 minutes before expiry. *(Amended 2026-11-22, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* The margin is the smaller of 10 minutes and half the token's lifetime (section 5.2), for a Connection too. The plugin's pure `buildUpstreamRequest` turns the credential into the URL and the headers ([./05-plugins.md](./05-plugins.md)).

*(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **Only secrets are removed from what a server sends back.** A server may echo its request in an error, a result or a tool definition. The gateway removes from every answer and every stored tool definition the values of the Connection's fields that its type marks `secret` ([./05-plugins.md](./05-plugins.md#101-the-setup-flow-contribution)), and the OAuth access token, which is always a secret. It removes them at any length, so a short token is removed too. It removes no other value: a field that only names something, such as Sentry's organization slug, stays readable, because the agent needs it to call the server's tools. The headers `buildUpstreamRequest` builds are not removed as a whole, only the secret values inside them. A tool whose name holds a secret value is left out of the stored list.

On an HTTP 401 from the server, before the tool ran, if the token sent is still the stored one, the gateway asks `connections` to refresh now and retries once. If a newer token is already stored, it uses that. It never refreshes on a timeout and never on a tool error. Then:

- **The provider refuses the refresh.** The refresh follows the existing Connection rules ([./05-plugins.md](./05-plugins.md#101-the-setup-flow-contribution)). The Connection is marked `needs-reauth`, and its servers move to `needs-sign-in`. The fix is "Reconnect <Connection>".
- **The provider cannot be reached.** The Connection is left as it is, and the call is refused as `unreachable`, for this call only.
- **There is nothing to refresh.** A pasted credential has no refresh, and neither do OAuth tokens with no refresh token or a Connection type with no refresh endpoint. *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* A 401 then moves the **server** to `error` ("refused the Connection's token") and leaves the **Connection** alone, with no Notification: the Connection's own sign-in may be fine, and the server may refuse for a reason a new sign-in does not cure. This differs from a stale token that cannot be refreshed, which the Connection rules above already mark `needs-reauth`, because there nothing at all is known to work.
- **The Connection changed while its token was being refreshed.** If the user reconnected twice in a row while a refresh and its repeat were in flight, the server is `unreachable` and is checked again with the backoff of [section 5.3](#53-status). The Connection is not marked.
- **The Connection is not `needs-reauth` but holds no credentials** (a Connection of a type with no sign-in flow, whose secrets are gone). The server is `error` ("The Connection <label> holds no credentials"), not `needs-sign-in`, because the Connection does not say it needs signing in.
- **The refresh works and the server still refuses the fresh token.** The MCP Server goes to `error`, with the reason ("Sentry's MCP server refused the Connection's token"). The Connection is left alone. Reconnecting gives a token of the same kind, and marking the Connection would stop the Inbox polls for nothing.

### 5.2 A URL server's sign-in

A URL server keeps its own sign-in: none, a pasted token, or OAuth tokens. It is stored as secrets owned by the MCP Server. Their owner kind in the secrets table is `mcp-server`, and the generic `secret.set` and `secret.delete` refuse it ([./13-security.md](./13-security.md#2-secrets-at-rest)). It is not a Connection.

*(Amended 2026-11-21, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* **What is built, and how it reads:**

- **No sign-in.** A server added with no token is called with no `Authorization` header.
- **A pasted token** is sent as `Authorization: Bearer <token>`, to the server's own origin only. It is given on `mcpServer.create` (`source.token`) or with `mcpServer.setToken`. ~~It must be an RFC 6750 bearer token of at least 8 characters (letters, digits and `-._~+/`, then `=` padding), pasted without `Bearer ` and without spaces.~~ *(Amended 2026-11-22, [#1210](https://github.com/theagenticage/hercule/issues/1210), found in the live sign-in against Notion.)* It must be at least 8 printable ASCII characters with no space, and not a part of the `[removed]` marker, pasted without `Bearer `. The same rule applies to an access token an OAuth sign-in brings. RFC 6750's `b64token` is not required, because Notion's access tokens hold a `:`. The shortest token the rule allows cannot be a part of the marker that replaces a secret in an answer, and a token with spaces could be trimmed in the header while the scrubber looks for it untrimmed. Like a Connection's secret fields, it is removed from every answer and stored tool definition ([section 5.1](#51-a-plugin-servers-credential)). `create` with a token and `setToken` are operations that carry a secret, so a Permission Request never keeps their input ([./13-security.md](./13-security.md)).
- *(Amended 2026-11-21, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* ~~**A secret in the address's query.** Some servers take a key in the query (`https://mcp.x.com/mcp?api_key=K`). The record shows the address with the value of every query parameter hidden (`?api_key=…`), to every reader, and a query value that looks like a key is removed from every answer, as a token is: one that passes the token's own rule (an RFC 6750 bearer token of at least 8 characters). Other values (`true`, `1`, `docs`, `object`) are only hidden in the record, because they occur in ordinary answers and tool schemas, and removing them would corrupt both. A bare query key with no `=` (`?KEY`) counts as a value. A key in the path is not hidden; a key belongs in the token. The stored address keeps it, because requests go there. A key belongs in the token; the CLI's help says so. This is the recommendation the implementer built while Rogier was asked, and one function (`addresses.ts`) decides it.~~ *(Amended 2026-11-22, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* Decided by Rogier, 2026-11-22: (c). An address is not a secret: it is shown whole in the record to every reader with `mcp.read`, and in the audit entry to every reader with `event.read`, and nothing of it is removed from answers. A key belongs in the token. Some servers take a key in the query (`https://mcp.x.com/mcp?api_key=K`). The record shows it as it is stored, and a query value is removed from no answer and no tool list, because only the token is a secret. The CLI's help says to put no secret in the address and to give the token with `--token-stdin`. A user name or a password in the address is still refused: an HTTP client sends it as credentials of its own, which is a different thing from a query.
- **A refused credential.** A 401 to a URL server, with no sign-in or with a pasted token, moves it to `needs-sign-in`, with a detail that says to paste a token or sign in, in Settings > MCP servers. The record's `source.signInOffered` says what the server's 401 asked for: `oauth` when it was a `Bearer` challenge with a `resource_metadata` parameter, `token` otherwise, and `null` before any 401. A check and a call both record it, and a change of it alone is announced on the `mcpServer` topic. A client reads it to offer the token field or the browser sign-in.
- **A new sign-in** (`setToken`, a finished OAuth sign-in, Replace) raises the server's revision, so a check that started before cannot write its result and the upstream MCP sessions opened with the old sign-in are closed. On an upstream MCP session, a request that continues an exchange, or the DELETE that ends the session, carries the stored token only when it is the token the session opened with. So a new sign-in never puts its token on an old session, and a change that leaves the token as it is, such as switching the server off or "Check now", still ends the session with it. Every request of a check carries the token stored when it is sent, and a check whose server changed since it started (its revision or what it depends on) sends no further request: its result is discarded.

Its OAuth tokens are refreshed one at a time, by the refresh code `connections` has. That code moves below both domains and is shared. A failed refresh, or a 401 after a refresh, moves the server to `needs-sign-in`. Only a URL server can be in `needs-sign-in` on its own account. [#1210](https://github.com/theagenticage/hercule/issues/1210) builds this.

*(Amended 2026-11-22, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* **The OAuth sign-in, as built.**

- **The refresh code below both domains** is the leaf `apps/controller/src/oauth/`: the token requests (with `resource`, RFC 8707, and the client's auth method), one refresh permit per key, and `renewTokenSet`, which runs the refresh and the guarded write of its answer together. Connections and MCP Servers each keep their own reading, write guard and status rules.
- **What "a failed refresh" means.** A refresh the provider refuses moves the server to `needs-sign-in`, from a check and from a call alike. A token endpoint that cannot be reached is the rule section 5.1 gives a plugin server, because a new sign-in would not cure it: a check makes the server `unreachable`, and a call is refused as `unreachable` for that call only, leaving the server's status as it was.
- **A token is renewed** when the time it has left is under the smaller of 10 minutes and half its lifetime, so a provider with short-lived tokens is not asked again at once.
- **Discovery** follows RFC 9728 and RFC 8414: the `resource_metadata` of the server's `Bearer` challenge, else the well-known address; the metadata's `resource` must be exactly the address it was found for; the first authorization server listed; its `issuer` must match; S256 is required. No OAuth metadata at all, no S256, or a registration the authorization server refuses: `sign-in-unsupported` (paste a token instead). Metadata that breaks the rules, or a server that cannot be reached: `source-unreadable`.
- **The client** is registered by Dynamic Client Registration with the one redirect URI `http://127.0.0.1/callback` (any port is accepted on loopback, as the live test showed), as a public client. A sign-in reuses the client stored with the server when the issuer, the authorization endpoint and the token endpoint are the same, its secret has not expired (`client_secret_expires_at`), and the authorization server has not refused it (`invalid_client`, from the authorization page, the exchange or a refresh); otherwise it registers again. A client registered by a start that has not committed yet is kept in memory and reused by the next start, so repeated starts do not register a client each.
- **An attempt** lives in the controller's memory for 10 minutes, one per server: a newer start replaces it, and a controller restart means starting again. It holds the PKCE verifier, `state`, the issuer, the resource and the redirect URI. A finish claims it once, checks its deadline, and commits only if it is still the server's current attempt and no token paste, Replace or other sign-in came between (`sign_in_generation`).
- **`iss` follows RFC 9207**: required and compared when the authorization server advertises it; when it does not, an answer without `iss` is accepted, and an `iss` that is present is always compared.
- **What is stored:** one secret of the server, `oauth`, holding the issuer, the endpoints, the resource, the scope, the client and the tokens together, written only when a sign-in commits. A refresh uses only that stored set.
- **Outbound rules for every OAuth address** (section 5.6 applies): every endpoint is https, except one on the same host as an http MCP server; no redirect is followed; every answer is read with a size bound; no text the provider sent reaches a message, only a standard RFC 6749 error code.

~~**Open:** which OAuth client registration a URL server uses: a Client ID Metadata Document, Dynamic Client Registration, or a pre-registered client. [#1210](https://github.com/theagenticage/hercule/issues/1210).~~ *(Amended 2026-11-21, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* **Decided by Rogier, 2026-11-21: Dynamic Client Registration**, which needs no setup and was proven on Notion and Linear in the live test ([#1210](https://github.com/theagenticage/hercule/issues/1210#issuecomment-7060458159)). A Client ID Metadata Document on hercule.sh is the follow-up [#1242](https://github.com/theagenticage/hercule/issues/1242), decided together with the return page of [#1206](https://github.com/theagenticage/hercule/issues/1206), before DCR is removed (no earlier than July 2027).

**Open:** a return page on hercule.sh, so the web app's sign-in needs no pasted address. It would change [./13-security.md](./13-security.md#31-policy)'s "hosts no OAuth relay". [#1206](https://github.com/theagenticage/hercule/issues/1206).

### 5.3 Status

| Status | Meaning |
|---|---|
| `checking` | From creation, or from switching on, until the first list ends. A later check does not go back to `checking`. Its result sets the status. *(Amended 2026-11-21, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* A new sign-in (`setToken`) and Replace also go back to `checking`, because the last status was about a sign-in or a destination that is gone |
| `ready` | The last list or call succeeded |
| `needs-sign-in` | The credential is not usable ([sections 5.1](#51-a-plugin-servers-credential) and [5.2](#52-a-url-servers-sign-in)) |
| `unreachable` | No usable answer, and trying again later may cure it: no connection, a connection that closes in the middle of an exchange, a timeout on a check, an HTTP 5xx, or an HTTP 429. Checked again with backoff |
| `error` | The server answers but refuses or fails: a 401 after a working refresh, a protocol error (an answer that is not MCP, or an HTTP 4xx other than 401, 429 and the fallback cases of [section 3.10](#310-upstream-sessions)), a revision the gateway cannot speak, or the plugin switched off |

- A server keeps its last stored tools in every status.
- **Server-wide failures change the status:** no connection, a connection that closes mid-exchange, a timeout on a check, an HTTP 5xx or 429, a 401 after a working refresh, a protocol error and an unsupported revision. A tool result with `isError: true`, a tool-level error, or a 403 on one tool is that call's answer and changes nothing. *(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* So is every failure of the call's own request. A call whose answer asks for more input is "not supported" for that call alone ([section 3.2](#32-protocol-revisions-and-what-is-spoken)). The client can refuse a call before it sends anything, for instance when an argument does not fit a header the tool declares. A result can fail to decode. The tool's own request can get HTTP 400, 413 or 422. Each of these is that call's `isError` result, with a fixed text, and the server's status stays. Only a failure that says something about the server as a whole changes the status. One call could otherwise take a server away from every Thread until its next check.
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

*(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **A whole check has 45 seconds**, as a call does ([section 3.5](#35-a-call)): opening the upstream MCP session, the refresh, the retry and the listing. Its listing alone was given 60 seconds, the same as the time a promotion freeze waits for running work, so a server that hung during a check could outlast the wait and fail the freeze. The limit is now the freeze's 60 seconds less 15. A check that is still running then ends `unreachable`, with the detail "The server did not answer in time", and is checked again with the backoff of [section 5.3](#53-status). A refresh that has started still runs to its own end, as it does for a call.

### 5.5 Notifications

Entering `needs-sign-in`, `unreachable` or `error` raises one Notification per episode, never for a server that is switched off. An episode ends when the server is `ready` again. A plugin server never raises one for `needs-sign-in`, because its Connection already does. *(Amended 2026-11-21, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* A URL server does. *(Amended 2026-11-21, [#1210](https://github.com/theagenticage/hercule/issues/1210), decided by Rogier.)* **A server that has never worked raises none**, whatever its failure: a Notification is for what the user would not have seen otherwise, and a failure of the checks after a server is added is seen by whoever adds it (the Add dialog, `hercule mcp-server read`). Notifications start once the server has been `ready` once (`checkedAt` is set). A server added by URL with no token whose first check gets a 401 raises none. *(Amended 2026-11-21, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* That holds for every cause: the core raises the Connection's Notification whenever it sets the Connection to `needs-reauth`, whether a refresh was refused, an ingest `AuthError` came in, or the plugin reported it ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.2). Rogier decided this. The Notification subject gains MCP Server ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)). *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* The kind is `core.mcp-server-failed`, informational, raised in the transaction that writes the status, with the server as subject. A plugin that is not in this build counts as a plugin that is switched off: the server is `error` with cause `plugin`, and it is checked again when the plugin is back.

### 5.6 Outbound rules

These rules cover every URL the controller follows for a server, sign-in included: discovery, metadata, registration, exchange and refresh.

- A URL is `http` or `https` and holds no user name or password.
- A redirect is not followed with a credential to another origin.
- The URL that a plugin's `buildUpstreamRequest` returns must be on the `origin` the contribution declared.
- Private addresses are allowed. Hercule is single-user on a LAN or tailnet, and only the user adds a URL.
- *(Amended 2026-11-22, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* **Addresses the server names, not the user.** A sign-in follows addresses that the MCP server and its authorization server give: the metadata documents, the registration, the authorization and the token endpoints. They may name any https host, a private one included, and an http one only on the http MCP server's own origin. A server could use that to make the controller send a GET with a path and query it chose, the fixed registration POST, and token POSTs to such a host. That is accepted, because those requests carry no Hercule credential, are never redirected, are read with a size bound and a timeout, and their answers reach no one but the sign-in. It is a known limit of signing in at a server the user added by address (For Rogier, PR #1255).
- *(Amended 2026-11-22, [#1210](https://github.com/theagenticage/hercule/issues/1210).)* **Which host asks for the approval.** A server added by address chooses its authorization server, and nothing ties the endpoints to the issuer beyond what OAuth checks (`state`, PKCE, `iss` when the authorization server sends it). So a client shows the user the host of the authorization address before it opens the browser: the CLI prints it, and the dialog shows it ([./17-desktop-app.md](./17-desktop-app.md)).

## 6. The plugin servers

Three plugins offer a server in v1. Each is reached with the plugin's Connection, and the plugin's `buildUpstreamRequest` builds the request. The vendor facts are from [the exploration](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-vendor-auth.md).

### 6.1 Sentry

- URL: `https://mcp.sentry.dev/mcp?disable-skills=project-management`. The query drops ~~18~~ 19 tools that the Connection's scopes do not cover, and 55 remain *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* The server does not filter its list by the token's scopes: without the query it lists 74 tools. So the query is what keeps the unusable tools out, and a scope the token lacks would show only when such a tool is called, as that call's own answer.
- Header: `Authorization: Sentry-Bearer <token>`.

~~**Verify at build time:** that `mcp.sentry.dev` accepts a Hercule Sentry Connection's token as `Sentry-Bearer`. This is unproven. A proof call is the first acceptance criterion of [#1208](https://github.com/theagenticage/hercule/issues/1208). If it fails, that slice stops and reports, because it then needs another route to "no second sign-in".~~ *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* **Proven on 2026-11-20** ([the proof](https://github.com/theagenticage/hercule/issues/1208#issuecomment-7041913349)). A token from Hercule's Sentry application, made by the Connection's device flow with its six scopes, was accepted as `Sentry-Bearer` (`initialize`, `tools/list` and a `whoami` call all answered 200), and the same token as plain `Bearer` got 401. Sentry answered the older revision `2025-06-18` it was asked for. *(Amended 2026-11-20, [#1208](https://github.com/theagenticage/hercule/issues/1208).)* In the live run of the same day ([section 3.11](#311-build-time-verifications)), where the gateway tries `2026-07-28` first, Sentry's server answered the modern revision `2026-07-28`.

Sentry kills the old access token the moment it is refreshed. The gateway never hands a token out, so a refresh cannot break a running session.

### 6.2 Linear

- URL: `https://mcp.linear.app/mcp`.
- Header: `Authorization: Bearer <token>`. A pasted API key works too.

*(Amended 2026-11-21, [#1209](https://github.com/theagenticage/hercule/issues/1209).)* The token is the redirect flow's access token, or else the pasted API key, and both are sent as `Bearer`. Linear's GraphQL API takes a pasted key without `Bearer`; its MCP server takes OAuth tokens and API keys alike as `Bearer` ([Linear: MCP server](https://linear.app/docs/mcp)).

**Verify at build time:** that Linear accepts the Connection's token as `Bearer`. [#1209](https://github.com/theagenticage/hercule/issues/1209). *(Amended 2026-11-21, [#1209](https://github.com/theagenticage/hercule/issues/1209).)* ~~Built from Linear's documentation and checked against a fake server. A real call needs Rogier's sign-in and is still open.~~ **Proven on 2026-11-21** in #1209's live sitting ([the sitting's result](https://github.com/theagenticage/hercule/issues/1209#issuecomment-7060978302)): with the redirect flow's token as `Bearer`, the server listed 78 tools and `get_user` returned the Connection's account. The pasted API key was not tried live.

### 6.3 GitHub

- URL: `https://api.githubcopilot.com/mcp/`.
- Header: `Authorization: Bearer <token>`. `X-MCP-Toolsets` is limited to what the Connection's scopes cover.

*(Amended 2026-11-21, [#1209](https://github.com/theagenticage/hercule/issues/1209).)* What "the Connection's scopes cover" means in the build:

- **The toolsets.** `X-MCP-Toolsets` names the 17 toolsets in which the device flow's scopes (`repo`, `read:org`, `notifications`, `workflow`) cover every tool: `actions`, `code_quality`, `code_security`, `context`, `dependabot`, `discussions`, `git`, `issues`, `labels`, `notifications`, `orgs`, `pull_requests`, `repos`, `secret_protection`, `security_advisories`, `stargazers` and `users`. `repo` includes `security_events`. The list was read from the source of `github/github-mcp-server` at commit `9a72d8d38`: the toolset ids and each tool's declared scopes.
- **One tool left out by name.** `repos` holds `delete_repository`, which needs `delete_repo`. `X-MCP-Exclude-Tools: delete_repository` removes it, and GitHub applies that header after the toolsets.
- **Left out:** `gists` (`gist`), `projects` (`project`, `read:project`) and `governance` (`admin:org`, `admin:enterprise`, `read:enterprise`), because they need scopes the Connection lacks. The `copilot` toolsets are also left out, because they need a Copilot subscription rather than a scope. So is the remote-only `github_support_docs_search`, whose scopes the source does not declare.
- **Why it matters.** For an OAuth token, GitHub answers a tool that needs a missing scope with a scope challenge. The gateway cannot answer that challenge, so such a tool would only fail.
- **For Rogier: a pasted token gets the same list.** `buildUpstreamRequest` is pure, so it cannot ask GitHub which scopes a pasted token has. A classic token without `read:org`, or a fine-grained token (which GitHub never lets read notifications), therefore lists tools it cannot use. Such a call fails as that call's own answer and leaves the server's status alone ([section 5.3](#53-status)). The recommendation is to keep this. The alternative is to read a pasted token's scopes when the Connection is validated and store them, so that the list can follow them.

**Verify at build time:** that GitHub accepts the Connection's token as `Bearer`, with that `X-MCP-Toolsets`. [#1209](https://github.com/theagenticage/hercule/issues/1209). *(Amended 2026-11-21, [#1209](https://github.com/theagenticage/hercule/issues/1209).)* ~~Built from GitHub's documentation and source and checked against a fake server. A real call needs Rogier's sign-in and is still open. It must show `get_file_contents` in the list and no `delete_repository`.~~ **Proven on 2026-11-21** in #1209's live sitting ([the sitting's result](https://github.com/theagenticage/hercule/issues/1209#issuecomment-7060978302)): with the device flow's token as `Bearer`, the toolsets and the excluded tool, the server listed 78 tools, `get_file_contents` among them and no `delete_repository`, and `get_me` returned the Connection's account. A pasted token was not tried live.

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
2. The gateway resolves the token, checks `mcp.use`, checks that the name was offered on the MCP session of the call, maps it to a server in the session's list and a tool in its stored list, and checks that the server is `ready` ([section 3.5](#35-a-call)).
3. It takes a fresh credential, sends the call upstream, and returns the answer. On a 401 it refreshes once and tries again ([section 5.1](#51-a-plugin-servers-credential)).
4. It writes the audit entry. A refused call also gets a tool result with `isError: true` and a `runtime.warning` on the Thread ([section 3.6](#36-a-refused-call)).

### 7.4 A list changes while a Thread runs

1. The user changes the Thread's list, or switches a server on or off, or a daily check finds a new tool list.
2. After the commit, the gateway sends `notifications/tools/list_changed` on the open stream of each session the change touches ([section 3.7](#37-list-changes)).
3. The harness lists again and the gateway answers from the stored lists. A server taken away is already refused at the next call.
4. ~~A Codex Thread without the `mcp_tool_list_changed` feature does not list again. A server added now is usable from the next start.~~ *(Amended 2026-11-21, [#1209](https://github.com/theagenticage/hercule/issues/1209).)* ~~That is a Codex older than 0.164.0. Its Thread was warned at its start.~~ Below Hercule's Codex floor (0.171.0) now, so no Codex Thread is in this case.

## Post-v1

- **Hercule's own tools over MCP.** Spec 11 section 10 parks a "Hercule MCP server" ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)): Hercule's own API as MCP tools. It stays post-v1, because a measurement of 280 runs found no success gap and the CLI costs the least context. The name `hercule` is kept for it ([section 2.2](#22-names)). The CLI stays the agent surface for Hercule's own operations ([ADR 0013](../adr/0013-agents-operate-hercule-through-the-public-api.md) stands for that).
- **Local MCP servers (stdio) on runners:** [#1213](https://github.com/theagenticage/hercule/issues/1213). A local server the harness starts would be a second kind of entry in `SessionSpec.mcpServers`, next to the gateway's, with no redesign.
- **Which tools of a server a session may call**, and overrides per project: [#1214](https://github.com/theagenticage/hercule/issues/1214). v1 stores and shows the tool list, and every tool of a served server is callable.
- **Agents and workflow steps naming MCP Servers:** [#222](https://github.com/theagenticage/hercule/issues/222). Until then only a Thread has a list.
- **Two accounts at one URL**, and a plugin server that follows the session's Connection of its type: [#1218](https://github.com/theagenticage/hercule/issues/1218) and [#1219](https://github.com/theagenticage/hercule/issues/1219) ([section 2.3](#23-one-server-per-address-and-account), [section 6.3](#63-github)).
- **Codex's changed lists, pi's built-in MCP, URL servers and the screens:** ~~[#1209](https://github.com/theagenticage/hercule/issues/1209), [#1212](https://github.com/theagenticage/hercule/issues/1212),~~ *(Amended 2026-11-22, [#1212](https://github.com/theagenticage/hercule/issues/1212).)* Codex's changed lists and pi's built-in MCP are built ([#1209](https://github.com/theagenticage/hercule/issues/1209), [#1212](https://github.com/theagenticage/hercule/issues/1212)). Left: [#1210](https://github.com/theagenticage/hercule/issues/1210), [#1211](https://github.com/theagenticage/hercule/issues/1211). They are part of the design, built after the first slice.

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
