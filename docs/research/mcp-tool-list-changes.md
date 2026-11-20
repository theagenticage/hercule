# How each harness caches and re-reads an MCP tool list

These facts back the design of the MCP gateway: one MCP server per session at one fixed address, whose `tools/list` differs per thread and can change while the thread runs. They come from each harness's source code, its documentation, and live runs against a probe MCP server on 2026-11-20. This note adds to `mcp-protocol-and-harnesses.md` (sections A5, B1, B2, B3) and does not repeat it.

Versions examined:

| Thing | Read | Probed | What Hercule pins |
|---|---|---|---|
| Claude Code | docs at code.claude.com; the text inside the installed binary 2.1.329 (build 2026-11-19) | 2.1.329 | Agent SDK 0.3.263, which bundles 2.1.263 |
| Codex | source at tags `rust-v0.171.0`, `rust-v0.169.0`, `rust-v0.154.0` | 0.171.0, through `codex app-server` | 0.154.0 |
| pi | source and docs at tag `v1.5.2` (commit `b4afdddf`, released 2026-11-10, the latest release) | not probed | 0.85.1 |
| MCP specification | `2026-07-28` and `2025-11-25` | - | - |

Two things differ from what the task brief assumed:

- **The CLIs on this machine are newer than stated.** `claude --version` prints 2.1.329 (the binary is dated 2026-11-20 09:13) and `codex --version` prints 0.171.0 (released 2026-11-20). Older Claude binaries 2.1.325 to 2.1.328 are still on disk.
- **Hercule runs the machine's `claude`, not the bundled 2.1.263.** `apps/runner/src/harnesses/claude-code.ts` passes `pathToClaudeCodeExecutable: binary`, and the binary is the `claude` found on the runner. The session that wrote this note had `CLAUDE_AGENT_SDK_VERSION=0.3.263` and `CLAUDE_CODE_EXECPATH=.../versions/2.1.329`. So version notes such as "needs 2.1.274" are about the runner's install, not about the SDK pin.

## Method

- **Probe server.** A copy of `docs/design/mcp/benchmark/list-changed-probe.ts`, changed so that:
  - the tool list depends on the caller: `server_time` always, `only_<token>` for the bearer token, `only_thread_<n>` for a `thread` query parameter, and `<group>__tool_<i>` rows for `many=<count>`;
  - `POST /__grow` adds a tool and sends `notifications/tools/list_changed` on every open GET stream;
  - every request is logged with its token, query string and MCP session id.
- **Environment.** Each harness ran with an environment built from nothing: `HOME`, `USER`, a `PATH` with no `/.hercule/` entry, and for Claude the session's own `CLAUDE_CONFIG_DIR`. No `HERCULE_*` variable. Each run had its own empty directory.
- **Claude Code** ran as `claude -p ... --setting-sources project --strict-mcp-config --mcp-config <json> --no-session-persistence --dangerously-skip-permissions --output-format stream-json --verbose --model sonnet`. One run used `--input-format stream-json` to send two messages to one process, as the Agent SDK does in streaming mode. 15 short runs, about 0.55 dollars in total. Three of them were lost to a quoting mistake in the probe script and are not used below.
- **Codex** ran as one `codex app-server` process per scenario, driven over stdio: `initialize`, `thread/start` with `config` holding `mcp_servers.probe_lc.url` and `mcp_servers.probe_lc.http_headers`, `ephemeral: true`, then `turn/start`. It used the user's own `~/.codex` for sign-in, with `notify`, memories and the update check turned off by `-c`. Eight model turns.
- **What the model saw** was read in two ways: the `tools` array of the stream-json `init` message, and a prompt that asked the model to list the tool names it can see without calling a tool.
- **Source reading.** Codex and pi were shallow clones, read only, deleted afterwards. Claude Code is not open source: its facts come from the docs, and from the minified JavaScript that `strings` finds inside the binary. Facts from the binary are marked "binary 2.1.329" and name the function.
- **Side effects of the probes.**
  - The runs with `MCP_DISCOVERY_CACHE=1` made Claude Code create `<CLAUDE_CONFIG_DIR>/mcp-discovery-cache/` with four entries. They were deleted afterwards, and the folder too.
  - The same runs made Claude Code add a sealing key (`mcpDiscoveryCacheKey`) to the account's entry in its credential store. That key stays. Claude Code adds it itself when the cache is on.
- **Not done.** No resumed session was probed, because `--resume` needs session persistence in the live config directory. pi was not run. No large tool list was tried on Codex.
- "Unverified" marks a claim that no primary source or probe confirmed. The list is at the end.

