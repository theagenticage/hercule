# The Antigravity harness: what the spike found

Research for adding Google's Antigravity CLI (`agy`) as the fourth harness, so a Google account can run Gemini models (and the Claude and GPT models Google resells) in Hercule. Done on 2026-11-23 to 2026-11-25 against a real `agy` 1.5.15 on macOS arm64, with two free-tier Google accounts, and by reading T3 Code's implementation at commit `c6fe23dd2871126cd189cf197761849e7ef0f91d`.

Everything marked **verified** was seen on the real binary. Everything marked **from T3** was read in T3 Code's source and not run by us. Everything marked **open** still needs a recording or a test.

- Recordings of real sessions, one JSON-RPC message per line: `docs/research/antigravity/recordings/`.
- The scripts that made them: `docs/research/antigravity/scripts/` (`record-turn.ts` records a session, `mcp-turn.ts` runs a turn against the repo's fake MCP server, `summarise.py` prints one line per message).

## 1. Decisions Rogier made

| Date | Decision |
|---|---|
| 2026-11-23 | The harness is `antigravity/antigravity`, run as `agy acp`. The provider is `google/google`. The first Account Kind is a subscription signed in on each machine. An API key kind is a follow-up. |
| 2026-11-23 | Copy T3 Code's Effect ACP client (`packages/effect-acp`, MIT) into our repo, with full attribution. An Effect upgrade to 4.1.5 was allowed, and turned out not to be needed. |
| 2026-11-24 | No Account Usage for a Google subscription in v1. `agy` does not report quota over ACP, and Hercule never calls a vendor itself with a subscription login (ADR 0048). A follow-up looks for a route through `agy`. |
| 2026-11-24 | Several Google accounts on one machine matter. A workaround is acceptable once cleaner routes are ruled out. They were (section 3). |
| 2026-11-24 | The Claude and GPT models that Google lists are shown, as models of the Google account, but not in the default menu: the default selection holds Google's own current models, and the others are found in the model browser by maker. Tentative. |
| 2026-11-25 | `packages/acp`: the copied files stay as copied, in a folder excluded from lint, so a sync with T3 is a plain copy. One small hand-written module in front, with our names and docstrings, is the only thing the rest of the code imports. It must also make it easy to swap the ACP library later. |
| 2026-11-25 | The adapter may read the `id_token_email` field of `agy`'s token file to report who is signed in. |
| 2026-11-25 | Steering: declare `unsupported` for now (tentative). Native steering is a follow-up. |
| 2026-11-25 | The build runs on the runner `beelink`. |
| open | Deny on Antigravity: offer only `allow` and `cancel`, or also `deny` (section 6.3). Recommended: `allow` and `cancel` only. |

## 2. The binary

- **What it is.** `agy` is Google's Antigravity CLI, a Go binary. It is not Gemini CLI: Gemini CLI stopped serving free and AI Pro/Ultra accounts on 2026-06-18 and those moved to `agy`.
- **Where it comes from (verified).** GitHub releases of `google-antigravity/antigravity-cli`, assets `agy_cli_<os>_<arch>.tar.gz` (`mac_arm64`, `mac_x64`, `linux_x64`, `linux_x64_musl`, `linux_arm64`, `linux_arm64_musl`, Windows zips). The archive holds one file named `antigravity`. It is not on npm, so `HarnessReleaseSource` needs a second member. Google's install script is `curl -fsSL https://antigravity.google/cli/install.sh | bash`; whether it can pin a version is **open**.
- **Version.** `antigravity --version` prints `1.5.15`. Gemini 4 Neon needs 1.5.12 or newer (from T3 and Google's changelog). T3 refuses anything below 1.5.
- **Releases come several times a week.** `AGY_CLI_DISABLE_AUTO_UPDATE=1` turns off its self-update (from T3; the variable is in the binary).
- **Useful commands (verified from `--help`).** `agy acp` starts the ACP server on stdio. `agy models` lists models. Print mode: `agy -p <prompt> --output-format json --json-schema <schema> --model <id> --effort <level>`, which is a native route for Text Generation and structured output.

`agy acp` flags that matter (verified, all listed by `agy acp --help`):

| Flag | Use |
|---|---|
| `--gemini-dir <dir>` | Where `agy` keeps everything. Per account, inside the Harness Home. |
| `--app-data-dir <name>` | A folder name below the gemini dir (we used `antigravity-acp`, as T3 does). |
| `--process-per-session` | **Required for HTTP MCP servers.** Without it `mcpCapabilities` is absent from the `initialize` reply; with it the reply has `mcpCapabilities: {http: true}`. |
| `--dangerously-skip-permissions` | Approves every tool call without asking. An MCP call ran with no permission request (`mcp-skip.out`). This is full access. |
| `--login` | Signs in, then exits. |
| `--log-file <path>` | Where the ACP log goes. |
| `--sandbox` | Terminal restrictions. Not tested. |

## 3. Sign-in and where the login is kept

**The flow (verified).**

```
agy acp --login --gemini-dir <dir> --app-data-dir antigravity-acp
  stdout: "Open this link in a browser to log in with Google:"
          ""
          "  https://accounts.google.com/o/oauth2/auth?...   (about 800 characters)"
          ""
          "Then paste the authorization code, or the full URL of the page you land on, and press Enter:"
  stdin:  <code>\n          (Google redirects to https://antigravity.google/oauth-callback, which shows the code)
  stdout: "Logged in as <email>."
  exit 0
```

- It works on plain pipes. No pseudo-terminal is needed.
- The link is on stdout. With stdin closed and no code, it exits 1.
- This is the shape of Claude Code's `sign-in`, so `apps/runner/src/harnesses/login.ts` fits as it is: the `AUTHORIZE` pattern finds the link, the code goes to stdin with a newline, and exit 0 is success.

**Where the login lands (verified on macOS).**

| Environment | Browser | Storage | Two accounts |
|---|---|---|---|
| Nothing special | `agy` opens the link itself with `open`, on the machine it runs on | The macOS login keychain, one fixed entry: service `gemini`, account `antigravity` | **No.** A second, empty `--gemini-dir` was signed in as the first account at once. |
| `SSH_CONNECTION` set (any value, we used `127.0.0.1 0 127.0.0.1 0`) | None. `agy` prints the link and waits. | A file, `<gemini-dir>/<app-data-dir>/antigravity-oauth-token`, mode 0600. The log says "Using file-based token storage because SSH session detected". | **Yes.** Account 2 in its own folder, an empty third folder not signed in, and the keychain entry untouched. |

What was ruled out before taking the variable:

- One `--gemini-dir` per account and nothing else: fails, as above.
- A different `--app-data-dir`: the keychain entry's name does not contain it.
- T3's older switch `AGY_ACP_FORCE_FILE_STORAGE`: the string is not in the 1.5.15 binary.
- A supported "use a file" switch: the binary has the message "Using file-based token storage because the caller requested it", but no flag, variable or setting we could find reaches it.

So the adapter sets `SSH_CONNECTION` on **every** `agy` process of an account: login, probe, sessions and text generation. A process without it looks in the keychain. Read it as "this session is driven from elsewhere", which is what a runner is. Its cost: the agent's own shell commands inherit the variable, so tools that check for SSH behave as if remote.

- **Linux (open).** The changelog says `agy` skips the keyring by itself when there is no D-Bus session bus. A headless runner should then need no variable, but set it anyway so both systems behave the same. Test this on `beelink`.
- **Who is signed in (verified).** The token file is JSON with `token.access_token`, `token.refresh_token`, `token.expiry`, `auth_method` and a plain `id_token_email`. Rogier allowed reading `id_token_email`. The email is also in each session's worker log (`<gemini-dir>/<app-data-dir>/log/acp-worker-*.log`, line `applyAuthResult: email=...`).
- **The plan (verified).** The reply to `authenticate {methodId: "oauth-personal"}` carries `_meta.antigravity.tier = {name: "Antigravity Starter Quota", id: "free-tier", upgradeUri}`. `session/new` carries the same.
- **Not signed in (verified).** `authenticate` fails with `-32603` "No browser is available here (this is a remote (SSH) session...) Run `agy acp --login`...", and `session/new` fails with `-32000` "Authentication required".
- **Other auth methods (verified list).** `oauth-personal`, `oauth-business` (Gemini Enterprise), `gemini-api-key` (`GEMINI_API_KEY`), `agent-platform` (Vertex). Only the first is in scope.
- **Open.** Whether the refresh token rotates when several `agy` processes share one folder. Whether `agy` writes a line to stderr after the code and takes more than 2 seconds to exit, which `login.ts` would read as "code rejected". Whether pasting the full landing URL exceeds the 512 character limit of a sign-in code.

## 4. ACP facts

**Handshake (verified).** `initialize` with `protocolVersion: 1` answers `protocolVersion: 1`. T3 sends 2 and notes that `agy` then reports 2 with the version 1 response shape.

```
agentCapabilities: {
  loadSession: true,
  promptCapabilities: { image: true, audio: false, embeddedContext: true },
  sessionCapabilities: { resume, close, load, list, additionalDirectories },   // no fork, no delete
  mcpCapabilities: { http: true },                                             // only with --process-per-session
  auth: { logout },
  _meta: { antigravity: { tier: true, systemPrompt: { append: true } } }
}
agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" }
```

Capabilities are sent twice, in camelCase and snake_case.

- **What the client must advertise.** `fs.writeTextFile: false` (from T3: with it, `agy` swaps diff edits for whole-file `client_edit_file`). `terminal: false`. `elicitation: { form: {} }`, which makes questions real requests (section 6.4).
- **Client name.** T3 identifies as `t3-code` since 1.5.1. Ours must be our own. Whether the name changes which models are offered is **open**; Google's docs and changelog disagree.
- **System prompt (from T3, capability verified).** `session/new` takes `_meta: { antigravity: { systemPrompt: { append } } }` when `agentCapabilities._meta.antigravity.systemPrompt.append` is true. This is where the orientation goes.
- **Session ready in about 2 seconds** after spawn (verified), so a probe fits the 15 second deadline.

**Models (verified, free tier).** The reply to `session/new` has `configOptions`:

- `model` (select): `gemini-3.8-flash`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. Flat, no groups, so the maker has to come from the id or the name.
- `thought_level` (select): `low`, `medium`, `high`. It is reported for the current model only. T3 walks each model once to learn its levels; Neon has Low, Medium, High and XHigh (from T3).
- `mode` (select): `default`, `accept-edits`, `auto`, `plan`.

Set them with `session/set_config_option {sessionId, configId, value}` and `session/set_mode {sessionId, modeId}`. An unknown model fails the change with `-32602 "Unknown model ID: ..."` and the session stays on its model (`bad-model.jsonl`). **Neon itself is untested**: neither test account has a subscription. The list is read per account, so Neon appears by itself on a subscribed one.

**MCP (verified).** `session/new` takes

```json
{ "type": "http", "name": "tools", "url": "<gateway url>",
  "headers": [{ "name": "Authorization", "value": "Bearer <session token>" }] }
```

- Every request to the server carried the header: `server/discover`, `initialize`, `notifications/initialized`, `tools/list`, `tools/call`.
- The tool arrives named `mcp_<server>_<tool>`: `mcp_tools_sentry__whoami`.
- `agy` asked permission before the call in `default`, `accept-edits` and `auto`, also for a tool marked read-only. That is what spec 06 section 10.2 demands.
- **Open.** Whether `session/resume` needs the servers again (T3 sends them), and whether a changed tool list (`notifications/tools/list_changed`) is honoured.

**Access Modes.**

| Access Mode | `agy` | Evidence |
|---|---|---|
| approval-required | mode `default` | asks for edits, commands and MCP calls; reads run unasked |
| auto-accept-edits | mode `accept-edits` | MCP still asks |
| auto | mode `auto` (offered on the free tier too) | MCP still asks; a command with `BypassSandbox: true` ran unasked |
| full-access | `--dangerously-skip-permissions` | nothing asks |

T3 notes an open bug where Auto stays in `default` (T3 issue 40896). The adapter should warn when the mode `agy` reports is not the mode it set.

## 5. Our events against agy

"direct" is one-to-one. "adapter" means the adapter derives it. "gap" means `agy` gives nothing. Evidence is a recording name.

| Our event or field | What `agy` sends | Verdict |
|---|---|---|
| `session.started` | reply to `session/new` or `session/resume` (`sessionId`) | adapter |
| `session.exited` | nothing; `session/close` exists | adapter, from the process ending |
| `turn.started` | nothing: ACP has no turn | adapter: one turn is one `session/prompt` and its reply |
| `turn.completed` completed | `stopReason: "end_turn"` | direct |
| `turn.completed` interrupted | `stopReason: "cancelled"` after `session/cancel` (`cancel`) | direct |
| `turn.completed` failed | never seen | **open** |
| `turn.completed` usage | `PromptResponse.usage`, per turn | adapter: sum per process |
| structured result, `costUsd` | nothing | gap |
| `item.started` / `item.completed` | `tool_call` / `tool_call_update` with `completed` or `failed` | direct |
| `item.updated` | `tool_call_update` resends the whole object | adapter: used for `todo_list` only |
| status `declined` | `failed` plus the text "user denied permission" | adapter: it answered, so it knows |
| `user_message` | nothing | adapter, from the input |
| `assistant_message` | `agent_message_chunk`, no message id | adapter decides the boundaries (section 6.6) |
| `reasoning` | `agent_thought_chunk`, summary text | adapter, same |
| `command_execution` | `run_command`, kind `execute`, `rawInput.CommandLine`, `rawInput.toolSummary` | direct |
| `file_change` | `edit_file` (`Path`, `Target`, `Replacement`), `write_file` (`Path`, `Content`), kind `edit` | direct |
| `file_read` | `read_file`, kind `read`; the content read is never sent | direct |
| `file_search` | not seen; `agy` used `grep` through `run_command` | open |
| `tool_call` (MCP) | `mcp_tools_<server>__<tool>`, kind `other`; no result is sent | adapter: parse the name |
| `web_search` | `search_web`, kind `search`, `rawInput.query`; results never sent | direct |
| `subagent` | one `invoke_subagent` call (`Prompt`, `Role`, `TypeName`) and nothing else | gap: no child events, ids or tokens |
| `plan` | no ACP `plan` update; a `write_file` of `<app-data-dir>/brain/<sessionId>/implementation_plan.md` | adapter polyfill |
| `todo_list` | no ACP `plan` update; writes of `brain/<sessionId>/task.md` with `- [ ]`, `- [/]`, `- [x]` | adapter polyfill, best effort |
| `context_compaction` | `/compact` produces one model call and nothing visible | gap; a manual one can be drawn |
| `content.delta` assistant, reasoning | the two chunk kinds | direct |
| `content.delta` command output | nothing streams; output arrives whole at completion | gap (as Claude Code) |
| `request.opened` command / file change / tool | `session/request_permission {toolCall, options}`, told apart by `toolCall.kind` | direct |
| `request.opened` file read | never asked | not applicable |
| `request.opened` question | `elicitation/create`, once the client advertises it (`question-elicit`) | direct |
| `request.resolved` | nothing confirms | adapter: emit when it replies |
| decision `allow` | option `allow` (`allow_once`) | direct |
| decision `allow_always` | never offered | gap: leave it out of `decisions` |
| decision `deny` | option `deny` (`reject_once`) ends the turn (`deny2`) | differs (section 6.3) |
| decision `cancel` | outcome `cancelled`; same effect | direct |
| `session.usage.updated` | per-turn numbers only | adapter: emit the running sum after each prompt reply |
| the four `Usage` counts | `inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedWriteTokens` | direct (section 6.7) |
| `editedFiles` | paths on every edit | direct; use `rawInput.Path` |
| `subagentId` | nothing | gap |
| `harnessRefs`, `raw` | session id, tool call id, permission request id; the whole message | direct |

What `agy` sends that we have no place for:

| `agy` message | What to do |
|---|---|
| `usage_update {used, size}`: how full the context window is, after every model call | We are missing this. Spec 06 section 6.6 already plans the field. Add later. |
| `session_info_update {title}` | Drop: Hercule names threads. |
| `available_commands_update` (11 slash commands) | Drop for now. |
| `current_mode_update`, `config_option_update` | Read only to check the mode and the model. |
| `rawInput.toolSummary` (a human title per command) | Use it in the item's detail. |

## 6. Findings that shape the adapter

### 6.1 Tool calls

- The first status is `in_progress`. It goes back to `pending` while a permission request is open, then `in_progress`, then `completed` or `failed`.
- `tool_call_update` resends everything, it does not patch.
- `tool_call` has a field `args` that ACP does not define; it copies `rawInput`.
- Map by tool name, not by `kind` alone: `kind: "other"` covers MCP tools, `ask_question` and `invoke_subagent`.
- `locations[].path` flips between `/tmp/...` and `/private/tmp/...` within one call. Use `rawInput.Path`.
- An edit's `content[0]` is a diff: the fragment at permission time, the whole file before and after at completion. A new file has `newText` only.

### 6.2 Command output

- Not streamed. At completion it is in `rawOutput.output` and in `content[0].content.text`, with a header: `Created At: ...`, `Completed At: ...`, `Command exited with code 0.`, a blank line, `Command output:`. Line ends are CRLF. The exit code is `rawOutput.exit_code`.
- Long output is cut by `agy`, with a pointer to a file under `brain/`.
- A command that runs past `WaitMsBeforeAsync` goes to the background and its tool call stays `in_progress`. What completes it is **open**.

### 6.3 Approvals

- The options are always `allow_once` and `reject_once`. There is no "always allow".
- **Deny ends the turn (verified, `deny2`).** The tool call fails, and the prompt returns `end_turn` 2 ms later with no further model call. The prompt said "if refused, reply REFUSED"; in 30 seconds nothing came. Answering with outcome `cancelled` does exactly the same, and also returns `end_turn`, not `cancelled`.
- Spec 06 section 6.5 says `deny` is "refuse with a reason the model sees" and the turn goes on. `agy` cannot do that. So on Antigravity `deny` and `cancel` would be the same button. Recommendation, for Rogier: offer `allow` and `cancel` only, as pi leaves out `allow_always`.

### 6.4 Questions

- Without the capability, `agy` runs an `ask_question` tool that never completes, prints the question as text and ends the turn (`question`).
- With `clientCapabilities.elicitation: { form: {} }` it sends a real request (`question-elicit`):

```json
{ "method": "elicitation/create", "id": "jetski-acp-front:4",
  "params": { "sessionId": "...", "toolCallId": "call_...", "mode": "form", "message": "The agent has a question.",
    "requestedSchema": { "type": "object", "properties": {
      "q1": { "type": "string", "title": "Which colour should the banner be?",
              "oneOf": [{ "const": "1", "title": "Red" }, { "const": "2", "title": "Green" }, { "const": "3", "title": "Blue" }] },
      "q1_other": { "...": "free text" } } } } }
```

  The reply `{ "action": "accept", "content": { "q1": "1" } }` completes the tool call and the agent goes on. This maps to our `question` Request. The exact shape for multi-select and for declining is **open**; read the recording.

### 6.5 Turns, cancel and steering

- **Cancel (verified).** `session/cancel` is a notification. The prompt returns `stopReason: "cancelled"` with usage. A full `tool_call_update` for the stopped tool can arrive **after** the prompt returned, so the adapter must accept updates for a turn that is over. Cancel also stops the agent's background commands and subagents (from T3).
- **Steering (verified in part, `steer2`).** A second `session/prompt` sent mid-turn made the first prompt return `end_turn` at once, with the usage of one model call, while its command still ran. The work went on, and the steered text was acted on (`steer.txt` was written). But no reply for the second prompt came within 75 seconds, and no closing message. So the end of a steered turn was not signalled.
- **What T3 does.** It steers natively on 1.5.0 and newer and treats the second prompt's reply as the turn's end. It carries a 15 minute inactivity timer, a watcher that reads `agy`'s on-disk session log to learn how a prompt ended (`AntigravityTurnOutcome.ts`), and state for prompts that settle early. Before T3 PR 39165 it interrupted and resent, which stopped the agent's subagents.
- **For v1:** declare `steering: "unsupported"`. The controller then interrupts and sends the input as the next turn. Never treat `end_turn` of a prompt as the end of the turn when a newer prompt is in flight.
- The binary also holds: "the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again".

### 6.6 Messages and reasoning

Chunks carry only their text. There is no message id. Per model call the order is: thought chunks, message chunks, `usage_update`, tool calls. Close the open message or reasoning item at any update of another kind and at the prompt reply. Two messages in one turn with no tool between them are split only by a `usage_update` (`subagent`).

### 6.7 Usage

- `totalTokens = inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens`. Checked on every recorded turn (edit-shell: 21453 + 935 + 40912 + 0 = 63300).
- `inputTokens` leaves out cache reads. `outputTokens` already includes `thoughtTokens`, so never add them.
- The numbers are per prompt. The adapter sums them per process to get our snapshot "since the process started".
- A cancelled turn still reports usage. A subagent's tokens are not in the parent's numbers, so report usage as incomplete once a subagent ran.
- There is no cost anywhere.

### 6.8 Subagents, plans and compaction

- **Subagents.** `invoke_subagent` completes in about a second with no content. No child id, no child events. The result reaches the parent invisibly. Our section 13 model gets one `subagent` item with a description and a type, and nothing else.
- **Plans and todo lists.** Files under `<app-data-dir>/brain/<sessionId>/`. Each write asked permission in `default` and `plan` mode, because the path is outside the workspace. Plan mode has no "approve the plan" request; the turn just ends.
- **Compaction.** `/compact` as a prompt compacts silently. Automatic compaction is invisible, and no switch to turn it off was found (`AGY_CLI_AUTO_COMPACT_OVERRIDE` is in the binary, untested).

### 6.9 Things agy does that an adapter must expect

- It can stream with no open prompt: background commands and timers wake it (from T3).
- It creates empty `.gemini/skills` and `.agents/skills` folders in the workspace (from T3).
- It reads `AGENTS.md` and `GEMINI.md` from the gemini dir (from T3). With a private gemini dir the user's own are not seen.
- An upstream API error arrives as a chat message plus `end_turn` (from T3). How a failed turn looks is **open**.

## 7. What the spec must record as exceptions for Antigravity

- No `allow_always`. Deny ends the turn.
- No fork: `sessionCapabilities` has no `fork`. Nothing in the controller reads `declared.fork` today, because all three harnesses support it, so a refusal has to be added.
- No structured output in a session. Nothing reads `declared.structuredOutput` either. Print mode with `--json-schema` is the route for Text Generation.
- No `command_output` stream, no results for reads, web search, MCP calls and subagent calls.
- Subagents are one call on the parent, with tokens not counted.
- No cost. No Account Usage.
- Steering unsupported until proven. `disallowedTools` unsupported.
- Automatic compaction cannot be seen or turned off.

## 8. Recordings still needed

1. A failed turn: network off mid-turn, an exhausted quota, a revoked login.
2. Steering again with a prompt that ends in a visible message; a second prompt while a permission request is open.
3. `session/resume` and `session/load`: what is replayed, usage afterwards, whether MCP servers must be sent again.
4. A non-zero exit code, and a background command that finishes by itself.
5. `session/cancel` while a permission request is open; two tool calls asking at once.
6. A question with several questions and with multi-select; a declined question.
7. An image in a prompt; a failing MCP tool; a changed MCP tool list.
8. Prompts that force file search, a directory listing, a URL fetch, a delete.
9. A subscribed account: Neon, its thinking levels, and whether Auto behaves differently.
10. Linux: the keyring with no D-Bus session.

## 9. T3 Code as a reference

MIT, "Copyright (c) 2026 T3 Tools Inc.". Worth reading, by path in `pingdotgg/t3code`:

| Path | For |
|---|---|
| `packages/effect-acp/` | the ACP client we copy; `src/compat.ts` holds the quirk handling |
| `apps/server/src/provider/antigravityAuthSupport.ts` | the spawn recipe and environment |
| `apps/server/src/provider/acp/AntigravityAcpSupport.ts`, `AntigravityProtocol.ts` | Antigravity's ACP quirks |
| `apps/server/src/provider/AntigravityProvider.ts` | models and thinking levels from `session/new` |
| `apps/server/src/provider/acp/AntigravityTurnOutcome.ts` | how a prompt really ended, read from `agy`'s log |
| `packages/provider-acp/src/server/adapter.ts` (`steerWithPrompt`) | native steering |
| T3 PRs 9348, 26876, 28629, 31158, 35487, 38970, 39378, 39165, 39686 | the history of the fixes |

What we do not take: their stdio MCP bridge (we have the gateway over HTTP), their quota read against `cloudcode-pa.googleapis.com` (ADR 0048), their managed installer.

T3 changes `packages/effect-acp` about five times a week, and about two of those are fixes we want. That is why the copy stays untouched behind our own module.

## 10. A spike of the copied package

Branch `spike/acp-package` (commits `63d3de543`, `0153040a4`) holds a first copy as `packages/acp`: the client half, the generated schemas of ACP v1 and v2, a generator at `scripts/gen-acp-types.ts`, the MIT notice and 82 passing tests, on Effect 4.0.7 with no source change. It is a starting point, not the final shape: its second commit edits the copied files to pass lint, which the decision of 2026-11-25 undoes (exclude the folder from lint instead). Three things it found:

- T3's checked-in schemas cannot be reproduced from T3's generator alone: every generator release emits open structs. The spike's script closes them, and the result then matches T3's.
- Closed structs reject unknown fields, so an `agy` that adds a field to a known message fails decoding. `agy` ships often; loosen this for messages we receive.
- The client builds on Effect's `rpc` modules, which Effect marks unstable.

The runner starts processes with `Bun.spawn`, so the adapter hands the client its stdio itself.
