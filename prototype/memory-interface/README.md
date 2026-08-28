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

## Results

See `results/phase1/summary.md`, `results/phase2/summary.md` and the resolution on the ticket.
