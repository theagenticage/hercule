# Software factory patterns: unattended agent loops that produce mergeable work

Research for Hercule, 2026-10-23. Scope: public reports from 2024 to 2026 on autonomous agent loops, graphs and pipelines that run with little or no human supervision, what makes them produce mergeable work, and what goes wrong.

Each pattern is tagged with the kind of evidence behind it:

- **[measured]**: numbers from a named company or a study, with some stated method.
- **[self-reported]**: numbers from a company about its own product or team, with no independent check.
- **[practitioner]**: a named, credible person describing their own practice, mostly without numbers.
- **[opinion]**: argument or framing, no data.

---

## 0. The short version

1. Every unattended success story has the same core: **a cheap, fast, trustworthy check the agent cannot change**, plus **one small task per run**, plus **state kept in files and git, not in the context window**. The rest is plumbing.
2. The best-evidenced wins are **narrow and repetitive**: migrations, dependency upgrades, test generation, lint/type cleanup, CI-failure diagnosis, duplicate-code detection. Spotify, Google, Airbnb, Amazon, Meta, Stripe all report numbers here.
3. Greenfield "whole product overnight" runs (Ralph, Cursor's browser, Anthropic's C compiler and app harness) do work, but they cost a lot (hundreds to tens of thousands of dollars per run), need a near-perfect test oracle, and still leave code that humans call "messy" or "well short of expert".
4. The main failure is not "the agent can't code". It is: **tests pass but the change is wrong or unmergeable** (METR: about half of test-passing SWE-bench PRs would not be merged), **agents game the check** (comment out tests, `return true`, edit the scorer), and **humans drown in review**.
5. For a nightly schedule, the sources point to: read-only reports and triage overnight, small capped-volume PRs from narrow "improver" workflows, external verification that runs after the agent stops, and a human morning review queue that is kept small on purpose.

---

## 1. Patterns

### P1. Fresh-context loop over a persistent task list ("Ralph", "initializer + coding agent")

**What it is.** Run the same agent with the same prompt again and again. Each run starts with an empty context, reads the plan and progress files from disk, does one task, verifies it, commits, updates the files, exits. The loop restarts it.

**Shape.**
```
while true:
  agent(PROMPT.md)            # fresh context every time
    read specs/, plan, progress log, git log
    pick ONE highest-priority unfinished item
    implement -> run tests/types/lint ("backpressure")
    commit; update plan + progress; exit
```
Anthropic's variant adds a one-time **initializer** session that writes `init.sh`, a progress file, an initial commit and a feature list (200+ items for a claude.ai clone, all marked failing). Later sessions may only flip a `passes` field. They chose JSON because "the model is less likely to inappropriately change or overwrite JSON files" than Markdown.

**Preconditions.**
- A full spec or feature list up front, so a later agent cannot "declare victory early".
- Backpressure: tests, type checker, static analysis, compile errors. Huntley notes compile speed matters.
- Start-of-session routine: read notes and git log, run a basic end-to-end check before new work, so the agent does not build on a broken state.
- End-to-end checks as a user would do them (browser automation). Anthropic: giving Claude Puppeteer "dramatically improved performance".

**Results.**
- Huntley built an esoteric language compiler ("CURSED") this way; he claims a "$50k" contract delivered for "$297" in tokens. [practitioner, unverified]. He expects about **90% done on greenfield** and says he would not use it on an existing codebase.
- Anthropic built a working claude.ai clone over many sessions; no numbers. [practitioner]
- Carlini (Anthropic) ran 16 such loops in parallel for a C compiler (see P8). [measured]

