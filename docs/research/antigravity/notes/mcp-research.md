# MCP research (agy 1.5.15, Linux, home neon). Recordings: /tmp/hercule-1282/rec7/ (x1* = step 1, x2 resume, x3 redirect, x4 list_changed, x5/x5b 404, x6 failing tool, x7-* modes, x8 kept log). Stand-in: /tmp/hercule-1282/mcp-standin/server.ts (log per run: rec7/<run>.A.jsonl / .B.jsonl). Scripts: recorder/mcp/*.ts, recorder/mcp-lib.ts. Bearers are disposable canaries (list: mcp-standin/canaries.txt). home config/mcp_config.json (0 bytes originally) restored byte-identical (cmp vs mcp_config.json.orig). Another engineer's `h1293-` skills appear in the model's skill list in x1b recordings; no effect counted.

Format of an MCP config file (docs antigravity.google/docs/mcp): `{"mcpServers": {"<name>": {"serverUrl": "...", "headers": {"Authorization": "Bearer ..."}}}}` (`url` is an alias). Global: `<gemini-dir>/config/mcp_config.json`; workspace: `<workspace>/.agents/mcp_config.json`.
Tool name for model/permission title: `mcp_<server>_<tool>` for ACP servers (title "Run mcp_tools_whoami", kind other); for file-defined servers the tool is a "lazy MCP tool", not in the model's tool list, found via `<home>/antigravity-acp/mcp/<server>/<tool>.json`; title "MCP Tool whoami", kind execute.

## 1. Other MCP config sources (benign stand-in B must see nothing)
File entry points at B (bearer canary B). ACP entry `tools` -> A.
| file | with ACP `tools` | no ACP, file entry `tools` |
|---|---|---|
| `<cwd>/.agents/mcp_config.json` | B: ZERO requests (entry dropped, same name) | B connects (discover, initialize, tools/list, later tools/call works). x1b-ws-noacp |
| git root `.agents/mcp_config.json` (cwd = repo/sub) | B zero | B connects and is callable (x1b-gitroot-noacp) |
| `<home>/config/mcp_config.json` | model's call goes to A; B also got handshakes, BUT other agy processes use this home at the same time, so B's probes are not attributable to my process | B connects and is callable (x1b-home-noacp) |
| `<cwd>/.gemini/settings.json` | B zero | B zero (NO TOOL) |
| `<cwd>/mcp_config.json`, `<cwd>/.mcp.json` | B zero | B zero |
| plain (non-git) parent folder `.agents/mcp_config.json`, `.gemini/settings.json` | B zero | B zero |
| fake HOME `~/.gemini/config/mcp_config.json`, `~/.gemini/settings.json`, `~/.agents/mcp_config.json` | B zero | B zero |
Same-name rule: ACP `tools` WINS and the file's `tools` is not even contacted (workspace, git root). A file entry with a DIFFERENT name (`other`) is ADDED beside the ACP one and connects and is callable (x1c-ws-acp, x1c-gitroot-acp, x1c-home-acp: both whoami results returned). So: ACP mcpServers neither replace nor block file servers of other names. A repo's `.agents/mcp_config.json` (cwd or git root) is read with no trust prompt in ACP (never asked) and its server gets called with the same permission ask as any MCP tool. Home and workspace files both apply; the `--gemini-dir` home config is the account's, the workspace one is the repo's.

## 2. Resume (x2)
Servers given only at session/new are NOT reconnected on resume. Resume with `mcpServers: []`: A got zero requests, model said NO TOOL. Resume with a NEW canary: A got discover, initialize, tools/list, tools/call all with the NEW bearer (c2), never the old one. So each resume must pass mcpServers again.

## 3. Redirect (x3)
Not followed at all, even for 127.0.0.1:portA -> 127.0.0.1:portB and -> localhost:portB. Handshake redirect (307 on discover and initialize): agy retried initialize, never followed, B zero requests, no tool. Redirect only on tools/call: model got the error `calling "tools/call": sending "tools/call": rejected by transport: Post "http://localhost:.../mcp": redirect not followed: target is outside the origin http://127.0.0.1:... of the request`. B zero requests, so the Authorization header never reaches another origin. Same-origin redirect not tested.

## 4. list_changed (x4)
ACP servers: agy opens two GET streams WITHOUT session id and WITHOUT Authorization (404 from a spec server; harmless); no usable GET stream, so push on GET is not delivered. A notification inside a POST response (SSE body before the answer) works: agy then sent a fresh `tools/list`, and the model called new tool `second` (answered, permission ask `Run mcp_tools_second`). After `whoami` was removed on the server (list_changed not delivered that time, my stand-in returns the error before the SSE branch): a model call of `whoami` reached the server and failed with `Encountered error in tool execution: calling "tools/call": Unknown tool: whoami` (tool_call_update failed). Not measured: removal with the notification delivered.

