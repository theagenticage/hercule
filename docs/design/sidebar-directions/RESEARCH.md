# Sidebar research: thread lists in agentic coding tools, and 2+ agents on one unit of work

Researched 2026-10-21. **[V]** verified in a primary source (docs, changelog, release notes, official repo/PR). **[S]** secondary only (blog, aggregator, forum). **[I]** my inference. Dates are of the source.

**Headline:** most tools still make one agent conversation the list row. A few have moved the row up to a unit of work (workspace / Space / session) with conversations inside it. Only VS Code, Conductor, Devin Desktop and Vibe Kanban treat "several agents, one worktree" as first-class. T3 Code built it and dropped it.

---

## Coding tools

### VS Code Agents window (1.127 Jul 1, 1.136 Sep 2, 1.141 Oct 7 2026): closest to the Hercule problem
- **Unit:** a *session* (one worktree) with a main chat plus **peer chats**. "All chats share the session's workspace and worktree." "Sibling chats can use different agents or models" [V]. Mixing harnesses in one session is not addressed [V: absent].
- **List:**
  - grouped by workspace (default) or by time [V];
  - **custom groups** you drag sessions onto, each with "new session in group" and "mark all done" [V 1.127];
  - peer chats are tree children that expand and collapse, and "each chat row shows its own title, status, and pending approvals" [V 1.136].
- **Roll-up:** "the session remains in progress while any chat is working". A **Changes pill combines edits from all chats** [V].
- **Clever:** unread is tracked per chat, and "an unread nested session does not make the main session appear unread". Mark as Read on the main session clears the whole tree [V 1.141]. Cleanup skips active, running, needs-input and pinned sessions [V].

### Conductor (changelog to 0.91.0, Oct 15 2026)
- **Unit:** the *workspace* = worktree + branch. Chats are **tabs** inside it (⌘T, 0.17.0), and the tabs can be Claude Code, Codex, Cursor or OpenCode in the same workspace [V].
- **The only vendor whose docs name this exact pattern:** use one workspace for "an agent implementing while another reviews the same diff" [V].
- **Sidebar:**
  - grouped by repo (0.35.2) and by status backlog / in progress / in review / done (0.35.0);
  - rows "labeled by PR title when available" [V];
  - GitHub state ("merged, failing CI, conflicts"), a needs-permission mark and a hover card with next actions (0.44.0, Mar 24 2026) [V];
  - a waiting indicator plus timer for background work (0.77.0) [V].
- **Clever:** clicking the workspace that is already selected "jumps to its oldest unread chat" [V].
- **Gap:** the list does not show which tab is which agent [I].

### Devin Desktop (formerly Windsurf; docs undated, "2.0")
- **Spaces** group "agent sessions, PRs, files, and context for a specific task" [V].
- **"Every session is its own Space by default, even if it isn't shown as one."** To group, you "drag a session onto another session in the sidebar". ⌘T opens a new session in the current Space. New sessions inherit the Space's context, and the layout is restored when you return [V].
- The Agent Command Center is a kanban by status. Arena Mode runs the same prompt across models in separate worktrees [S].
- **Missing from the docs:** how a Space row looks and how its status rolls up.

### Vibe Kanban (docs undated)
- **Unit:** the *workspace*, created from a kanban issue. *Sessions* are the conversations inside it ("one session for implementing the backend API and another for the frontend UI") [V].
- Sessions sit in a **dropdown in the chat toolbar**, auto-named from the initial task. "Each session remembers which agent it's using", e.g. Claude Code plus Gemini CLI [V].
- **Roll-up:** "the workspace sidebar summarizes the state across all sessions" (Running / Idle / Needs Attention). The sidebar is flat or an accordion by status, with a raised-hand icon for approvals and a PR badge [V].
- **Weakness:** the siblings are hidden in the dropdown [I].

