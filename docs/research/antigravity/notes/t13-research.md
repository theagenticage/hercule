# t13: what the home PreToolUse hook sees when agy's browser subagent starts (agy 1.5.15, Linux, no Chrome)

Setup: copy of the pinned binary (`--version` 1.5.15); new scratch Harness Home with a 0600 copy of the neon login; fake HOME; private TMPDIR (both under /var/tmp/hercule-1282-t13/, since deleted); work folder = fresh git repo under /var/tmp; env from nothing plus PATH, HOME, TMPDIR, `SSH_CONNECTION`, `AGY_CLI_DISABLE_AUTO_UPDATE=true`; flags `--gemini-dir <home> --app-data-dir antigravity-acp --process-per-session --log-file <scratch>`. Home hook `config/hooks.json`, PreToolUse, matcher "", a `sh` script that appends `<epoch ms> <stdin>` to a log and prints nothing (allow). Mode `default`, model `gemini-3.8-flash`, every permission request answered with reject and counted. One prompt per session. PATH of runs A/B: the machine PATH, which has node 24 and npx (`/home/<user>/n/bin`). `ps -eo pid,ppid,args` plus a listing of the launcher paths every 0.5 s (0.1 s in the extra runs).
Driver: recorder/scenarios/t13-run.ts, t13-session.ts. Raw logs: /tmp/hercule-1282/rec13/ (`<run>.hook.log`, `.out`, `.jsonl` = ACP recording, `.ps.txt`, `.files.txt`, `.agy.log`; first line of each = setup note). Token and email scrubbed (checked by value and by regex, nothing needed changing). Nothing written to homes/neon or ~/.hercule.

## Facts

