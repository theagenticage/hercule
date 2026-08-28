# hydra-project
> Hydra architecture decisions, repo facts, open threads

## Facts
- Repo: github.com/rogierpennink/hydra (local dir agentick-next). TypeScript, clean slate.
- Controller/runner split: runner dials the controller; controller owns domain state, runner owns material state.
- One SQLite database on the controller is the source of truth. No repo-local config, ever.
- Providers wrap Claude Code (Agent SDK), Codex app-server and pi. All three installed on the Mac mini.
- Channels v1: Discord + Slack. Event sources v1: GitHub, Gmail, cron, manual.

## Decisions (ADRs merged so far)
- 0001 runs freeze an execution plan
- 0002 orchestration stays on the controller
- 0003 sessions run as bare processes
- 0004 controller state lives in one SQLite database
- 0014 assistants remember through distilled memory, not merged sessions

## Open threads
- Packaging: single binary vs npm install still undecided; Bun compile under evaluation.
- Runner join ceremony: token format not settled.
- Memory interface prototype (this assistant is the guinea pig).