### T3 Code (pingdotgg/t3code)
- **Sidebar v2 became the default on Aug 8 2026 (#5672).** It is a **flat thread list** that replaced the project-grouped sidebar, with sections Pinned / Active / Snoozed / Settled and auto-settle [V].
- **Snooze (#4311):**
  - an overlay on Active, not a new destination;
  - a collapsed "Snoozed · N" shelf;
  - a woken thread gets an amber **Woke** pill in its original slot: "the calm static sort is untouched; the pill carries the signal";
  - blocked-on-you threads cannot be snoozed [V].
- **#4458 "task tabs" (closed unmerged, Jul 30 2026) is exactly this problem.** "The current sidebar treats each agent conversation as an independent unit even when several agents are working toward one outcome." The PR grouped sibling threads under a durable `workspaceTaskId` ("the worktree-backed task the durable unit"), showed them as tabs with a different provider per tab, and made settle, snooze and unread act on the whole task [V].
- **Why it died:** the maintainer wrote "restart from a small v2-native task-group model". A user replied: "the biggest thing missing from T3 Code" [V].

### Claude Code (code.claude.com docs; desktop redesign blog Apr 14 2026)
- **Desktop:**
  - the row is a *session*, with Group by / Sort by and filters by status, project or environment [V];
  - a session auto-archives when its PR merges (opt-in) [V], ⌘-click opens a second pane, and a **Dispatch badge** marks sessions that Dispatch started [V];
  - subagents are not in the sidebar [V].
- **Cross-session messages:** shown "as a card labeled with the sending session's title and a link back" [V]. The list shows no relation between the two sessions [I].
- **Agent view (`claude agents`, research preview):**
  - grouped by state: **Pinned, Ready for review, Needs input, Working, Completed**, with Ctrl+S to group by directory [V];
  - **colour = state, shape = process liveness** (`✻` running, `∙` exited, `✢` sleeping loop) [V];
  - a PR label `#1234` coloured by PR state, and Space opens a peek panel with a reply box [V];
  - subagents and teammates are not rows [V].
- **Agent teams (CLI):** working, failed and viewed teammates keep their own rows. When more than three teammates are idle, the rest **collapse into a "2 idle agents" row** [V].
- **Projects (beta):** a coordinator plus one thread per sub-task, each with its own branch and PR. The Overview groups threads by Ready for review / Waiting on you / Working / Landing / Idle / Resolved, and threads auto-resolve after a week idle [V]. This is one thread per task, not several threads per task [I].

### OpenAI Codex app + CLI (app 26.1007 Oct 8 2026; CLI 0.163.0 Oct 15 2026)
- **App:**
  - sidebar sections Pinned / Projects / Recents, with a filter for by-project or chronological [V];
  - threads run in Local, Worktree or Cloud mode, and Handoff moves a thread between Local and Worktree (Mar 2026) [V];
  - "chat coordination for local projects and worktrees" and "consistent visual identifiers for background subagents" (May 28 2026) [V wording; scope unclear];
  - subagents appear as read-only Active / Done lists [V].
- **No grouping of sibling threads on one worktree.** A Feb 2026 bug report complained that worktree threads did not group under their project [S].
- **CLI:** a Command Center where `p` pins tasks into a shared Pinned group (0.162.0), plus manually ordered chat sections (0.147.0) [V].

### Cursor (3.0 Apr 2 2026 to 3.24, Oct 2026)
- **Sidebar:** grouped Today / Last 7 days / Older, with Older collapsed [V]. The editor sidebar groups by git remote, so all worktrees of a repo share one section, and "per-worktree grouping" is still being built [S, staff forum reply].
- **3.24:** "Subagents and side chats open as tabs on their parent agent", and "a Project's row now lights up when one of its threads is unread" [V].
- **Best-of-n:** `/best-of-n` runs one task across several models, each in its own worktree, and a parent agent compares or merges the results [V].
- **Projects (Sep 10 2026):** a coordinator plus workers. You "drag a local agent onto a cloud Project in the sidebar" to add it [V].

### Superset (changelog to Sep 13 2026)
- **Unit:** the workspace. The row carries **chips** for ports and running agents, and subagents "nest under their parent in the workspace row's agents chip" (hover popover) [V].
- **Workspaces page:** grouped by "what needs you": Needs attention / Working / Needs review / Idle / Merged / Deleted, "derived from agent status and PR state". Rows show ahead/behind `↑N ↓N` [V].

### Zed (parallel agents, Apr 22 2026)
- Threads are grouped by project, and "threads running in linked Git worktrees appear under the same project as their main worktree" [V].
- A row is title + status + agent. The project header has a "+" for a new thread in that group, and terminal threads (claude, codex) are rows with an icon [V].
- No level below the project.

### Amp (ampcode.com docs; thread map Dec 11 2025)
- **Sidebar:**
  - Pinned first, then active threads by project;
  - a collapsed **"Inactive Last 72h"** section with archive-all;
  - Snoozed and Archived sections at the bottom [V];
  - a **thread colour** that tints both the sidebar mark and the title bar [V].
- **Lineage:** Fork was removed in favour of **Handoff** (a new thread with distilled context) plus **mentions**. The **thread map** is "a top-down view of all threads connected to your current thread via mentions, handoffs, or forks" [V].

### Warp (Agent Management Panel)
- "Local children don't appear as separate rows"; they are pills above the agent header [V].
- **There is no roll-up.** "A parent's status reflects only its own work, so it can succeed while a child is still running or has failed" [V]. This is the anti-pattern to avoid.

### GitHub Agent HQ
- You can "assign an issue to Copilot, Claude, Codex, or all three to compare results" (Feb 4 2026) [V].
- **The issue is the unit:** a header pill "shows all active and completed agent sessions at a glance" (Apr 23 2026) [V].

### Others, briefly
- **Devin managed sessions** (Mar 19 2026): a coordinator with child sessions, each with its own link and compute meter [V].
- **Jules:** running tasks first in the repo view; `--parallel` starts up to 5 sessions per prompt [S].
- **Nimbalyst** (successor to Crystal, which was deprecated Feb 2026): a session kanban and "group into workstreams" [V, marketing].
- **Sculptor:** a container per agent, and Pairing Mode syncs it into the local repo. No task grouping [V].
- **OpenHands, Factory, Terragon:** flat lists with filters and pins; nothing on multi-agent grouping [V/S].

---

## Non-coding patterns worth borrowing
- **Gmail conversation view:** *implicit* grouping by a shared key (the subject), with no user action [V]. Hercule's equivalent key is the shared workspace.
- **Slack:** an active huddle shows a headphones icon on the channel row [V]. Show child activity on the parent row.
- **Linear:** "Nested sub-issues" in lists, group by parent on boards; closing a parent closes its children [V].
- **Chrome tab groups:** name + colour; collapsed, a group shows only "the group's name or colored circle" [V].
- **Arc:** Folders, and Split View made by dragging a tab into the window [V]. A split is a single sidebar item [I].
- **Stage Manager:** drag a window in to add it to a set; the set is focused as one unit [V].
- **iOS notification stacks / iMessage group avatars:** N items in one slot with overlapping avatars, expanded on tap [I].
- **Things 3 headings:** light labeled sections inside a project; a heading can be promoted to a project [V].
- **Kanban swimlanes:** a row per unit, a column per status [I].
- **Git graph / Amp thread map:** lineage drawn as edges, not boxes [V].

---

## Gaps nobody fills
1. **Automatic grouping by shared worktree.** Grouping is either too coarse (repo/project: Cursor, Zed, Codex) or manual (VS Code custom groups, Devin drag-to-Space). Hercule knows two threads share a workspace and can group them like Gmail threads mail.
2. **The agent shown on each child row in a mixed-harness group.** Conductor and Vibe Kanban allow mixing agents but hide which agent is which inside tabs or a dropdown.
3. **Roles.** No tool labels a sibling "implementer" or "reviewer", or shows where the review loop stands ("review found 3 issues, implementer fixing").
4. **A defined roll-up priority plus a pointer to the child.** No tool documents which state wins (needs-input > failed > working > ready-for-review > idle) and links to the child that needs you, as Conductor's "jump to oldest unread chat" does.
5. **Repeated titles.** Child rows are auto-named from prompts, so "MwsResult" appears twice. Nobody gives the unit one title and shortens child rows to role + agent ("Codex · review").
6. **Unit-level lifecycle.** Snooze, settle, archive or auto-settle on PR merge for all siblings at once. Only T3's abandoned PR and VS Code's "mark all done" come close.
7. **A group of one drawn as a plain row.** Devin's "every session is its own Space" has the right idea, but no tool shows a single thread without group chrome that grows a group only when a second thread joins.
8. **Collapsing quiet siblings in a GUI sidebar.** Claude agent teams collapse idle rows ("2 idle agents"); no app sidebar does.
9. **A combined review surface.** Only VS Code's combined Changes pill exists. No tool shows a reviewer's findings beside the implementer's diff.

---

## Vocabulary (applied to this sidebar)
- **Object-oriented UX (OOUX):** pick the primary object first. Here it is the unit of work (the workspace), with threads nested inside it.
- **Nested vs flat hierarchy:** a two-level unit > threads tree against T3-style flat rows. Nesting pays only when a unit has 2+ threads.
- **Containment vs association:** a group box (Spaces, peer chats) against links between peers (Amp mentions). A pair on one worktree is containment.
- **Implicit vs explicit grouping:** grouping by a shared key against grouping by drag. Implicit costs the user nothing.
- **Degenerate case (group of one):** a unit with one thread must look exactly like today's row.
- **Chunking:** N rows become a few units, so there is less to scan.
- **Progressive disclosure:** show the unit's status first, the siblings on expand or hover (Superset chip, Chrome collapse).
- **Roll-up / aggregation:** the parent's status is computed from its children by a fixed priority.
- **Information scent:** cues that point to the right row: agent icon, role, PR number, diff stats.
- **Glanceability:** one look answers "which unit needs me?".
- **Pre-attentive attributes:** colour, shape, motion and position are seen before reading. Claude's colour = state, shape = liveness is a good split.
- **Gestalt common region:** a shared background or border marks one unit.
- **Gestalt proximity:** tight spacing inside a unit, more space between units.
- **Gestalt similarity:** the same mark or colour on every sibling (Amp thread colour, Chrome group colour).
- **Gestalt connectedness:** a tree guide line joining the siblings.
- **Gestalt common fate:** siblings move together when the list re-sorts.
- **Focus + context:** the active thread is drawn in full; its siblings stay visible but quieter.
- **Overview + detail:** the sidebar is the overview, the pane is the detail, and a peek panel sits between them.
- **Wayfinding:** highlight both the active child and its unit, so you know where you are.
- **Recognition over recall:** you see that two rows belong together instead of remembering it.
- **Stable ordering / spatial memory:** rows don't jump when status changes; a badge carries the signal (T3's "calm static sort").
- **Swimlane:** a lane per unit, with its threads inside.
- **Stack:** overlapping cards or avatars meaning "N here".
- **Clustering:** grouping by attribute similarity (worktree, branch, PR).
- **Redundancy removal:** say the shared title once on the unit; children show only what differs (agent, role, status).

## Sources
code.visualstudio.com/updates/v1_127, v1_136, v1_141 + /docs/agents/run/sessions/manage-sessions; conductor.build/docs/concepts/parallel-agents, /agent-modes, /changelog (0.17.0, 0.35.0, 0.44.0, 0.77.0); docs.devin.ai/desktop/spaces, /agent-command-center; vibekanban.com/docs/workspaces/interface.md, /sessions.md; github.com/pingdotgg/t3code PRs #4311 #4458 #5672; code.claude.com/docs/en/desktop, /agent-view, /agent-teams, /claude-projects; claude.com/blog/claude-code-desktop-redesign; learn.chatgpt.com/docs/features, /changelog, /whats-new.md, /agent-configuration/subagents; cursor.com/changelog/3-0, /docs/release-notes, /changelog; forum.cursor.com [S]; superset.sh/changelog/2026-09-13, docs.superset.sh/workspaces; zed.dev/docs/ai/parallel-agents, /blog/parallel-agents; ampcode.com/docs/threads, /news/thread-map; docs.warp.dev/agent-platform/cloud-agents/managing-cloud-agents; github.blog (Agent HQ Feb 4 2026; changelog Apr 23 2026); cognition.com/blog/devin-can-now-manage-devins; imbue.com/sculptor; github.com/stravu/crystal; support.google.com (Gmail, Chrome); support.apple.com (Stage Manager); linear.app/docs/display-options; culturedcode.com Things headings; slack.com/help.