### Run A: `/browser open https://example.com and tell me its title`
Hook calls in order (t = ms after prompt start):
1. t+5.5 s, PARENT conversation: `invoke_subagent`, args `{"Prompt":"Open https://example.com and get its page title.","Role":"Web Browser","TypeName":"browser"}`. `lastUserInput` = the `/browser ...` text.
2. t+11.7 s, SUBAGENT conversation (own `conversationId`, `lastUserInput` ""): `mcp_chrome_devtools_list_pages`, args `{"toolSummary":"List open pages"}`.
3. t+23.4 s, subagent: `send_message`, args `{Message:"Connection to Chrome could not be established ... (could not find DevToolsActivePort) ...", Recipient:<parent conversationId>}`.
4. t+27.3 s, parent: `run_command` `which google-chrome chromium chromium-browser chrome 2>/dev/null; ps aux | grep -i chrome`.
ACP side (the client sees only the PARENT): `tool_call` "Run invoke_subagent" kind `other`, in_progress then completed, rawInput = the args above, rawOutput null; then the parent's `run_command` (kind `execute`, pending -> in_progress -> failed after our reject, rawOutput `{"output":""}`). The subagent's `mcp_chrome_devtools_list_pages` and `send_message` never appear as ACP updates. Permission requests: 1 (the parent's run_command, rejected). `invoke_subagent` and the MCP call raised none. Turn ended `end_turn` after 27 s.

### Run B: plain prompt "Use your browser agent to open https://example.com and tell me the page title."
Tried 4 times (B, B2, B3, B4): every time the model used `run_command` `curl -s https://example.com` (B3 also `read_file` first). Hook saw only those; no `invoke_subagent`, no launcher, nothing created. Also "Use the browser subagent to open ..." (B5v1): curl again. A prompt that names the tool, "Delegate to the browser subagent (invoke_subagent, TypeName browser): open https://example.com in Chrome and report the page title. Do not use curl." (B5v2) started the subagent. B5v2 hook order, identical in shape to A: parent `invoke_subagent` (`Role":"Browser Agent","TypeName":"browser"`), subagent `mcp_chrome_devtools_list_pages` (`{"toolSummary":"List open browser pages"}`), subagent `send_message`, parent `run_command` (`which google-chrome ...; ps aux | grep -i chrome`). 1 request (the run_command). So with a plain prompt the browser subagent is not reliably chosen by Gemini 3.8 Flash; it is chosen when asked by tool name or with `/browser`.

### What the launcher is
`npm exec chrome-devtools-mcp@latest --no-usage-statistics --no-performance-crux --autoConnect` (parent: the agy per-session worker), which runs `sh -c "chrome-devtools-mcp" --no-usage-statistics --no-performance-crux --autoConnect` -> `chrome-devtools-mcp` (node), plus a short `node .../bin/check-latest-version.js <fakehome>/.cache/chrome-devtools-mcp/latest.json`. It is `@latest` (installed 1.14.0), NOT 1.12.0. It runs `npm exec` from the PATH: it did not download Node and did not use `/tmp`.

### Does the hook come BEFORE the launcher?
Yes, measured with a delaying hook (extra run `run_sleep`): the hook slept 4 s on `invoke_subagent`. Hook started at ...106975, finished at ...110980. First `npm exec chrome-devtools-mcp@latest` process seen at ...111069 (90 ms after the hook returned, nothing in 4 s before). So agy waits for the hook before it starts the launcher. In the plain runs (A, B5v2) the first hook line is 0.5 s before the first sample that shows `npm exec` (A: hook 909012, `_npx` created 909438, first ps sample 909534), consistent but too coarse alone; the sleep run is the proof.
Deny (extra run `run_deny`): the hook denied `invoke_subagent` -> ACP `tool_call_update` status `failed`, rawOutput `tool call denied by pre-tool hook: t13 deny`. No subagent, no MCP call, no `npm exec` process in 0.1 s sampling, nothing created under fake HOME or TMPDIR; the model told the user the launch was denied. So a deny on `invoke_subagent` comes before the launcher and prevents it.
The launcher starts at subagent start (before the subagent's first tool call), not on the first `mcp_chrome_devtools_*` call.

### Subagent start in the hook (item 4)
- Name `invoke_subagent` (same tool as every subagent). Args: `Prompt`, `Role` (model-chosen: "Web Browser" / "Browser Agent"), `TypeName` = `"browser"`. A gate should match `TypeName == "browser"` (and be careful that `Role` is free text).
- Subagent MCP calls reach the hook with the subagent's `conversationId` and name `mcp_chrome_devtools_<tool>` (seen: `mcp_chrome_devtools_list_pages`). They are not seen over ACP. No permission request was raised for it in default mode.
- Without node on PATH (extra run C, PATH=/usr/bin:/bin): hook saw `invoke_subagent` (TypeName browser), then the subagent's `manage_task {"Action":"list"}` and `send_message` ("The chrome_devtools MCP server is not available at all"), then the parent's `run_command` curl. No `mcp_chrome_devtools_*` call, no process, nothing downloaded or created. So no Node download was observed; with no npx the launcher just fails.

### What the launcher left behind (run A, fresh fake HOME and TMPDIR before it)
- `<HOME>/.npm/` (16 MB): `_cacache`, `_logs`, `_npx/15c61037b1978c83/node_modules/chrome-devtools-mcp` (package.json `chrome-devtools-mcp@latest`, ^1.14.0), `_update-notifier-last-checked`. Created at +0.2..0.7 s after the hook.
- `<HOME>/.cache/chrome-devtools-mcp/latest.json`.
- `<TMPDIR>/node-compile-cache/` (2.8 MB; Node compile cache).
- Nothing new in `/tmp` with node/chrome/devtools/npm in its name (before/after name list identical; `/tmp/node-compile-cache` and `/tmp/node-jiti` existed before, from other tools on this machine). Real `~/.npm/_npx` existed before and was not touched (fake HOME was used).
- No process remained after the run (agy's close stops `npm exec`, `sh`, `chrome-devtools-mcp`); once a `[npm exec chrome]` zombie was seen in a sample after agy exit (run_sleep) and was gone at the next check. No Chrome was started.
List: rec13/runA.leftovers.txt.

## Not measured / limits
- No Chrome here: after the launcher starts, the MCP tools fail ("could not find DevToolsActivePort"), so a successful page open was not measured; hook calls with a working Chrome (`navigate_page`, `take_snapshot`, ...) are untested. The tool name pattern is `mcp_chrome_devtools_<tool>`.
- Run B (plain prompt) never started the subagent in 5 tries; its hook sequence is from B5v2 (a prompt naming the tool). `/browser` is the deterministic route (A, sleep, deny, C all started it on the first try).
- The Node 22.20.0 download branch was not seen: node was on PATH in A/B, and absent in C (nothing downloaded). Whether another condition (e.g. an old node on PATH) triggers a download was not tried.
- Hook-before-launcher is proved for the parent hook call by the sleep run (one run). One account, one binary, one model.
- Timing numbers come from `date` in the hook (ms) and a 0.5 s ps loop.
