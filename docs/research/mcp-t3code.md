# How t3-code lets agents operate the app through MCP

These facts back the decision whether Hercule should expose its public API to agent sessions as an MCP server, next to the `hercule` CLI and its skill. They come from the source of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) at commit `25fada9351ce9f907ecbe8ca3a819e358646777d` (2026-11-17), its pull requests, issues, discussions and docs, and one blog post the repo's FAQ links to. Nothing here comes from a secondary write-up.

## Method

- The repository was cloned shallowly into a scratch directory outside this repo, read with grep and a file reader, and deleted afterwards. None of its code was run and none of its dependencies were installed.
- History, pull requests, issues and discussions were read with `gh` (`gh pr view`, `gh issue view`, `gh api`, GraphQL for discussions).
- File links point at the examined commit. A claim marked "unverified" was not confirmed against a primary source. Token counts marked "estimate" are this note's arithmetic, at 4 bytes per token.
- Several maintainer comments on issues are written by a bot "on behalf of" the maintainer and say so. They are cited as such.

## The short answer

- t3-code runs **one MCP server, in the app server's own process**, at `/mcp` on the app's HTTP port, over streamable HTTP. Every agent session gets its own bearer token for that one endpoint.
- The server advertises **82 tools** to agents, about **52 KB** of JSON, plus a 6 to 7 KB block of instructions in the system prompt.
- **No measurement, benchmark or eval compares MCP with a CLI.** The one written reason for MCP compares it with per-harness plugins, not with a CLI.
- The repo records a long list of costs of the MCP route: context size, harness quirks, tool-count and schema-size caps, policy blocks. It also ships a terminal fallback (`acp-mcp-call`) for harnesses that accept the server but never show its tools.

## 1. The server

