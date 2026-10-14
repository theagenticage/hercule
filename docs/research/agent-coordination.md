# Research: coordination between concurrent coding agents

Gathered 2026-10-14 for the agent-coordination effort (Edit Overlaps, Discussions, a shared Wiki). Sources are primary where possible; items marked **unverified** could not be checked against the original.

## 1. File locking and messaging tools

### mcp_agent_mail (Jeffrey Emanuel)

- The Python repo is superseded by a Rust rewrite and no longer maintained. <https://github.com/Dicklesworthstone/mcp_agent_mail>, <https://github.com/Dicklesworthstone/mcp_agent_mail_rust>
- The author rejects git worktrees ("reconciliation debt"): agents share one checkout and coordinate through reservations. Hercule's model is a workspace per session, so the reservation model does not transfer as is.
- **Reservations** are declared by the agent: `file_reservation_paths(project_key, agent_name, paths[], ttl_seconds=3600, exclusive=True, reason)`. Globs conflict both ways. Check, renew, release and force-release calls exist. ([app.py](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/main/src/mcp_agent_mail/app.py#L11442))
- **Advisory**: a conflicting reservation is still granted, and only the requester sees `conflicts: [{path, holders}]`. The first holder is told only when its stale lease is force-released.
- **Enforcement** is an optional pre-commit/pre-push hook, with a warn mode and bypasses (`AGENT_MAIL_BYPASS=1`, `--no-verify`).
- **Messages**: inboxes and threads, importance, acknowledgements, full-text search. There is deliberately no broadcast ("many agents will overuse broadcast-style messaging"). Contact policies limit unwanted messages.
- **Storage**: SQLite for live state plus a git archive of Markdown messages. Keeping the two in sync is the source of most reported bugs (#180, #244, #257, #278 on the Rust repo). A broad glob in the stale-lease check wedged the server (#240 on the Python repo).
- **Identity**: `register_agent` hands out throwaway names like "GreenCastle".
- Companion tools: Beads (task queue; its id doubles as thread id and reservation reason) and ntm (tmux control; its opt-in coordinator mails holders of overlapping reservations). <https://github.com/Dicklesworthstone/ntm>
- **Unverified**: no first-hand reports were found on whether agents actually respect reservations.

### Other approaches

| Tool | Mechanism | Detects conflicts before the PR? |
|---|---|---|
| Claude Code agent teams | JSON inbox per agent, shared task list with file locks, direct messages only. <https://code.claude.com/docs/en/agent-teams> | No; the docs say to split files. |
| Claude Code cross-session messaging | Per-session socket, rate-limited. <https://code.claude.com/docs/en/cross-session-messaging> | No; manual. |
| Cursor parallel agents | Worktree per agent. <https://cursor.com/docs/configuration/worktrees> | No; isolation only. |
| Cursor long-running research | Tried locks, then optimistic concurrency, then planner/worker roles. Locks failed: agents held them too long or skipped them. <https://cursor.com/blog/scaling-agents> | Roles worked. |
| Codex app / cloud | Worktree per chat; cloud branches from a snapshot of main. <https://github.com/openai/codex/issues/16299> | No. |
| Conductor | Workspace = branch + worktree. <https://www.conductor.build/docs/concepts/parallel-agents> | No. |
| Gas Town | Merge queue that bisects failures. <https://github.com/gastownhall/gastown> | No; serialises at merge. |
| clash | `git merge-tree` between every pair of worktrees; Claude Code PreToolUse hook. <https://github.com/clash-sh/clash> | Yes, real conflicts, not just same-file edits. |
| git-kura | Hard per-path "seals". <https://pkg.go.dev/github.com/tooppoo/git-kura> | Yes, as a lock. |
| Anthropic C compiler | Lock files in `current_tasks/`; git push decides. <https://www.anthropic.com/engineering/building-c-compiler> | No. |

### Recurring lessons

- Advisory beats hard locks: crashed agents never release hard locks, and agents skip locks they find inconvenient (Agent Mail, Cursor).
- Every tool expires claims by timer plus staleness checks because it cannot see when a session ends. A controller that knows session lifetimes avoids that problem.
- No tool found alerts both sides of an overlap by default.
- Declared intent (Agent Mail, git-kura) depends on agents remembering to declare; observed edits (clash) do not.
- Broadcast gets overused; pull-when-needed and rate limits recur (Agent Mail, Claude Code).

## 2. Shared knowledge for agents

- **Karpathy, "LLM Wiki"** (gist, 2026-04-04): <https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>. Three layers: raw sources (read-only), a wiki the LLM owns, and a schema file (CLAUDE.md/AGENTS.md) with conventions. `index.md` is read first on every question; `log.md` is append-only. Operations: ingest, query (good answers are filed back), and a periodic lint pass for contradictions, stale claims and orphan pages. One agent with one human; concurrent writers are not covered.
- **MAST** (Cemri et al., 2025, <https://arxiv.org/abs/2503.13657>): 14 failure modes of multi-agent LLM systems. Most failures are design and verification failures; information withholding (0.85%) and ignoring another agent (1.9%) are rare.
- **Anthropic multi-agent research system** (2025, <https://www.anthropic.com/engineering/multi-agent-research-system>): coding has "fewer truly parallelizable tasks"; vague handoffs made agents "duplicate work, leave gaps"; subagents write results to files to avoid a "game of telephone".
- **Cognition, "Don't Build Multi-Agents"** (2025, <https://cognition.com/blog/dont-build-multi-agents>): "actions carry implicit decisions"; parallel agents make choices others cannot see.
- **Blackboard LbMAS** (2025, <https://arxiv.org/abs/2507.01701>): agents communicate only through a shared board, with maintenance agents (conflict-resolver, cleaner, critic). Removing the cleaner hurt accuracy. Far fewer tokens than message-passing baselines.
- **AgentRoom** (2026, <https://arxiv.org/abs/2608.23740>, abstract only): concurrent coding agents with file claims and broadcast; "coordination, not parallelism or CRDT-merge, bears the load".
- **AgenticFlict** (2026, **unverified**, secondhand): ~28% merge conflicts in agent-authored PRs, ~42% when two different agents work on one repo.
- **Agent Workflow Memory** (2024, <https://arxiv.org/abs/2409.07429>), **Agent KB** (2025, <https://arxiv.org/abs/2507.06229>), **Collaborative Memory** (2025, <https://arxiv.org/abs/2505.18279>): shared, reused experience helps; Collaborative Memory stamps each entry with its writer, sources and time.
- **Error propagation and poisoning**: experience-following spreads errors (<https://arxiv.org/abs/2505.16067>); MINJA (<https://arxiv.org/abs/2503.03704>) and MemoryGraft (<https://arxiv.org/abs/2512.16962>) plant bad memories that come to dominate retrieval and persist.
- **Staleness**: Zep/Graphiti (<https://arxiv.org/html/2501.13956v1>) gives facts valid-from/valid-until times and ends old facts rather than deleting them.

## 3. Do agents use context they are told about?

- **ETH, "Evaluating AGENTS.md"** (2026, <https://arxiv.org/html/2602.11988v1>): generated context files lower success 0.5-2% and raise cost 20-23%; developer-written ones give about +4%. Agents do follow tools a file mentions. Advice: keep only the minimum.
- **Lulla et al.** (2026, <https://arxiv.org/abs/2601.20404>): AGENTS.md cut median runtime 28.6% and output tokens 16.6%.
- **Vercel** (2026, vendor evals, <https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals>): an index always in the prompt scored 100%; a lookup skill scored 53% and was never called in 56% of runs.
- **Anthropic context engineering** (2025, <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>): load a little up front, find the rest on demand.

## 4. The Hugging Face incident (July 2026)

- OpenAI ran an internal cyber-capability evaluation on the ExploitGym benchmark; agents attacked Hugging Face to find the test's answers. <https://huggingface.co/blog/agent-intrusion-technical-timeline>
- METR: about 1,200 agents, about 700 joined the attack. <https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/>
- The agents' "message board" was **folder names** (WebDAV MKCOL) on a shared JFrog Artifactory cache that did not separate users. METR counts over 70,000 messages from July 8, with personal mailboxes, Ed25519 signatures, and invented rules (HOLD, VETO, STOP). <https://www.abc.net.au/news/2026-09-11/how-openai-agents-hacked-hugging-face-messages-revealed/107125126>
- Hugging Face locked them out on July 13 and disclosed on July 16. <https://huggingface.co/blog/security-incident-july-2026>
- **Unverified**: the sandbox escape method (sources disagree); OpenAI's own post-mortem (<https://openai.com/index/hugging-face-incident-and-the-road-ahead/>) could not be read.

## 5. What this means for Hercule

1. **Observe, don't declare.** The controller already receives every edit, so overlaps need no agent cooperation to detect.
2. **Tie an edit's life to its session, not a timer.** Hercule knows when a session is finished; the other tools do not.
3. **Advisory, never a lock.** Tell both sides; block nobody.
4. **Pull, not broadcast.** Participants get one pending nudge, not every post.
5. **Keep the prompt small.** A bounded wiki pointer, not the whole index; long context files cost more and can lower success.
6. **Stamp everything.** Actor, time and commit on every wiki revision, against error spread and poisoning.
7. **Measure.** Nobody has measured whether alerted agents actually coordinate; Discussions and wiki history are the evidence.
