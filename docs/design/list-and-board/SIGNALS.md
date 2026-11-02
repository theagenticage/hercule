# How far along, and where? A session digest

PROTOTYPE. The technical answer behind the List and the Kanban in this folder. Checked against
`main` at 7c071e3e on 26 October 2026, and against the provider versions Hercule pins (Claude Agent
SDK 0.3.263, Codex 0.154.0, pi 1.2.0). Full provider notes, with links: `research/provider-signals.md`.

## 1. The answer in one paragraph

Hercule does not need a code map to say how far along a session is or where it works. Every
command a session runs, every file it reads, searches or edits, and the plan it keeps already
arrive at the controller as transcript events. The controller stores them and reads none of them.
The proposal is a small **session digest**, computed as each event arrives, the way
`Subagent.activity` already is ("Running npm test", `sessions/subagents.ts`). The digest
is stored on the session row and pushed on the existing `session` topic, so every list and board
reads it with the one `session.query` it already makes. It answers four things, each from a
fact.

One finding shapes everything below: **agents keep no plan today.** On this runner, 496 Claude
sessions made no todo or task call (the SDK turned those tools off by default for current models),
188 Codex sessions made no `update_plan` call, and pi has no plan tool. So Hercule cannot read
progress from a plan it does not get. It has to ask for one, with a tool of its own (§3, `plan`),
and when there is no plan it shows only facts.

| Question | Digest field | From |
|---|---|---|
| What is it doing now? | `activity`, `phase` | the latest tool item of the current turn |
| How far along? | `plan`, `milestones` | a plan Hercule asks the agent to keep; checks Hercule sees itself |
| Where? | `focus` | the paths of the files it read, searched and edited |
| Is it healthy? | `lastCheck`, `turnStartedAt` | test, build and lint commands and their outcome; turn timing |

## 2. What already arrives (and what is dropped)

All of this is in `session_stream` today (`packages/protocol/src/sessions.ts`, the three
normalizers under `apps/runner/src/providers/`):

| Signal | Claude Code | Codex | pi |
|---|---|---|---|
| Commands | `command_execution`, `detail.input.command` | `command_execution`, `detail.command` | `command_execution`, `detail.command` |
| Command outcome | `failed` from `is_error`, no exit code | exit code only in `raw` | `failed` from `isError` |
| File edits | `file_change`, `detail.path(s)`, plus the edit watch | `file_change`, `detail.path(s)`, plus the edit watch | `file_change`, `detail.path`, plus the edit watch |
| File reads | `file_read`, `detail.input.file_path` | `file_read` | `file_read`, `detail.path` |
| Searches | `file_search`, `detail.pattern`, `detail.path` | `file_search` | `file_search`, `detail.pattern` |
| The plan | **TodoWrite stays a plain `tool_call`**; steps and statuses in `detail.input.todos` | **`turn/plan/updated` is dropped** by the normalizer | no plan |
| Turn start and end | `turn.started`, `turn.completed` | same | same |

What the research measured on this runner, about how much each signal is really there:

- **Plans:** none (above).
- **Shell dominates:** pi ran 3,404 `bash` calls against 92 `read` calls; about 45% of Codex's
  4,709 commands are reads, searches or listings that Codex itself parses (`commandActions`).
  Claude and pi reads hide in shell commands too, so the runner needs a small shell parser
  (`cat`, `sed -n`, `head`, `rg`, `grep`, `ls`, `find` are reads and searches).
- **Exit codes lie for tests:** 86% of test commands were piped, 190 of 240 (79%) into `tail`,
  `head` or `grep`, which hides the test runner's exit code; only 2 of 240 were marked failed. A
  test outcome must come from the output's summary line, and is unknown when the line is not
  recognised.
- **Git is reliable:** commits, pushes and `gh pr create` match by command text. Claude's own
  `gitOperation` field caught only some of them (17 of 28 PR creates), so it is a bonus, not the
  source.

Paths from the edit watch are already repository-relative (`EditedFile`, `{resourceId, path}`).
Paths in tool inputs are the harness's, usually absolute; the runner knows each checkout's root,
so it can convert them the same way `sessions/edited-files.ts` converts edits.

Spec 18 turned down an activity line for the phone because "reading every transcript to get one
costs a read per row". The digest removes that cost: it is computed once, at ingest, and travels
with the session record.

## 3. The digest, field by field

### `activity`: what it is doing now

One line from the latest tool item, built by the same function as `Subagent.activity`:
"Running pnpm test checkout", "Editing payment.ts", "Reading 3ds-modal.tsx", "Searching for
requires_action". Cleared at turn end.

### `phase`: the kind of work, now