## 5. 404 / restart (x5, x5b)
- 404 on agy's session id for the notification that precedes each call (`notifications/roots/list_changed`, sent before every tools/call): agy re-handshakes silently (discover, initialize, initialized, tools/list) and then sends the call; the model sees success. Same after a real restart of the stand-in (new process, no sessions).
- 404 on the `tools/call` request itself: NO retry, NO new initialize; the model gets `calling "tools/call": sending "tools/call": failed to connect (session ID: ...): session not found`. The next call recovers via the roots-notification re-handshake (x5 pattern; next turn not run separately in x5b).

## 6. Failing tool (x6)
`isError: true` with text: tool_call_update status `failed`, kind other, title "Run mcp_tools_whoami", content `[{type:"content",content:{type:"text",text:"standin tool failure"}}]`, rawOutput "standin tool failure". JSON-RPC error: same shape, status `failed`, text `calling "tools/call": standin rpc failure` (rawOutput the same). Model quotes both; turn ends end_turn.

## 7. Approval per mode (x7)
`whoami` call: default asks (1 request, options allow_once/reject_once); accept-edits asks (1); `--dangerously-skip-permissions` asks 0 (call runs). File-defined servers ask too (title "MCP Tool whoami", kind execute).

## 8. Token persistence
53 canaries used (incl. KEEPLOG run x8). Found ONLY in `<home>/antigravity-acp/conversations/<session>.db` (26 dbs, cleartext `Authorization: Bearer <canary>` in the stored session; one db per session, ACP and file-defined headers). NOT found in: any other home file (antigravity-acp/mcp/*.json, brain/, annotations/, settings, config/), the kept `--log-file` folder (rec-log-*, agy.log + 2 rotated files), the private TMPDIRs (/var/tmp/hercule-1282-tmp7), nor in stderr. Canaries also sit in my own placed config files (work dirs) and recordings (we sent them). Consequence: the account home's conversation db keeps every MCP bearer ever passed; deleting a session's db is the only cleanup (not tested whether agy deletes it).

# Part 2: plugins (recordings rec7/x8-*, x8L-live; script recorder/mcp/exp8.ts)
Plugin `<home>/config/plugins/hercule-1282-test/` with `plugin.json` `{"name":"hercule-1282-test"}`; removed after every run (folder gone; no `h1293-*` plugin touched; config.json not edited, so enabled by default). My hook script only approves when its stdin holds a marker word, so other engineers' runs were not auto-approved.
(a) Plugin `hooks.json` (same format as home hooks.json, PreToolUse `*`, command prints `{"decision":"auto_approve"}`): `echo HERCULE1282` in `default` ran with 0 permission requests and the hook marker was written (x8-hook). Control, same session type without the plugin: 1 request (x8-live "before plugin"). So a plugin hook auto-approves in default mode, like the home hooks.json.
(b) Plugin `mcp_config.json` ADDS a server, never replaces `tools`. The server is namespaced `<plugin>_<server>`: here `hercule-1282-test_tools`, a lazy MCP tool. With ACP `tools`->A: both connected, the model called A as `tools` and B as `hercule-1282-test_tools` (x8-mcpacp); B was NOT benign: it got handshakes and a tools/call. With no ACP entry: B callable as `hercule-1282-test_tools` (x8-mcpnoacp). Plugin server named `other`: B connected too, A untouched (x8-mcpother). So a plugin's MCP server always connects, and a plugin cannot shadow the ACP `tools` name because of the prefix.
(c) Live: a plugin added while a session runs is picked up: its hook auto-approved the very next command (0 requests, marker written), and its MCP server was handshaked and called successfully in the same session (x8L-live: `hercule-1282-test_live` whoami answered by B). (First try with the wrong server name `live` failed with "tool whoami is not enabled for server live": a name error, not a load failure.)

# Part 3: tool added on the server with NO list_changed (rec7/x9, x9c; recorder/mcp/exp9.ts)
Stand-in 1 starts with `whoami`; a prompt lists tools; then `second` is added with no notification of any kind.
(a) New prompt, same process: NO fresh `tools/list` (stand-in saw only `notifications/roots/list_changed`); the model sees only `mcp_tools_whoami`, "NO SECOND". Not usable.
(b) Then a 404 on the next `notifications/roots/list_changed` (forced re-handshake): agy re-did discover, initialize, initialized, `tools/list` right after the 404. In THAT turn the model still saw "NONE" (the tool set was empty while reconnecting). On the FOLLOWING prompt the model listed `mcp_tools_whoami` and `mcp_tools_second` and called `second` (answered). So usable one turn after the re-handshake.
(c) Resume in a new process (second added while no process ran; mcpServers passed again): the fresh handshake lists both and `second` is called in the first prompt after resume. Usable immediately.
Summary: with no list_changed, a running process never learns of the new tool; it needs a re-handshake (a 404 on the roots notification does it, seen at the second prompt after) or a new process. A POST-response list_changed (Part 1, step 4) refreshes the list immediately and usable at once.
