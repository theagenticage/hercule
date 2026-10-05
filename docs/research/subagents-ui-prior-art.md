# Research: how agent UIs show and control subagents

Resolves [#349](https://github.com/theagenticage/hercule/issues/349), part of the map [#345](https://github.com/theagenticage/hercule/issues/345) (subagents).

**Question:** how do existing agent UIs show a session's subagents, and what control do they give the user? Four sub-questions per product:

1. How a subagent is marked in the parent's transcript, and how its progress shows while it runs.
2. Whether there is a list or tree of a session's subagents, running and finished, and how nesting shows.
3. What the subagent's own view looks like, how it tells the user they are not in the main session, and how they get in and out.
4. What the user can do to a subagent: stop it, message it, answer its approvals and questions, and how a prompt from a subagent is attributed to it.

**Primary sources**

- **Claude Code**: official docs at `code.claude.com/docs/en/` ([sub-agents](https://code.claude.com/docs/en/sub-agents), [interactive-mode](https://code.claude.com/docs/en/interactive-mode), [statusline](https://code.claude.com/docs/en/statusline), [agent-teams](https://code.claude.com/docs/en/agent-teams), [desktop](https://code.claude.com/docs/en/desktop), [claude-code-on-the-web](https://code.claude.com/docs/en/claude-code-on-the-web), [remote-control](https://code.claude.com/docs/en/remote-control), [Agent SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents)), the [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) up to 2.1.289, and UI strings in the installed CLI binary 2.1.288. The changelog has no dates, so arrival is given as a CLI version.
- **Codex**: `openai/codex` at tag `rust-v0.160.0` (commit `a956835d`), `codex-rs/tui/src/`. `T/` below stands for `https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/`. Note: Hercule pins `rust-v0.154.0` for the app-server; this tag is newer and was read only for the TUI. The Codex app and IDE extension are closed source: [Subagents docs](https://learn.chatgpt.com/docs/agent-configuration/subagents) (developers.openai.com/codex/subagents redirects there) and the [changelog](https://learn.chatgpt.com/docs/changelog).
- **t3code**: `pingdotgg/t3code` `main` at `cf3e714b` (2026-10-05), 5 commits past nightly `v0.0.46-nightly.20261005.2667`. `G/` stands for `https://github.com/pingdotgg/t3code/blob/cf3e714b0f58e29c8fa8660db50d2187e3263b65/`.
- **pi**: `badlogic/pi-mono` at `b9ab918c` (2026-10-05), the official example `packages/coding-agent/examples/extensions/subagent/`; and three published extensions: `nicobailon/pi-subagents` v0.76.0 (`ba008223`), `tintinweb/pi-subagents` v0.19.0 (`e955e29c`), `HazAT/pi-interactive-subagents` v3.7.2 (`c100577e`).
- **Others**: `anomalyco/opencode` at `907b3bc5` (sst/opencode redirects there), `cline/cline` at `68b24a92`, `RooCodeInc/Roo-Code` at `b867ec91`, `zed-industries/zed` at `96837d78`; docs for Cursor, Amp and GitHub Copilot in VS Code.

Everything was read from docs or source. No product was run, so on-screen looks are inferred from render code or doc text. Claims that rest only on a forum post, PR or blog are marked so. The last section lists what was not verified.

Quoted UI strings keep their wording. Where a source string contains an em dash, it is written here as "-".

## TL;DR

- **Everyone draws a subagent as one row or card in the parent's transcript**, opened by a click or a key. The row shows a name, the task, and a status. The richer ones add elapsed time, tool-use and token counts, and the subagent's current tool (OpenCode, Cline, Claude Code, Zed, pi extensions). Codex's TUI is the poorest: fixed "Spawned / Waiting / Finished waiting" cells and no live progress.
- **A list of the session's subagents exists in most products, but it rarely keeps finished ones.** Claude Code's CLI drops a finished subagent after 30 seconds. Codex's `/subagents` picker and t3code's "Lineage" panel keep them. The Codex app has an "Active" and a "Done" section. Only Claude Code's CLI draws a real tree (rows with a `(+N)` descendant count and a path back to `main`); Roo Code draws a tree in task history. Most others cap nesting at depth 1.
- **The subagent's own view is the parent's transcript view, reused, with one marker.** The marker is small almost everywhere: a footer label (Codex: `Robie [explorer]`), a composer placeholder ("Message @name...", "Viewing sub-agent - direct input is disabled"), a divider at the top ("Subagent of <parent>" in t3code), a "← Parent task" button (Roo), or a lock icon (Copilot). t3code is the most explicit: it replaces the composer with a bar saying "Runs on its own" and an "Open parent" button.
- **Read-only is the norm.** t3code (provider subagents), Zed, OpenCode, Cursor, Copilot and Codex V2 children give the subagent view no composer, or disable it. Claude Code and Codex V1 are the exceptions that let you type to a subagent. This matches Hercule's decision to not message subagents.
- **Stop:** per-subagent stop exists in Claude Code (from `/tasks` in the CLI, a Stop in the desktop tasks pane and the VS Code agent map), Zed (Stop Subagent on the card and in full screen), pi extensions, and Codex (Esc while viewing the child, from code). t3code, OpenCode and Cline only stop the whole parent, which cascades.
- **Attribution of a subagent's prompt is the weakest spot.** Only Codex's TUI does it well: the approval overlay heads with `Thread: Robie [explorer]`, offers `o to open thread`, and lists `! Approval needed in Robie [explorer]` above the composer. Claude Code's CLI "names the subagent that is asking" (exact wording not verified). Zed lists "Subagents Awaiting Permission:" with a "Scroll to Subagent" link. t3code and OpenCode show a subagent's approval in the parent with **no** attribution at all.

## Claude Code CLI (terminal)

1. **In the parent's transcript**
   - The Agent tool call is a row: agent name and short task, for example `code-improver(Suggest code improvements)` ([sub-agents](https://code.claude.com/docs/en/sub-agents)).
   - In an interactive session subagents run in the **background** by default since 2.1.232 (fork mode on) ([sub-agents, foreground or background](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)).
   - Binary 2.1.288 strings: a running background row reads `Backgrounded agent (↓ to manage · ctrl+o to expand)`; a finished one reads `Done (N tool uses · X tokens · duration)` (metrics added in 2.1.30, changelog).
   - The completion notice shows elapsed time, for example "Agent completed · 3h 2m 5s" (2.1.144). The main spinner's token count includes background agents (2.1.0).
   - Live progress shows in the **subagent panel below the prompt**, not inline. A row is `name · description · token count`; the model's progress summary replaces the description when there is one ([statusline, subagent status lines](https://code.claude.com/docs/en/statusline#subagent-status-lines)). The `subagentStatusLine` setting lets the user replace the row text; its input per row is id, name, type, status, description, label, startTime, model, effort, contextWindowSize, tokenCount, cwd.
   - Ctrl+O opens the full transcript viewer; Ctrl+B moves a running foreground subagent to the background ([interactive-mode](https://code.claude.com/docs/en/interactive-mode)).
2. **List or tree**
   - The panel below the prompt lists running background subagents, forks and teammates, plus a row for the main session. At most 5 rows; idle rows hide after 30 s (2.1.181).
   - **Finished subagents do not stay.** A successful one leaves the panel at once and the footer shows `/tasks to see subagents` for 30 s; a failed or stopped one stays 30 s. In `/tasks`, a completed subagent stays 30 s, "marked done and sorted below running work"; failed and stopped ones leave ([sub-agents](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)). The [commands](https://code.claude.com/docs/en/commands) page instead says `/tasks` lists background work "including subagents that have finished", with no time limit; the two pages disagree.
   - **Nesting is a real tree**: "Claude Code shows nested subagents as a tree in the subagent panel below the prompt input and marks each row that still has descendants in the panel with a `(+N)` count of them. Open a row to see that subagent's siblings and direct children with a path back to `main`" ([sub-agents, nested](https://code.claude.com/docs/en/sub-agents#let-subagents-spawn-their-own-subagents)). Default depth 3 since 2.1.219.
   - `/tasks` rows show status icon, name and model (changelog: "Added the model (and effort level) each subagent ran on to `/tasks` and the agent detail dialogs"). `/agents` no longer lists running subagents since 2.1.198.
3. **Own view**
   - Select a row with ↑/↓ and Enter to open that subagent's transcript. Select the main-session row to go back.
   - Markers that you are not in the main session: the prompt placeholder reads "Message @name..." (changelog: "Improved the prompt placeholder to read "Message @name…" while viewing a background subagent or fork transcript"), the viewed row is bold, and the binary holds notices "Viewing agent" / "Viewing teammate" (on-screen look not verified). No banner or colour band is documented; the agent's `color` frontmatter colours it in the task list and transcript.
   - Commands typed in the view: plain text goes to the subagent; `/compact`, `/clear`, `/rewind` ask first and name the target (changelog: "a dialog now names the target and asks first"); `/model` and `/fast` are refused ([sub-agents, observe and steer](https://code.claude.com/docs/en/sub-agents#observe-and-steer-running-forks)).
4. **Control**
   - **Stop**: one background task can be stopped from `/tasks` ("View and manage background work", [commands](https://code.claude.com/docs/en/commands); "when you stop a background task from `/tasks`", [interactive-mode](https://code.claude.com/docs/en/interactive-mode)). `x` on a panel row is documented only as clearing the row of a subagent that already failed or was stopped; whether `x` stops a running one is not verified. Ctrl+X Ctrl+K stops all running background subagents (press twice within 3 s; it works while a subagent's permission prompt is open) ([interactive-mode](https://code.claude.com/docs/en/interactive-mode), [keybindings](https://code.claude.com/docs/en/keybindings)). Esc on the main turn does not stop background agents (2.1.47). A stopped agent keeps its partial results (2.1.76).
   - **Message**: type in its open view; Ctrl+Enter sends at once and backgrounds its running command (2.1.286). Typing into a stopped one resumes it.
   - **Approvals**: "When a background subagent reaches a tool call that needs permission, Claude Code surfaces the prompt in your main session and names the subagent that is asking. Approve to let the subagent continue, or press Esc to deny that one tool call without stopping the subagent." A grant that lasts beyond one call applies to the whole session. Foreground subagents pass prompts straight through ([sub-agents](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)).

Agent teams (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) are a **different mechanism**: teammates are separate Claude Code sessions with a team lead, not subagents. They share the panel and the "view" mechanics above, can be messaged directly, and can run in their own tmux or iTerm2 pane ([agent-teams](https://code.claude.com/docs/en/agent-teams)). They are prior art only for "own view" and "messaging".

## Claude Code desktop app (Code tab)

1. **Transcript**: Ctrl+O switches view modes: Normal (tool calls folded into summaries), Thinking, Verbose ([desktop](https://code.claude.com/docs/en/desktop)). How a subagent call is drawn inline is not documented.
2. **List**: a "tasks" pane, opened from the Views menu, lists the session's background work: subagents, background shell commands and workflows ([desktop, watch background tasks](https://code.claude.com/docs/en/desktop#watch-background-tasks)). Nesting not documented. The pane layout came with the 2026-04 redesign ([blog](https://claude.com/blog/claude-code-desktop-redesign), blog only).
3. **Own view**: clicking a tasks-pane entry opens its output in a separate "subagent" pane that can be dragged anywhere in the layout ([desktop](https://code.claude.com/docs/en/desktop)). How that pane marks itself is not documented.
4. **Control**: stop a subagent from the tasks pane. Agent teams are not available in Desktop. Whether the permission card names the asking subagent is not documented.
- **VS Code extension** (outside the three surfaces, but the most complete documented GUI): an "N agents" footer pill opens an **agent map** with a card per subagent, "Stop agent", and read-only transcripts (changelog `[VSCode]` 2.1.269); live progress rows for running subagents under tool-call groups (same release); Stop and Escape end only the current turn and background agents are stopped one by one from the map (later `[VSCode]` entry).
- **What a host gets from the Agent SDK** (Desktop is likely built on it; the docs do not say): messages carry `parent_tool_use_id`; `task_started`, `task_progress` (total_tokens, tool_uses, duration_ms, last_tool_name, summary) and `task_updated` events; the permission callback gets an `agentID`; `stopTask(taskId)` stops one ([Agent SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents#detect-subagent-invocation)).

## Claude Code on the web (claude.ai/code)

- For cloud sessions, the docs only say subagents "work the same way they do locally" ([claude-code-on-the-web](https://code.claude.com/docs/en/claude-code-on-the-web)).
- For a local session opened through Remote Control: subagent and workflow progress stay in sync on every device; on connect, the browser shows running background subagents and workflows; stopping one there stops it on the machine ([remote-control](https://code.claude.com/docs/en/remote-control)). Since 2.1.251 a foreground subagent's tool calls stream live to Remote Control clients; "background subagents, the default, still show status only" (changelog).
- Transcript marking, list, own view, and approval attribution in the web UI: not documented.

## Codex CLI (terminal)

The default user gets V1 (`multi_agent` on, `multi_agent_v2` off, `codex-rs/features/src/lib.rs`). See [subagents-codex.md](https://github.com/theagenticage/hercule/blob/research/subagents-codex/docs/research/subagents-codex.md) for the wire.

1. **In the parent's transcript** (`T/multi_agents.rs`, snapshot `T/snapshots/codex_tui__multi_agents__tests__collab_agent_transcript.snap`)
   - V1 cells:
     ```
     • Spawned Robie [explorer] (gpt-5 high)
       └ Compute 11! and reply with just the integer result.
     • Sent input to Robie [explorer]
     • Waiting for Robie [explorer]        (or "Waiting for N agents")
     • Finished waiting
       └ Robie [explorer]: Completed - 39916800
         Bob [worker]: Error - tool timeout
     • Closed Robie [explorer]
     ```
   - The nickname is accent colour and bold, the role is `[role]`, `(model effort)` is magenta. Status words: Pending init, Running, Interrupted (yellow), Completed (green, with a result preview), Error (red), Shutdown, Not found.
   - V2 cells: `• Started /root/worker`, `Interacted with ...`, `Interrupted ...`, `Completed ...`.
   - **No live progress** for a child in the parent: no spinner, timer, tokens or tool calls per child. Only the `/subagents` status cell (`T/app/agent_status_feed.rs`, V2 children only) shows "Sub-agents running" with the last few items per agent (`$ cmd`, `Updated N file(s)`, ...).
2. **List** - `/subagents` ("switch between this session's subagents", `T/slash_command.rs`) opens a picker (snapshot `T/snapshots/codex_tui__app__tests__path_backed_agent_picker.snap`):
   ```
     Subagents
     Select an agent to watch. ⌥← previous, ⌥→ next.
   › 1. • Main [default] (current)  <uuid>
        • Robie [explorer]  <uuid>
     enter select · esc back
   ```
   - Green dot means not closed; "running" is not shown. Order is spawn order. Finished children stay. Grandchildren are included but the list is flat; depth shows only in a V2 path like `/root/a/b`.
   - The docs say "`/agent` or `/subagents`", but at this tag only `subagents` and `agents` exist (`T/bottom_pane/slash_commands.rs`); `/agents` is a daemon-wide task center, not this list.
3. **Own view**
   - In: pick it in `/subagents`, or Alt+← / Alt+→ to cycle threads, or `o` on a child's approval. Out: the same keys back to "Main [default]".
   - The view is the child's full transcript, drawn like a normal session. The only marker is a footer label `Robie [explorer]` (or the V2 path), in secondary text style; it is hidden when only one thread exists (`T/bottom_pane/footer.rs`). No header, no colour.
   - A V2 child is locked: the composer placeholder reads "Viewing sub-agent - direct input is disabled" (`T/bottom_pane/chat_composer.rs:1658`), and submitting shows "This sub-agent is controlled by its parent. Direct input is disabled." A V1 child takes typed input.
4. **Control**
   - **Stop**: Esc in the child's view interrupts that child's turn; the interrupt path has no parent-owned check (`T/bottom_pane/mod.rs`). Read from code, not tested. No stop from the parent view.
   - **Message**: V1 yes, by typing in its view; V2 no.
   - **Approvals - the best attribution found.** A child's approval pops up wherever you are. The overlay header reads `Thread: Robie [explorer]` (fallback `Agent (<8-char id>)`) and the hint adds `o to open thread` (`T/bottom_pane/approval_overlay.rs:700`, test at L2188-2196). Above the composer, a list shows `! Approval needed in Robie [explorer]` (up to 3) and `/subagents to switch threads` (`T/bottom_pane/pending_thread_approvals.rs:48`). The docs confirm: "The approval overlay shows the source thread label, and you can press o to open that thread" ([developer commands](https://learn.chatgpt.com/docs/developer-commands.md?surface=cli)).
   - **Questions** (`request_user_input`) from a child are not surfaced in other threads, only approvals. Code only.

## Codex app (desktop) and IDE extension

Closed source; docs only ([Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), tabs per surface). The figures there are HTML mock-ups, not screenshots; the only image files are the identicon SVGs, for example `https://learn.chatgpt.com/images/codex/icons/subagent-seafoam-light.svg`.

1. **Transcript**: "The app surfaces each subagent thread so you can inspect its work and the summary returned to the main chat." The figure shows chips with a coloured identicon and a name, followed by "started working". Stable identicons for background subagents (changelog 2026-06-09); subagent diff stats in the composer (2026-04-01).
2. **List**: a Subagents panel with an "Active" section ("No active subagents") and "Done · 3"; each Done row has identicon, name, elapsed time ("2m") and a one-line result. Nesting not documented. IDE: "active subagents appear above the composer. Expand the panel to see their status, stop all active subagents, or open an individual subagent thread."
3. **Own view**: "Open a subagent thread from the activity shown in the main thread to inspect its work." What it looks like and how you get back are not documented.
4. **Control**: app - "Ask Codex directly to steer a running subagent, stop it, or close completed subagent threads"; no buttons documented. IDE - stop *all* active subagents from the panel. "Subagents inherit the permission mode selected beneath the composer." Approval attribution not documented.

## t3code

t3code has two kinds of subagent (`G/packages/contracts/src/orchestrationV2.ts`): **provider-native** (Claude's Agent tool, Codex `spawnAgent`, Cursor, OpenCode), which "cannot take messages", and **app-owned** ones started by its own MCP tool `delegate_task`, which are normal threads. Each subagent becomes its own child thread.

1. **In the parent's timeline**
   - One subagent is a `SubagentTimelineLink` row (`G/apps/web/src/components/chat/V2LifecycleRow.tsx`): an avatar (provider icon or `BotIcon`) with a status dot (blue running/waiting/queued, green completed, red failed, grey stopped or "Idle · resumable"), a title, one detail line (progress while running, result when done), an elapsed timer ticking every second, and a chevron. The whole row is a button labelled "Open <title>".
   - A hover card shows model, account, status, elapsed time, a 280-character preview, and the branch or worktree if it differs from the parent's (`SubagentTooltipContent.tsx`).
   - Several in a row collapse into a `V2SubagentGroup` (`MessagesTimeline.tsx`): up to 3 overlapping avatars plus "+N", "N subagents", and counts like "2 working · 1 done · 1 failed".
   - The spawn tool-call rows themselves are hidden (`withoutSubagentDelegationRows`). A finish notification is drawn as the same card with "Finished/Failed/Stopped".
   - No live tool feed in the parent and no token count (open issue #15429). Claude: the progress line is `task_progress.description`; frames with a `parent_tool_use_id` go into the child thread. Codex: children are registered from `receiverThreadIds` / `subAgentActivity`; a path like `/root/x_y` is shown as "X Y".
2. **List** - a **"Lineage"** panel in the thread details (`G/apps/web/src/components/chat/ThreadRelationshipsControl.tsx`): header "Lineage · N running", running subagents in an open group, finished ones in a collapsed "Previous agents (N)" group that shows "N failed" if any failed. Rows: icon with status, title, elapsed, status label; click opens. 6 rows then "Show N more". Only one level is listed; a grandchild shows in its own parent's Lineage. The sidebar hides subagent threads.
3. **Own view** - a full thread at `/$environmentId/$threadId`, entered from the card, a Lineage row, or a name in the background-work banner.
   - Top of the timeline: a divider "Subagent of <parent title>" with `BotIcon` and an "Open parent thread" button (`MessagesTimeline.tsx:1264`).
   - For provider-native subagents, `ProviderSubagentBar.tsx` **replaces the composer**: provider icon, model and effort, live status and elapsed, the text "Runs on its own", and an "Open parent" button.
   - Lineage's first row is "Parent agent".
4. **Control**
   - **Stop**: no per-subagent stop on main (open PR #15211 "stop active subagents from Lineage", PR only). The background-work banner names each running subagent and has one "Stop" that interrupts the whole parent thread.
   - **Message**: provider-native no (no composer, by design); app-owned yes.
   - **Approvals**: a provider subagent's approvals and questions are written to the **root** thread and answered there (`ChatView.tsx` ~L4157, `CodexAdapterV2.ts` `approvalOwnerCodexTurn`). **No attribution in the UI**: the approval panels do not say which subagent asked; the link exists only as `parentNodeId` in the data. PR #13703 says so and leaves it for later (PR only).

## pi (and its subagent extensions)

pi core has no subagents on purpose: "Pi ships with powerful defaults but skips features like sub-agents and plan mode" (`packages/coding-agent/README.md:19`). Core also asks no approvals by default (`docs/security.md:3`), so prompts exist only where an extension adds them. Mario Zechner's [blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) (blog only) calls Claude Code's subagents opaque and suggests spawning `pi` via bash or tmux "for full observability".

**Official example** (`examples/extensions/subagent/index.ts`)

1. A custom `subagent` tool row: bold "subagent", agent name in accent colour, a dim 60-character task preview; "parallel (N tasks)" or "chain (N steps)" for the other modes. Progress updates at each child message end: tool calls as `→ $ cmd`, `→ read ~/p:1-10`, and a usage line `3 turns ↑12k ↓2k ... $0.0123 ctx:40k model`. No spinner, no elapsed. Collapsed shows the last 10 items "(Ctrl+O to expand)"; expanded shows the task, all tool calls, the output as Markdown, and usage. Quirk: single and chain mode show a green ✓ while still running.
2. No list. Modes: single, parallel (max 8, 4 at once), chain. No nesting control.
3. No own view; the child is `pi --mode json -p --no-session`, so no session file.
4. Stop: aborting the tool sends SIGTERM, then SIGKILL after 5 s. No steering. **Prompts in the child are silently denied**: in print mode `ctx.ui.confirm` returns false (`src/core/extensions/runner.ts:324-326`).

**nicobailon/pi-subagents** (by far the most used, about 593k downloads a month)

1. Collapsed header `<spinner> name <model> · ⟳ N · N tool uses · 12k token · 1m3s`; while running `⎿ <current tool>: args | 2.0s` and "Press <key> for live detail"; when done `⎿ Done/Stopped/Paused/Error`, the first output line, and session and output paths. Icons ✓ green, ✗ red, ■ yellow (`src/tui/render.ts`).
2. A fleet widget under the editor, "2 active agents · ... ↓/← to inspect", which expands into a tree (docs; row layout not verified). Commands `/subagents-fleet`, `/subagents-stop`, `/subagents-steer`. Nesting off unless enabled, default depth 2.
3. A `/subagents-fleet` overlay at 95% width with transcripts (j/k, s steer, D stop, Enter inspect, Esc/q close - docs). Each child has its own session file.
4. Stop: Esc aborts the foreground child; D or `/subagents-stop` per child. Steer: yes. Prompts: the child calls a `contact_supervisor` tool; the parent shows "⚠ Supervisor decision request" with `Run:`, `Agent:` and `Child index:` lines (`src/intercom/supervisor-ui.ts:141-143`), and the **parent model**, not the user, replies.

**tintinweb/pi-subagents** (styled after Claude Code)

1. `▸ <coloured name badge> description`; while running a spinner and `haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k tokens` plus an activity line ("reading..."). Done: ✓ "⎿ Done", ■ "Stopped", ✗ "Error".
2. A widget above the editor, "● Agents", with a `├─`/`└─` tree, two lines per agent (stats, elapsed, activity), queued ones folded into one row; a status bar "2 running, 1 queued agents" (`src/ui/fleet-list.ts`). Default depth 2; nested agents are hidden from the widget.
3. A live `ConversationViewer` overlay (90% × 70%), opened with Enter on a fleet row; Esc/q closes.
4. Stop: `x` twice in the viewer ("x again to STOP"). Steer: Enter in the viewer, or `@handle msg` in the editor. Prompts: the child gets no UI context, so prompts are auto-denied with no attribution (`agent-runner.ts:1019`).

**HazAT/pi-interactive-subagents** - each child is a full interactive pi in its own tmux/cmux/zellij/wezterm pane. A bordered widget `╭─ Subagents ── N running ─╮` lists `MM:SS name (agent)` and `active · <tool>`; finished ones drop out. The own view is the real pane; the user answers prompts and types there. Parent Esc does not reach the child.

## Others, briefly

**OpenCode** (`anomalyco/opencode` `907b3bc5`)

- Each subagent is a child session with `parentID` (`packages/opencode/src/tool/task.ts`). The parent shows an inline row "`<Agent> Task - <description>`" with a spinner and a second line `↳ Read foo.ts` (the child's current tool), then `✓` with tool count and duration; "Delegating..." before the child exists (`packages/tui/src/routes/session/index.tsx` `Task()` L2215).
- Child view: keys `<leader>down` first child, `right`/`left` cycle siblings, `up` to parent (`packages/tui/src/config/keybind.ts:103-106`; also [docs](https://opencode.ai/docs/agents)). Its footer reads "General (2 of 3) · tokens (ctx%) · $cost" with Parent / Prev / Next buttons (`subagent-footer.tsx`). **No prompt box.**
- Permissions and questions from children show only in the parent, collected across children; the prompt header names the tool, **not the subagent**. Rejecting offers "reject with message" (`permission.tsx`). Esc on the parent cancels the child. Default depth 1.

**Zed** (`zed-industries/zed` `96837d78`; `spawn_agent` since 0.227.0)

- A collapsible card per subagent: spinner, title, "· <model>", "N files changed" with +/- counts, and "Subagent Canceled" / "Subagent Failed". Buttons: **Stop Subagent**, expand (an inline preview of the child's thread), "Make Subagent Full Screen" (`crates/agent_ui/src/conversation_view/thread_view.rs` `render_subagent_card` ~L11148).
- Full screen: title bar with Stop and "Minimize Subagent", no message editor, and the final reply marked "Subagent Output" with a tooltip that everything below went to the main agent.
- Permissions are answered in the subagent's card; the parent shows a bar **"Subagents Awaiting Permission:"** listing each with a "Scroll to Subagent" link (L3942, PR #52460). Depth 1 (`MAX_SUBAGENT_DEPTH = 1`, `crates/agent/src/thread.rs:77`).

**Cline** (`68b24a92`)

- `new_task` is a hand-off to a fresh task, not a child. Real subagents are `use_subagents` (experimental, read-only researchers, parallel, no nesting; `docs/features/subagents.mdx`).
- One block "Cline wants to use subagents:" with a bordered card per prompt: status icon (spinner, check, X, slash for cancelled), prompt clamped to 2 lines, "N tools called · tokens · $cost", the latest tool call while running, "Show output" (`components/chat/SubagentStatusRow.tsx`). No own view, no messaging. One approval covers the batch. Aborting the task cancels them (changelog 4.1.17).

**Roo Code** (`b867ec91`; repo archived)

- Only one task is open at a time: on `new_task` the parent is parked and the child opens full panel in its place (`ClineProvider.ts` `delegateParentAndOpenChild`). The parent shows "Roo wants to create a new subtask in {mode} mode" and later "Subtask completed", both with "View task".
- The child's header has a **"← Parent task"** button (`TaskHeader.tsx:103`). History renders nested subtasks as a recursive tree ("N subtasks", a "Subtask" tag); parent cost reads "Total Cost (including subtasks)".

**Cursor** (closed; weakly verified)

- Docs: foreground or background subagents; "the subagent task card shows which model ran"; since 2.5 subagents can spawn one more level ([docs](https://cursor.com/docs/agent/subagents)).
- Forum staff post only: "Subagent transcripts in the IDE are read-only 'drill-in' views... To get the input back, click back into the parent agent's conversation" ([forum t/160023](https://forum.cursor.com/t/160023), 2026-05-08). Stop and approvals not verified.

**Amp**

- Subagents (Search, Oracle, Librarian): "You can't guide them mid-task"; the main agent "only receives their final summary" ([docs](https://ampcode.com/docs/models-and-subagents)). How they render is not documented. A "Thread Map" in the CLI shows linked threads as a graph ([news](https://ampcode.com/news/from-agent-to-agent)).

**GitHub Copilot in VS Code** (docs only, [subagents](https://code.visualstudio.com/docs/copilot/agents/subagents))

- In chat, a subagent is a "collapsed tool call with its agent name and current activity"; clicking shows prompt, tool calls and result.
- In the Agents window, subagents are "read-only chats" with a **lock icon** that "don't accept input"; an indicator shows model, elapsed time and active tool. Nesting opt-in, up to depth 5. Image: `https://code.visualstudio.com/assets/docs/agents/agents-window/agents-window-follow-subagents-read-only-chat.png`.

## What to steal for Hercule

Mapped to the decisions so far.

- **A Subagent is an entity owned by its session, nested by a parent pointer.**
  - Draw each subagent as one row in the parent's transcript, at the point it was spawned: name, task, status, elapsed time, and a live "current activity" line (OpenCode's `↳ Read foo.ts`, Cline's latest tool call, tintinweb's "reading..."). Add tool-use and token counts on the finished row (Claude Code's `Done (N tool uses · X tokens · duration)`).
  - Collapse several consecutive spawns into one group row with stacked avatars and status counts ("2 working · 1 done · 1 failed", t3code).
  - Give each subagent a stable identity mark (Codex identicons, Claude Code `color`) so the same agent is recognisable in the transcript row, the list, its own view and its Requests.
- **Per session, the user sees every subagent run.**
  - Keep finished ones. Claude Code's 30-second vanish is a gap, not a model. t3code's Lineage split ("running" open, "Previous agents (N)" collapsed, failures counted in the header) and the Codex app's "Active" / "Done" split both work.
  - Nesting: draw a tree from the parent pointer. Claude Code's `(+N)` descendant count on a collapsed row and its "path back to `main`" are the only real tree UI found; copy both. Most others cap depth at 1, so there is little else to learn from.
- **Open its transcript like a session's, clearly marked as a subagent.**
  - Reuse the session transcript view (everyone does), filtered to the subagent.
  - Mark it more strongly than anyone does today. Combine t3code's top divider "Subagent of <parent>" with an "Open parent" button, a breadcrumb built from the parent chain (Claude Code's path to `main`), and replace the composer with a status bar (t3code's `ProviderSubagentBar`: model, status, elapsed, "Runs on its own"). Read-only matches Zed, OpenCode, Copilot, Cursor and Codex V2.
  - Mark the final reply that went back to the parent ("Subagent Output", Zed).
- **Stop, cascading to descendants.**
  - A per-subagent Stop on its row, in the list, and in its own view (Zed has all three). Stopping the session's own turn should not silently stop background subagents, or should say so (Claude Code changed this in 2.1.47; VS Code split Stop into "turn" and "agent").
  - When the stop will cascade, say how many descendants it stops (Claude Code asks first and says how many subagents would restart, for workflows).
- **Several open Requests, each with an optional subagentId.**
  - Copy Codex's TUI: every Request names its asker (`Thread: Robie [explorer]`) and offers "open subagent" (`o to open thread`); keep a short list of "Approval needed in <name>" above the composer.
  - Copy Zed's "Subagents Awaiting Permission:" bar with a jump link.
  - Show the Request in both places: docked on the session's composer (where Hercule already surfaces Requests) and in the subagent's own view. t3code and OpenCode prove the failure mode: a subagent's approval in the parent with no name is ambiguous once two subagents run.
  - Mark the subagent's row as "waiting on you" while it has an open Request (Codex `/agents` "Waiting for approval.").
- **Messaging is ruled out.** The prior art supports this: most GUIs make the subagent view read-only. Claude Code and Codex V1 are the exceptions, and Codex V2 removed it.

## Open UI questions for the prototype

- **Where the list lives**: a side panel (t3code Lineage, Codex app panel, Claude Desktop tasks pane), a strip above the composer (Codex IDE, Claude Code CLI), or only rows in the transcript? Web and desktop may differ.
- **Subagent view as route or panel**: a deep-linkable route that replaces the session view (t3code, Roo), a side or split pane next to the parent (Claude Desktop, Copilot Alt-click), or an inline expand plus full screen (Zed)?
- **Back target**: does "back to parent" return to the spawn row in the parent's transcript, or to the top?
- **How strong the "you are in a subagent" marker is**: a top banner, a breadcrumb, a tinted background, the identity colour, or a combination. Must survive scrolling.
- **What a running row shows**: current tool only, or a short live tail; counts only (Claude Code) or tool names (OpenCode)?
- **Finished row**: result preview length, and whether failed or stopped look different from completed (all products use green/red/grey; is that enough?).
- **Nesting display**: indent in the list, `(+N)` counts, breadcrumbs in the view, and how grandchildren appear in the parent's transcript (the child's row only, or nested rows?).
- **Requests**: on the docked card, how the asker is named (name plus identity mark, plus path for nested?); whether answering from the parent is allowed or the user must open the subagent; what a session row shows when only a subagent waits.
- **Stop**: confirm or not when the stop cascades; what a stopped subagent's row says; whether a stopped subagent's open Requests are shown as cancelled.
- **Late finish**: a subagent can finish after its parent's turn ended (Codex V2 sends `completed` late, see subagents-codex.md). Where does that completion appear in the parent's transcript?
- **Naming**: what the row title is when the harness gives no name (Codex nickname and role, Claude Code agent type and description, t3code formats the task path).

## Not verified

- Nothing was run. On-screen looks come from docs and render code.
- **Claude Code CLI**: which key stops one running subagent from the panel or `/tasks` (docs say only that `/tasks` can stop a task); the exact wording of the permission dialog that names the subagent; the inline progress format for a foreground subagent (the older "+N more tool uses" string is not in 2.1.288); whether the subagent view has any marker beyond the placeholder, the bold row and the "Viewing ..." notices.
- **Claude Code desktop**: how a subagent call is drawn inline; nesting; permission attribution; messaging from the subagent pane; when the tasks and subagent panes arrived (blog only).
- **Claude Code on the web**: transcript marking, list, subagent view, approval attribution.
- **Codex CLI**: Esc stopping a V2 child (from code only); questions from a child (code only). The docs' `/agent` command does not exist at `rust-v0.160.0`.
- **Codex app and IDE**: the child view, how to get back, per-agent stop, approval attribution, nesting. No real screenshots exist; the figures are mock-ups.
- **t3code**: mobile UI (from client-runtime code and PRs only); per-subagent stop (open PR only); the stop path for app-owned children.
- **pi extensions**: nicobailon's fleet row layout and inspector keys (docs only).
- **Cursor**: stop and approvals; the read-only view rests on a forum staff post.
- **Amp**: how subagents render in a thread.
- **Copilot**: stop and approvals.