A word for the class of the latest tool item in the current turn:

| Phase | When |
|---|---|
| **Exploring** | reads, searches, web searches, and no edit yet in this turn |
| **Changing** | a file edit; reads after an edit in the same turn stay Changing |
| **Verifying** | a command classed as test, typecheck, lint or build (table below) is running or just ran |
| **Shipping** | `git commit`, `git push`, `gh pr create`, `gh pr merge`, or the GitHub Connection's PR actions |

How sure each phase is:

| Phase | Reliability |
|---|---|
| Changing | reliable: completed edits, and the edit watch |
| Shipping | reliable: git and `gh` command text |
| Exploring | good on Codex (`commandActions`); on Claude and pi it needs the shell parser |
| Verifying | reliable that a check ran; whether it passed is known only when its output is recognised |

An open Request overrides the phase with **Waiting**; an idle session is **Resting**. The phase
is what the agent is doing, never a guess at a stage of a project. It is cheap and deterministic,
and the peek panel can always say why: "Verifying: ran pnpm test checkout 40s ago".

Commands are classed by their first real program (after `cd ... &&` and `env`):

| Class | Matches (first words) |
|---|---|
| test | `pnpm test`, `npm test`, `yarn test`, `bun test`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `dotnet test`, `rspec` |
| typecheck | `tsc`, `bun check`, `pnpm typecheck`, `mypy`, `pyright` |
| lint | `eslint`, `oxlint`, `pnpm lint`, `ruff`, `golangci-lint`, `cargo clippy` |
| build | `pnpm build`, `vite build`, `cargo build`, `go build`, `make`, `dotnet build` |
| git | `git commit`, `git push`, `gh pr ...` |

The table is a setting with defaults, so a project with its own `just test` can add it.

### `plan`: a plan Hercule asks for

`{ done, total, current, steps, updatedAt }`, from a progress tool **Hercule** gives every
session, whatever its provider:

- **The tool.** Sessions already use the `hercule` CLI. A new verb, `hercule progress`, takes the
  whole list each time, the way Claude's old TodoWrite did, plus an optional line for what it is
  doing now (Claude's old `activeForm`): `hercule progress --step "Find the cause:done" --step
  "Push the branch:doing" --step "Open the PR" --now "Pushing the branch"`. The runner turns it
  into a `plan` item with `detail.steps[{text, status}]` and `detail.now`; `plan.current` is
  `now`, or the step in progress when `now` is missing.
- **The ask.** Hercule's session instructions gain two sentences: keep a progress list with
  `hercule progress` when a task has more than three steps; update it when a step is done. Short
  questions get no plan, and that is fine.
- **The providers' own plans are read too,** when they appear: Claude's TodoWrite or Task tools
  (if someone enables them with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`), and Codex's
  `turn/plan/updated`, which the normalizer drops today although spec 06 §6.3 says it maps it.
  Whichever arrived last wins.

Only the latest plan is kept. A plan that grows is shown as it is ("3 of 9", up from "3 of 7");
the row never claims a percentage the agent did not give. Without a plan, the row shows phase,
place and time, never a bar.

### `milestones`: what Hercule saw happen

Facts Hercule observes itself, each with its time, in the order a coding task usually meets them:

1. **Changed**: the first file edit (edit watch or `file_change`).
2. **Tested**: the first test command.
3. **Passing**: the latest test command's output ends in a recognised summary that says it
   passed ("24 passed"). A failing summary clears it; an unrecognised one leaves it **unknown**,
   and the row says "tests ran", not "tests pass".
4. **Committed**: a `git commit` ran and succeeded.
5. **Pushed**: a `git push` ran and succeeded.
6. **PR open**: `gh pr create` succeeded, or the GitHub Connection reports a PR for the branch.

Milestones are evidence, not a plan: a research thread may reach none and still be done. Together
with `plan` they give an honest picture: "3 of 7 steps, tests passing, not pushed".

### `focus`: where it works

The folder most of its recent file activity falls in, with no code map:

1. Take the paths of this turn's file items (or the last turn's, when idle), made relative to the
   checkout root. Weigh an edit 3, a read 1, a search 0.5. Edits come from `editedFiles`, which
   are already repository-relative. Reads and searches (including the ones the shell parser
   finds) count only until the turn's first edit: once a session edits, where it edits is where
   it works. Skip root-level files every agent reads (`AGENTS.md`, `CLAUDE.md`, `package.json`,
   lockfiles), or they pull every focus to the root.
2. For every folder on those paths, add up the weight of the files under it.
3. `focus.path` is the **deepest folder holding at least 60%** of the weight. `focus.file` is the
   single heaviest file. If no folder below the root reaches 60%, the focus is the two heaviest
   top-level folders ("src/cart, src/checkout").