## A. Tool-list caching

### A1. Claude Code

**The cache is the "MCP discovery cache".**

- **It exists since 2.1.221.** It was on by default up to 2.1.237. From 2.1.238 it is off unless a gradual rollout enabled it for the account, or `MCP_DISCOVERY_CACHE=1` is set. `MCP_DISCOVERY_CACHE=0` keeps it off even when the rollout enabled it ([MCP docs, Server status detail](https://code.claude.com/docs/en/mcp#server-status-detail), [env vars](https://code.claude.com/docs/en/env-vars)). So 2.1.263 has it, off by default.
- **The rollout is a feature flag per account**, `tengu_mcp_discovery_cache_enable` (binary 2.1.329, `BOt`). On the account used here it was off: no cache folder existed before the probes, and none appeared in the default runs.
- **It covers remote HTTP and SSE servers only**, in the SDK too. With the cache on, a server with a cached list does not hold the first turn, and connects on its first tool call ([Agent SDK MCP docs, Connection timing](https://code.claude.com/docs/en/agent-sdk/mcp#connection-timing)).
- **It is stored under `CLAUDE_CONFIG_DIR`**, as `<CLAUDE_CONFIG_DIR>/mcp-discovery-cache/<32 hex>.json`, one file per entry (probe; binary 2.1.329, `O()` and `fe`). So every session of one account on one machine shares the folder.
- **Each file is sealed** with AES-256-GCM. The key is in Claude Code's credential store (binary, `Z`, `_e`).
- **What an entry is keyed by** (binary, `fe`, `T`, `us`, `xK`, `Otn`, `Ct`). The file name is a hash over all of:
  - the server name;
  - a hash of the server's config: `type`, `url` with its query parameters sorted, `headers`, and the other connection fields. `tools`, `discoveryCache` and the fields that say where the entry was configured are left out;
  - the account: account id and organization id, plus a hash of the OAuth refresh token when the server uses OAuth;
  - the protocol era (legacy or `2026-07-28`);
  - the Claude Code version. An upgrade starts with an empty cache.
- **What is never cached** (binary, `Ke`, `re`, `vt`, `Ot`):
  - a stdio or in-process server;
  - a server with `headersHelper`;
  - a server whose URL or headers hold an environment placeholder;
  - a server entry with `discoveryCache: false`. This field is in the binary's config schema and not in the docs: unverified in use;
  - a tool list whose text contains one of the credentials the session sent.
- **When an entry is used** ([env vars](https://code.claude.com/docs/en/env-vars); binary, `hPa`):
  - younger than `MCP_DISCOVERY_CACHE_TTL_S` (900 seconds): used as is. The server is not contacted at start;
  - older than that, younger than `MCP_DISCOVERY_CACHE_MAX_STALE_S` (14,400 seconds, at most 7 days): used, and refreshed in the background;
  - older: dropped. The server connects at start as with the cache off;
  - after `MCP_DISCOVERY_CACHE_STRIKES` failed refreshes in a row (default 1): dropped.
- **When an entry is written:** after every live `tools/list` of an eligible server (binary, `persistLiveListing`).

**Probe, cache off (the default here).** Same server name, same URL, token `tokA` then `tokB`.

- Session 1 `init`: `mcp_servers: [{name: probe_lc, status: connected}]`, tools `mcp__probe_lc__only_tokA`, `mcp__probe_lc__server_time`. The model listed the same two names.
- Session 2 `init`: tools `mcp__probe_lc__only_tokB`, `mcp__probe_lc__server_time`. The model listed the same two. It never saw `only_tokA`.
- Server log: each session listed live.

  ```
     9.0s POST [token=tokA query=- session=-] server/discover
     9.0s POST [token=tokA query=- session=-] initialize
     9.0s GET [token=tokA query=- session=s1]: the client opens the stream for messages from the server
     9.0s POST [token=tokA query=- session=s1] tools/list -> 2 tools: server_time, only_tokA
    12.1s POST [token=tokB query=- session=-] initialize
    12.1s POST [token=tokB query=- session=s2] tools/list -> 2 tools: server_time, only_tokB
  ```

- No `mcp-discovery-cache` folder was created.

**Probe, cache on (`MCP_DISCOVERY_CACHE=1`).**

- **Token A, then token B:** two cache files. Session 2 listed live and saw `only_tokB` only.

  ```
    42.5s POST [token=tokA query=- session=s6] tools/list -> 2 tools: server_time, only_tokA
    53.5s POST [token=tokB query=- session=s7] tools/list -> 2 tools: server_time, only_tokB
  ```

  After session 1 the folder held `9d71bcd7e6cc88a1b976a0f5d9604e54.json`; after session 2 also `925f747d6c7d60424ef657779f2452c8.json`.
- **Token A again:** `init` showed `status: pending` and the tools `only_tokA`, `server_time`. The server log has no line at all for this session: the list came from the cache.
- **Same token, URL `?thread=1` then `?thread=2`:** two more cache files, both sessions listed live, and each saw only its own `only_thread_<n>`.

  ```
    70.6s POST [token=tokA query=?thread=1 session=s8] tools/list -> 3 tools: server_time, only_tokA, only_thread_1
    72.4s POST [token=tokA query=?thread=2 session=s9] tools/list -> 3 tools: server_time, only_tokA, only_thread_2
  ```

- **A cached list can be stale.** The server then gained `secret_word`. A new session with token A started from the cache: `status: pending`, two tools, no `secret_word`. It connected only when the model used a tool, and listed then:

  ```
    86.3s POST [token=tokA query=- session=-] initialize
    86.3s POST [token=tokA query=- session=s10] tools/call server_time
    86.3s POST [token=tokA query=- session=s10] tools/list -> 3 tools: server_time, only_tokA, secret_word
  ```

  In the one model request that followed, the model said no new tool had been announced. Whether a later request would have named it: unverified.

**Answer.** In no run did a session see or try a tool that only another token or another query string had. The reason is the key: the bearer header and the URL are both in it.

### A2. Codex

Source paths are under `codex-rs/` at `rust-v0.171.0`.

- **No disk cache for a configured server.** The only tool list written to disk is that of the built-in `codex_apps` server, in `$CODEX_HOME/cache/codex_apps_tools/`, keyed by account (`connectors/src/connector_runtime/persistence.rs`, `connector_runtime/mod.rs`). Same at 0.169 and 0.154.
- **There is a cache in memory, one per process:** `McpToolCatalogCache` in `codex-mcp/src/tool_catalog_cache.rs`. 32 entries, 30 minutes.
  - Its key is the server name plus a hash of the transport: `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, auth settings, protocol version, and a hash of the value of each environment variable the config names.
  - A server with `http_headers_helper`, OAuth, or stored OAuth credentials is not cached.
  - It does not replace the `tools/list` at start, which always runs (`codex-mcp/src/rmcp_client.rs`, the listing labelled `"initial"`). A new thread may be shown the cached list while its own connection is still starting.
  - It exists at 0.154 too, with the same size and lifetime and with the headers in its key.
- **Each thread has its own connections and its own list.** Connections are shared between threads only for stdio servers, only on protocol `2026-07-28`, and only with the feature `mcp_connection_sharing`, which is under development and off (`codex-mcp/src/connection_manager.rs`, `connection_pool.rs`, `features/src/lib.rs`). 0.154 has no sharing at all.
- **Probe: two threads in one app-server process**, same server name and URL, tokens `tokCA` and `tokCB`. Each thread made its own connection with its own token, and `mcpServerStatus/list` gave each thread its own list.

  ```
     1.9s POST [token=tokCA query=- session=s1] tools/list -> 2 tools: server_time, only_tokCA
     7.4s POST [token=tokCB query=- session=s3] tools/list -> 2 tools: server_time, only_tokCB
  ```

  `thread A: probe_lc tools = ["only_tokCA","server_time"]`, `thread B: probe_lc tools = ["only_tokCB","server_time"]`.
- **Hercule starts one app-server per session** (`apps/runner/src/harnesses/codex/adapter.ts`, "One app-server per session, not per account"), so even the in-memory cache is not shared between sessions.

### A3. pi 1.5.2

Source paths are under `packages/` at `v1.5.2`.

- **No disk cache.** The list is the `tools` field of each server connection, in memory, for one session (`coding-agent/src/extensions/mcp/runtime.ts`). The MCP code writes only `mcp.json`, `mcp-auth.json` and `mcp.log`.
- **Every `session_start` reconnects and lists again:** new, resumed, forked and reloaded sessions (`coding-agent/src/extensions/mcp/index.ts`, the `session_start` handler). Connecting starts in the background at session start, not at first use.
- **`tool_search` keeps no index.** It builds its ranking from the registered tools on every call (`coding-agent/src/extensions/tool-search/tool.ts`). The `searchTools()` of codemode does the same.

## B. When each harness re-reads the tool list

### B1. Codex, from source

- **`tools/list` runs when a connection starts.** That is once per thread start, and again only when the connection is replaced (`codex-mcp/src/rmcp_client.rs`). It does not run per turn.
- **The model's tool set is rebuilt from the in-memory list before every model request**, not frozen at thread start (`core/src/session/turn.rs`, `codex-mcp/src/runtime.rs`). So a changed in-memory list reaches the model at its next request.
- **`notifications/tools/list_changed`, default settings:** nothing is listed again. The handler writes a log line (`rmcp-client/src/logging_client_handler.rs`: `info!("MCP server tool list changed")`). 0.171 also counts the notification (`rmcp-client/src/tool_list_changes.rs`), but nothing reads the count while the feature below is off.
- **The feature `mcp_tool_list_changed` makes Codex list again.**
  - It first appears at `rust-v0.164.0` (2026-10-23). At 0.171.0 it is still `Stage::UnderDevelopment`, `default_enabled: false` (`features/src/lib.rs`). 0.154 does not have it.
  - It is turned on like any feature: `--enable mcp_tool_list_changed`, `-c features.mcp_tool_list_changed=true`, or `[features]` in `config.toml`. An under-development feature only adds a warning.
  - The re-list is lazy. It runs when the next model request is prepared, not when the notification arrives (`codex-mcp/src/connection_manager.rs`, `refresh_notified_catalog`; `connection_manager/tool_catalog.rs`). If it fails, the old list stays and Codex waits 5 seconds before trying again (`codex-mcp/src/client_tool_catalog.rs`).
  - It is read once per thread. `config/mcpServer/reload` does not change it for a loaded thread: unverified by probe.
- **`config/mcpServer/reload`** takes no parameters and needs no experimental capability (`app-server-protocol/src/protocol/common.rs`).
  - It re-reads the config from disk and applies it to every loaded thread (`app-server/src/mcp_refresh.rs`).
  - A server whose connection settings did not change keeps its connection, and is not listed again (`codex-mcp/src/connection_manager.rs`, the reuse branch).
  - A server whose URL, headers or other connection settings changed reconnects and lists again.
- **`mcpServerStatus/list`** with a `threadId` and no server name opens new connections of its own, lists live, and closes them. It does not change what the thread's own connection knows (`codex-mcp/src/mcp/mod.rs`; probe below).
- **No refresh method exists.** The app-server has no `mcpServer/refresh` or `mcpServer/reconnect`. Core has an `Op::RefreshMcpServers` that forces new connections, but nothing in the repository sends it.
- **`thread/resume` with a new `config`:** on a loaded thread that is running, the new config is ignored with a warning. On a loaded thread that is idle and has no subscribers, the thread is shut down and resumed cold, with new MCP connections (`app-server/src/request_processors/thread_processor.rs`). A cold resume always connects and lists again. Not probed.
- **The tool-search index** is built per thread and rebuilt only when the set of deferred tools changes (`core/src/tools/handlers/tool_search.rs`).

### B2. Codex, probe

One `codex app-server` 0.171.0 process, one thread, the probe server as `mcp_servers.probe_lc`.

**Default features.** The new tool never became usable, whatever was called.

| Step | What Codex did |
|---|---|
| `thread/start` | connected and listed once |
| Turn 1, "reply READY" | nothing sent to the server |
| The server adds `secret_word` and sends `list_changed` | received on the open stream; no request followed |
| Turn 2, "find and call the secret-word tool" | no request; the reply was `NO SUCH TOOL` |
| `mcpServerStatus/list` with the thread id | a second connection listed live and returned `["secret_word","server_time","only_tokC"]` |
| Turn 3, same question | no request; `NO SUCH TOOL` |
| `config/mcpServer/reload` | replied `{}`; no request |
| Turn 4, same question | no request during the turn; `NO SUCH TOOL` |

Server log. Session `s1` is the thread's connection; `s2` to `s4` belong to `mcpServerStatus/list` calls:

```
   1.3s POST [token=tokC query=- session=-] initialize
   1.3s GET [token=tokC query=- session=s1]: the client opens the stream for messages from the server
   1.3s POST [token=tokC query=- session=s1] tools/list -> 2 tools: server_time, only_tokC
   5.5s GROW: secret_word appears; 1 open stream(s) get tools/list_changed
   9.5s MARK: step 4: turn 2, ask for the secret-word tool
  17.9s MARK: step 5: mcpServerStatus/list
  17.9s POST [token=tokC query=- session=s3] tools/list -> 3 tools: server_time, only_tokC, secret_word
  18.6s DELETE [token=tokC query=- session=s3]: the client ends the session
  18.6s MARK: step 6: turn 3, ask again after mcpServerStatus/list
  23.2s MARK: step 7: config/mcpServer/reload
  27.2s MARK: step 8: turn 4, ask again after config/mcpServer/reload
  32.5s POST [token=tokC query=- session=s4] tools/list -> 3 tools: server_time, only_tokC, secret_word
```

Between 1.3s and the end, session `s1` sent nothing.

**With `--enable mcp_tool_list_changed`.** The new tool was usable in the next turn, and inside a running turn.

- A change between turns was listed when the next turn started, and the tool was called:

  ```
     8.0s GROW: secret_word appears; 1 open stream(s) get tools/list_changed
    12.0s MARK: step 4: turn 2, ask for the secret-word tool
    12.1s POST [token=tokC query=- session=s1] tools/list -> 3 tools: server_time, only_tokC, secret_word
    16.5s POST [token=tokC query=- session=s1] tools/call secret_word
  ```

  The turn's reply was `marmalade-4821`.
- A change inside a turn (the model ran a shell command that added `late_two`, then looked for it) was listed before the model's next request, and the tool was called in the same turn:

  ```
    20.9s GROW: late_two appears; 1 open stream(s) get tools/list_changed
    25.0s POST [token=tokC query=- session=s1] tools/list -> 4 tools: server_time, only_tokC, secret_word, late_two
    29.1s POST [token=tokC query=- session=s1] tools/call late_two
  ```

- A new thread always lists at start, so it sees the current list.

### B3. Claude Code

- **On `list_changed` Claude Code fetches the list again.** In `-p` and in the Agent SDK it refreshes the tool list only, not prompts or resources. If the refresh fails, the old list stays ([MCP docs, Dynamic tool updates](https://code.claude.com/docs/en/mcp#dynamic-tool-updates)).
- **The list of deferred tool names the model sees is updated too**, not only what `ToolSearch` finds. Probe, a change inside a turn: the model ran `curl -X POST .../__grow && sleep 4` and was then asked what it could see without calling `ToolSearch`.
  - Before: `mcp__probe_lc__only_tokE`, `mcp__probe_lc__server_time`.
  - After: the same two plus `mcp__probe_lc__secret_word`. The model quoted the reminder it had received: "The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded ... mcp__probe_lc__secret_word".
  - Server log:

    ```
       3.4s GROW: secret_word appears; 1 open stream(s) get tools/list_changed
       3.4s POST [token=tokE query=- session=s1] tools/list -> 3 tools: server_time, only_tokE, secret_word
    ```

- **Streaming input needs nothing extra.** Probe: one process with `--input-format stream-json`, message 1, then the change while the session was idle, then message 2.
  - Claude Code listed again at once, while idle:

    ```
       2.3s GROW: secret_word appears; 1 open stream(s) get tools/list_changed
       2.3s POST [token=tokG query=- session=s1] tools/list -> 3 tools: server_time, only_tokG, secret_word
       6.3s MARK: g1 message 2
    ```

  - The `init` message of message 2 listed three `mcp__` tools, and the model received the same reminder naming `mcp__probe_lc__secret_word`.
  - `setMcpServers()` and `reconnectMcpServer()` are not needed for a list change on a server that stays configured.
- **A removed tool is announced as well.** The binary holds the texts "The following deferred tools are no longer available ..." and "The following tools are no longer available. Do not call them:" (binary 2.1.329). Not probed.
- **Claude Code asked `server/discover` first** in every run that connected, got "no method", and then used `initialize` and a GET stream. That is the v2 client runtime asking for `2026-07-28` ([MCP docs, MCP client runtimes](https://code.claude.com/docs/en/mcp#mcp-client-runtimes)).
- **On a server that speaks `2026-07-28`, the notification stream has reopen limits.** A stream that closes within 10 seconds is reopened three times, then no more for that connection. A stream that closes later is reopened five times an hour, then Claude Code waits about six hours. Until it reopens, the session keeps the last list ([MCP docs, Notification streams on the v2 runtime](https://code.claude.com/docs/en/mcp#notification-streams-on-the-v2-runtime)). What Claude Code does when a legacy GET stream closes: unverified.
- **A resumed session connects its servers again.** The docs describe a resumed session whose "MCP server is still connecting", and hold a tool call up to 10 seconds for it ([MCP docs](https://code.claude.com/docs/en/mcp)). In every probe a connect was followed by `tools/list`. With the discovery cache on and a fresh entry for the same name, URL and headers, the start reads the cache and sends nothing (A1). Resume itself was not probed.

### B4. pi 1.5.2

- **`list_changed` is handled.** The client lists again and registers the tools again (`coding-agent/src/extensions/mcp/runtime.ts`):

  ```ts
  client.onNotification("notifications/tools/list_changed", () => {
      void this.refreshTools(client);
  });
  ```

  A withdrawn tool is registered again as `hidden`, because pi cannot unregister a tool. The docs agree: "When a server announces a changed tool list, new tools are added and withdrawn tools become unreachable" (`coding-agent/docs/mcp.md`).
- **pi opens the GET stream** by default, after `notifications/initialized`, and reconnects it with backoff. A 405 answer ends the attempts (`mcp/src/transports/streamable-http.ts`).
- **When the model notices:** `tool_search` and codemode scripts see the new tools at their next call, because neither keeps an index. A `direct` tool is declared from the next model request. That last step was read, not run: unverified.
- **`pi.registerMcpServer()` again with the same name:**
  - with the same config: nothing happens. No reconnect, no new list;
  - with a different config: the old tools are hidden, the old connection closes, and a new connection starts and lists at once (`coding-agent/src/extensions/mcp/index.ts`, the `mcp_servers_change` handler; the comparison is on `JSON.stringify(config)`).
  - `pi.unregisterMcpServer()` hides the tools and closes the connection.
- **No call re-lists a server on request.** The user command `/mcp reconnect [server]` does. `/reload` restarts every connection.
- **Which modes load the built-in MCP, tool-search and codemode extensions:**
  - the CLI in every mode, RPC included: `main.ts` puts `builtInExtensions` first, then starts interactive, print or RPC mode;
  - SDK sessions do not. The program adds `createMcpExtension()`, `createToolSearchExtension()` and `createCodemodeExtension()` (`coding-agent/docs/sdk.md`);
  - `--no-extensions` drops them, and `-e builtin:mcp` loads one back (`coding-agent/src/cli/args.ts`, `core/package-manager.ts`). The built-in names are `mcp`, `tool-search` and `codemode`.
- **Hercule starts pi with `--mode rpc --no-extensions -e <its own extension>`** (`apps/runner/src/harnesses/pi/adapter.ts`). On a pi that has MCP, that command line loads none of the three.

## C. Tool search over one large server

### C1. One server with prefixed names against several servers

**Claude Code**

- **No limit on tools per server.** "Claude Code doesn't impose a fixed per-server tool cap; the practical limit is your context window budget" ([MCP docs, tool search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search)).
- **A full name over 128 characters drops the tool.** Claude Code leaves out a tool whose `mcp__<server>__<tool>` name is longer than 128 characters. Before 2.1.292 it sent the tool and every request failed with a 400 ([MCP docs](https://code.claude.com/docs/en/mcp#tools-with-names-longer-than-128-characters)).
- **Descriptions are cut**, at 16,384 characters for a deferred tool (see note B1).
- **Every name is listed, also for one big server.** Probe: one server with 43 tools, then with 303 tools, named `mcp__probe_lc__<group>__tool_<i>`. The `init` message listed 43 and 303 `mcp__` tools, and the model reported one row per tool in its deferred list, 303 rows in the second run.
- **How `ToolSearch` matches** (binary 2.1.329, `Pw`, `aJt`):
  - a tool's name is split into the server name and the tool name, and those again at `_`, `.` and spaces. `mcp__hercule__sentry__find_issue` gives the parts `hercule`, `sentry`, `find`, `issue`;
  - a query word that equals a part scores highest. A word found in the description scores lower;
  - `+word` keeps only tools with that word in a name part or in the description;
  - a query that starts with `mcp__` returns the tools whose name starts with it. So `mcp__hercule__sentry__` works as a group prefix.
- **What differs with one server:** the server-name part is the same for every tool, so it tells nothing apart. The group word does that job, and it is matched the same way as a server name.
- **The binary also holds a shortened form of the list**, in which a server with more than 30 tools becomes one row, `mcp__<server>__* (<count>)`, with no names (binary 2.1.329, `pHe`, the text "This list is shortened to save room"). It did not show in the probes, and no code that turns it on was found in the binary's text. When it applies: unverified. With one server it would hide every name behind one row.

**Codex 0.171**

- **Limit: 2,048 tools per server** (`codex-mcp/src/pagination.rs`, `MAX_MCP_CATALOG_ITEMS`), in at most 100 pages. One tool more is an error, not a cut: the server fails to start with "tools/list exceeded the catalog limit of 2048 items".
- **Name limit: 128 characters** for namespace plus tool name. A longer name is cut and given a 12-character hash. Any character outside `[A-Za-z0-9_]` becomes `_` (`codex-mcp/src/tools.rs`). So a `.` or `-` in an upstream tool name changes.
- **The model sees a namespace per server, not flat names.** Server `hercule` with tool `sentry__find_issues` is namespace `mcp__hercule`, function `sentry__find_issues` (`codex-mcp/src/rmcp_client.rs`, `core/src/tools/handlers/mcp.rs`).
- **Up front the model sees no tool names.** When the model supports the search tool, every MCP tool is deferred. The model gets the `tool_search` tool and a list "Deferred tool namespaces", one line per server: the namespace and the first line of the server's instructions, at most 250 characters. The whole list is at most 4 KiB (`core/src/context/world_state/tools.rs`; feature `deferred_tool_world_state`, stable and on at 0.171). With one server that is one line for everything behind the gateway.
- **At 0.154 that list is off.** The `tool_search` description names each server with its instructions instead (`core/src/tools/tool_search_spec.rs` at `rust-v0.154.0`).
- **Search** is BM25 over one document per tool: names, server name, title, description, the server's instructions and the input property names. Eight results by default (`core/src/tools/handlers/mcp.rs`, `tools/src/tool_discovery.rs`). With one server, the server name and instructions repeat in every document and tell nothing apart.
- **Descriptions** of configured servers' tools are not cut. Input schemas are compacted to 5,000 bytes (`tools/src/json_schema.rs`).
- Not probed on Codex with a large list.

**pi 1.5.2**

- **Name limit: 64 characters** for `mcp__<server>__<tool>`. A longer name keeps its first 55 characters and gets an 8-character hash (`mcp/src/naming.ts`). With `mcp__hercule__<group>__<tool>`, a long name loses the end of the tool part. Characters outside `[A-Za-z0-9_]` become `_`.
- **No limit on tools per server** was found. Descriptions are not cut.
- **Default exposure is `codemode`:** the model sees no MCP tool names. It sees one line per server in an `mcp_servers` section of the system prompt (`coding-agent/src/extensions/mcp/index.ts`). `deferred` gives the same section and the `tool_search` tool.
- **`tool_search`** is BM25 over name, description and the server's instructions, eight results by default, with no grouping by server (`coding-agent/src/extensions/tool-search/tool.ts`). A query that equals a full name, or the part after any `__`, wins first. So `<group>__<tool>` and `<tool>` both find the tool.

**MCP specification**

- Tool names should be 1 to 128 characters, of ASCII letters, digits, `_`, `-` and `.` ([Tools, Tool Names](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool-names)). No limit on the number of tools or on description length.

### C2. A server's `instructions`

| Harness | Shown to the model | Limit |
|---|---|---|
| Claude Code 2.1.329 | Yes, at session start, under the server's name. Probe: the model quoted "## probe_lc" and "PROBE INSTRUCTIONS: the code phrase is walnut-77. Tool groups: sentry, linear, github." | 4,096 characters ([MCP docs](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search)). Probe with 5,000 extra characters: the text ended in "… [truncated]" and the model never saw the end marker. 2,048 before 2.1.296. |
| Codex 0.171 | First line in the "Deferred tool namespaces" list. The whole text as the namespace description once a tool of the server is loaded, and in the search text. | 250 characters for the first line, 4 KiB for the list. 512 KiB for the namespace description. |
| Codex 0.154 | In the `tool_search` description, per server, and as the namespace description. | 512 KiB in total. |
| pi 1.5.2 | First line in the `mcp_servers` section, and only when the server's config has no `description`. The whole text feeds `tool_search` ranking. A server with only `direct` tools: nowhere. | 250 characters per server, 4,096 for the section. |

- Claude Code sends changed instructions to the model as an update of their own (binary 2.1.329, attachment type `mcp_instructions_delta`). Whether a server can change its instructions without a reconnect: unverified. The protocol sends them only in the `initialize` result.

## What this means for the gateway

### Claude Code

1. **A list that differs per thread at one address is safe** when each session sends its own bearer token, or its own URL.
   - Cache off (the default from 2.1.238 unless rolled out): there is no cache. Every session lists live.
   - Cache on: the cache key holds the URL and the headers, so two sessions with different tokens or different query strings never share an entry (probed).
   - Not safe: two threads that send the same token to the same URL with the cache on. The second starts from the list the first one cached, and sends nothing until its first tool call (probed with one token used twice).
   - `MCP_DISCOVERY_CACHE=0` in the session's `env` turns the cache off for good, at the cost of the first turn waiting for the connection.
2. **A server added mid-thread is usable as soon as the gateway sends `notifications/tools/list_changed`** on the session's open stream. Claude Code lists again at once, also while idle, and the model is told the new names with its next request (probed inside a turn and between messages). Nothing else is needed.
3. **Open risks.**
   - With the cache on, a session whose token and URL are the same as in an earlier run starts from the cached list and sends nothing until its first tool call. A thread that keeps its token across a restart or a resume could start with an old list.
   - With the cache on, every session with its own token leaves one sealed file in `<CLAUDE_CONFIG_DIR>/mcp-discovery-cache/`. Whether old files are ever removed without being read: unverified.
   - The session misses the notification when its stream is closed. For a gateway that speaks `2026-07-28` the reopen limits of B3 apply.
   - A full tool name over 128 characters is dropped without a message to the model.
   - A shortened name list exists in the binary. If it ever applies, one gateway server becomes one row with no names.
   - Instructions are cut at 4,096 characters.

### Codex

1. **A list that differs per thread at one address is safe.** No disk cache for a configured server. Each thread has its own connection and lists at thread start. The in-memory cache is keyed by the headers, and Hercule runs one app-server per session.
2. **A server added mid-thread is not usable with default settings**, at 0.154 or at 0.171. Codex gets the notification and does not list again. `config/mcpServer/reload` and `mcpServerStatus/list` do not change that for a server whose settings stayed the same (probed). What does work:
   - **Codex 0.164 or newer with `mcp_tool_list_changed` on.** The gateway sends `list_changed`; Codex lists before the next model request (probed at 0.171). The feature is under development and off by default.
   - **A new connection.** A thread that starts, or resumes cold, lists again. That means ending the thread's app-server and resuming the thread. From source; not probed.
   - **A changed connection setting plus `config/mcpServer/reload`.** A server whose URL or headers changed in the config on disk reconnects and lists. A setting given in `thread/start`'s `config` cannot be changed for a loaded thread. From source; not probed.
3. **Open risks.**
   - The pinned 0.154 has neither the feature nor the counter behind it.
   - The feature can change or go away: it is under development.
   - At 0.171 the model sees one line for the whole gateway: `mcp__<server>` and the first 250 characters of the first line of the instructions. It sees no tool names until it searches.
   - More than 2,048 tools from one server fails the server.
   - Tool names with `.` or `-` reach the model with `_` in their place.
   - Whether a given model gets tools deferred or direct is set by model data that the source does not hold.

### pi

1. **A list that differs per thread at one address is safe.** Nothing is cached on disk, and every session start lists again.
2. **A server added mid-thread is usable after `list_changed`**: pi lists again and registers the tools (from source; not probed). Registering the gateway again with the same config does nothing. A changed config reconnects it.
3. **Open risks.**
   - Hercule pins 0.85.1, which has no MCP.
   - Hercule's command line has `--no-extensions`, which drops the built-in MCP, tool-search and codemode extensions on a pi that has them. Each needs `-e builtin:<name>`.
   - The 64-character name limit cuts long `mcp__<server>__<group>__<tool>` names.
   - With the default `codemode` exposure the model sees one line per server and no tool names. With one gateway server that is one line.
   - A withdrawn tool stays registered as hidden for the rest of the session.

## Unverified

- Whether `discoveryCache: false` on a server entry is honoured when passed through the Agent SDK. It is in the binary's schema only.
- Whether Claude Code names a tool that a cached session finds on its first connect, in a later request of the same session.
- Whether Claude Code ever removes unread files from `mcp-discovery-cache`.
- What Claude Code does when a legacy GET stream closes while the session stays alive.
- When Claude Code's shortened deferred-tool list applies.
- How a resumed Claude Code session lists and announces tools. Not probed.
- Whether `features.mcp_tool_list_changed` in the `config` of `thread/start` takes effect. It was probed only as a process flag.
- Codex's cold resume and changed-config reload paths. Read in source, not run.
- Codex with several hundred tools on one server. Not run.
- Everything about pi's behaviour at run time. Source only.
- Whether a server may change its `instructions` on an open connection in any harness.
