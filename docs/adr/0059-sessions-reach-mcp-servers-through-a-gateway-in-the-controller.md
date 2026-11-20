# 59. Sessions reach MCP servers through a gateway in the controller

Date: 2026-11-20

## Status

Accepted by [MCP support (#1207)](https://github.com/theagenticage/hercule/issues/1207). Decided by Rogier in the design review of 2026-11-17, 2026-11-19 and 2026-11-20 and in the grilling of 2026-11-20. Amends [ADR 0013](./0013-agents-operate-hercule-through-the-public-api.md), which kept MCP passthrough in the session spec and carries a dated note. Keeps [ADR 0006](./0006-plugins-request-capabilities-and-register-contributions-in-code.md) (a plugin registers data in the catalog), [ADR 0010](./0010-external-accounts-are-core-owned-connections.md) (a Connection is core-owned) and [ADR 0032](./0032-threads-link-the-users-own-material.md) (the user's own harness settings are not linked). The rules are in [spec 21](../spec/21-mcp.md). The exploration behind this decision is the [architecture page](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/design/mcp/index.html) and its research notes, kept at one commit because they are not on `main`.

## Context

Rogier asked three things when the exploration started (2026-11-17).

- **Tools set up once, working on every runner.** A user connects Sentry, Linear or GitHub to Hercule once. A session on any runner then calls that service's tools. Nothing is signed in again on each machine, in each harness.
- **A plugin brings its service's server with its sign-in.** The Sentry plugin already holds a Sentry Connection. Turning on Sentry's agent tools must not ask for a second sign-in. A server for a service that has no plugin must also be possible, added by its URL.
- **Should Hercule's own API speak MCP?** Agents operate Hercule through the `hercule` CLI ([ADR 0013](./0013-agents-operate-hercule-through-the-public-api.md)). The same operations could be offered to a session as MCP tools.

The facts that shaped the answer:

- Claude Code and Codex take an HTTP MCP server with a bearer token. pi has a built-in MCP that Hercule does not switch on yet ([research: protocol and harnesses](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-protocol-and-harnesses.md)).
- Vendors differ in how their token behaves. Sentry and GitHub end the old token the moment it is refreshed ([research: vendor sign-in](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-vendor-auth.md)).
- Codex does not let the servers of a loaded thread change, and every other harness needs its own call for it. One standard message, `notifications/tools/list_changed`, works for all three when the server list is kept behind one address ([research: a changed tool list](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-tool-list-changes.md)).
- Measured over 280 runs, an agent operating Hercule through MCP tools succeeds as often as one using the CLI. The CLI costs the least context in every session ([research: CLI against MCP](https://github.com/theagenticage/hercule/blob/9b9b82a25/docs/research/mcp-cli-vs-mcp.md)).

## Decision

**An MCP Server is a record on the controller. The harness of every session on a runner and harness that support it is given one MCP server, the MCP Gateway in the controller, at one fixed address, with the session's own Session Token.**

- **An MCP Server is a record.** It is a remote MCP server that offers tools to sessions. It comes from a plugin, reached with the plugin's Connection, or it is added by URL, reached with its own sign-in. It knows nothing about projects or threads.
- **One gateway, one address.** The session spec carries the MCP servers a harness is given, as plain HTTP entries: `SessionSpec.mcpServers`. Every session on a runner and harness that support it gets exactly one, `tools`, whose address is `<controller>/mcp` and whose bearer is the Session Token. The runner fills in both at each start, because the address differs per runner and the token per start. The entry is kept as a session primitive so that later kinds, such as a local server the harness starts, can join without a redesign. The gateway knows the session from the token. It lists the tools of the servers in that session's list, each named `<server name>__<tool>`, and forwards each call with a credential the controller holds. No vendor token reaches a runner.
- **A list per session, a default per project.** A Project names the servers a new thread in it starts with. That is a default only. A session keeps its own list and the user changes it under the composer's plus button. A changed list reaches a running session as `notifications/tools/list_changed`.
- **A plugin's server uses the plugin's Connection.** The plugin registers the server as a contribution. The server exists once the user switches it on.
- **A URL server keeps its own sign-in.** It is stored as secrets owned by the MCP Server. It is not a Connection and does not show in the Connections list.
- **Hercule's own API is not offered as MCP tools in v1.** The CLI stays the agent surface for Hercule's own operations. The name `hercule` is kept for a later server of that kind, so no server the user adds can take it.
- **Only the user gives `mcp.manage`.** The grant is one only the user gives, like `skill.write` and `skill.apply`. A session holds it only when the user put it on the session's profile or approved a Permission Request for it. An MCP Server reaches an outside account, and its tool descriptions steer every thread that has it.

The model is in [spec 02](../spec/02-domain-model.md), the harness mapping in [spec 06](../spec/06-providers.md), the plugin registration in [spec 05](../spec/05-plugins.md), the operations and the route in [spec 11](../spec/11-public-api-and-agent-surface.md), the grants in [spec 13](../spec/13-security.md), and the gateway, the status of a server and its credentials in [spec 21](../spec/21-mcp.md).

## Considered options

- **One gateway address per server** (`/mcp/sentry`, `/mcp/linear`, and the harness is given a thread's servers one by one). Rejected. It keeps each service's usual tool names, and Codex shows the model a line per server. But a running thread's list could not change: Codex cannot change a loaded thread's servers, and every other harness needs its own call for it. With one address a changed list is one standard message.
- **Hand the vendor's token to the runner, with header helpers** (`headersHelper` on Claude Code, `http_headers_helper` on Codex). Rejected, for four reasons.
  - The refresh depends on each harness running its helper again after a 401, and the Claude SDK's types do not list that.
  - Sentry and GitHub end the old token when it is refreshed, GitHub about every 8 hours, so every long session would rely on it.
  - A server that challenges for sign-in makes the harness try OAuth on the runner.
  - pi gets nothing, and every vendor token would sit in runner memory.
- **A bridge process per session on the runner** (`hercule mcp-bridge sentry`, a stdio server the harness starts). Rejected. It adds one more process of the 99 MB binary per server per session, and the controller sees no call, so there is no grant check and no audit.
- **Each harness signs in itself**, by linking the user's own harness MCP settings, as User Material does for instructions. Rejected. It is one sign-in per server, per harness, per machine, kept in three places. [ADR 0032](./0032-threads-link-the-users-own-material.md) left this out for that reason.
- **Plugin-written tools instead of the vendor's server** (a plugin's workflow actions offered to sessions as tools). Rejected for now. Sentry's own server has 59 usable tools against the plugin's three actions, and Sentry keeps them current. Start with the vendor's server and add a plugin's own tools where no vendor server exists.
- **A URL server's sign-in as a Connection, through a built-in `mcp` plugin.** Rejected, by Rogier. The sign-in is the server's own and is shown on its page. It would otherwise show in the Connections list next to accounts it has nothing to do with.
- **The raw `mcpServers` config on the Agent and in the stored `SessionSpec`** (as [spec 06 section 4](../spec/06-providers.md) and [#222](https://github.com/theagenticage/hercule/issues/222) planned). Rejected. It would put vendor configuration and secrets on the runner, and repeat them per Agent. A list of record ids on the session, plus the one plain HTTP entry for the gateway in `SessionSpec.mcpServers`, replaces it.
- **Hercule's own API as MCP tools in v1.** Not now. In the measurement above there was no success gap, and the CLI costs the least context in every session. A tool per operation would add about 2,800 tokens to every session on a harness that defers tools, and about 91,000 on one that does not. It could pay later for an Agent that does little but call Hercule, as a choice per Agent. The name `hercule` is kept for it.

## Consequences

- **One hop more per call.** Every call to an outside server passes the controller. A controller that is down takes MCP tools with it, as it does the CLI.
- **The controller is in the data path.** On every call the gateway checks `mcp.use` and the session's list, and writes one audit entry. It sends a refusal back as a tool result the agent can act on, with a button the apps draw to fix it.
- **A direct call skips the approval card.** The harness is given the Session Token, and so is the agent's shell, as with the CLI. An agent can send a call to the gateway with `curl`. That command is itself under the Access Mode, so the guard on a call is `mcp.use` plus the session's list. The gateway has no approval step of its own.
- **Taint is unchanged.** A result from an MCP server does not mark a session tainted ([spec 13 section 10](../spec/13-security.md)). Much of what a server returns is trusted or holds no text an outsider wrote. What still guards the Skill Library is that no shipped Permission Profile can apply a skill.
- **A new extension point, plugin capability and grant family.** The extension point is "MCP server", the plugin capability is `mcp-servers` (host API 9), and the grants are `mcp.read`, `mcp.manage` and `mcp.use`.
- **A Project holds a second default.** The Project had one, its Model Profile. It now also holds the MCP Servers a new thread starts with. It still has no behaviour.
- **ADR 0013 is amended in one line.** Its parked MCP passthrough is replaced by the gateway. The CLI stays the surface for Hercule's own operations.
- **GitHub has no special rule.** Its MCP server is a plugin server reached with its own Connection. A thread whose GitHub server acts as another account than the one its repository pushes as may meet a mismatch, which the agent reports. A fix that works for every plugin is [#1219](https://github.com/theagenticage/hercule/issues/1219).
- **pi is unsupported until [#1212](https://github.com/theagenticage/hercule/issues/1212),** which switches on its built-in MCP explicitly. Codex reads a changed tool list only with a feature that is off by default; [#1209](https://github.com/theagenticage/hercule/issues/1209) turns it on.
- **Left for later, each with its ticket in [spec 21](../spec/21-mcp.md) and [spec 16](../spec/16-open-items.md):** servers added by URL and their sign-in ([#1210](https://github.com/theagenticage/hercule/issues/1210)), two accounts at one URL ([#1218](https://github.com/theagenticage/hercule/issues/1218)), which tools of a server a session may call ([#1214](https://github.com/theagenticage/hercule/issues/1214)), local servers on runners ([#1213](https://github.com/theagenticage/hercule/issues/1213)), and servers named by an Agent or a workflow step ([#222](https://github.com/theagenticage/hercule/issues/222)).
