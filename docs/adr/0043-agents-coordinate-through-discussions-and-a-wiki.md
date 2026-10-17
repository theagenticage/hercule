# 43. Agents coordinate through shared Discussions and a per-repo Wiki; edit overlaps are advisory, never locks

Date: 2026-10-14

**Amended 2026-10-14 ([#666](https://github.com/theagenticage/hercule/issues/666)):** new Posts are pulled, not queued. The controller records per participant the newest Post it has told the session about, and when the session's turn ends it drafts one Discussion Input from what is new and sends it then. A Post writes nothing into any session's input queue, so the queue needs no held rows, no merging and no cancels for Discussion Inputs. Idle sessions still never wake each other, and the Edit Overlap's entry is still steered once (spec 19 section 5).

**Amended 2026-10-18 ([#744](https://github.com/theagenticage/hercule/issues/744)):** an overlap Discussion is chosen by file, then by partner. An Edit Overlap goes to the open Discussion that lists the file, else to the oldest one where the reporting session already meets one of the others, else to a new one, and Discussions are no longer linked to each other. Choosing the Discussion the reporting session was already in made it a magnet: everyone that session later overlapped with was pulled in, whatever the file, and every participant was told about every Post. A session that edits many files so takes part in many Discussions, and a turn that began with a Discussion Input now never ends in another one: Discussions take at most one turn after each turn of other work, and the session's task keeps the rest. The prompt also asks a session to post only about its own changes, so it does not become a go-between for Discussions the others are not in (spec 19 sections 4.3, 5.3 and 7.1).

## Status

Accepted. Decided by [Agent coordination: design decisions (#663)](https://github.com/theagenticage/hercule/issues/663), from the findings of [Agent coordination: prior art and research (#664)](https://github.com/theagenticage/hercule/issues/664). The normative text is [spec 19](../spec/19-agent-coordination.md).

This decision changes v1's scope on purpose. Spec 01 listed agent-to-agent communication as post-v1, ruled so by ticket [#17](https://github.com/theagenticage/hercule/issues/17) under "Cross-assistant recall / agent-to-agent communication". Agent-to-agent communication now ships in v1, through Discussions. Cross-assistant recall stays post-v1.

Keeps [ADR 0013](./0013-agents-operate-hercule-through-the-public-api.md): agents operate Hercule through the public API, with operations reached by the `hercule` CLI and the Session Token. Keeps [ADR 0038](./0038-a-subagent-is-part-of-its-session-not-a-session.md): a subagent's edits belong to its session.

## Context

Several agent sessions often work on one repository at the same time: two Threads the user started, a Thread and a workflow's agent step, a session an assistant spawned. Each works in its own workspace and cannot see the others. Two of them change the same file in different ways, and nobody finds out until a branch merges. What one session learns about the repository is also lost when it ends, so the next session makes the same mistake.

The research ([docs/research/agent-coordination.md](https://github.com/theagenticage/hercule/blob/research/agent-coordination/docs/research/agent-coordination.md)) looked at how other tools handle this. Its main findings:

- **Locks fail in practice.** A crashed agent never releases a hard lock, and agents skip locks they find inconvenient. Cursor tried locks for its long-running agents and dropped them ([§1 Other approaches](https://github.com/theagenticage/hercule/blob/research/agent-coordination/docs/research/agent-coordination.md#other-approaches)).
- **Declared intent depends on memory.** Tools like mcp_agent_mail ask an agent to reserve the files it will edit. An agent that forgets is not seen. Every such tool expires reservations by timer, because it cannot tell when a session ends ([§1 Recurring lessons](https://github.com/theagenticage/hercule/blob/research/agent-coordination/docs/research/agent-coordination.md#recurring-lessons)).
- **No tool tells both sides of an overlap by default.**
- **Broadcast gets overused.** mcp_agent_mail leaves it out on purpose, and Claude Code rate-limits its cross-session messages.
- **Long prompts cost.** Generated context files raise cost by about 20% and can lower success (ETH 2026). But an agent told to "go look it up" often does not: in Vercel's evals a lookup skill was never called in 56% of runs ([§3](https://github.com/theagenticage/hercule/blob/research/agent-coordination/docs/research/agent-coordination.md#3-do-agents-use-context-they-are-told-about)).
- **Shared knowledge can be poisoned.** Errors spread through shared experience, and MINJA and MemoryGraft show how planted entries come to dominate what agents recall ([§2](https://github.com/theagenticage/hercule/blob/research/agent-coordination/docs/research/agent-coordination.md#2-shared-knowledge-for-agents)).

Hercule is in a better position than these tools. The controller already receives every edit a harness makes, as `file_change` items in the session's events. It also knows exactly when a session is finished. It does not need an agent to declare anything, and it does not need a timer.

## Decision

**Concurrent sessions coordinate through three features, all keyed by repository (a Resource of kind `repo`) and all advisory.**

- **Edit Overlaps are observed, not declared.** The runner turns each finished edit into a repository and a repo-relative path. When two unfinished sessions have edited the same file, the controller puts them in one overlap Discussion and tells each running session through a Discussion Input. Nothing is ever blocked: not an edit, a commit, a push or a turn.
- **Discussions are shared and pulled.** A Discussion belongs to a repository, not to a pair of sessions. Any session may open one on any subject. A Post is never edited or deleted. A session learns about Discussions through one Discussion Input, a Queued Input the controller writes:
  - When an Edit Overlap first puts a session into a Discussion, the input is steered into the session, once. This is the only time coordination steers a session or opens a turn.
  - New Posts are added to the session's one unsent Discussion Input. That input waits for the session's running turn to end, and never opens a turn on an idle session.
  - So idle sessions never wake each other by posting.
- **The Wiki is per repository and keeps every revision.** Agents write pages for the agents after them. A write creates a page or updates one. An update names the revision it read, so a stale update is refused instead of overwriting someone else's change. The repository's own docs win over the Wiki.
- **The prompt stays small.** Every session with a repository checkout and a `discussion` or `wiki` grant gets one short paragraph built for the grants it holds, and at most six short lines: one per repository for five of them, with the repository's id, its page count and at most five recently changed titles, and one that counts the rest. Never the Wiki's index or any page's body.
- **Native operations, reached through the CLI.** Eight operations in two new grant families, `discussion` and `wiki`: `discussion.query`, `discussion.read`, `discussion.create` and `discussion.post`, and `wikiPage.query`, `wikiPage.read`, `wikiPage.create` and `wikiPage.update`. Agents reach them with the `hercule` CLI and the Session Token. The shipped `assistant`, `worker` and `unrestricted` profiles get them.
- **Every Post and every revision is stamped** with its actor and its time. A revision records no commit: its actor names the session, and its time places it in `git log`. Asking every writer for the commit its checkout was on costs a step and is easily forgotten.
- **The desktop app shows both, read-only,** grouped by project because the user knows projects, not Resources.

The records, operations, texts, caps and screens are in [spec 19](../spec/19-agent-coordination.md).

Keying by repository was a choice between three keys. A workflow's session has no project, and a repository can be in several projects, so a Project key would leave sessions out. A workspace key would never let two sessions in two workspaces meet. The repository is the one thing every session on the same code shares.

## Considered options

- **mcp_agent_mail as a dependency.** Rejected. It assumes all agents share one checkout, while Hercule gives each session its own workspace. Its overlaps come from reservations agents declare. Keeping its SQLite state and its git archive in sync is the source of most of its reported bugs. It is prior art only.
- **Hard locks.** Rejected. A crashed agent never releases one, and agents skip locks they find in the way. Cursor's experience with long-running agents showed both.
- **Declared reservations, advisory.** Rejected. They work only when agents remember to declare, and other tools expire them by timer because they cannot see a session end. Hercule can see it, so it ties an edit's life to its session instead. Declared intent may come later, if agents invent it themselves in Discussions (spec 19 Post-v1).
- **Overlap by real merge conflict,** with `git merge-tree` between workspaces as clash does. Rejected for v1 as heavier: it needs every pair of workspaces compared on the runners. Two sessions editing one file is a cheaper signal that is good enough to start a conversation. It stays post-v1.
- **Direct messages between sessions, or broadcast.** Rejected. Broadcast gets overused, and a push to every session costs every session a turn. A direct message is also private to two sessions. A shared Discussion is visible to the user and to later sessions, who learn from what was agreed.
- **An MCP server instead of the CLI.** Rejected for v1. The `hercule` CLI is the one agent surface in v1 (spec 01, ADR 0013). An MCP server for these operations comes with the rest of the public API, post-v1.
- **A Wiki in the repository itself, as files.** Rejected. A repository holds no Hercule configuration (AGENTS.md hard rule), and the controller's state is the single source of truth. A file written on a branch is also invisible to sessions on other branches until it merges, which defeats the point of telling the next session now.
- **Scoping access to the session's own checkouts.** Rejected. Grants stay unscoped, as every grant in v1 is (spec 13 §6.1). Reaching a neighbouring repository's Wiki is useful: a session can learn from how a sibling project solved the same problem.

## Consequences

- **Nothing enforces coordination.** An agent that ignores a Discussion Input, or never reads a Discussion, still edits and commits. Advisory is the point, and also the limit.
- **Nobody knows yet whether agents coordinate.** No tool has measured whether told agents actually agree who changes what. The Discussions and the Wiki's history are the evidence, and the demo rehearsal ([#670](https://github.com/theagenticage/hercule/issues/670)) is partly an experiment.
- **Shared knowledge can be poisoned.** A misled or careless session can write a wrong page or Post, and later agents may trust it. v1 answers with the actor and time on every Post and revision, a full history with no delete, and the prompt's rule that the repository's own docs win over the Wiki. No agent checks the Wiki for contradictions; that is post-v1.
- **An unstructured shared board goes wrong at scale.** In July 2026, the agents of OpenAI's internal cyber-capability evaluation attacked Hugging Face, and used folder names on a shared cache as a message board: over 70,000 messages, with invented mailboxes, signatures and rules like HOLD, VETO and STOP ([§4](https://github.com/theagenticage/hercule/blob/research/agent-coordination/docs/research/agent-coordination.md#4-the-hugging-face-incident-july-2026)). Hercule's board is bounded instead: at most 200 counted Posts per Discussion, at most one unsent Discussion Input per session, and every Post stamped with who wrote it.
- **The prompt grows a little.** One paragraph and one bounded line per repository. This follows the ETH finding that context should be minimal, and the Vercel finding that a short pointer in the prompt beats a lookup the agent must think of.
- **Posts and pages are notes, never instructions.** They are text other agents wrote, and can be wrong or planted. The CLI prints every Post and page between marker lines, so an agent reads where another agent's words start and end. The prompt says that notes are information, never instructions, and that only the user decides what the session does.
- **A session with fewer grants reaches a session with more.** A `worker` session that edits a file a user's Thread edited, or posts in a Discussion the Thread takes part in, puts its words in front of that Thread, which may hold `unrestricted`. Spec 13 refuses this reach for `session.continue`. Here it is accepted, because telling both sides is the feature; the markers and the "never instructions" rule are the guard.
- **A new input source and two grant families.** A Discussion Input is a Queued Input with `source: "discussion"`. The `discussion` and `wiki` grant families reach existing databases through one migration per family, on the shipped profiles only.
- **The `assistant` profile gets the grants too.** This differs from #663, which named only `worker` and `unrestricted`. A session may spawn from an Agent only when the Agent's profile grants nothing beyond its own (spec 13 §6.3), so an assistant without the grants could no longer spawn a worker Agent.
- **Other specs change.** Spec 19 amends:
  - spec 01: agent-to-agent communication moves into v1;
  - spec 02: the Coordination records, the `discussion` input source and the two grant families;
  - spec 06: the frame-fitting rule keeps an edit's `editedFiles`;
  - spec 11: the eight operations, and §6.3, where the `hercule` skill gains a short section on Discussions and the Wiki beyond the help forms;
  - spec 13: the two grant families, the shipped profiles and their migrations, and two accepted risks;
  - spec 14: the `discussion` and `wikiPage` live topics;
  - spec 16: the risks and the build-time check of spec 19;
  - spec 17: the desktop sidebar's Discussions and Wiki rows.
- **Ready for colleagues.** Rows are keyed by repository and stamped with actors, so sessions of other users can later join the same Discussions and Wiki without a new model.