Example, the 3-D Secure fix's last turn:

| Item | Path | Weight |
|---|---|---|
| read | `src/checkout/payment.ts` | 1 |
| read | `src/checkout/3ds-modal.tsx` | 1 |
| read | `src/lib/stripe.ts` | 1 |
| edit | `src/checkout/payment.ts` | 3 |
| edit | `src/checkout/payment.ts` | 3 |
| edit | `src/checkout/payment.test.ts` | 3 |

`src/checkout` holds 11 of 12 (92%), and nothing deeper does, so the row says **src/checkout**,
and the peek panel names `payment.ts` as the hot file. A multi-repo workspace keeps one focus per
resource and shows the heaviest.

### `lastCheck`: is it healthy?

`{ class, command, outcome: passed | failed | unknown, at, counts? }` from the latest classed
command. The outcome and the counts ("24 passed, 1 failed") are read from the output's last lines
when they match a known summary (vitest, jest, pytest, go test, cargo test, tsc, eslint). Exit
codes are not trusted for tests, because pipes hide them.

### `turnStartedAt` and `turnCount`

Set when the main agent's turn starts (`moved(..., "busy")`). They give "working 12m" and the
Kanban's time in column, which no field holds today.

## 4. How a row reads it

One muted line, chosen in this order; the first that applies wins:

1. **Waiting:** the ask, as today ("Run git push?").
2. **Working with a plan:** `done of total · current` ("4 of 7 · Fixing handlePaymentResult").
3. **Working without a plan:** `phase · focus` ("Changing · src/checkout"), or `phase · working
   12m` when there is no focus.
4. **Resting:** the latest reliable outcome ("Pushed · PR #1281", "Changed 3 files", "Tests
   ran"), or, with no milestone, the age. Never "tests pass" when the outcome is unknown.

The peek panel shows everything: the plan's steps, the milestone ladder, the focus with its hot
files, the last check, the turn's time.

## 5. Cost (ADR 0037)

- **At ingest:** a few comparisons per stored `item.started` and `item.completed` in
  `applyReport`. No extra read, no model call.
- **Storage:** one small JSON column on `sessions` (or a few columns), rewritten in the same
  transaction as the event that changed it.
- **Push:** the existing `session` topic's `countsOnly` announce, batched over one second, the way
  `usage` and `toolCalls` already are. Nothing per streamed token.
- **Client:** nothing new to read; the digest comes with `session.query`.

## 6. What changes, where

| Layer | Change |
|---|---|
| Runner | `hercule progress` becomes a `plan` item with `detail.steps[{text, status}]`. Claude: map TodoWrite and the Task tools the same way when they appear. Codex: map `turn/plan/updated` (spec 06 §6.3 already says so). Copy `exitCode`, `durationMs`, `cwd`, `commandActions` and Claude's `gitOperation` out of `raw` into typed `detail` fields. A small shell parser classes reads, searches, checks and git. Make read and search paths checkout-relative, as edits already are. |
| Session instructions | Two sentences asking for `hercule progress` on tasks of more than three steps. |
| Protocol | `detail.steps` on `plan` items; `detail.exitCode` on `command_execution` completions. |
| Controller | `buildSessionDigest` in `sessions/`, beside `buildSubagentActivity`; a `digest` column (migration); `turn_started_at`, `turn_count`. |
| Contract | `Session.digest` (`activity`, `phase`, `plan`, `milestones`, `focus`, `lastCheck`) and `Session.turnStartedAt`. |
| Client-core | one function that turns a digest into the row's line, and one that groups by phase for the Kanban, each with its own test. |

Note: mapping TodoWrite out of `tool_call` changes what `toolCalls` counts; the digest work
should decide that on purpose.

## 7. What it does not do

- It does not make agents keep a plan. Some will skip it; their rows say less.
- It does not give a percentage for a session without a plan. Phase and milestones say what
  happened; they do not say how much is left.
- The phase says what the agent is doing in this turn, not where the work stands overall. A
  thread that ran its tests and then reads more files is Exploring again, and that is true.
- Focus works per checkout. A thread with no workspace files (a question, a web search) has no
  focus, and the row says less.
- Main workspaces are not watched by the edit watch, but their tool items still carry paths, so
  focus still works there.

## 8. Later, if wanted

- **Changes** (`+48 −12 · 3 files`): the runner already runs git for the edit watch; a
  `git diff --shortstat` at each turn end is one more command per turn.
- **A headline per turn**, written by a Text Generation, as titles are. It costs one harness
  process per turn per session (0.5 to 2 s, spec 06 §14), so it should be opt-in.
