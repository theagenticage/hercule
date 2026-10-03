# Subagents on pi: which extension, and how each one works

Research for [#348](https://github.com/theagenticage/hercule/issues/348), part of [#345](https://github.com/theagenticage/hercule/issues/345). Researched 2026-10-03.

## The question

pi has no subagents of its own. Subagents come from extensions. Which one should Hercule use, and how does each one behave when Hercule runs pi as `pi --mode rpc --no-extensions -e <hercule extension>`?

1. What extensions exist, and how do they work: children in the same process or spawned `pi` processes, where a child's transcript is kept, how the parent hears from children, and nesting.
2. What each one looks like on the RPC stream, and whether child events are visible and can be tied to a child.
3. Can a host stop, message or steer a child, or answer its requests (approvals)?
4. How t3code, which added pi as a provider, handles pi subagents.

## Answer in short

- **No published extension fits Hercule as it is.** Each one either skips Hercule's approval hook in its children (so child tools run unapproved or are silently denied), keeps no child transcript, gives the host no way to steer or stop one child, or depends on pi internals. Usually several of these.
- **Hercule cannot simply "use" a user's extension anyway.** The launch passes `--no-extensions`, and ADR 0032 already rules that the user's pi extensions never load, not even for Threads, because they share a process with Hercule's approval extension. So whatever subagent tool a pi session gets, Hercule ships it, inside the extension it loads with `-e`.
- **Recommendation: write a small Hercule-owned `subagent` tool in `hercule-extension.ts`.** Model it on pi's bundled example (spawn a child `pi` process per task), but spawn each child as `pi --mode rpc` with Hercule's own flags and `-e`, so the approval hook runs in every child. The parent forwards each child's approval to its own `ctx.ui.confirm`, tagged with a child id, so Hercule's existing approval park works unchanged. Details in [Recommendation](#recommendation).
- **t3code does not really support pi subagents.** It only recognizes the bundled example's tool result and shows it as progress text, with no child thread, no child approvals and no control. For real delegation it uses its own MCP tool that starts a separate t3code thread.

## Sources

All primary, read at these versions:

- **pi**: 1.0.0 (released 2026-10-01), installed package `@earendil-works/pi-coding-agent`, and the repo [earendil-works/pi](https://github.com/earendil-works/pi) at `83692682` (`badlogic/pi-mono` now redirects there). Docs read: `extensions.md`, `rpc.md`, `rpc-commands.md`, `rpc-extension-ui.md`, `json.md`, `sdk.md`, `session-format.md`, `security.md`, `cli.md`, `CHANGELOG.md`. Source: `dist/core/extensions/runner.js`. Bundled example: `examples/extensions/subagent/` (last changed 2026-08-18, `8af7690c4f`).
- **Hercule**: `apps/runner/src/providers/pi/adapter.ts`, `extension.ts`, `normalize.ts`, `probe.ts`, `testing.ts`; spec 06 §6.3 (item kinds), §9.1 ("User Material") and §10.3; ADR 0032.
- **t3code**: [pingdotgg/t3code](https://github.com/pingdotgg/t3code) at `71dbaf1f94b5`: `orchestration-v2/Adapters/PiRpc.ts`, `PiAdapterV2.ts` (+ test), `piT3McpInjection.ts`, `orchestrationV2.ts`.
- **Extensions**: npm tarballs and git clones of the packages below, at the versions named. Weekly download counts are from the npm API on 2026-10-03.
- **pi issues**: [#9403](https://github.com/earendil-works/pi/issues/9403) (children should keep the parent's `-e`; closed, no action), [#9436](https://github.com/earendil-works/pi/issues/9436) (the example listens for an event pi never emits), [#10315](https://github.com/earendil-works/pi/issues/10315) / [#10359](https://github.com/earendil-works/pi/issues/10359) (pi 1.0.0 broke pi-subagents' background children).

A note on versions: Hercule was built and tested against pi 0.85.1 (`FAKE_PI_VERSION` in `testing.ts`), but `probe.ts` installs pi unpinned from `pi.dev/install.sh`, so a new runner gets 1.0.0 today. A few facts below are only true from a given version; those say so.

## The pi pieces that matter

These are the parts of pi any subagent design runs into.

1. **Extension dialogs in RPC mode.** `ctx.ui.confirm/select/input/editor` in an RPC-mode pi become `extension_ui_request` lines on stdout, and the host answers with `extension_ui_response` (`rpc-extension-ui.md`). This is how Hercule's approval hook works today.
2. **No UI means silent "no".** A session with no UI context (an in-process child bound without `uiContext`, or a `--mode json` / `-p` child) uses `noOpUIContext`: `confirm` returns `false`, `select` and `input` return `undefined`, `hasUI` is false (`dist/core/extensions/runner.js:132-144, 404`). Hercule's hook would then block every tool, and a user's own confirm-gated check would deny without anyone seeing it.
3. **The host's `-e` does not travel.** `-e` is a CLI flag of one process. A child `pi` process only loads it if the parent passes it on, and an in-process child only loads it if the extension adds the path to its `DefaultResourceLoader`. pi declined to make children inherit it (#9403).
4. **What reaches stdout from an extension.** Only these:
   - `tool_execution_update` from the tool's `onUpdate`, with `toolCallId`, `toolName`, `args` and `partialResult` (`json.md`). The `details` object is free-form.
   - Custom messages from `pi.sendMessage`, as `message_start`/`message_end` with `role: "custom"` and a `customType`.
   - `entry_appended` for `pi.appendEntry()`.
   - `extension_ui_request` (dialogs, `notify`, `setStatus`, string `setWidget`).

   `pi.events` is an in-process bus and never reaches stdout (`rpc.md`).
5. **A host-to-extension channel exists.** The RPC `prompt` command runs an extension slash command (`/name args`) at once, even while the agent is streaming, without starting a model turn (`rpc-commands.md`, prompt). `steer` and `follow_up` do not accept extension commands. This is the only way for a host to call into an extension without a model turn.
6. **Nested tool ids (1.0 only).** `ctx.executeTool()` gives nested calls a `parentToolCallId` and ids of the form `<parent>/<n>`. This came in 0.99.0 (CHANGELOG), so not in 0.85.1. It covers tools called by a tool, not child agents.
7. **Session linkage.** A session file's header has an optional `parentSession` field (`session-format.md`).

## pi's own position

pi ships no subagent feature. The docs and README describe subagents as something to build or install as an extension, and the repo carries one example.

### The bundled example (`examples/extensions/subagent`)

- **How it runs children.** It registers a `subagent` tool with three modes: single, parallel (up to 8 tasks, 4 at a time) and chain. Each task spawns a separate process: `pi --mode json -p --no-session [--model] [--thinking] [--tools] [--append-system-prompt <tmp file>] "Task: ..."` (`index.ts:300-341`). It finds the `pi` binary through `process.execPath`, which works for the Bun-compiled binary Hercule installs.
- **Agents.** Agent definitions are Markdown files in `<agent dir>/agents/` (user scope) or `.pi/agents/` (project scope, behind a confirm). The example ships four (`scout`, `planner`, `reviewer`, `worker`) but they are not installed anywhere; an unknown name is an error.
- **Transcript.** None on disk (`--no-session`). The child's messages pile up in the tool's `details.results[i].messages`, and the final result keeps them.
- **How the parent hears.** It reads the child's JSON event stream, and on each child `message_end` calls `onUpdate` with the full `details` so far: `results[]` of `{agent, task, exitCode (-1 while running), messages, usage, model, stopReason, step}`. Each update resends everything, so updates grow with the child's transcript. (It also listens for `tool_result_end`, which pi never emits, #9436.)
- **On the RPC stream.** One `tool_call` with `tool_execution_update`s. A child is identified only by its index in `results[]` and its agent name.
- **Nesting.** Only if the child happens to discover the extension itself. It is not passed on.
- **Control.** Aborting the tool call sends SIGTERM, then SIGKILL after 5 seconds, to every child. No steer, no message, no stop of one child.
- **Approvals.** The child runs in `--mode json`, so it has no UI.

**Under Hercule it would not work as is.** With `PI_CODING_AGENT_DIR` pointing at the instance home, there are no agent files, so every call fails with "Unknown agent". If Hercule shipped agent files, the child would load no extensions at all (Hercule's extension file is `<home>/hercule-extension.ts`, outside the discovered `extensions/` folder, and the child gets no `-e`). Its `bash`, `edit` and `write` would run **without Hercule's approval hook**, even in an approval-required session. That is an approval bypass. The child also gets no `--offline` or `--no-approve`.

## Published extensions

There is no standard. Every extension invents its own child ids, events and control. The table covers the ones that matter by use or by design; the sections after it give details.

| Extension (version, weekly downloads) | Children run as | Child transcript | What the RPC host sees | Nesting | Host control | Child approvals |
|---|---|---|---|---|---|---|
| bundled example | spawned `pi --mode json` | none (in tool result only) | `tool_execution_update`, child = index | no | abort all | none, no UI |
| `pi-subagents` (nicobailon) 0.75.0, ~205k | in-process SDK sessions; background runs in a detached runner process | pi session file per child, plus artifacts | foreground: updates with `runId` + `index`; background: a completion message whose run id is only in its text, plus an RPC-only JSON widget | depth 2 | none direct; steer/stop are tools for the model, slash commands, or a file inbox | silent "no"; host `-e` only via an opt-in registry |
| `@tintinweb/pi-subagents` 0.19.0, ~7.4k | in-process | pi session file (path never emitted) + `.output` JSONL in /tmp | foreground: updates every 80 ms with no child id; background (default): `subagent-notification` with `details.id` | depth 2 | abort foreground only; steer is a model tool | silent "no"; loads the user's extensions, not the host's `-e` |
| `@gotgenes/pi-subagents` 22.0.0, ~3.7k | in-process (fork of tintinweb for pi 1.0) | pi session file with `parentSession` | `subagent-notification`, `entry_appended` `subagents:record` | no | a `globalThis` service (spawn, abort, steer, resume) for other extensions | silent "no" |
| `@quintinshaw/pi-dynamic-workflows`, ~5.8k | in-process | per agent session file | foreground snapshot with `agents[]` (id, sessionFile, history) | workflow scripts | per run only | silent "no"; patches `AgentSession.prototype` |
| `gentle-pi` 4.0.0, ~5.1k | spawned `pi --mode rpc` | real pi session + Markdown copy | no updates; completion message with `taskId`; a JSON activity widget only when a special env var is set | depth 1 | model tools send RPC `steer` / `abort` | **forwarded** to the parent's `ctx.ui`, but with no child id |
| `@mjasnikovs/pi-task`, ~5.2k | spawned `pi --mode json --no-extensions` | none | final text only | no | abort all | none |
| `@chankov/agent-fleet`, ~4.1k | spawned `pi --mode json --no-extensions -e ...` | session files | its own Unix socket | yes | its own | relayed into the hub's `select`, child named only in the title |
| `@mjakl/pi-subagent` 3.1.0, 176 | spawned `pi --mode rpc` | `--no-session`, or named sessions with a `pi-subagent:delegation` entry | updates with `results[]` by `callIndex` | depth 3 | abort all | **passes the parent's `--no-extensions` and every `-e` on**, so Hercule's hook runs in children, but child dialogs are auto-cancelled, so it denies |
| `@williamcr01/pi-subagents` 0.2.7, 342 | spawned `pi --mode rpc --session-id <runId>`, long-lived | real pi session + a registry JSON per run | tool returns at once; results in later tool results or a custom message | depth 2 | model tools: `send_to_subagent` (steer), `cancel_subagent` | **forwarded** to the parent's `ctx.ui`, child named only in the title |

Not usable headless: `@henryqw/pi-subagent` and `pi-herdsman` need the herdr terminal multiplexer and do nothing without it. Also surveyed, with nothing better to offer: `@bacnh85/pi-subagent` (in-process, in-memory transcripts, pi below 1.0), `@agimon-ai/doompi-team` (its own runtime and SQLite store), `pi-subagents-lite` (in-process, patches internals), several small RPC-child extensions that cancel child dialogs, and forks of tintinweb (`@cad0p/...`) and bridges (`@alexeiled/pi-subagents-bridge`, `@tintinweb/pi-tasks`).

### pi-subagents (nicobailon)

By far the most used. It is also the largest and the most coupled to pi internals.

- **Children.** A foreground child is a pi `AgentSession` created inside the parent process. A background run (the default) starts one detached runner process that hosts its children in-process. With the Bun-compiled pi, that runner is `pi --no-extensions --no-skills --no-prompt-templates --no-session --mode rpc --extension <bootstrap>`. Runners outlive pi: killing the parent session does not stop them.
- **Transcripts.** Real session files per child under `<parent session dir>/<parent session name>/<runId>/run-<n>/`, plus input, output and transcript artifacts. `results[].sessionFile` is in the tool result.
- **On the RPC stream.** Foreground runs stream `tool_execution_update` with `runId` and `results[].index` per child (the full message list is stripped). Background runs show only a `PI_SUBAGENT_ASYNC_JSON:` widget line (a run tree with ids and states, sent only in RPC mode) and a `subagent-notify` completion message that has no `details`. The `/subagents-inspect-rpc` command returns a transcript window without a model turn.
- **Control.** Steer, stop, interrupt and resume exist as tool actions for the model, as slash commands, as a file inbox, and as `pi.events` methods for background runs. None reaches a host directly; a Hercule extension would have to bridge them.
- **Approvals.** Children have no UI, so confirms return `false`. Permission rules set to "ask" are decided by an LLM watchdog, not a person. A child can ask the parent's model through a `contact_supervisor` tool. Since 2026-09-10 another extension can call `registerRequiredChildExtensions({sessionId, extensions})` to load its path in every child; that is the only way to get Hercule's hook into them.
- **Internals.** Uses private pi fields and import paths. pi 1.0.0 removed one of them and broke background children (#10315); 0.75.0 fixed it the next day.

### @tintinweb/pi-subagents and its fork @gotgenes/pi-subagents

- **Children** run in-process. Under `--no-extensions -e <host>`, a tintinweb child loads **all of the user's installed extensions and none of the host's `-e`**: the parent's choice is inverted.
- **Transcripts.** tintinweb writes a real session file but never emits its path, and a Claude-style `.output` JSONL in /tmp whose path it does emit. gotgenes writes the session file under `<parent session dir>/<name>/tasks/` with `parentSession` set.
- **On the RPC stream.** Foreground updates come about 12 times a second with no child id until the end. Background is the default and shows only the completion message. A child's own events never reach stdout.
- **Control.** A `steer_subagent` model tool; no stop tool. A `globalThis` registry hands other extensions the live child session (tintinweb) or a spawn/abort/steer/resume service (gotgenes).
- **Approvals.** Silent "no".

### gentle-pi

The only one that forwards a child's dialogs to the host in a structured way: a child's `extension_ui_request` is re-asked through the parent's `ctx.ui` and the answer written back to the child. The host sees an ordinary parent dialog with a decorated title and **no child id**. Children are `pi --mode rpc` with real sessions, steered with RPC `steer` and stopped with RPC `abort`. It passes no `--no-extensions`, so children load the user's installed extensions, and not the host's `-e`.

### mjakl/pi-subagent

The only one that passes the parent's `--no-extensions` and every `-e` on to children (it reads them back from the parent's argv). Under Hercule, the approval hook would run in every child. But it auto-cancels child dialogs, so in an approval-required session every gated child tool would be blocked. No background mode and no steer.

### williamcr01/pi-subagents

Long-lived `pi --mode rpc` children with real sessions and a registry file per run (`runId`, `parentRunId`, `rootRunId`, `sessionFile`, `pid`, status). Steers with an RPC `prompt` in steer mode; cancels with SIGTERM then SIGKILL. Forwards child dialogs to the parent's `ctx.ui` with `[childName]` in the title. Does not pass the host `-e`. The registry lives under `~/.pi/agent`, which conflicts with Hercule's per-instance home.

## What this means for Hercule's adapter

Today's code, read against the above:

- **Launch** (`adapter.ts`, `buildArgv`): `--no-extensions` plus one `-e <home>/hercule-extension.ts`. A user-installed subagent extension never loads, and ADR 0032 keeps it that way for Threads too. So the only subagent tool a Hercule pi session can have is one Hercule loads itself.
- **Approvals** (`extension.ts` + `parseDialog` in `adapter.ts`): the hook parks on `ctx.ui.confirm(title, JSON{toolCallId, toolName})`, and `parseDialog` accepts only `confirm` requests and reads `toolCallId` from that JSON. This is the right seam for child approvals too, if the JSON also carries a child id. A child that is not running Hercule's hook is an approval bypass; a child with the hook but no UI denies everything.
- **Stream** (`normalize.ts`): a subagent tool today becomes one plain `tool_call` item, and `onToolUpdate` turns `partialResult.content` text into `command_output` deltas. `entry_appended` and custom messages fall into the default case and are dropped. `TOOL_KINDS` has no `subagent` entry. Spec 06's item table already lists `subagent` as an item kind ("absent on pi"), so the obvious mapping is: the Hercule subagent tool becomes a `subagent` item, the way Claude's `Agent` tool and Codex's `collabAgentToolCall` already do.
- **No parent link on items.** The normalized stream has no field tying an item to a parent item, for any provider (Claude children are only kept apart by `parent_tool_use_id` inside the normalizer). Showing a child's own items nested under its `subagent` item is a protocol change, separate from this ticket.
- **Spec 06 §10.3** says "Absent by design: subagents ... Declared, not emulated." That holds for pi itself. If Hercule ships its own subagent tool, §10.3 needs an amendment to say so.

## Options

1. **Load the bundled example with a second `-e`.** Least code. But: an approval bypass in children, no transcript, no per-child control, and agent files Hercule would have to provide. Rejected.
2. **Load nicobailon's pi-subagents with a second `-e`,** and register Hercule's extension as a required child extension. Gets transcripts and a run tree. But: it is large and changes daily (0.75.0 was published the day before this research), it depends on private pi internals (pi 1.0.0 already broke it once), background runners outlive the session (Hercule's runner owns process lifetimes), child confirms still return `false` (so approval-required children are blocked, not asked), and host control means bridging `pi.events`. Rejected.
3. **A Hercule-owned subagent tool, children as in-process SDK sessions** bound with a `uiContext` that forwards to the parent's `ctx.ui`. Cheaper on memory (no extra process per child). But it builds on pi's TypeScript SDK, the "pre-1.0 TypeScript API" that spec 06 §10.3 chose the RPC binary to avoid, and every in-process extension surveyed reaches into internals sooner or later.
4. **A Hercule-owned subagent tool, children as spawned `pi --mode rpc` processes.** Uses only the public RPC protocol, the same contract Hercule already depends on. Costs one pi process per running child.

## Recommendation

**Option 4.** Write a small `subagent` tool inside `hercule-extension.ts`, modeled on the bundled example's process-per-child design and on what gentle-pi and mjakl got right:

1. **Spawn each child with Hercule's own flags.** `pi --mode rpc --no-extensions --no-skills --no-prompt-templates --no-themes --no-approve --offline -e <home>/hercule-extension.ts --session-dir <home>/sessions --session-id <child id>`, same model and thinking level unless the call asks otherwise. The child gets the same environment (`PI_CODING_AGENT_DIR`, the access mode, the session token). The approval hook, `--offline` and the trust settings then hold in every child, by construction.
2. **Keep a real transcript per child** in the instance's session dir, with `parentSession` pointing at the parent session, so a child can be read, resumed or forked like any pi session.
3. **Forward child approvals.** The parent extension reads each child's `extension_ui_request` confirm and re-asks it through its own `ctx.ui.confirm`, adding the child id to the JSON message (`{toolCallId, toolName, childId, childToolCallId}`), then writes the answer back to the child. Hercule's existing park and `parseDialog` keep working, with one more field.
4. **Report children with stable ids.** One `tool_execution_update` per child state change (started, a tool call, finished), with `details` keyed by child id and session id. Send changes, not the whole transcript each time. `normalize.ts` maps the tool to a `subagent` item.
5. **Let the host control one child.** Register extension commands such as `/hercule-subagent-steer <id> <text>` and `/hercule-subagent-stop <id>`. The runner sends them as an RPC `prompt`, which runs them at once even mid-stream, and they send `steer` or `abort` to that child. Model-facing steer or stop tools can come later, if wanted.
6. **No background mode and no runaway processes.** Children are part of the tool call: aborting the parent aborts them, and they die with the parent session. A depth limit (passed to the child in an env var) stops runaway nesting; depth 1 is a fine start.

Why this one:

- **Approvals stay correct by construction.** Every child runs the same hook. A child cannot bypass approval, and its approvals reach the user like any other, tagged with the child.
- **Only public contracts.** The RPC protocol and the extension API Hercule already depends on; no SDK, no private fields.
- **Hercule owns the lifecycle.** No detached runners, no files under `~/.pi`, everything under the instance home.
- **Small.** The bundled example does most of this in about 500 lines. This is about the same size, with the UI parts dropped and the forwarding added.

The cost is memory: one more pi process per running child (each a Bun process; spec 06 already counts a whole Claude Code session at about 1 GiB as a starting point). Cap concurrent children per session, as every extension surveyed does (4 is the common default).

## Open questions

- **Which pi version Hercule pins.** The research used 1.0.0; Hercule tests against 0.85.1 and installs unpinned. The recommendation uses nothing newer than what Hercule already relies on (`extension_ui_request`, RPC `steer`/`abort`), plus extension commands through `prompt`, which should be checked on the pinned version.
- **Does a child need the parent's system prompt and workspace?** The child should share the parent's working directory, but whether it gets the parent's appended system prompt (and `submit_result`) is a product choice.
- **The protocol has no parent link on items.** Nesting a child's items under its `subagent` item needs a protocol change that would also serve Claude and Codex children.
- **Spec 06 §10.3** needs amending from "absent by design" to "provided by Hercule's extension" once this is built.

## Note on t3code

- **Launch.** t3code spawns `pi --mode rpc` with its own `--extension` (an MCP bridge) and no `--no-extensions`, so the user's extensions, including any subagent extension, load (`piT3McpInjection.ts:250-288`). Minimum pi 0.80.5.
- **pi subagents are observation only.** `PiAdapterV2.ts:1016-1115` (`emitSubagentTasks`) parses the bundled example's `details.results[]` and emits subagent items with `childThreadId: null`, id `<toolCallId>:subagent:<step>`, and the last 200 characters of text as progress (`:2854-2878`). Its capability flags for pi are all false: no child thread ids, no approvals from subagents, no forking a child (`:182-191`). It is tested only with a synthetic payload (`PiAdapterV2.test.ts:1066`). Other extensions' formats are not recognized.
- **Approvals.** Any `confirm` becomes an approval and `select`/`input`/`editor` become questions, but none is tied to a child.
- **Real delegation** goes through t3code's own `delegate_task` MCP tool, which starts a separate t3code thread ("app-owned" child) for any provider. Its shared model (`orchestrationV2.ts:632-667`) gives a subagent a parent node, an origin (`provider_native` or `app_owned`), status, progress, result and a nullable child thread id; the UI only offers "Open subagent thread" when that id is set. Claude children are tied to the parent by `parent_tool_use_id`, Codex children have real child threads and their approvals show in the parent.

So t3code is no help for pi child control or approvals. Its useful lesson is the data model: a subagent as an item with an origin, a status, a progress line, and an optional link to a full child session.

## Addendum: pi upstream direction, and two more extensions

Added after the ticket closed, from a wider survey of the extensions on npm. The clones it read are in `/tmp/pi-subagent-research/`, which is temporary.

- **pi upstream.** pi 1.0.0 has no subagents of its own. The experimental durable harness (`@earendil-works/pi-durable` 1.0.1 on npm; its source is `packages/coding-agent/src/experimental/durable/subagent.ts`) has them:
  - each child is a conversation owned by a task;
  - aborting the call aborts the child, but the child outlives the call, so the user can switch to it and keep talking;
  - the README and examples 22-23 show spawn, steer, wait, stop and list.

  Nothing commits to exposing this through `pi --mode rpc`. badlogic points multi-session work at a future "pi server" (pi issue #5700). Two issues were auto-closed with no action: #7808, a `pi.spawnChild` API, and #9403, passing the parent's `-e` to children. So Hercule's own extension is the only route for now. The pi spec should name pi-durable as the thing to re-check when Hercule pins a new pi version.
- **pi-landstrip** (0.19.4, about 750 downloads a week):
  - runs workers as `pi --mode rpc`, each with a real session;
  - passes child dialogs up to the parent's `ctx.ui` one at a time, with `@agent · description · taskId[0:8]` at the start of the title (`dist/index.ts:5149-5175`, `2809-2813`);
  - like williamcr01, it gives the child id only inside the title text.
- **@quintinshaw/pi-dynamic-workflows** (about 5.8k downloads a week) shows the most detailed live tree on the RPC stream. Its `onUpdate` details carry `agents[]`, each with `id`, `callId`, `sessionId` and `sessionFile` (`display.ts:10-61`). A shape like this is worth copying for Hercule's own `subagent` tool.
- **Untested risk.** pi does not check whether a tool call has finished before it emits `tool_execution_update` (`pi-agent-core/dist/agent-loop.js:541-543`). So an extension can still send an update after its tool call has finished. Hercule's normalizer should ignore an update for a call that has already ended, or treat it as a protocol error.
