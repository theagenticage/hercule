# Antigravity (`agy`) research for #1282

Evidence behind the agy facts in the spec of the Antigravity sessions work (#1282, PR #1298 and the follow-up PR 2). Everything here was recorded on 2026-11-26 on a Linux x64 test machine with `agy` 1.5.15.

Layout:

- `sessions-recorder/`: the scripts that drove `agy` over ACP (see its README). `mcp-lib.ts` and `mcp/` are the MCP stand-in servers and experiments, `scenarios/` has one script per recording.
- `notes/`: the research notes, one per question.
- `recordings/recN/`: the recordings and hook logs. Every `.jsonl` starts with a setup note (first line), then one `{ t, direction, message }` object per JSON-RPC message.

The notes were written against the scratch folder `/tmp/hercule-1282/`. Read `/tmp/hercule-1282/recN/` in a note as `recordings/recN/` here, and `recorder/` as `sessions-recorder/`.

Scrubbed before publishing: the machine's user name (`<user>`), host name (`<host>`) and non-loopback IP addresses (`<ip>`). The `Bearer canary-...` values are made-up markers the recorder sent to its own stand-in servers, not credentials. No OAuth token or email address is present.

| Note | Question | Recordings | Scripts |
|---|---|---|---|
| `notes/recording-findings.md` | What the first recordings show (ACP flow, permissions, modes) | `recordings/rec/` | `scenarios/*` (one per recording name) |
| `notes/permission-research.md` | When does agy ask, per mode, path and hook | `recordings/rec2/`, `recordings/rec/` | `scenarios/modes.ts`, `perm-generic.ts`, `perm-tmpdir-resume.ts`, `read-outside.ts` |
| `notes/stop-research.md` | What stopping a session does to agy and its children | `recordings/rec3/` | `scenarios/stop-research.ts`, `stop-lib.ts` |
| `notes/trust-research.md` | Folder trust and the trust prompt | `recordings/rec4/`, `recordings/rec5/` | `scenarios/t1-hooks.ts` to `t6-search.ts`, `trust-lib.ts` |
| `notes/websearch-hook-research.md` | Can a home hook make `search_web` ask or deny | `recordings/rec6/` | `scenarios/t8-websearch.ts` |
| `notes/mcp-research.md` | How agy takes MCP servers (ACP list, config files, resume, list_changed) | `recordings/rec7/` | `mcp-lib.ts`, `mcp/*` |
| `notes/hook-gate-research.md` | Can a home PreToolUse hook gate edits | `recordings/rec8/` (with `cfg/`) | `scenarios/t9-gate.ts`, `t10-escalate.ts` |
| `notes/skill-frontmatter-research.md` | Skill frontmatter against approvals | `recordings/rec9/` | `scenarios/skill-fm.ts` |
| `notes/t11-research.md` | PreToolUse hook facts | `recordings/rec11/` | `scenarios/t11-run.ts`, `t11-session.ts` |
| `notes/t12-research.md` | What agy does with a failing PreToolUse hook | `recordings/rec12/` (hook log, `hook.sh`, `run.sh`, `agylogs/`) | `scenarios/t12-run.ts`, `t12-session.ts` |
