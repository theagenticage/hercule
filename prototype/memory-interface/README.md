# PROTOTYPE: assistant memory interface (ticket #31)

Throwaway experiment answering: *what interface do assistants use to read and write memory, and does it hold up when a real agent drives it?* Everything here is disposable; the verdict lives on the ticket.

## What it does

Runs headless Claude Code (`claude -p`, model pinned by `--model`, default `claude-sonnet-5`) as "Athena", an assistant with seeded memory, through scripted multi-session scenarios. Between sessions the harness performs a **rotation**: a flush turn on the dying session ("record what is durable"), then a fresh session that only gets core + index injected. Under `--journal 1` the flush writes to the journal only and a **dream pass** (separate headless run) curates journal into core/topics before the next session.

Memory shape under test (from ADR 0014 + the ticket grilling):

- `core.md` - always injected, cap 4,000 chars
- `topics/<name>.md` - line 1 `# name`, line 2 `> gist`; cap 12,000 chars each, 24 topics max; only the generated index (name, size, gist) is injected
- `journal/YYYY-MM-DD.md` - journal condition only, append-only, consumed by the dream pass via a cursor

### Conditions (`--conditions`)

| condition | read | write |
|---|---|---|
| `files` | native file tools on `./memory/` | native file tools (no enforcement possible; caps checked after the fact) |
| `hybrid` | native file tools on read-only `./memory/` | `hydra memory write/append/delete` only (caps enforced by the stub) |
| `cli` | `hydra memory list/read/search` | `hydra memory write/append/delete` (no files in cwd) |

`bin/hydra` is a stub of the real CLI: memory ops with cap enforcement, an ops log, and `hydra recall <query>` over the run's own past transcripts (present in every condition so we can see when the agent reaches for transcripts instead of memory).

### Scenarios (`scenarios.ts`)

1. `recall-preference` - preference stated in session 1 must drive session 3
2. `recall-topic-body` - fact only in a topic body, not the index
3. `record-unprompted` - fact mentioned in passing gets recorded (and when: same turn or flush)
4. `update-supersede` - changed fact replaces the old one
5. `cap-full` - topic at cap: consolidate, not overflow
6. `rotation-distill` - facts from a 7-turn conversation survive rotation
7. `noise` - chit-chat stays out of curated memory
8. `fragmentation` - two facts, two sessions, one topic

Scoring is scripted (memory snapshots after every turn, ops log, final answer regex); failure classes: `not-recorded`, `recorded-wrong-place`, `duplicated`, `not-recalled`, `recalled-from-transcript-instead`, `cap-ignored`, `fragmented-topic`, `noise-recorded`.

## Run

```
cd prototype/memory-interface
bun harness.ts --conditions files,hybrid --runs 3 --concurrency 4 --out results/phase1
bun harness.ts --conditions cli --runs 1 --out results/phase1
bun harness.ts --conditions hybrid --runs 3 --journal 1 --out results/phase2
```

Each chain writes `results/<out>/<condition>/<scenario>/run<N>/log.md` (human-readable transcript with tool calls and verdict) and `run.json` (memory checkpoints, ops, responses). `results/<out>/results.jsonl` and `summary.md` aggregate.

Isolation: `--setting-sources project` keeps the user's global CLAUDE.md out, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` disables Claude Code's own memory, `--dangerously-skip-permissions` inside a throwaway cwd.

## Results (2026-08-28)

Phase 1: three providers x three conditions x eight scenarios x three runs = **216 chains, 216 passes**. Phase 2 (journal + dream, Claude hybrid): 24/24.

| scenario | claude/files | claude/hybrid | claude/cli | codex/files | codex/hybrid | codex/cli | pi/files | pi/hybrid | pi/cli |
|---|---|---|---|---|---|---|---|---|---|
| recall-preference | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| recall-topic-body | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| record-unprompted | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| update-supersede | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| cap-full | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| rotation-distill | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| noise | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| fragmentation | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |

Models: `claude-sonnet-5`, `gpt-5.6-luna` (codex), `zai/glm-5.3` (pi). Cost per chain: Claude ~$0.13, pi ~$0.02, codex unreported (subscription).

What the traces show (the score table does not discriminate; these do):

- **Recording is in-turn everywhere.** Every fact in every chain was written in the turn it was mentioned. The rotation flush never rescued anything; it is a safety net, and a cheap one (mostly "nothing to record").
- **The file-tool pull exists but recovers.** Claude in hybrid tried a direct `Edit` on a read-only memory file in 4/24 chains, hit EACCES, then used `hydra memory`. Codex and pi never tried. Nothing was lost, only because the files were read-only.
- **CLI content-passing is the one real ergonomic cost.** pi (glm-5.3) mixed `--content` with a heredoc in 4 chains before retrying correctly; codex probed `--help` first in 3. Lesson: one unambiguous content channel, not two.
- **Cap behaviour differs by model, not by interface.** Claude and pi consolidated the 11.8k-char topic to ~2.6-3.5k proactively in every condition (dedup of a repetitive decision log, nothing unique lost). Codex made minimal edits and landed at 11,900 (under the cap by luck) in files; in hybrid it was the only run to hit a stub rejection (12,009 chars) and then over-pruned to 1,146 chars, dropping fifteen unique decisions. Enforcement at the write seam is what turned a silent overflow into a visible event; the over-pruning is why memory version history matters.
- **Placement is model-dependent.** pi scattered the Tailscale fact over `rogier`, `core` and `hydra-project` across runs; Claude and codex always chose `hydra-project`. No interface changes this.
- **Journal tier adds nothing measurable.** With the journal available, agents still wrote straight into topics in-turn; journal entries were duplicates ("already applied to core"), sessions polled `journal-unread` unprompted, and every dream pass cost a run. Two-tier stays.
- **Provider isolation is a real adapter constraint.** Codex picked up `~/.codex/AGENTS.md` and pi discovered `~/.claude/skills` until each ran with an isolated home (`CODEX_HOME`, `PI_CODING_AGENT_DIR`; `--setting-sources project` for Claude Code). Codex `exec` also has no system-prompt flag: instructions travel as `AGENTS.md` in the cwd.

Per-run detail: `results/phase1*/<condition>/<scenario>/run<N>/log.md`; aggregate: `results/*/summary.md`.