- **Where.** `apps/server/src/mcp/`. [McpHttpServer.ts][http] registers the tools and the transport, [McpSessionRegistry.ts][registry] issues tokens, [McpToolAccess.ts][access] holds the access rules, and `toolkits/<area>/tools.ts` and `handlers.ts` hold one toolkit per area.
- **Library.** Effect's `McpServer` from `effect/ai`. Tools are `Tool.make(...)` with Effect Schema parameters ([McpHttpServer.ts L15][http]).
- **Transport.** Streamable HTTP via `McpServer.layerHttp`, path `/mcp`, protocol versions `2025-06-18` and `2026-07-28`, session termination by `DELETE` ([McpHttpServer.ts L1334-1343][http]).
- **Start.** It is a layer of the main server ([server.ts L861][server]). There is no separate process. The endpoint is `http://127.0.0.1:<server-port>/mcp`, or the bound host ([McpSessionRegistry.ts L113-116][registry]).
- **One shared server.** The first version states the choice: "The environment server now hosts one reusable Streamable HTTP MCP endpoint at `/mcp`", and "It does not launch a separate headless browser or per-thread MCP process, so the agent and user share the same page" ([PR #3053](https://github.com/pingdotgg/t3code/pull/3053), merged 2026-06-14).
- **Stdio exists only as a relay.** `t3 acp-mcp-bridge` is a small stdio process that an ACP agent spawns per session. It forwards JSON-RPC lines to the HTTP endpoint ([AcpMcpStdioBridge.ts][bridge], [binMain.ts L4-5][binmain]). The reason is in the file: "ACP mandates stdio MCP support; HTTP/SSE support varies."
- **Other clients of the same endpoint.** Outside agents sign in over OAuth ([outside-agents.md][outside]). The `t3 thread` CLI signs in as a short-lived MCP client ([thread.ts L214-246][threadcli]). Linked environments call each other's `/mcp` ([remote.md][remote]).
- **History.** Ten `preview_*` browser tools came first (PR #3053, June 2026). The orchestration tools (delegate, threads, scheduling) arrived with the V2 orchestrator ([PR #2829](https://github.com/pingdotgg/t3code/pull/2829), merged 2026-10-02).

## 2. The tool roster

83 `Tool.make` calls in `toolkits/*/tools.ts`: 82 advertised tools and `tool_search`, which only deferring clients see. Counted by grep, not by running the server.

| Toolkit | Count | Tools |
|---|---|---|
| orchestrator | 20 | `orchestrator_capabilities`, `delegate_task`, `task_status`, `task_cancel`, `t3_workflow_stop`, `t3_background_wait`, `schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task`, `request_secret`, `create_threads`, `t3_thread_list`, `t3_thread_read`, `t3_thread_update`, `t3_thread_send`, `t3_thread_wait`, `t3_thread_interrupt`, `t3_environment_links`, `t3_environment_link`, `t3_environment_unlink` |
| preview | 12 | `preview_status`, `preview_open`, `preview_dialog`, `preview_navigate`, `preview_resize`, `preview_set_appearance`, `preview_snapshot`, `preview_act`, `preview_evaluate`, `preview_wait_for`, `preview_recording_start`, `preview_recording_stop` |
| pullRequests | 9 | `link_pull_request(s)`, `unlink_pull_request(s)`, `list_thread_pull_requests`, `watch_pull_request`, `unwatch_pull_request`, `write_pull_request_guides`, `read_pull_request_guide` |
| issues | 8 | `list_issues`, `read_issue`, `create_issue`, `comment_on_issue`, `set_issue_state`, `link_issue`, `unlink_issue`, `list_thread_issues` |
| project | 7 | `t3_project_list`, `_read`, `_create`, `_update`, `_delete`, `_clone`, `t3_thread_launch` |
| thread | 7 | `t3_thread_organize`, `t3_queue`, `t3_pending_request`, `t3_thread_configure`, `t3_thread_transfer`, `t3_thread_search`, `run_scheduled_task_now` |
| device | 4 | `device_list`, `device_open`, `device_screenshot`, `device_close` |
| attachment | 3 | `t3_attachment_prepare_upload`, `t3_attachment_discard`, `t3_thread_send_attachments` |
| worktree | 3 | `t3_worktree_handoff`, `t3_worktree_status`, `t3_worktree_list` |
| environment, theme, previewControls, html | 2 each | `t3_environment_read`, `t3_environment_preferences_update`, `t3_theme_read`, `t3_theme_set`, `t3_preview_list`, `t3_preview_close`, `html_preview`, `html_render` |
| message | 1 | `send_to_user` |
| toolSearch | 1 | `tool_search` |

### Size

- **The tool list is 52,145 bytes** as the model sees it (name, description, input schema of every tool, as JSON). The number is committed in [agentContextBudget.json][budget] and [AgentContextBudget.test.ts][budgettest] fails when the measured value differs. About 13,000 tokens (estimate).
- **Instructions come on top.** The text appended to Claude's system prompt is 5,930 bytes; Codex's additional context is 7,324 bytes (same file). The text is in [orchestrationInstructions.ts][instructions].
- **Descriptions are short; schemas are the bulk.** For the 60 tools whose description is a plain string literal, descriptions total 11,373 characters: mean 189, median 146, longest 759 (`preview_act`). Measured with a regex over the source. Example: `delegate_task` is "Start one child agent with only `task`. No parent history. ..." ([orchestrator/tools.ts L89-100][orchtools]).
- **Measured by others, in real harnesses:**
  - Copilot over ACP: 68 T3 tools made a "hi" request cost 33,792 input tokens with 24,915 tool-schema tokens. With 4 T3 tools listed it cost 19,264 and 10,540 ([PR #34245](https://github.com/pingdotgg/t3code/pull/34245)). So 64 T3 tools cost about 14,400 tokens.
  - Pi: with a 79-tool fixture the first request fell from about 88.7 KB to 16.4 KB once tools were deferred ([PR #17220](https://github.com/pingdotgg/t3code/pull/17220)).
  - A user measured a Pi session at about 18.9k tokens with T3's tools and text and about 3.2k without ([discussion #17205](https://github.com/pingdotgg/t3code/discussions/17205), comment of 2026-11-17). User-reported, unverified.
- **Growth.** 10 tools in June 2026, 84 tools and 65,789 schema characters by late October, cut to 66 tools and 43,175 characters ([PR #25423](https://github.com/pingdotgg/t3code/pull/25423)), then back up to 82 tools at the examined commit.

### How the list is kept small

- **Compact advertised schema.** [advertisedJsonSchema.ts][advertised] drops `additionalProperties: true`, safe-integer bounds, the `null` branch of optional fields and JSON-string fallbacks, and merges a tagged union of objects into one object. Decoding still uses the full schema.
- **Action tools.** Related tools are one tool with an `action` field: `preview_act` (click, type, hover, select, drag, upload, press, scroll), `t3_queue`, `t3_pending_request`, `t3_thread_transfer`; `schedule_task` creates or updates (PR #25423).
- **A CI ratchet.** A workflow compares `agentContextBudget.json` with `main` and fails when any number is higher. Growth needs the `agent-context-increase` label ([PR #25785](https://github.com/pingdotgg/t3code/pull/25785)).
- **Deferred loading, done three ways:**
  - Claude Code has its own ToolSearch. T3 forces it on when the user's `ENABLE_TOOL_SEARCH` is `auto`, because on 1M-context models `auto` sends every schema in full ([ClaudeAdapterV2.ts L2113-2124][claude]). Two tools carry `_meta: {"anthropic/alwaysLoad": true}` so Claude loads them up front: `request_secret` and `send_to_user`. The reason given: "agents that never load this one ask in chat" ([orchestrator/tools.ts L219-221][orchtools]).
  - Pi 0.99+ gets three tools directly (`orchestrator_capabilities`, `delegate_task`, `task_status`) and finds the rest through Pi's own `tool_search` (PR #17220).
  - A client with no tool search of its own sends the header `t3-tool-exposure: deferred`. The server then lists the same three tools plus its own `tool_search`, which scores tools by name and description, loads up to 10 matches for that session and sends `notifications/tools/list_changed`. Calls are never gated, only the list ([McpToolExposure.ts][exposure], [McpHttpServer.ts L1375-1403][http], PR #34245). Only Copilot uses it at the examined commit ([provider-acp-registry adapter.ts L285-288][acpreg]).
- **No meta "call" tool** on the MCP side. The nearest thing is the `acp-mcp-call` command (section 3).
- **Bounded results.** A thread read stops at about 30,000 characters and a browser snapshot at 20,000 bytes, because "Claude Code saves MCP results over its token limit to a file instead of showing them" ([orchestrator-mcp-server.md][orchdoc], [McpHttpServer.ts L301-302][http]).

## 3. How each harness gets the server

`ProviderSessionManager` issues a credential before a provider session opens, and each adapter passes endpoint and `Authorization` header in the harness's own way ([orchestrator-mcp-server.md][orchdoc]). The server key is `t3-code` everywhere.

| Harness | What the adapter passes | Source |
|---|---|---|
| Claude Agent SDK | `mcpServers: {"t3-code": {type: "http", url, headers: {Authorization}, timeout: 65 min}}` and `allowedTools: ["mcp__t3-code__*"]` (17 read-only tools in a read-only sandbox). Sent with `setMcpServers()` after start, not in the query options, to "keep them out of SDK argv and inherited command environments". | [ClaudeAdapterV2.ts L2449-2504, L1474-1475, L1614-1650][claude] |
| Codex app-server | Per-thread config on `thread/start`, `resume` and `fork`: `mcp_servers.t3-code = {url, tool_timeout_sec: 3900, http_headers: {Authorization}, disabled_tools: [t3_thread_wait, delegate_task]}` and a second entry `mcp_servers.t3-code-direct` with only those two tools and `omit_tools_from: ["code_mode", "deferred"]`. Code Mode would otherwise run a blocking wait as a nested call that the model keeps polling. | [CodexAdapterV2.ts L1499-1549][codex] |
| Cursor SDK | `mcpServers: {"t3-code": {type: "http", url, headers}}` on `Agent.create`, `Agent.resume` and each `send`. | [provider-cursor adapter.ts L211-226][cursor] |
| OpenCode 1.x | `client.mcp.add({name: "t3-code", config: {type: "remote", url, headers, oauth: false}})`, on one T3-managed OpenCode server per thread. | [provider-opencode adapter.ts L1072-1083][opencode] |
| OpenCode 2 | One entry per thread, `t3-code-<thread>`, because OpenCode registers MCP servers per directory and T3's token is per thread. Permission rules deny every other thread's entry. An external OpenCode server gets no T3 tools. | [providers.md L14-25][providersdoc], [v2/adapter.ts L4287-4317][opencode2] |
| Muse | `mcpServers: {"t3-code": {transport: "streamableHttp", mode: "optional", url, headers}}` on `session/start`. `optional` because Muse's default fails the run when the server is unreachable. | [provider-muse adapter.ts L1939-1949][muse] |
| Pi | A generated Pi extension plus `T3_MCP_URL` and `T3_MCP_BEARER_TOKEN` in the environment. The extension registers each tool as `mcp__t3-code__<name>` and calls the HTTP endpoint itself. Pi's native MCP is not used: its 60-second timeout cuts long tools and `mcp.json` entries override native registrations. | [orchestrator-mcp-server.md "Pi V2"][orchdoc] |
| ACP agents (Grok, Kiro, fx, Antigravity, registry agents such as Copilot and Devin) | Three candidate entries in `session/new`, `load` and `fork`; one is sent. If the agent advertises `mcpCapabilities.acp`: `{type: "acp", name: "t3-code", serverId}` (MCP over the ACP connection). Else, if the flavor opts in and the agent advertises `http`: `{type: "http", url, headers}`. Else stdio: `{name: "t3-code", command: <t3 binary>, args: [..., "acp-mcp-bridge"], env: [ELECTRON_RUN_AS_NODE=1, T3_ACP_MCP_ENDPOINT, T3_ACP_MCP_AUTHORIZATION]}`. | [provider-acp adapter.ts L911-965][acp], [AcpSessionRuntime.ts L2170-2184][acpruntime] |

- **HTTP is opt-in per ACP flavor** because "codex-acp 1.2.0 and pi-acp drop injected HTTP servers" ([provider-acp adapter.ts L920][acp]). Antigravity, Copilot and Command Code take HTTP: Copilot CLI 1.0.105 rejects stdio servers from the client, and Command Code cannot start the bridge on Windows ([acp-registry adapter.ts L234-238][acpreg], [AntigravityAdapterV2.ts L213-214][antigravity]).
- **Instructions travel separately.** Claude gets them in the system prompt append, Codex as additional context, and ACP agents, which have no system field, as a wrapped block in the first prompt ([orchestrationInstructions.ts][instructions]).
- **Kiro and fx** build on the shared ACP adapter (seen in their imports). Their exact flavor options were not read. Unverified in detail.

### The `acp-mcp-call` fallback

- **What it is.** A hidden CLI command, `t3 acp-mcp-call <tool> <arguments-json>`. It opens an MCP session on the HTTP endpoint, calls one tool, prints the JSON result and ends the session ([AcpMcpStdioBridge.ts L178-193, L345-421][bridge], [cli/acpMcpBridge.ts][bridgecli]).
- **Why it exists.** "This is the terminal fallback for ACP agents that accept `mcpServers` in `session/new` but fail to expose those tools to their model." And: "some ACP agents accept the injected MCP server but never expose its tools, so they need the terminal transport other harnesses never use" ([orchestrationInstructions.ts L58-60][instructions]).
- **How the agent learns of it.** ACP sessions get one extra instruction line: if the T3 tools are absent and `T3_ACP_MCP_NODE` is set, run `"$T3_ACP_MCP_NODE" ... acp-mcp-call orchestrator_capabilities '{}'` (same file).
- **How it authenticates.** The agent process environment carries `T3_ACP_MCP_ENDPOINT`, `T3_ACP_MCP_AUTHORIZATION`, `T3_ACP_MCP_NODE`, `T3_ACP_MCP_ENTRYPOINT` and `T3CODE_THREAD_ID` ([provider-acp adapter.ts L953-964][acp]). So any command the agent runs can read the token. Claude's adapter avoids exactly that.
- **It is a real second path.** The ACP runtime parses `acp-mcp-call` out of shell commands so the UI shows them as T3 tool calls ([runtimeModel.ts L1062][acpmodel]).
- **It has failed in the field.** Antigravity ACP dropped the three largest tools past a cap of about 40 KB of schemas, and the fallback's environment variables did not reach the agent ([issue #36088](https://github.com/pingdotgg/t3code/issues/36088)). A later report says Antigravity cuts the list at 50 tools ([issue #37911](https://github.com/pingdotgg/t3code/issues/37911), title only, unverified).

## 4. Authentication, attribution and access rules

- **One token per provider session.** `McpSessionRegistry.issue` makes 32 random bytes, stores only the SHA-256 hash, and binds the token to environment, thread, provider instance, a new `providerSessionId`, a `subagent` flag and a set of capabilities (`orchestration`, `worktree`, `pull-requests`, `issues`, plus `preview` and `device` when the user allows them) ([McpSessionRegistry.ts L118-160][registry]).
- **Sent as a header.** `Authorization: Bearer <token>`. The URL is the same for every session; nothing about the session is in the URL.
- **Attribution.** The auth middleware resolves the token to an `McpInvocationScope` and provides it to the handler as a service. A tool acts as "the calling thread" without the model passing its own thread id ([McpHttpServer.ts L239-295][http], [McpInvocationContext.ts][invocation]).
- **Lifetime.** A token stops working after 24 hours without use, is revived only by a provider turn, and is revoked when the provider session is released. All tokens die on server restart ([McpSessionRegistry.ts L70-75][registry], PR #3053).
- **Browser origins are refused** before credentials are read ([McpHttpServer.ts L286-287][http]).
- **Outside clients** use a narrow OAuth authorization-code server with PKCE. The user grants read-only or a runtime-mode ceiling, not a scope list. A sign-in lasts 30 days. Only `/mcp` accepts these sessions ([environment-auth.md L42-68][authdoc], [outside-agents.md][outside]).
- **Per-tool access.** Every handler is built by one declaration in `McpToolAccess` ([PR #16335](https://github.com/pingdotgg/t3code/pull/16335)):

  | Declaration | Who may call it |
  |---|---|
  | `reads` | every caller |
  | `readsAsCaller` | a T3 thread, about its own things |
  | `actsAsCaller` | a T3 thread with a live turn |
  | `writes` | a live thread or an outside agent with write access |
  | `writesThreads` | the same, and each target thread's modes are not broader than the caller's |
  | `startsThreads` | the same, and the requested modes are within the caller's |
  | `writesEnvironment` | a full-access caller |

- **Enforced three ways.** The types: `McpToolAccess.toLayer` only accepts a toolkit whose every handler went through a declaration, and the declaration classes cannot be built elsewhere. The lint rule `t3code/no-raw-mcp-registration`, which reports any import of Effect's `McpServer` or call to `addTool` or `registerToolkit` outside `McpHttpServer.ts` ([no-raw-mcp-registration.ts][lint]). And a start-up check that a tool acting as its calling thread is hidden from outside clients ([McpToolAccess.ts L426-434][access]).
- **Privilege ceiling.** A child or launched thread may not run with a broader runtime or interaction mode than its caller. The orchestrator rechecks under the thread's command lock ([orchestrator-mcp-server.md "Policy And Idempotency"][orchdoc]).
- **Hiding is discovery only.** `EnabledWhen` hides tools from subagents, outside clients, or while a beta is off; the handler still refuses the call ([McpInvocationContext.ts L174-200][invocation]).

## 5. Why MCP and not a CLI

### Stated reasons

- **MCP instead of per-harness plugins.** Theo Browne's blog post, linked from the FAQ: "Technically speaking, we could have rebuilt all of T3 Code's coolest features as a set of plugins for Claude Code, Codex, Antigravity, Pi, Cursor, Muse... Or we could keep all the code in T3 Code itself, and expose a simple MCP server for the LLMs to use instead :)" ([What is a harness?](https://t3.gg/blog/post/what-is-a-harness), 2026-10-22; [faq.md L7][faq]). The post does not mention a CLI as an alternative.
- **One shared HTTP endpoint instead of a process per thread**, so the agent drives the browser tab the user sees (PR #3053). This is a reason for the transport, not for MCP over a CLI.
- **A capability is a service method; MCP is one thin transport of several.** "Users trigger a capability from the WebSocket, agents reach it through MCP tools, and scheduled tasks and the CLI run it too" ([effect-services.md L19-22][servicesdoc], [AGENTS.md L72][agents]).
- **MCP over a harness's own callback tools.** "The SDK has in-process custom callback tools, but the V2 adapter intentionally uses the authenticated, thread-scoped MCP server instead" ([cursor.md L64-65][cursordoc]). No reason is given.

### What is not there

- **No benchmark, eval or measurement compares MCP with a CLI.** None was found in the docs, `AGENTS.md`, `evals/`, the pull requests listed here, or the issues and discussions searched.
- **The evals measure something else.** `evals/mcp-tool-use` replays fake threads and checks whether models use T3's MCP tools correctly. It compares two versions of T3's text and schemas, never MCP against another mechanism ([evals/mcp-tool-use/README.md][evals], [PR #24635](https://github.com/pingdotgg/t3code/pull/24635)).
- **The CLI question is open, not decided.** Users asked for a thread-bound CLI where a company's Claude Code policy blocks the localhost MCP server ([issue #18635](https://github.com/pingdotgg/t3code/issues/18635), [issue #19236](https://github.com/pingdotgg/t3code/issues/19236), [discussion #6779](https://github.com/pingdotgg/t3code/discussions/6779)). The reply, a bot comment on behalf of Julius Marminge: the admin should allowlist the endpoint, and a terminal mode "is a product call, so please wait for a maintainer go-ahead". No decision is recorded.
- **A CLI did ship, for scripts, on top of MCP.** `t3 thread start|send|show|list` signs in as a short-lived MCP client and calls the same tools: "There is no new server endpoint and no second copy of the launch or queue logic" ([PR #22732](https://github.com/pingdotgg/t3code/pull/22732)). It is not bound to a calling thread, so it cannot delegate as one.

### Costs of the MCP route that the repo records

- **Context.** Every thread pays for the tool list. Users ask for a switch to turn the server off (discussion #17205, no maintainer reply found).
- **Agents ignore tools they were given.** The eval exists because "agents also repeat the same T3 tool mistakes: native subagents instead of `delegate_task`, `sleep` poll loops instead of `watch_pull_request`" (PR #24635). The FAQ: "the chef won't open it unless you tell them to".
- **Deferred tools get missed.** The instructions carry "T3 tools may load late. Try the name once before you call it absent."
- **Each harness needs its own workaround:** Codex Code Mode polling (a second server entry), Pi's 60-second timeout (a custom bridge), Claude's 60-second default (raised to 65 minutes), OpenCode's per-directory registrations, ACP agents that drop HTTP servers or reject stdio ones, Antigravity's size and count caps, Gemini rejecting non-string enums and a llama.cpp backend failing on a schema `pattern` ([advertisedJsonSchema.ts L24-26][advertised], discussion #17205).
- **Policy.** A managed MCP allowlist removes every T3 tool from Claude threads, and the thread shows nothing (issue #18635).

### Inference, not stated anywhere

- MCP looks like the path of least resistance in June 2026 more than the winner of a comparison. The first tools returned screenshots as image content and needed a per-session identity, and every harness already had an MCP hook.
- A token in an HTTP header that only the harness holds is a real security difference from a CLI. The Claude adapter keeps the token out of argv and the environment on purpose; the terminal fallback puts it in the environment. The source states the first half only for Claude. That this argues against a CLI in general is this note's reading.

## 6. Third-party MCP servers configured by the user

- **T3 Code has no central list at the examined commit.** No setting, contract or UI for user-defined MCP servers was found in `packages/contracts`, `apps/server` or `apps/web`.
- **Each harness loads its own config, on the machine that runs it:**
  - Claude: its settings sources `user`, `project`, `local` ([ClaudeAdapterV2.ts L5596][claude]).
  - Codex: its own config. T3 overrides "only T3's servers so launch-argument MCP servers survive" ([CodexAdapterV2.ts L1537][codex]).
  - Cursor: `.cursor/mcp.json`, `~/.cursor/mcp.json` and plugins. "Custom Cursor MCP servers and plugins are not configured in T3 Code" ([cursor.md L18-27][cursordoc]).
  - fx: `~/.fx/mcp.json`. Kiro: its own MCP configuration. Pi: its own extensions and settings.
- **OAuth is the harness's job, and often fails.** Cursor: run `agent mcp login <server>` on that machine; the local SDK cannot do interactive OAuth ([cursor.md L21-26][cursordoc]). Kiro threads could not use OAuth servers at all until T3 implements Kiro's secret storage ([PR #31019](https://github.com/pingdotgg/t3code/pull/31019), open).
- **Config is per machine and per provider account.** After a change the user must run "Restart agent session" ([composer.md L286][composer]).
- **Central management has been proposed and not merged:**
  - [Discussion #14118](https://github.com/pingdotgg/t3code/discussions/14118): environment-level servers attached to every session. No maintainer decision.
  - [PR #16466](https://github.com/pingdotgg/t3code/pull/16466): T3 as a proxy at `/mcp/shared/<server>` holding headers and OAuth tokens. Closed for lack of prior approval.
  - [PR #21817](https://github.com/pingdotgg/t3code/pull/21817): "manage skills and MCP servers in Settings", by a maintainer. Open.

## 7. Idempotency and other choices worth copying

- **`clientRequestId`.** An optional string, at most 256 characters, on eight input schemas, described to the model as "Reuse it to retry the same call. A new call gets a new key." ([orchestratorMcp.ts L50-58][contract]).
  - The server derives stable ids from it: `command:mcp:<providerSessionId>:<operation>:<clientRequestId>[:index]`, and the same for thread and message ids. A retry returns the same durable work ([OrchestratorMcpService.ts L767-815][orchsvc]).
  - Without it the server generates a key and the call creates new work.
  - The key is scoped to the provider session, so a reissued credential breaks retries ([PR #23796](https://github.com/pingdotgg/t3code/pull/23796), open).
  - `t3_thread_launch` has no retry key. The docs tell the agent to inspect existing threads after a lost response ([orchestrator-mcp-server.md][orchdoc]).
- **Failures are results, with a code.** Tools use `failureMode: "return"` and a typed failure with codes such as `capability_denied`, `parent_not_active`, `runtime_mode_escalation_denied` and `thread_not_found`. Messages say what to do next.
- **Unknown arguments are rejected by name**, with the accepted list. `null` is accepted for optional fields ([McpHttpServer.ts L522-556][http]).
- **Results go in both `content` and `structuredContent`**, because "some clients show only the text content and others only structuredContent".
- **Hints.** Each tool carries `readOnlyHint`, `destructiveHint` and `idempotentHint`. Claude's read-only sandbox pre-approves exactly the read-only tools.
- **Waiting without polling.** `delegate_task` has `mode: "wait"` and `"async"`. A result's `next` field tells the agent that completion will wake it. Tool timeouts are raised to 65 minutes because `request_secret` can wait an hour.
- **Links, not ids.** Results carry a ready `link` for a thread that the agent repeats verbatim.
- **Provenance.** Threads and messages made through MCP are stamped `createdBy: "agent"`, `creationSource: "mcp"`.
- **Telemetry without content.** One span per tool call named for the tool; arguments stay out because they hold prompts and ids.
- **The first instruction line** is "Ordinary coding tasks need no T3 tools."
- **Evals from real mistakes.** Each case reproduces a mistake an agent made, must fail before the fix and pass after. A full run cost $25 on Sonnet and $45 on Opus on 2026-11-10 ([evals/mcp-tool-use/README.md][evals]).

## Not verified

- Nothing was run. Tool counts come from the source and byte sizes from the committed budget file.
- How each harness behaves with the injected server at runtime (which defer, which truncate) is taken from the repo's own comments, PRs and issues.
- Whether Codex defers T3's tools by default. The config key `omit_tools_from: ["code_mode", "deferred"]` implies Codex has both modes; the default was not checked.
- Statements by the maintainers outside the repo and the one linked blog post were not searched.

[http]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/mcp/McpHttpServer.ts
[registry]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/mcp/McpSessionRegistry.ts
[access]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/mcp/McpToolAccess.ts
[invocation]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/mcp/McpInvocationContext.ts
[exposure]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/mcp/McpToolExposure.ts
[advertised]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/mcp/advertisedJsonSchema.ts
[bridge]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/mcp/AcpMcpStdioBridge.ts
[bridgecli]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/cli/acpMcpBridge.ts
[binmain]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/binMain.ts
[threadcli]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/cli/thread.ts
[server]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/server.ts
[orchtools]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/mcp/toolkits/orchestrator/tools.ts
[orchsvc]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/mcp/OrchestratorMcpService.ts
[budget]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/provider/agentContextBudget.json
[budgettest]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/provider/AgentContextBudget.test.ts
[claude]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
[codex]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts
[antigravity]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts
[cursor]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/packages/provider-cursor/src/server/adapter.ts
[opencode]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/packages/provider-opencode/src/server/adapter.ts
[opencode2]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/packages/provider-opencode/src/server/v2/adapter.ts
[muse]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/packages/provider-muse/src/server/adapter.ts
[acp]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/packages/provider-acp/src/server/adapter.ts
[acpruntime]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/packages/provider-acp/src/server/AcpSessionRuntime.ts
[acpmodel]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/packages/provider-acp/src/server/runtimeModel.ts
[acpreg]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/packages/provider-acp-registry/src/server/adapter.ts
[instructions]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/packages/provider-core/src/server/orchestrationInstructions.ts
[contract]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/packages/contracts/src/orchestratorMcp.ts
[lint]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/oxlint-plugin-t3code/rules/no-raw-mcp-registration.ts
[orchdoc]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/docs/orchestration-v2/orchestrator-mcp-server.md
[outside]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/docs/user/outside-agents.md
[remote]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/docs/internals/remote.md
[authdoc]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/docs/internals/environment-auth.md
[servicesdoc]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/docs/internals/effect-services.md
[providersdoc]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/docs/internals/providers.md
[cursordoc]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/docs/user/cursor.md
[composer]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/docs/user/composer.md
[faq]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/docs/user/faq.md
[agents]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/AGENTS.md
[evals]: https://github.com/pingdotgg/t3code/blob/25fada9351ce9f907ecbe8ca3a819e358646777d/evals/mcp-tool-use/README.md