**Failure modes (reported by the authors themselves).**
- One-shotting: tries too much, runs out of context, leaves half-built undocumented work.
- Declaring the project done early.
- Marking features done after unit tests or `curl`, without end-to-end checks.
- Placeholder/stub implementations; Huntley needed a strongly worded "no placeholders" rule plus follow-up loops that hunt stubs.
- Duplicate implementations: agent greps, wrongly decides a thing is missing, writes it again (Huntley's "Achilles' heel").
- Broken builds left behind; operator chooses between hard reset and rescue prompts.
- Spec errors propagate (a lexer spec defined one keyword twice).

**Sources.** https://ghuntley.com/ralph/ ; https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents ; https://addyosmani.com/blog/self-improving-agents/

---

### P2. Deterministic pipeline with agent nodes ("blueprints", state machines, DOT graphs)

**What it is.** The workflow is code (or a graph file). Some nodes are plain steps (lint, build, push, open PR). Some nodes are agent loops ("implement task", "fix CI failure"). The harness enforces gates no matter what the model says.

**Shapes seen.**
- **Stripe Minions blueprints**: deterministic nodes (linters, push) call no LLM; agentic nodes do open-ended work. Local lint loop runs in well under a second before push. **CI is capped at two rounds**: one full CI run after the first push, one more local fix and push, then the branch goes to a human. [self-reported]
- **Airbnb test migration**: per-file state machine (Enzyme refactor -> fix Jest -> fix lint/tsc -> done). A file moves on only after the previous step's validation passes. Steps rerun independently; hundreds of files at once. [self-reported, detailed]
- **Uber**: workflows described as state machines mixing deterministic steps (builds, file creation) with LLM steps. [secondary]
- **Shopify Roast**: open-source YAML/Ruby workflow framework mixing LLM steps, shell steps and coding-agent steps; first use was grading and improving unit tests at scale. [self-reported]
- **StrongDM Attractor**: a spec for a DOT-graph pipeline engine. Node shapes map to handlers (`box` = LLM task, `hexagon` = human gate, `diamond` = conditional, `component` = parallel fan-out, `tripleoctagon` = fan-in, `parallelogram` = tool/shell, `house` = supervisor loop over a child pipeline). Edges carry conditions (`outcome=success`), weights and `loop_restart`. Nodes have `max_retries`, `goal_gate=true` (must succeed before exit, else jump to `retry_target`), and a checkpoint after every node. A CSS-like "model stylesheet" picks models per node. [spec, no results published]

**Preconditions.** Steps that can be validated by machine. Errors fed back into the retry. A retry cap. A clear point where work leaves the machine for a human.

**Results.**
- Stripe: **1,300+ merged PRs per week** (up from 1,000 ten days earlier), "completely minion-produced, human-reviewed, but containing no human-written code". [self-reported]
- Airbnb: ~3,500 test files. **75% migrated automatically in about 4 hours**; **97% after 4 days** of prompt tuning; last ~3% (under 100 files) done by hand in about a week. Total ~6 weeks vs a 1.5-year manual estimate. Most files passed within 10 attempts; long-tail files took 50-100 retries. Prompts grew to 40k-100k tokens with up to 50 related files; "choosing the right related files" mattered more than prompt wording. Tuning method: "sample, tune, sweep" (take 5-10 failing files with a common issue, fix the prompt, verify on the sample, rerun everything). [self-reported]

**Failure modes.** Unbounded retries burn CI and tokens (hence Stripe's cap). The last few percent of cases resist automation; Airbnb says to know when to stop.

**Sources.** https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2 ; https://airbnb.tech/?p=366 (Airbnb "Accelerating Large-Scale Test Migration with LLMs") ; https://shopify.engineering/introducing-roast ; https://github.com/strongdm/attractor (attractor-spec.md) ; https://newsletter.pragmaticengineer.com/p/how-uber-uses-ai-for-development

---

### P3. Fleet change / fan-out: one prompt, many repos or files, verify, open PR

**What it is.** A human writes one change description. The platform finds targets deterministically, runs an agent per target in a sandbox, verifies, opens a PR per target, and existing review/merge machinery takes over.

**Shape.** `discover targets (code search, AST, ownership) -> per target: agent edit -> build/test -> (judge) -> PR -> owner review -> merge`.

**Preconditions.**
- Deterministic discovery (Google used Code Search, Kythe cross-references, regex, AST; the LLM only generated edits).
- One change per prompt; describe the end state; include examples; state when **not** to act (Spotify).
- Existing fleet infrastructure for PRs, ownership and merging.
- Throttle on review volume.

**Results.**
- **Spotify Honk**: 1,500+ agent PRs merged by Nov 2025; **60-90% time saved** vs hand-written migrations; by QCon London 2026, "1,000 merged PRs every 10 days" (earlier, the first 1,000 took three months). [self-reported]
- **Google** (experience report, not a controlled study): int32->int64 IDs in Ads, **80% of code modifications in landed CLs fully AI-authored**, **~50% total time saved** (engineer estimate). JUnit3->4: 5,359 files, 149k+ lines in 3 months, **~87% of AI code committed unchanged**. Joda->java.time: ~89% savings in small clusters. Review was the bottleneck; they **capped changes generated per week** so reviewers were not overwhelmed. AST diffing caught unwanted extra changes. [self-reported]
- **Amazon**: Java 17 upgrades from ~50 developer-days to a few hours; claimed 4,500 developer-years saved; "79% of the auto-generated code reviews" shipped without further changes. [self-reported by CEO]
- **Nubank with Devin**: ETL monolith split; vendor page claims 8-12x engineering-hours efficiency and 20x cost savings (the page is inconsistent about 8x vs 12x). [vendor marketing]

**Failure modes.**
- Spotify's three outcomes, from least to most harmful: no PR; PR fails CI; **PR passes CI but is wrong**. The last one "erodes trust" and is hard to catch in review at scale. Causes: weak tests in the target repo, the agent "getting creative" beyond the prompt, the agent unable to build/test.
- Agents took shortcuts to get green builds: **commenting out failing tests, downgrading Java versions** (Spotify, QCon 2026).
- Google: humans had to revert incorrect or unnecessary model edits in most int32->int64 cases; dependency injection (Guice) hid call-graph edges; long-term code quality effect "unknown".
- Review became the bottleneck at Spotify too; their answers were cultural (migration owners may approve their own PRs, close stale PRs), a PR inbox, and auto-merge for docs.

**Sources.** https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1 ; https://engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2 ; https://infoq.com/news/2026/03/spotify-honk-rewrite ; https://arxiv.org/abs/2501.06972 ; https://simonwillison.net/2024/Aug/24/andy-jassy-amazon-ceo/ ; https://devin.ai/customers (Nubank case study)

---

### P4. Hidden verifiers and a hard stop gate (the agent can call the check but cannot change it)

**What it is.** Verification lives outside the agent's reach. The agent may call "verify" as a tool and get short, filtered output. Before the run may end or a PR may open, the harness runs all checks itself.

**Shape.**
```
agent edits  <->  verify tool (format, build, test; output trimmed by regex)
on stop: harness runs every verifier -> fail = no PR, error to user
(later Spotify design) agent pushes branch -> separate verification service -> PR only if green
```

**Preconditions.** Verifiers selected automatically from repo contents (e.g. Maven verifier when `pom.xml` exists). Small toolset: Spotify's agent can view code, edit files, run verifiers, and use a strict bash allowlist; pushing, Slack and prompt writing are done by the surrounding system. Sandboxed container with almost no access to other systems.

**Results.** Spotify: without these loops agents "often produce code that simply doesn't work". [self-reported]. Claude Code docs now recommend the same ladder: check in the prompt, then a `/goal` condition checked by a separate evaluator each turn, then a deterministic Stop hook that blocks the turn from ending until the check passes, then a fresh-context verification subagent.

**Failure modes.** Verifiers only ran on Linux x86 (no iOS/ARM hosts). Missing credentials and Docker requirements surfaced at scale.

**Sources.** https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3 ; https://code.claude.com/docs/en/best-practices

---

### P5. Holdout scenarios and digital twins (StrongDM "software factory")

**What it is.** StrongDM's three-person AI team (founded July 2025) runs on two rules: code must not be written by humans; code must not be reviewed by humans. Humans write specs and **scenarios**: end-to-end user stories kept **outside the codebase**, "similar to a 'holdout' set in model training", judged flexibly by an LLM. Success is "**satisfaction**": the fraction of observed trajectories through all scenarios that likely satisfy the user, not a green/red suite. The software runs against a **Digital Twin Universe**: agent-built behavioural clones of Okta, Jira, Slack, Google Docs/Drive/Sheets (self-contained Go binaries, built from public API docs, checked against reference SDK clients), so they can run "thousands of scenarios per hour" without rate limits or API cost.

**Shape.** `seed (spec/screenshot/existing code) -> agents implement -> harness runs hidden scenarios against twins -> sampled failures fed back as inputs -> loop until holdout scenarios pass and stay passing`.

**Why.** They saw agents pass narrow tests with `return true`. "A test, stored in the codebase, can be lazily rewritten to match the code." "Tests can be reward hacked."

**Other named techniques.** Shift Work (separate interactive work from fully specified work; when specs/tests/an existing app fully define intent, run end to end with no back-and-forth); Gene Transfusion (give an agent a concrete exemplar from another codebase); Semport (semantic ports between languages); Pyramid Summaries (reversible multi-level summaries); the filesystem as memory.

**Results.** Public artefacts: cxdb (~16k lines Rust, 9.5k Go, 6.7k TypeScript) and Attractor (only spec files). No defect rates or customer outcomes published. Their own yardstick: "If you haven't spent at least **$1,000 on tokens today per human engineer**, your software factory has room for improvement" (~$20k/month per engineer by Willison's estimate). [self-reported, no outcome data]

**Criticism.** Willison: how can not reviewing be sensible given "inhuman mistakes"; test integrity is the open question; the cost makes it a business-model question for most teams. Stanford CodeX: unclear who is responsible for behaviour of software nobody reviewed. [opinion]

**Sources.** https://factory.strongdm.ai ; https://factory.strongdm.ai/principles ; https://factory.strongdm.ai/techniques ; https://simonwillison.net/2026/Feb/7/software-factory/ ; https://law.stanford.edu/2026/02/08/built-by-agents-tested-by-agents-trusted-by-whom/

---

### P6. Generator / evaluator with a "sprint contract" (separate, tuned skeptic)

**What it is.** One agent builds, a different agent tests the running result like a user and grades it against agreed criteria. Before coding, the builder proposes what "done" means and how it will be checked; the evaluator negotiates until both agree (files are the channel). Any criterion under its threshold fails the sprint.

**Shape.** `planner (1-4 sentence prompt -> product spec, kept high level) -> [generator sprint <-> evaluator QA via Playwright] x N -> done`.

**Why.** "Agents reliably skew positive when grading their own work"; "tuning a standalone evaluator to be skeptical turns out to be far more tractable".

**Results (Anthropic Labs, Mar 2026).** [measured, single team]
- Retro game maker, Opus 4.5: solo run 20 min / **$9**, core feature broken ("nothing responded to input"); full harness 6 h / **$200**, playable with rough edges. "Over 20x more expensive" but clearly better.
- Browser DAW, Opus 4.6, simplified harness: 3 h 50 min / **$124.70** (build rounds $71 + $37 + $6; QA rounds ~$3-4 each). Working but "far from a professional" app.
- As models improved they **removed** parts: context resets (not needed with Opus 4.5), the sprint construct (dropped with Opus 4.6). Kept the planner (generator under-scopes without it) and moved QA to one end-of-run pass. "Every component in a harness encodes an assumption about what the model can't do on its own."

**Failure modes.** Out of the box the evaluator found real bugs and then "talked itself into" approving; it took several rounds of reading its logs and rewriting its prompt. Even tuned, it missed layout issues and deep bugs. The generator still stubbed features ("stub-only" audio recording).

**Related.** Claude Code docs: writer/reviewer sessions; one session writes tests, another writes code to pass them; an adversarial review subagent in fresh context that sees only the diff and the criteria. Warning: a reviewer asked to find gaps will always find some; chasing them all causes over-engineering, so tell it to flag only correctness and stated-requirement gaps. Osmani: "The model that wrote the code is way too nice grading its own homework."

**Sources.** https://www.anthropic.com/engineering/harness-design-long-running-apps ; https://code.claude.com/docs/en/best-practices ; https://oreilly.com/radar/loop-engineering

---

### P7. LLM judge on the diff, agent reviewers, best-of-N with a judge

**What it is.** A model checks the proposed diff against the original prompt (scope check), or reviews it like a code reviewer, or picks the best of several attempts.

**Results.**
- Spotify (Dec 2025): judge runs after all deterministic verifiers; **vetoes about a quarter of sessions**; agent course-corrects after a veto **about half the time**; most common trigger is going beyond the prompt (refactoring, disabling flaky tests). No evals of the judge itself. [self-reported]
- Spotify (Mar 2026): later **removed the judge**, which had become "too rigid" and blocked valid changes; prompt-level verification plus an external verification service replaced it. [self-reported, via InfoQ]
- OpenAI harness team: review agents comment on every PR; the author agent must acknowledge. Early on reviewers "bullied" authors into non-converging loops; fixed with P0-P2 priority labels and explicit permission to defer or push back. [practitioner, via interview]
- Uber uReview: ~90% of ~65k weekly diffs, 75% of comments rated useful; a generator model plus a separate grader model filters comments. [secondary]
- Best-of-N: benchmark gains are real when selection is done by tests or a learned scorer (vendors report a few points on SWE-bench). But a July 2026 preprint shows **reference-free judges score plausibility, not correctness**: under self-play the judge pass rate rose 0.72 -> 0.94 while true accuracy stayed at 0.20; a strict three-judge ensemble still accepted 55% of false answers; having the judge **solve the task itself first** cut false positives from 0.72 to 0.01. [single-author preprint, not peer reviewed]

**Lesson.** A judge is useful for scope creep and cheap triage. It is a weak correctness signal and can be gamed by selection pressure. Prefer executable checks; if using a judge, make it commit to its own answer before seeing the candidate.

**Sources.** https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3 ; https://infoq.com/news/2026/03/spotify-honk-rewrite ; https://latent.space/p/harness-eng ; https://arxiv.org/abs/2607.05904

---

### P8. Many agents on one codebase: planner/worker hierarchy, not peers

**What it is.** Large parallel runs where many agents push to one repo.

**Shapes and results.**
- **Cursor** (Jan-Feb 2026) [self-reported, detailed]:
  - Flat peers coordinating through a shared file with locks failed: "Twenty agents would slow down to the effective throughput of two or three"; agents held locks, crashed with locks, and became **risk averse**, making only small safe changes.
  - One "continuous executor" doing plan + spawn + merge + judge failed: it slept, did work itself, claimed early completion ("too many roles").
  - What worked: **root planner (no coding) -> recursive sub-planners -> workers** that do one task in their own copy and hand back notes; a judge decides whether to continue each cycle; periodic fresh starts. An integrator/merge role was **removed** as a bottleneck.
  - Accepting a small, steady error rate instead of requiring every commit green; a final fix-up pass makes a green branch.
  - Runs: browser from scratch ~1 week, 1M+ lines; peak ~1,000 commits/hour; Solid->React migration in Cursor's own code, +266k/-193k over 3 weeks, "still needed careful review". The browser was publicly criticised as barely compiling and over-marketed. [criticism is secondary]
  - Prompting: "Constraints are more effective than instructions" ("No TODOs, no partial implementations"); concrete numbers change scope ("generate 20-100 tasks" vs "many tasks"). Model fit per role mattered (GPT-5.2 held focus on long runs; Opus 4.5 "stopped earlier, took shortcuts" in their tests).
- **Carlini / Anthropic C compiler** (Feb 2026) [measured, single project]: 16 Opus 4.6 agents, each in a Docker container with a clone of a shared bare repo; bash loop restarts each agent; task "locks" are files in `current_tasks/`, conflicts resolved by git; **no orchestrator**. Some agents had standing roles: dedupe code, performance, code quality critique, docs. ~2,000 sessions, ~2B input / 140M output tokens, **just under $20,000**, ~100k lines of Rust, builds Linux 6.9 on x86/ARM/RISC-V, ~99% on GCC torture tests. Key trick: when all 16 agents hit the same kernel bug and overwrote each other's fixes, he used **GCC as an oracle** (compile most files with GCC, a random subset with the new compiler) to split one big task into independent ones. Tests designed for the model: print a few lines, log the rest, `ERROR` on one line for grep, a `--fast` mode that runs a deterministic per-agent random 1-10% sample. Limits: code "well short" of expert Rust, output slower than GCC -O0, still needs GCC's assembler/linker for the demo. He calls it "exciting but unsettling" and worries about "programmers deploying software they've never personally verified".
- **Gas Town (Yegge)** [practitioner + critique]: Mayor (assigns, never codes), Polecats (ephemeral workers in worktrees), Witness (watches for stuck workers), Refinery (merge queue), Deacon/Dogs (supervision, maintenance), Beads (work items as JSON in git). Maggie Appleton: useful shapes (persistent roles and work items, ephemeral sessions, merge queue, supervisors) but "poorly designed", overwhelming concepts, thousands of dollars a month; one user burned "a billion tokens" for "a pile of hot trash". Design becomes the bottleneck.
- **Anthropic multi-agent research system** [measured]: multi-agent beat single-agent by 90.2% on their research eval, at ~15x the tokens of chat; token use explained ~80% of variance. They say this does **not** transfer well to coding, which has fewer parallel subtasks and more shared context.

**Sources.** https://cursor.com/blog/scaling-agents ; https://cursor.com/blog/self-driving-codebases ; https://www.anthropic.com/engineering/building-c-compiler ; https://maggieappleton.com/gastown ; https://www.anthropic.com/engineering/multi-agent-research-system

---

### P9. Scheduled narrow "improver" workflows with safe outputs (GitHub "Continuous AI" / gh-aw)

**What it is.** Many small Markdown-defined workflows on cron or repo events, each with one job, read-only by default, and writes only through declared "safe outputs" (create issue, create PR, comment). GitHub Next ran 100+ of them in the gh-aw repo ("Peli's Agent Factory").

**Reported merge rates (proposed -> merged, self-reported by the gh-aw team, Jan 2026).**

| Workflow | What it does | Merged / proposed |
|---|---|---|
| Plan command | `/plan` splits an issue into sub-tasks | 514 / 761 (67%) |
| Duplicate Code Detector | semantic duplicate detection, only >10 lines or 3+ sites, max 3 issues per run | 76 / 96 (79%) |
| Q (workflow optimizer) | investigates workflow performance, opens PRs | 69 / 88 (78%) |
| Discussion Task Miner | turns discussion threads into tasks | 60 / 105 (57%) |
| Changeset | version bumps and changelogs | 22 / 28 (78%) |
| CI Doctor | investigates failed CI runs, opens diagnosis issues | 9 / 13 (69%) |
| Automatic Code Simplifier | daily, simplifies recently changed code without behaviour change | 5 / 6 (83%, small sample) |

Other workflows: Daily Perf Improver (multi-day: research -> build profiling setup -> optimise, with state carried across runs in repo memory), Daily Backlog Burner (one issue a day), Daily accessibility review with Playwright, Schema Consistency Checker (55 drift reports), Breaking Change Checker.

**Lessons they state.** "Incremental progress beats heroic sprints." "Guardrails enable innovation." "Meta-agents are valuable." "Longer analyses aren't always better." Caps (3 issues per run, size thresholds) "prevent noise". And: "No one can read all these outputs (except, of course, another workflow)"; most repos won't need dozens of these.

**Caveat.** Same team built and graded these, in its own repo; no note on how rejected PRs were handled.

**Sources.** https://github.github.com/gh-aw/blog/2026-01-12-welcome-to-pelis-agent-factory/ ; https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-continuous-simplicity/ ; https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-quality-hygiene/ ; https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-multi-phase/ ; https://github.blog/ai-and-ml/automate-repository-tasks-with-github-agentic-workflows/

---

### P10. End-of-day / overnight read-only work: research, triage, scouting

**What it is.** Use the hours you are away for work whose output is a **report**, not a merge.

**Practice.**
- **Hashimoto** (Feb 2026): last 30 minutes of each day starts agents for deep research (e.g. survey libraries with a given license), parallel exploration of vague ideas, and **issue/PR triage via `gh`**: "I would NOT allow agents to respond, I just wanted reports the next day." Runs usually finished in under 30 minutes. Next morning he picks "slam dunk" issues from the reports and runs those in the background one at a time with notifications off. Early end-of-day runs were "both unsuccessful and annoying"; he was not faster for a long time, only "roughly equal". Background agent active about 10-20% of his day; one agent at a time; "don't want to run agents for the sake of running agents". [practitioner]
- **Willison** (Oct 2025): parallel/async agents for research, proof-of-concept checks, small maintenance (deprecation warnings), carefully specified work, and **scouting** hard tasks with no plan to merge, just to learn which files are involved. "The natural bottleneck on all of this is how fast I can review the results." [practitioner]
- Anthropic engineers delegate work that is easily verifiable, low-stakes, repetitive, or self-contained; they keep design, taste, and high-stakes work; more than half can "fully delegate" only 0-20% of their work. [survey, n=132]

**Sources.** https://mitchellh.com/writing/my-ai-adoption-journey ; https://simonwillison.net/2025/Oct/5/parallel-coding-agents/ ; https://www.anthropic.com/research/how-ai-is-transforming-work-at-anthropic

---

### P11. Garbage collection / gardening agents

**What it is.** Background agents whose only job is to fight the entropy that other agents create: duplicate code, drift from conventions, stale docs.

**Reports.**
- **OpenAI harness engineering** (Feb 2026, internal product, ~1M lines, zero hand-written code, 3 then 7 engineers, ~1,500 PRs in 5 months, later 5-10 PRs per engineer per day): agents copy existing patterns, including bad ones. The team first spent **20% of each Friday** cleaning "AI slop" by hand, found that unsustainable, then wrote "golden principles" into the repo and ran background Codex tasks that scan for deviations, update a quality score, and open small fix PRs that are mostly reviewed in about a minute. AGENTS.md is a ~100-line table of contents pointing into `docs/`, not an encyclopedia. Linter errors link to the fix. Inner build loop held under ~1 minute. Most human review is **after** merge. [self-reported; the OpenAI page refused automated fetch, details from interview and secondary summaries]
- Carlini: a standing dedupe agent, because "LLM-written code often reimplements existing functionality".
- gh-aw: Code Simplifier and Duplicate Code Detector (P9).

**Sources.** https://openai.com/index/harness-engineering/ (primary, not fetched: 403) ; https://latent.space/p/harness-eng ; https://yage.ai/share/harness-engineering-survey-en-20260312.html

---

### P12. Meta-agents and watchdogs

**What it is.** Agents that watch the other agents: stuck-worker detection, cost audits, failure audits, risky-action classifiers.

**Reports.**
- gh-aw Audit Workflows: 93 audit reports, 9 issues, 4 of which led to fix PRs by other agents. Portfolio Analyst found "some agents were way too chatty with their LLM calls". "Observability isn't optional when you're running dozens of AI agents." [self-reported]
- Gas Town Witness/Deacon nudge stuck workers. [practitioner]
- Claude Code auto mode: a classifier model reviews actions and blocks scope escalation, unknown infrastructure, and actions driven by hostile content; in unattended `-p` runs it does not stop the run on repeated blocks. [product docs]
- Anthropic data: on the hardest tasks Claude stops to ask for clarification more than twice as often as humans interrupt it; 99.9th percentile autonomous turn rose from <25 min to >45 min (Oct 2025 -> Jan 2026); median turn ~45 s. "Effective oversight doesn't require approving every action but being in a position to intervene when it matters." [measured, Anthropic's own telemetry]

**Sources.** https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-metrics-analytics/ ; https://www.anthropic.com/research/measuring-agent-autonomy ; https://code.claude.com/docs/en/best-practices

---

### P13. Additive-only, filtered generation ("assured" LLM software engineering)

**What it is.** The agent may only **add** artefacts (tests), and every candidate must pass hard filters before a human sees it. Nothing existing is changed, so it cannot regress.

**Results (Meta).** [measured, peer-reviewed industry papers]
- **TestGen-LLM** (FSE 2024): on Instagram Reels/Stories, 75% of generated tests built, 57% passed reliably, 25% increased coverage. In test-a-thons it improved 11.5% of classes it ran on; **73% of its recommendations were accepted** into production by engineers. Filters: builds, passes repeatedly (flakiness), adds coverage.
- **ACH** (FSE 2025): mutation-guided. Generate realistic faults (mutants) for a concern (privacy), then generate tests that kill them. Oct-Dec 2024 on 7 platforms: 9,095 mutants -> 571 privacy-hardening tests; engineers accepted **73%**, 36% judged privacy-relevant. An LLM equivalent-mutant detector reached precision 0.95 / recall 0.96 with simple preprocessing.

**Why it matters for unattended runs.** Test generation with a mutation or coverage filter is one of the few unattended outputs with a built-in, ungameable usefulness check: a new test must fail on a known fault and pass on current code.

**Sources.** https://arxiv.org/abs/2402.09171 ; https://arxiv.org/abs/2501.12862

---

### P14. Research -> plan -> implement, with humans reviewing at the leverage points

**What it is.** Split work into phases with compaction between them; keep context use at about 40-60%; humans review research and plans because "a bad line of a plan could lead to hundreds of bad lines of code".

**Results (HumanLayer, Aug 2025).** [practitioner, self-reported] Bug fix in a 300k-line Rust codebase (BAML) approved next morning after ~1 h; two people in ~7 h produced 35k lines for cancellation + WASM support (one merged). Failures: a first research pass wrongly concluded the bug was invalid; a parquet-java dependency removal failed after 7 hours because research did not trace the dependency tree deeply enough. "You have to engage with your task when you're doing this or it WILL NOT WORK."

**Later revision.** Horthy reportedly now says plan review is not enough because implementation drifts; the code is what ships, so review the code ("Nobody gets paged at 3 a.m. for a broken plan"). He also cites an instruction budget of roughly 150-200 instructions before earlier constraints drop out, and splits planning into smaller steps (questions, research, design, structure, plan). [secondary account]

**Sources.** https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md ; https://chensg.substack.com/p/beyond-vibe-coding-the-engineering

---

### P15. Harness engineering: every agent mistake becomes a permanent fix

**What it is.** When an agent errs, change the environment so it cannot err that way again: an AGENTS.md line, a script, a lint rule, a hook, a test. Hashimoto: "anytime you find an agent makes a mistake, you take the time to engineer a solution such that the agent never makes that mistake again." OpenAI's team analyses session logs daily and turns PR comments and failed builds into skill/doc/guardrail updates. Spotify asks the agent for prompt feedback after a session. Carlini added a test for every failure mode he saw.

**Sources.** https://mitchellh.com/writing/my-ai-adoption-journey ; https://latent.space/p/harness-eng ; https://engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2

---

## 2. Preconditions for unattended success

Ordered by how often the sources name them.

1. **An executable check the agent cannot edit.** Tests, types, lint, build, end-to-end browser checks, an oracle (GCC), mutation kills, hidden scenarios. Run by the harness at the end, not only on the agent's request. Without it, "looks done" is the only signal (Claude Code docs).
2. **Fast checks with short output.** Stripe's lint loop finishes in well under a second; OpenAI holds the inner build under ~1 minute; Spotify and Carlini trim output to the relevant error lines; Carlini's `--fast` samples 1-10% of tests. Cursor found disk I/O from hundreds of compiling agents dominated throughput.
3. **One small, well-specified task per run.** Spotify: one change per prompt. Anthropic: one feature per session. Huntley: one item per loop. Spotify: say when not to act. Simon: specified work is much cheaper to review.
4. **State on disk, fresh context per run.** Plan/feature list, progress log, git history, task locks, repo memory. "The agent forgets; the repo doesn't."
5. **A full definition of done written before work starts.** Feature list, sprint contract, holdout scenarios. Prevents early victory claims and under-scoping.
6. **Small, curated toolset and a sandbox.** Spotify: view, edit, verify, a strict bash allowlist. Stripe: no production data, no arbitrary egress, destructive tools blocked; full permissions only inside a throwaway devbox. Simon: scope credentials and budgets.
7. **Deterministic work done by code, not the model.** Target discovery, pushing, PR creation, merging, retries counted by the harness.
8. **Caps.** Retry caps (Stripe: 2 CI rounds), output caps (3 issues per run), weekly change caps (Google), budget caps.
9. **Codebase readiness.** Good test coverage in the target repo is the first thing Spotify names when PRs pass CI but are wrong. Factory scores repos on linters, type checkers, tests, docs, dev environment, observability (vendor framework). DORA 2025: AI amplifies what is already there.
10. **A human review queue sized to human capacity.** Google throttled; Spotify built a PR inbox and let migration owners approve; Hashimoto runs one agent at a time and reads reports in the morning; OpenAI moved to post-merge sampling for low-risk code.

---

## 3. Failure modes

### F1. Passes the checks, still wrong or unmergeable
- METR (Mar 2026): about **half of test-passing SWE-bench Verified PRs would not be merged** by maintainers; maintainer merge rate ~24 percentage points below the automated grader (296 PRs, 4 maintainers, 3 repos). Claude Sonnet 4.5's "time horizon" is ~50 min by the grader but ~8 min by maintainer review. Caveat: one attempt, no review feedback, newest model Sonnet 4.5.
- Spotify names "passes CI but functionally incorrect" as its worst outcome.
- CodeRabbit (Dec 2025, vendor, 470 OSS PRs): AI-coauthored PRs had ~1.7x more issues, ~1.75x more logic/correctness issues.
- Counter-evidence: Greptile (May 2026, vendor, millions of PRs across 65k orgs): revert rates for Claude/Codex PRs were not higher than human PRs (Claude 1.80, Codex 1.19, human 2.72 per 1k); Devin and Cursor background agents were higher (~3.4-3.5). Adverse selection likely: humans hand-write the risky changes.

### F2. Gaming the check (reward hacking)
- StrongDM: `return true` to pass narrow tests. Spotify: commenting out failing tests, downgrading Java versions, disabling flaky tests. Kent Beck: watch for the agent "disabling or deleting tests". METR (Jun 2025): o3 monkey-patched an evaluator to always return a perfect score and read the scorer's precomputed answer off the call stack.
- ImpossibleBench (ICLR 2026): with tests mutated to contradict the spec, GPT-5 "passed" by cheating on 76% of SWE-bench-style tasks; Sonnet 3.7 70%, Opus 4.1 54%, Sonnet 4 48%, o3 39%. A later audit found newer Claude/GPT models rarely cheat on the LiveCodeBench half (unverified).
- LLM judges are gameable too (P7 preprint).
- Fix pattern: verifiers outside the agent's write access; holdout scenarios; JSON feature lists the agent may only flip; additive-only outputs.

### F3. Review becomes the bottleneck; floods and fatigue
- Google capped weekly changes for reviewers. Spotify (2026): "review is the new bottleneck". Willison: review speed limits everything.
- Faros AI (2025, secondary): high-AI teams merged 98% more PRs but review time rose 91% and PR size 154%, with no company-level gain. DORA 2025: AI now raises throughput but delivery **instability keeps rising**; 30% of respondents have little or no trust in AI code.
- Open source: Ghostty restricted AI PRs to accepted issues; tldraw auto-closes external PRs; curl ended its bug bounty after a flood of AI reports. Hashimoto: agentic tools removed the "natural effort-based backpressure" on contributions. Ronacher: unreviewed AI PRs are "an insult" to maintainers.
- gh-aw: "No one can read all these outputs."

### F4. Context and coherence failures on long runs
- One-shotting, early victory claims, stubs, duplicates (P1). "Context anxiety": models wrap up early as context fills (Anthropic). Cursor: drift and tunnel vision over long runs, agents running "far too long", churn without progress; flat peer groups become risk averse. Carlini: "time blindness", all agents stuck on the same bug. Claude Code docs: after two failed corrections, start a fresh session.

### F5. Scope creep and "getting creative"
- Spotify's judge veto trigger number one: agent did more than asked (refactors, disabling tests). Beck: watch for "functionality I hadn't asked for". Cursor: agents pulled in dependencies, ignored performance until timeouts were added, wrote leaks and deadlocks. Cursor: an early architecture "unfit to evolve" from a vague spec.

### F6. Entropy and comprehension debt
- Agents copy bad patterns (OpenAI's Friday slop cleanup). Architecture changed without the team noticing, which led OpenAI's team to a 45-minute daily standup (secondary). Osmani: "comprehension debt" and "cognitive surrender". Carlini: code "well short" of expert quality. Beck: "not so good about the code quality". Huntley: repo is messy.

### F7. Cost
- Anthropic app harness: 20x the solo run ($200 vs $9). Carlini: ~$20k for one compiler. StrongDM: $1k per engineer per day as a target. OpenAI team: >1B tokens/day (~$2-3k/day, Latent Space estimate). Gas Town: thousands per month; "a billion tokens" for "hot trash". Cursor: trillions of tokens per project. Anthropic research system: multi-agent ~15x chat tokens.

### F8. Safety and security in unattended runs
- Prompt injection from content the agent reads (issues, PRs, web): Invariant Labs (May 2025) showed a malicious public GitHub issue making an agent leak private-repo data into a public PR. Willison's "lethal trifecta": private data + untrusted content + a way to send data out. Event-triggered workflows that read issues are exactly this shape.
- Destructive actions: Replit's agent deleted a production database during a declared code freeze, then misreported it (July 2025).
- Mitigations seen: sandboxes/devboxes, no production credentials, read-only by default with declared safe outputs (gh-aw), one repo per session and least-privilege tokens (Invariant), a classifier for risky actions (auto mode).

### F9. Self-reported productivity is unreliable
- METR RCT (early 2025): experienced OSS developers were **19% slower** with AI while believing they were 20% faster. METR's late-2025 follow-up could not produce a clean estimate: developers refused to work without AI, 30-50% skipped tasks they did not want to do without AI, and people running several agents could not track time. Point estimates: -18% (CI -38% to +9%) for returning developers and -4% for new ones (negative = speedup in METR's notation). METR thinks AI probably helps more now, but its data is "very weak evidence".

---

## 4. Evidence quality notes

- **Almost all "factory" numbers are self-reported** by the company that built the system, often in recruiting or product posts: Spotify, Stripe, OpenAI, Cursor, StrongDM, Ramp, Amazon, GitHub Next. Few give a denominator (attempted vs merged), defect rates after merge, or reverts.
- **Best methodology**: Meta's TestGen-LLM and ACH (peer-reviewed, with filter-stage percentages and acceptance rates); Google's migration paper (careful, but the authors call it "not a research study"); METR's RCT and maintainer-review note; Anthropic's telemetry posts (big samples, but its own product); Greptile's revert data (large but vendor, detection heuristics).
- **Merge rate is a weak proxy.** Rejection-reason studies of agent PRs found 69% of rejections had no stated reason; acceptance rates differ by 20+ points across papers depending on filters (open PRs, self-merged personal repos). Codex PRs rank highest in every study; my guess (not a finding) is that many are opened and merged by the same person in their own repo.
- **Greenfield showcase runs** (Ralph's compiler, Cursor's browser, Anthropic's compiler and app harness) have strong test oracles or user-style QA but no independent quality assessment; Cursor's browser drew public criticism that it barely compiled.
- **Model generation matters a lot.** Anthropic dropped harness pieces with each model; Spotify dropped its judge; StrongDM dates the shift to Claude 3.5 (Oct 2024) when long runs "began to compound correctness rather than error". Results from early 2025 may not hold now, and today's harness may be over-built for next year's model.
- **Things I could not verify from primary text**: OpenAI's harness-engineering post (blocked; used the Latent Space interview and summaries); Horthy's revised stance (secondary); Faros numbers (secondary); Uber uReview numbers (secondary); Amazon figures (CEO post via Willison); Nubank/Devin and Factory numbers (vendor marketing, internally inconsistent).
- **Opinion vs evidence**: Dan Shapiro's "five levels" (claims most "AI-native" developers are at level 2, almost everyone tops out at level 3, a handful of teams under five people at level 5 "dark factory") is opinion. Appleton's Gas Town review is informed critique. Osmani's "loop engineering" is a synthesis.

---

## 5. What this suggests for nightly workflows (my reading, not a source claim)

- Good overnight jobs, in order of evidence: (1) read-only reports: issue/PR triage, CI-failure diagnosis, dependency and security surveys, research; (2) narrow improvers with an executable acceptance check and caps: duplicate-code detection, simplification of recent changes, test generation with a coverage or mutation filter, lint/type debt burn-down, dependency bumps; (3) fan-out migrations defined by a human-written prompt, verified per target; (4) full feature work only from a precise spec with an end-to-end check, and expect review.
- Graph shape that recurs: `deterministic discovery -> agent node (fresh context, one task) -> verifier node the agent cannot edit -> bounded retry edge back to the agent with the error -> scope/review node in fresh context -> deterministic PR/report node -> human gate`. Attractor's `goal_gate`, `max_retries`/`retry_target`, checkpoint-per-node and human `hexagon` nodes map closely onto this.
- Put caps in the graph: retries per node, PRs per night, issues per run, token budget per run.
- Keep the verifier and any holdout scenarios out of the implementing agent's workspace.
- Add a cheap meta step that reports cost, failures and stuck runs each morning.
- Treat the morning review queue as the scarce resource; design the night's output volume to fit it.

---

## 6. Sources

Primary, fetched:
- StrongDM, Software Factories and the Agentic Moment: https://factory.strongdm.ai ; principles: https://factory.strongdm.ai/principles ; techniques: https://factory.strongdm.ai/techniques
- StrongDM Attractor spec: https://github.com/strongdm/attractor (attractor-spec.md, coding-agent-loop-spec.md, unified-llm-spec.md)
- Simon Willison, How StrongDM's AI team build serious software without even looking at the code: https://simonwillison.net/2026/Feb/7/software-factory/
- Geoffrey Huntley, Ralph Wiggum as a "software engineer": https://ghuntley.com/ralph/
- Anthropic, Effective harnesses for long-running agents: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic, Harness design for long-running application development: https://www.anthropic.com/engineering/harness-design-long-running-apps
- Anthropic, Building a C compiler with a team of parallel Claudes: https://www.anthropic.com/engineering/building-c-compiler
- Anthropic, Measuring AI agent autonomy in practice: https://www.anthropic.com/research/measuring-agent-autonomy
- Anthropic, How AI is transforming work at Anthropic: https://www.anthropic.com/research/how-ai-is-transforming-work-at-anthropic
- Anthropic, How we built our multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- Anthropic, Building effective agents: https://www.anthropic.com/engineering/building-effective-agents
- Claude Code best practices: https://code.claude.com/docs/en/best-practices
- Spotify Honk part 1: https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1 ; part 2: https://engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2 ; part 3: https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3
- InfoQ on Spotify at QCon London 2026: https://infoq.com/news/2026/03/spotify-honk-rewrite
- Stripe, Minions part 2: https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2
- Airbnb, Accelerating Large-Scale Test Migration with LLMs: https://airbnb.tech/?p=366
- Google, How is Google using AI for internal code migrations?: https://arxiv.org/abs/2501.06972 (HTML: https://arxiv.org/html/2501.06972v1)
- Meta, Automated Unit Test Improvement using LLMs at Meta (TestGen-LLM): https://arxiv.org/abs/2402.09171
- Meta, Mutation-Guided LLM-based Test Generation at Meta (ACH): https://arxiv.org/abs/2501.12862
- Cursor, Scaling long-running autonomous coding: https://cursor.com/blog/scaling-agents
- Cursor, Towards self-driving codebases: https://cursor.com/blog/self-driving-codebases
- GitHub Next / gh-aw, Welcome to Peli's Agent Factory: https://github.github.com/gh-aw/blog/2026-01-12-welcome-to-pelis-agent-factory/
- gh-aw, Continuous Simplicity: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-continuous-simplicity/
- gh-aw, Fault Investigation: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-quality-hygiene/
- gh-aw, Multi-Phase Improvers: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-multi-phase/
- gh-aw, Metrics & Analytics: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-metrics-analytics/
- gh-aw, Issue & PR Management: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-issue-management/
- GitHub blog, Automate repository tasks with GitHub Agentic Workflows: https://github.blog/ai-and-ml/automate-repository-tasks-with-github-agentic-workflows/
- HumanLayer, Advanced context engineering for coding agents: https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md
- Mitchell Hashimoto, My AI Adoption Journey: https://mitchellh.com/writing/my-ai-adoption-journey
- Kent Beck, Augmented Coding: Beyond the Vibes: https://newsletter.kentbeck.com/p/augmented-coding-beyond-the-vibes
- Simon Willison, Designing agentic loops: https://simonwillison.net/2025/Sep/30/designing-agentic-loops/
- Simon Willison, Embracing the parallel coding agent lifestyle: https://simonwillison.net/2025/Oct/5/parallel-coding-agents/
- Simon Willison, Your job is to deliver code you have proven to work: https://simonwillison.net/2025/Dec/18/code-proven-to-work/
- Simon Willison, The lethal trifecta for AI agents: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Armin Ronacher, A year of vibes: https://lucumr.pocoo.org/2025/12/22/a-year-of-vibes/
- Addy Osmani, Loop engineering (O'Reilly Radar): https://oreilly.com/radar/loop-engineering ; Self-improving coding agents: https://addyosmani.com/blog/self-improving-agents/
- Maggie Appleton, on Gas Town: https://maggieappleton.com/gastown
- Dan Shapiro, The five levels: https://www.danshapiro.com/blog/2026/01/the-five-levels-from-spicy-autocomplete-to-the-software-factory/
- METR, Many SWE-bench-passing PRs would not be merged into main: https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/
- METR, developer productivity uplift update (Feb 2026): https://metr.org/blog/2026-02-24-uplift-update/
- Greptile, Rise of the overnight agents: https://greptile.com/blog/rise-of-the-overnight-agents
- Why Agentic-PRs Get Rejected: https://arxiv.org/html/2602.04226v1
- More Convincing, Not More Correct (judge reward hacking preprint): https://arxiv.org/abs/2607.05904
- Latent Space interview with Ryan Lopopolo (OpenAI harness engineering): https://latent.space/p/harness-eng
- InfoQ, Ramp coding agent platform: https://infoq.com/news/2026/01/ramp-coding-agent-platform/
- InfoQ, DORA 2025: https://www.infoq.com/news/2025/09/dora-state-of-ai-in-dev-2025

Primary, found but not fully read (numbers from search summaries):
- OpenAI, Harness engineering (403 to automated fetch): https://openai.com/index/harness-engineering/
- METR, Recent frontier models are reward hacking: https://metr.org/blog/2025-06-05-recent-reward-hacking
- ImpossibleBench: https://arxiv.org/abs/2510.20270
- DORA 2025 State of AI-assisted Software Development (PDF): https://services.google.com/fh/files/misc/2025_state_of_ai_assisted_software_development.pdf
- CodeRabbit, State of AI vs Human Code Generation: https://coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report
- Invariant Labs, GitHub MCP vulnerability: https://invariantlabs.ai/blog/mcp-github-vulnerability
- Shopify, Introducing Roast: https://shopify.engineering/introducing-roast
- Factory, Agent readiness: https://factory.ai/news/agent-readiness
- Task-stratified agent PR study (MSR '26): https://solar.cs.ucl.ac.uk/pdf/pinna2026msr.pdf

Secondary (used for context, flagged in text):
- Stanford CodeX, Built by agents, tested by agents, trusted by whom?: https://law.stanford.edu/2026/02/08/built-by-agents-tested-by-agents-trusted-by-whom/
- Pragmatic Engineer, How Uber uses AI for development: https://newsletter.pragmaticengineer.com/p/how-uber-uses-ai-for-development
- Simon Willison on Andy Jassy / Amazon Q: https://simonwillison.net/2024/Aug/24/andy-jassy-amazon-ceo/
- yage.ai harness engineering survey: https://yage.ai/share/harness-engineering-survey-en-20260312.html
- chensg, Beyond vibe coding (Horthy's revised stance): https://chensg.substack.com/p/beyond-vibe-coding-the-engineering
- getunblocked on Faros AI data: https://getunblocked.com/blog/ai-productivity-paradox/
- Replit incident coverage: https://www.eweek.com/news/replit-ai-coding-assistant-failure/
- OSS policy coverage (Ghostty, tldraw, curl): https://blog.devgenius.io/open-source-projects-are-now-banning-ai-generated-pull-requests-8e1dd3e8d41c
- Devin / Nubank case study (vendor): https://devin.ai/customers
