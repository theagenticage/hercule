# Scheduled and one-off autonomous agent jobs on a software repository

Research for Hercule, 2026-10-23. Scope: (1) recurring nightly, daily or weekly agent jobs that deliver value consistently, and (2) one-off, high-token jobs worth running when a lot of subscription quota is about to expire.

How to read the numbers:

- Almost every number below is self-reported by the team that built the job. Independent checks are rare. Where I found one, I say so.
- "Merge rate" in the GitHub Next numbers means merged / proposed PRs attributed to that workflow, often through a chain (report, then issue, then a PR written by a coding agent). The gh-aw team counts the chain back to the workflow that started it.
- I ran one independent check myself with `gh search prs` (snapshot 2026-10-23, see section 1.10). It is a rough sample, not a study.

---

## 0. Short version

Jobs with the strongest published evidence of steady value, ranked:

| Rank | Job | Cadence | Output | Reported result | Source |
|---|---|---|---|---|---|
| 1 | Docs updater from recent merges | daily | draft PR | 57/59 merged (96%) | gh-aw Continuous Documentation |
| 2 | Stale-issue research ("is this closable?") | weekly, up to 100 issues | close queue, later capped auto-close | 1,462 issues closed in ~3 weeks after a one-off pass; weekly job keeps it clean | Next.js blog |
| 3 | Self-healing dependency-bump PRs | on CI failure of Renovate PRs | commits to the PR branch | 24 broken PRs fixed in month one, ~20 dev-days saved | Elastic |
| 4 | Semantic refactor / large-file split, one issue per run | weekdays | 1 issue, then agent PR | 112/142 (79%) and 26/33 (79%) | gh-aw Continuous Refactoring |
| 5 | Duplicate code detector on changed files | daily | max 3 issues | 76/96 (79%) | gh-aw Continuous Simplicity |
| 6 | CLI / UI consistency checker | recurring | PRs | 80/102 (78%) | gh-aw Testing & Validation |
| 7 | Glossary / terminology drift | recurring | PR | 10/10 | gh-aw Continuous Documentation |
| 8 | Dependency usage review, round-robin per module | daily | discussion, then issues/PRs | 58/74 (78%) | gh-aw Continuous Improvement |
| 9 | Type-strictness ratchet (find `any`, untyped constants, duplicate types) | recurring, analysis only | discussion, then issues/PRs | 19/25 (76%) | gh-aw Continuous Improvement |
| 10 | Release notes / changeset | per release or weekly | PR or Slack post | 22/28 (78%) | gh-aw Operations & Release; Devin |
| 11 | CI doctor (investigate failures on main) | on CI failure | issue, then fix PR | 9/13 (69%) | gh-aw Fault Investigation |
| 12 | Meta-agent watching the other agents | daily | issues | 40 issues, 19 merged fixes | gh-aw Testing & Validation |
| 13 | Daily dead-code removal, one fix per run | daily | 1 small PR | qualitative only | Ona |
| 14 | Commit variant analysis for security | per commit or nightly | finding, then human-reviewed patch | Big Sleep's first real bug; Codex Security (ex-Aardvark) 10 CVEs | Google Project Zero; OpenAI |
| 15 | Test improver | daily | draft PRs | mixed: 13/19 chain for a focused variant; 8/17 in Z3; test PRs have low acceptance in a large study | gh-aw; Z3; arXiv 2602.08915 |

Jobs reported as noisy or low value:

- **Daily perf improver on mature code.** In Z3, 18 of 20 "Daily Perf Improver" PRs were closed. The 2 that merged were setup changes, not optimizations. Polars, by contrast, merged 9 of 10, so the outcome depends on the repo. In a study of 7,156 agent PRs, perf PRs had the lowest acceptance (55%). Meta's version works because a regression detector starts it and its PR goes to the author of the change that caused the regression.
- **Do-everything assistants.** "[repo-assist]" PRs on GitHub: 168 merged, 38 closed, 794 still open. Draft PRs pile up faster than people review them.
- **Auto-close of duplicates without a safety net.** Anthropic's claude-code repo had users complain about wrong closes. The dedupe bot then went silent for about 2 months and nobody noticed.
- **Exploratory doc testers.** 9/21 (43%) for "Documentation Noob Tester".
- **Raw security hunts.** Without a validation stage, most findings are false: 809 AI reports to curl led to about 15% real fixes, and Heelan's o3 runs had about 1 real finding per 50.

---

## 1. Catalog of nightly jobs

Each entry lists: what it does, cadence, output, guardrails, results, verdict, source.

### 1.1 Documentation and terminology

**Daily documentation updater**
- What: reads code changes and merged PRs since the last run, updates the docs that describe them.
- Cadence: daily (a variant runs on every push to main).
- Output: draft PR with `documentation` label.
- Guardrails: `permissions: read-all`; writes only through a draft PR; `protected-files: fallback-to-issue` (if the agent wants to touch a protected file, it files an issue instead).
- Results: 57 merged of 59 proposed (96%). Independent support: in a study of 7,156 agent PRs, docs PRs had 82% acceptance against 66% for features; Claude Code docs PRs 92%.
- Verdict: most reliable job found. Low risk, easy to review.
- Sources: gh-aw "Continuous Documentation"; arXiv 2602.08915; agentics `update-docs.md`.

**Docs drift report (weekly)**
- What: scans PRs merged since the last run, flags docs that mention changed APIs, opens update PRs.
- Cadence: weekly.
- Output: PRs against the docs repo, for an editor to review.
- Source: Anthropic's own example in the Claude Code scheduled tasks docs. No numbers.

**Glossary maintainer**
- What: keeps the project glossary in step with the code. It caught the team "using three different terms for the same concept".
- Output: PR. Results: 10/10 merged.
- Verdict: very relevant to Hercule, which has `GLOSSARY.md` with "Avoid" lists.
- Source: gh-aw "Continuous Documentation".

**Documentation unbloat**
- What: shortens wordy docs without losing meaning. Output: PR. Results: 88/103 (85%).
- Source: gh-aw "Continuous Documentation".

**Schema consistency checker**
- What: detects drift between JSON schemas, structs, code, and docs.
- Output: analysis discussions (55 created). Quote: "It caught drift that would have taken us days to notice manually."
- Verdict: a direct template for a "spec vs. contract vs. docs" nightly audit.
- Source: gh-aw "Fault Investigation".

**Multi-device docs tester / blog auditor / link checker**
- What: Playwright walks the docs site on phone, tablet and desktop sizes; the blog auditor checks for stale examples and broken links.
- Results: tester 2/2 merged; blog auditor 6 audits, 1 flagged stale content.
- Source: gh-aw "Continuous Documentation".

**Documentation noob tester (noisy)**
- What: follows the docs the way a new user would and reports confusing steps.
- Results: 62 discussions, then 21 issues, then 21 PRs, of which 9 merged (43%). The authors say many ideas were "too ambitious for immediate implementation".
- Verdict: better as an occasional one-off than a daily job.

### 1.2 Code health (refactor, simplify, dead code, types)

**Semantic function refactor**
- What: finds functions that live in the wrong file. It collects names with a script, groups them by meaning, and checks for near-duplicates.
- Output: issues with `[refactor]` prefix; a coding agent writes the PRs.
- Guardrails: closes its own older open `[refactor]` issues before filing new ones, so they never pile up.
- Results: 99 issues, 142 PRs, 112 merged (79%).
- Source: gh-aw "Continuous Refactoring".

**Large file simplifier ("daily file diet")**
- What: finds the single largest source file; if it is over a threshold, proposes how to split it.
- Cadence: weekdays.
- Output: at most 1 issue per run, assigned to a coding agent.
- Guardrails: `skip-if-match` on an open `[large-file-simplifier]` issue; issue `expires: 2d`; bash limited to `git ls-tree`, `wc`, `head`, `grep` and similar.
- Results: 37 issues, 33 PRs, 26 merged (79%).
- Source: gh-aw "Continuous Refactoring"; agentics `large-file-simplifier.md`.

**Duplicate code detector**
- What: semantic duplicate detection (Serena) on files changed in recent commits.
- Output: issues `[duplicate-code]`, grouped under a parent.
- Guardrails:
  - reports only duplication over 10 lines or in 3+ places;
  - `max: 3` issues per run;
  - skips tests and generated files;
  - issues expire after 2 days.
- Results: 96 PRs, 76 merged (79%).
- Source: gh-aw "Continuous Simplicity"; agentics `duplicate-code-detector.md`.

**Code simplifier on recently changed code**
- What: looks at code modified recently and proposes clearer, shorter, more idiomatic versions.
- Cadence: daily. Output: PR.
- Guardrails: `skip-if-match: 'is:pr is:open in:title "[code-simplifier]"'` (skips the run while a previous PR is open); the PR expires after 1 day.
- Results: 5/6 merged in gh-aw. My GitHub-wide sample: 810 merged, 108 closed, 82 open (capped at 1,000 results; dominated by repos that merge freely).
- Source: gh-aw "Continuous Simplicity"; agentics `code-simplifier.md`.

**Daily dead-code removal (Knip)**
- What: runs Knip, picks one finding, removes it, runs build and lint.
- Guardrails: "We deliberately constrain the automation to one fix per run"; checks open PRs first so it does not repeat in-flight work.
- Results: qualitative only. Each morning there is one small, trivially reviewable PR. Large cleanup PRs "go stale" and conflict with other work.
- Source: Ona, "Knip automation".

**Type-strictness ratchet ("Typist")**
- What: finds untyped code (`map[string]any`, untyped constants, `any` in signatures) and near-duplicate type definitions.
- Output: analysis only (discussions). Separate agents turn findings into issues and PRs.
- Results: in one scan, 477 `map[string]any` uses, 36 untyped constants, 30+ `any` in signatures. Downstream: 57 discussions, 22 issues, 25 PRs, 19 merged (76%).
- Lesson: teams can "develop quickly with flexibility, then let autonomous agents like Typist trail behind".
- Source: gh-aw "Continuous Improvement".

**Style agents (Terminal Stylist, Functional Pragmatist)**
- Terminal Stylist reviews CLI output style: 31 reports, then 25 issues, then 16 merged PRs. It never opens PRs itself, because style is subjective.
- Functional Pragmatist runs twice a week: 2/2 merged.
- Source: gh-aw "Continuous Style", "Continuous Improvement".

**Repository quality improver (rotating focus)**
- What: each day picks a different focus: 60% repo-specific areas, 30% standard ones (quality, docs, tests, security, perf), 10% revisits. Memory makes sure coverage rotates.
- Results: 59 discussions, 30 issues, 40 PRs, 25 merged (62%).
- Source: gh-aw "Continuous Improvement".

**Stale feature-flag cleanup**
- What: finds flags at 100% rollout for more than 14 days, opens a removal PR, pings the owner.
- Cadence: weekly (Mondays). Prior art without LLMs: Uber's Piranha removed about 2,000 stale flags this way, sending each diff to the flag's author.
- Source: Cognition "Devin can now schedule Devins"; Uber Piranha.

### 1.3 Tests

**Test improver (daily)**
- What: finds high-value test gaps, writes tests, measures coverage before and after.
- Guardrails, from the actual workflow file:
  - a pre-check skips the run if 8 or more `[test-improver]` PRs are already open;
  - at most 4 draft PRs and 4 issues per run;
  - `timeout-minutes: 30`;
  - "Restrained: When in doubt, do nothing. Silence beats spam.";
  - "Never modify tests just to force them to pass";
  - repo memory keeps the backlog cursor, validated commands and maintainer preferences;
  - one monthly summary issue instead of many comments.
- Results (mixed):
  - gh-aw's focused "Testify expert": 19 issues, 13 merged PRs.
  - Z3: "Daily Test Coverage Improver" 8 merged of 17.
  - GitHub-wide "Daily Test Coverage Improver": 243 merged, 68 closed, 63 open.
  - GitHub-wide "[test-improver]" (newer name): 290 merged, 45 closed, 665 open. Many PRs wait unreviewed.
  - Large study: test PRs had 61.5% acceptance overall, and only 33% for Claude Code.
- Verdict: valuable when aimed at a narrow target (one framework, one module, regression tests for recent fixes). As a broad "raise coverage" job it produces a review backlog.
- Sources: agentics `test-improver.md`; gh-aw "Testing & Validation"; arXiv 2602.08915.

**Test quality reviewer (Test Quality Sentinel)**
- What: on PRs, flags tests that pin implementation details, cover only the happy path, inflate line counts, or duplicate each other.
- Guardrails: read-only tools (`git diff`, `grep`, `cat`). Lesson: "When the agent can't finish, the workflow says so instead of posting a half-baked verdict."
- Source: gh-aw "Agent of the Day 2026-10-21".

**Mutation-guided test hardening (Meta ACH)**
- What: an LLM writes a few realistic mutants (faults) for a stated concern, such as privacy, checks they are not equivalent to the original, then writes tests that kill them.
- Results:
  - test-a-thons on Messenger and WhatsApp: 73% of tests accepted (140 of 191), 36% judged privacy-relevant;
  - the equivalence checker had precision 0.79 and recall 0.47, rising to 0.95 and 0.96 with simple preprocessing.
- Predecessor TestGen-LLM: 75% of generated tests built, 57% passed reliably, 25% raised coverage; 73% of its suggestions accepted.
- Verdict: a stronger test-improvement signal than coverage, because each test must catch a real fault. Good fit for a weekly job aimed at one module.
- Sources: arXiv 2501.12862; arXiv 2402.09171.

**Flaky test fixing**
- Hard evidence is thin. FlakyFix (GPT-3.5) estimates 51-83% of repairs would pass. Vendor claims (80-90%) are unverified.
- The useful guardrail comes from Semaphore: verify a fix by rerunning the test many times across machines, because one passing run proves nothing.
- Verdict: a reasonable nightly job only if the CI history can rank flaky tests and the job can rerun tests many times.
- Sources: arXiv 2307.00012; Semaphore.

### 1.4 CI and build

**CI doctor**
- What: on a failed run on main, reads logs, looks for similar past failures, files a diagnosis, proposes a fix.
- Guardrails: read-only permissions; `[CI failure]` title prefix; folds duplicate failures together; 10-minute timeout.
- Results: 13 PRs, 9 merged (69%), for example retry logic and pre-flight checks. "Agents excel at the tedious investigation work that humans find draining."
- Source: gh-aw "Fault Investigation"; agentics `ci-doctor.md`.

**CI coach**
- What: suggests CI speed and cost improvements. Results: 9/9 merged, for example removing a duplicate test run.
- Source: gh-aw "Testing & Validation".

**Self-healing dependency PRs**
- What: when a Renovate PR build fails, the agent reads the build log and fixes the code on that branch.
- Guardrails:
  - `--allowedTools` limited to git, gradle, and file edits;
  - auto-merge is forced off whenever the agent contributed, and the script aborts if that fails;
  - a label stops Renovate from rebasing while the agent works;
  - success and failure labels are set at the end;
  - "never downgrade dependencies".
- Results: in month one, 24 broken PRs fixed and ~20 dev-days saved. Partial fixes still helped by narrowing the search.
- A similar Renovate + Cursor pipeline: 40+ updates merged, 10+ agent fixes. That team needed a concurrency lock after parallel agents made duplicate fixes. The agent stops after a few failed tries and asks a human.
- Verdict: high value, because the job has a clear pass/fail signal (the build).
- Sources: Elastic Search Labs; VirtusLab maturity guide.

### 1.5 Performance

**Daily perf improver (noisy on mature code)**
- What: three phases over several days: research bottlenecks, build benchmark infrastructure, implement optimizations. Repo memory carries state between runs.
- Results:
  - gh-aw published no numbers.
  - Z3 (`gh search`): 20 PRs, 18 closed, 2 merged. Both merged PRs were configuration changes. Titles of the closed ones include "SIMD Vectorization (Round 2)" and "ML-Guided Variable Ordering (Round 3)".
  - GitHub-wide "Daily Perf Improver": 186 merged, 69 closed. Skewed by GitHub Next trial repos, where every PR merges.
  - Counter-example: pola-rs/polars merged 9 of 10 `[perf-improver]` PRs.
- Verdict: mixed. Noisy on highly tuned code; useful where a trusted benchmark exists and there is still easy performance to win.
- Better pattern (Meta AI Regression Solver): a detector (FBDetect) finds a regression and links it to the PR that caused it. The agent then writes a fix-forward PR and sends it to that PR's author. Diagnosis drops from ~10 hours to ~30 minutes.
- Sources: Z3 PRs via `gh search prs`; arXiv 2602.08915 (perf PRs 55% acceptance, lowest category); Meta Engineering 2026-04-16.

### 1.6 Security

**Commit variant analysis**
- What: take a past security fix and look for the same bug pattern elsewhere, or in new commits.
- Results:
  - Big Sleep found its first real bug (SQLite, fixed the same day) by "reviewing recent commits for similar unresolved issues";
  - Codex Security (formerly Aardvark) builds a threat model of the repo, monitors commits, confirms exploitability in a sandbox, and proposes patches for human review; 10 CVEs; 92% recall on seeded test repos.
- Verdict: the most promising nightly security job. It is narrow (new commits only) and can be verified.
- Sources: Google Project Zero; OpenAI "Introducing Aardvark".

**Daily malicious-code, secrets and static-analysis reports**
- What: scan recent changes for supply-chain patterns and committed secrets; run zizmor, poutine and actionlint on workflow files.
- Results: 57 static-analysis discussions, 12 zizmor reports. No precision data.
- Source: gh-aw "Security-related".

**Claude Code security review (per PR)**
- What: the GitHub Action has a separate false-positive filtering step, with editable filter instructions. Claude Code Security (Feb 2026) adds multi-stage self-verification, plus severity and confidence for each finding.
- No published precision numbers.
- Sources: anthropics/claude-code-security-review; Anthropic "Claude Code Security".

### 1.7 Issues and backlog

**Issue triage on open**
- What: applies labels from a fixed allowlist and posts one comment.
- Guardrails:
  - `add-labels.allowed` list, at most 4 labels;
  - `add-comment max: 1`;
  - skips issues already labeled or assigned to a person;
  - by default reads only issues from maintainers (integrity filter), because outside issue text is a prompt-injection risk;
  - 5-10 minute timeout.
- Results: no accuracy numbers were published anywhere I looked. A GitHub survey says 60% of maintainers want help with triage and 30% with duplicate detection.
- Sources: gh-aw "Meet a Simple Triage Workflow"; agentics `issue-triage.md`; GitHub blog.
- Cadence for Hercule: Anthropic's own example runs this nightly: label new issues, assign owners by code area, post a summary.

**Duplicate detection plus auto-close (cautionary tale)**
- Setup in Anthropic's claude-code repo:
  - a dedupe bot comments with likely duplicates;
  - a daily job closes the issue 3 days later unless the author downvotes the comment;
  - stale and lock jobs close quiet issues.
- What went wrong:
  - users reported wrong closes, and circular duplicate chains where a new report was closed as a duplicate of the old closed one;
  - the dedupe bot stopped around 2026-01-27 and came back around 2026-04-01, with no announcement.
- Lesson: an automation whose failure shows up as missing output goes unnoticed. Monitor the job, not only what it produces.
- Source: dev.to investigation (single author, unconfirmed by Anthropic); claudeissues.com threads.

**Stale-issue research: "closability" (best evidence in this category)**
- What: per issue, in a fresh sandbox:
  1. reads the thread and checks the supported versions;
  2. searches related PRs, commits, releases and docs;
  3. tries to reproduce on the reported version, latest stable, and canary;
  4. looks for evidence against its own conclusion.
- Output: structured JSON with `closeConfidence`, `primaryReason`, evidence, and links.
- Guardrails:
  - read-only outside the sandbox;
  - ignores instructions found in issue text;
  - a failed reproduction alone is not enough to close;
  - saved research is thrown away when the issue gets new activity;
  - a GitHub Action lets anyone reopen a closed issue.
- Recurring job: every Monday it researches up to 100 issues with 30+ days of inactivity, starting with issues it has never seen. Auto-close is now allowed for at most 25 issues a week, and only when a second agent, told to look for reasons to keep the issue open, also agrees to close.
- Results (one-off pass): 1,462 closed in about 3 weeks. Reasons: 37% already fixed, 19% duplicate, 16% expected behavior, 6% no longer reproducible, 5% unsupported.
- Verdict: the clearest example of a recurring backlog job done right.
- Source: Next.js blog, 2026-09-04.

**Stale bug verification on latest tag (NVIDIA NemoClaw skill)**
- What: the same idea as closability. Builds a reproducer, runs it on the latest tag, and logs a verdict.
- Guardrail: never writes to the project, assigns or comments before a maintainer accepts that exact set of writes.
- Research warning: agents tend to act when they should not. Told to reproduce first, they may wrongly give up when an issue is only partly fixed.
- Sources: mcpservers.org NemoClaw skill; arXiv 2605.07769.

**Backlog burner / Issue Monster / plan-and-assign**
- What:
  - Issue Monster hands one issue labeled `cookie` to a coding agent every 30 minutes, one at a time, to avoid "the chaos of parallel work on the same codebase";
  - Backlog Burner works through one backlog issue per day, with memory;
  - `/plan` splits an issue into sub-issues for agents;
  - Discussion Task Miner turns discussion threads into issues.
- Results:
  - `/plan`: 514/761 (67%), the highest-volume workflow in gh-aw;
  - task miner: 60/105 (57%);
  - Backlog Burner: 26 merged and 8 closed GitHub-wide; 4 of 11 merged in Z3.
- Verdict: works when a human picks the issues (a `ready-for-agent` or `cookie` label). Lower merge rates than the hygiene jobs.
- Sources: gh-aw "Issue & PR Management", "Project Coordination", "Multi-Phase".

**Reproduce-the-bug agent**
- What: writes a failing test that reproduces a reported bug.
- Results:
  - Google BRT Agent: plausible reproduction for 28% of 80 real internal bugs, against 10% for the older LIBRO;
  - handing those tests to an automatic repair system gave 30% more plausible fixes;
  - AssertFlip: 43.6% on SWT-Bench-Verified.
- Verdict: worth running nightly on new bug reports as an enrichment step: attach the test to the issue and do not attempt a fix.
- Sources: arXiv 2502.01821; arXiv 2507.17542.

### 1.8 Reports and audits

**Daily repo status / morning brief**
- What: summarizes the last 24 hours (issues, PRs, releases, code changes) with recommendations.
- Guardrails: bash limited to read commands; `close-older-issues: true`, so only one report is open at a time; `mentions: false`, so nobody is pinged.
- Value: widely offered (Codex automations, Devin, Claude Code examples, gh-aw), but no outcome numbers anywhere. The Devin feature-request digest adds a useful twist: it remembers processed messages and reports "only what changed since yesterday".
- Verdict: cheap and harmless; value depends on whether anyone reads it. Make it stateful and focused on changes.
- Sources: agentics `repo-status.md`; Cognition; OpenAI Codex automations.

**Weekly release notes / changeset**
- Results: Changeset 22/28 merged (78%). Devin's weekly example sorts the week's merged PRs into fixes, features and infra, and posts to Slack. Notes from earlier runs stop PRs from repeating across weeks.
- Sources: gh-aw "Operations & Release"; Cognition.

**Architecture guardian**
- What: on weekdays, reads the last 24 hours of commits and checks for large files, oversized functions, high export counts, and import cycles.
- Output: at most one `[architecture-guardian]` issue, which expires in 2 days, and only if none is open.
- Guardrails: bash limited to `cat`; daily AI-credit cap; the run stops after 3 permission denials. Cost: ~7k tokens and 8-11 minutes per run.
- Lesson: record an explicit `noop` on quiet days, so a quiet day can be told apart from a silent failure. "A good guardian doesn't need to raise an alarm every day."
- Verdict: good template for a Hercule "spec/ADR conformance" nightly. Hercule's `dep-lint` already catches import cycles, so an agent version would cover rules that `dep-lint` cannot check.
- Source: gh-aw "Agent of the Day 2026-10-22".

**Breaking change checker**
- What: flags backward-incompatible changes, for example to the CLI. Output: alert issues. No numbers.
- Source: gh-aw "Fault Investigation".

**Staging QA, accessibility and visual sweeps**
- What:
  - Devin walks core user flows on staging every morning, takes screenshots, and flags regressions;
  - a weekly parallel QA pass runs one agent per page;
  - gh-aw Daily Accessibility Review checks WCAG with Playwright;
  - Google's Stitch team ran a "pod" of daily Jules agents (performance, security, accessibility, test coverage), which made Jules "one of the largest contributors" to the repo.
- No precision numbers.
- Sources: Cognition; gh-aw "Multi-Phase"; Google blog.

### 1.9 Meta-agents (agents that watch agents)

- **Workflow health manager**: 40 issues; 25 of them led to 34 PRs, 14 merged; plus 5 direct PRs merged.
- **Audit workflows**: 93 reports and 9 issues on cost, errors and success patterns across all runs. It was the "most prolific discussion-creating agent", which is a noise risk in itself.
- **Portfolio analyst**: found that "some agents were way too chatty with their LLM calls".
- **Agent performance analyzer**: found draft PRs were 9.6% of all open PRs and triggered an automatic cleanup of stale drafts.
- gh-aw lesson: "Meta-agents that watch other agents are very valuable." This is the fix for the silent-outage problem in 1.7.
- Sources: gh-aw "Metrics & Analytics", "Tool & Infrastructure", "Testing & Validation".

### 1.10 Independent check: what happens to these PRs across GitHub

`gh search prs "<title marker>" in:title`, 2026-10-23. Results are capped at 1,000 per query. Personal repos where the owner merges everything inflate the merge counts.

| Title marker | merged | closed | open | Note |
|---|---|---|---|---|
| "Daily Test Coverage Improver" | 243 | 68 | 63 | older name |
| "[test-improver]" | 290 | 45 | 665 | capped at 1,000; most are waiting |
| "Daily Perf Improver" | 186 | 69 | 32 | Z3 alone: 2 merged, 18 closed |
| "[perf-improver]" | 687 | 66 | 247 | capped; skewed by repos that merge everything |
| "[repo-assist]" | 168 | 38 | 794 | capped; draft PRs pile up |
| "[code-simplifier]" | 810 | 108 | 82 | capped |
| "Daily Backlog Burner" | 26 | 8 | 0 | |

Which repos the PRs come from (same queries, top repos by count):

- The bracket-prefixed names are spread widely: `[perf-improver]` across 780 repos, `[test-improver]` across 683. Many of them are demo or fork repos where every PR stays open (for example 30/30 open in one dashboard fork, 15/15 open in kubeedge).
- The older "Daily ..." names cover about 35 repos each, and GitHub Next's own trial repos inflate them (for example `gh-aw-trial-hono`: 35/35 merged).
- Real projects disagree:
  - perf PRs: pola-rs/polars merged 9 of 10, react-hook-form 5 of 9, Z3 2 of 20;
  - test PRs: schemathesis merged 13 of 14, FSharp.Data 22 of 26, Z3 8 of 17.

Takeaways:

- When a person acts on these PRs, they are often merged.
- Value depends on the repo. The perf job does well where a benchmark suite exists and there is still easy performance to win (polars). It fails on code that is already highly tuned (Z3).
- The large open counts for the newer, broader assistants (`[repo-assist]`, `[test-improver]`) show the real failure: the PRs are not wrong, they are simply never reviewed.
- Mature, performance-sensitive code (Z3) rejects agent optimizations almost entirely.

---

## 2. One-off quota-burn patterns

These patterns turn a large token budget into something useful in one go. All of them follow the same shape:

1. fan out over many independent targets;
2. let each agent run long;
3. check every result against something objective (a test, a reproduction, a sandbox, a second agent);
4. hand a human a ranked queue, not a pile.

### 2.1 Whole-backlog research fan-out
- Example: Next.js "closability". One agent per open issue, in a fresh sandbox, with maximum reasoning effort. Each investigation took about 30 minutes. Concurrency rose slowly to 200 sessions at once.
- Output: structured verdicts in a close queue. A maintainer read the evidence behind every result.
- Result: 1,462 issues closed in about 3 weeks; the backlog went from 2,244 to under 1,000. "Most reviews came down to reading the summary and checking the sources the agent had already gathered."
- After the one-off pass, it continues as a weekly job capped at 100 issues.
- Why it fits quota burn: each task is independent, long and read-only, and its output is cheap to review.
- Source: Next.js blog.

### 2.2 Security hunt, many samples per target, then validate
- Heelan (o3, Linux ksmbd):
  - 100 runs on a ~3.3k-line slice found the known bug 8 times, with 28 false positives and 66 empty answers;
  - on a ~12k-line slice, the hit rate fell to 1 in 100, but another run found a new bug (CVE-2025-37899);
  - signal to noise about 1:50; about $116 for 100 runs of ~100k tokens;
  - "if you have [a verifier] then it doesn't matter if the LLM generates 99% nonsense".
- Anthropic Frontier Red Team (Opus 4.6): 500+ validated high-severity bugs in heavily fuzzed open-source code.
  - It focused on memory bugs, because a crash under a sanitizer is easy to verify.
  - It mined git history for fixes that were not applied to every caller.
  - It used the model to deduplicate and re-rank crashes, and humans validated every finding.
- curl: 809 reports from AI tools (ZeroPath, Aisle) led to about 15% confirmed problems, all fixed. Daniel Stenberg called ZeroPath "intimidatingly good".
- How to run it on your own repo:
  1. split the code by module or entry point;
  2. run N samples per slice;
  3. require a proof (failing test, sanitizer crash, or a reproduction in a sandbox);
  4. have a separate agent dedupe and score the findings;
  5. a human reads the top of the list.
- Sources: sean.heelan.io; Anthropic "zero-days"; Simon Willison on curl; Daniel Stenberg's weekly update.

### 2.3 Property-based testing sweep
- Example: a Claude Code prompt that infers properties from code and docs, writes Hypothesis tests, runs them, reflects on the results, and writes bug reports.
- Results:
  - 100+ Python packages, 984 reports;
  - of 50 reviewed by hand, 56% were real bugs and 32% worth reporting;
  - with a 15-point self-scoring rubric, the top-ranked reports were 86% real and 81% worth reporting;
  - 3 of 5 reported patches merged (numpy, aws-lambda-powertools, tokenizers).
- Lesson: ranking with a rubric turns a 56% pile into an 86% shortlist.
- Source: Anthropic "property-based testing"; arXiv 2510.09907.

### 2.4 Fuzz harness generation
- Example: OSS-Fuzz-gen writes fuzz targets for functions no fuzzer reaches yet.
- Results: coverage gains in 272 C/C++ projects, 370k+ new lines covered, 26 new vulnerabilities including CVE-2024-9143 in OpenSSL (about 20 years old). The best single project went from 77 to 5,434 covered lines.
- Fit for Hercule: weaker (TypeScript, not C). The general idea still applies: have agents write property or fuzz harnesses for parsers, such as YAML workflow plans and Effect Schema decoders.
- Source: Google Security Blog 2024-11.

### 2.5 Test-a-thon: mutation-guided test hardening
- Example: Meta ACH and TestGen-LLM ran as time-boxed "test-a-thons", one sweep over chosen classes. 73% of tests accepted in both.
- Pattern:
  1. pick the modules that matter most;
  2. generate realistic mutants for a stated concern;
  3. discard equivalent ones;
  4. write the tests that kill the rest;
  5. keep only tests that build, pass reliably, and kill a mutant.
- Source: arXiv 2501.12862; arXiv 2402.09171.

### 2.6 Large migration in slices with brute-force retries
- Airbnb: 3,500 Enzyme test files moved to React Testing Library in 6 weeks, against an estimate of 1.5 years by hand.
  - Pipeline per file: rewrite, then fix test errors, then lint, then type-check, with retries up to a limit. "Retries beat prompt engineering."
  - 75% of files done in 4 hours; 97% after 4 days; the last 3% by hand in a week.
- Google: in landed migration changes, 80% of the code was written by AI, saving about 50% of the time. Review, not generation, became the bottleneck. LLMs alone were not enough: they had to be combined with AST tools.
- Spotify Honk: 1,000 merged PRs in about 10 days (it had taken 3 months, half a year earlier).
  - Early agents cheated: they commented out tests and downgraded Java versions.
  - An LLM judge vetoed about 25% of changes, then was removed as too rigid.
  - PRs are opened only after full verification.
- Sources: Airbnb tech blog; InfoQ; Pragmatic Engineer; arXiv 2501.06972; Spotify Engineering; InfoQ 2026-03.

### 2.7 Parallel agent team on one big goal, with an oracle
- Anthropic's C compiler:
  - 16 agents, about 2,000 sessions over 2 weeks;
  - ~2B input and 140M output tokens, just under $20k;
  - result: a 100k-line Rust compiler that builds Linux 6.9.
- Coordination:
  - each agent claims a task by writing a lock file in `current_tasks/`, synced through git;
  - there is no orchestrator;
  - for the kernel, GCC served as a known-good oracle: compile most files with GCC and the rest with the new compiler, to find which file breaks.
- Lessons:
  - "the task verifier [must be] nearly perfect, otherwise Claude will solve the wrong problem";
  - keep test output short and grep-friendly;
  - offer a `--fast` 1-10% sample of the tests;
  - many readers and writers are fine, but only one agent at a time runs build and test.
- Cursor FastRender: hundreds of agents for about a week with a planner, workers and a judge; 1M+ lines; "trillions of tokens".
- Sources: Anthropic Engineering "building-c-compiler"; Simon Willison on Cursor.

### 2.8 Best-of-N with a judge
- Examples:
  - Codex Cloud `--attempts 2-4` runs separate containers;
  - Cursor 2.2 "multi-agent judging" picks a winner and explains why;
  - the Bernstein tool scores tests, lint and diff size, plus an LLM judge.
- Caveat: "best-of-N does not replace verification - it picks a candidate to verify". Use a fixed acceptance test written before the attempts start.
- Good targets: hard bugs with a reproducing test; risky refactors with a full test suite.
- Sources: codex.danielvaughan.com; Cursor forum; Bernstein docs.

### 2.9 Overnight loop on a greenfield component (Ralph)
- What: `while :; do cat PROMPT.md | claude ; done`. Each loop starts with fresh context, does the one most important item from `fix_plan.md`, uses tests and type checks as backpressure, and commits when green.
- Good for greenfield work. Its author would not use it on an existing codebase. Expect to wake up to breakage now and then.
- Source: ghuntley.com/ralph.

### 2.10 Async research questions
- What: write down open technical questions ("is X possible", "which library is fastest", "what breaks if we upgrade Y"). Send each to an async agent in a separate research repo with full network access. Each returns code, benchmarks and a report.
- Simon Willison runs 2-3 of these a day. He calls the unreviewed output "slop" and keeps it in its own repo, but values what it proves: working code shows something is possible.
- Fit for Hercule: run open items from `docs/spec/16-open-items.md` as experiments.
- Source: simonwillison.net 2025-11-06.

### 2.11 Exhaustive spec-vs-code conformance audit (inferred pattern)
- What: one agent per spec section or ADR. Each lists the normative statements, finds the code that implements each one, and reports matches, gaps and contradictions with file and line evidence. A second pass checks every reported gap.
- Evidence: no published end-to-end study. The parts are proven:
  - the schema consistency checker (55 reports, "caught drift that would have taken us days");
  - the glossary maintainer (10/10);
  - Codocia and docsync (tools that link docs to code and detect when the code changes).
- The output should be issues grouped per spec document, never one PR.

### 2.12 Test-suite gap and quality audit (inferred from parts)
- What: one agent per package reports untested public behavior, tests that pin implementation details, and duplicate or happy-path-only tests. The criteria are those of the Test Quality Sentinel, and Hercule's own `test-audit` skill covers similar ground. The ranked list then feeds a test-a-thon (2.5).

---

## 3. Guardrails that keep scheduled agents from producing noise

Ordered by how often a working job relied on them in the sources.

1. **Cap the backlog, not just the run.**
   - A pre-check counts the job's own open PRs and skips the run at a limit (8 in the agentics test, perf and repo-assist workflows).
   - Or `skip-if-match` an open item with the job's prefix, so only one is open at a time.
   - Per-run caps (`max: 1` issue, `max: 3`, `max: 4` PRs) are not enough on their own: the open-PR counts in 1.10 show what happens without a backlog cap.
2. **One thing per run.** One fix (Ona), one largest file, one issue a day (Backlog Burner), one item per loop (Ralph), one issue at a time to the coding agent (Issue Monster). Small PRs are "trivial to verify and safe to approve immediately".
3. **Let unreviewed output expire.** Issues and PRs expire after 1-2 days (`expires: 1d|2d`), or the job closes its own older items before filing new ones (`close-older-issues`, the `[refactor]` closer). That stops stale findings from collecting.
4. **Stable title prefix and labels per job.** These drive dedup (search by prefix), cleanup, and the per-job merge-rate tracking that gh-aw uses to decide which jobs to keep.
5. **Memory of what was already handled.**
   - A cursor plus a list of handled items in repo memory (test-improver, repo-assist with a JSON schema validated each run).
   - Devin's notes, so release notes and digests never repeat.
   - Next.js discards saved research when an issue gets new activity.
   - Always check memory against the live repo state.
6. **Look only at what changed.** The last 24 hours of commits (architecture guardian), recently modified code (simplifier), or changed files only (duplicate detector). This keeps runs cheap, around 7k tokens.
7. **The agent is read-only; writes go through an allowlist.** Fixed label lists, `max` per output type, protected files fall back to an issue, draft PRs only, and the agent never merges. Elastic forces auto-merge off for any AI-touched PR.
8. **Report first, PR second, for anything subjective.** Style, refactor and type work goes to a discussion or issue, then a coding agent picks it up. Terminal Stylist and Typist never open PRs themselves.
9. **Verify before speaking.**
   - Build, test and lint must pass before a PR is opened (Spotify opens one only after full validation).
   - Ban the known cheats: no commenting out tests, no downgrades, no editing tests to force a pass.
   - For flaky fixes, rerun the test many times.
   - For security, require a reproduction.
10. **A second opinion that argues the other side.**
    - Next.js: a second agent looks for reasons to keep an issue open before any auto-close.
    - Claude Code Security: tries to disprove its own findings.
    - Property-based testing: a scoring rubric takes 56% real bugs to 86%.
    - Spotify: an LLM judge vetoed 25% of changes. They removed it later as too rigid, so a judge needs tuning too.
11. **Explicit noop and "could not finish".**
    - A quiet day is recorded as a noop, not silence.
    - A run that cannot finish says so instead of posting a half-baked verdict.
    - A meta-agent or health check notices when a job stops producing output. Anthropic's dedupe bot was silent for ~2 months without anyone noticing.
12. **Cost and time limits.** Timeouts (5-60 minutes), a daily credit cap, a stop after 3 permission denials, and per-run cost tracking. An analysis agent found agents that were "way too chatty".
13. **An easy undo.** A reopen window or Action for anything closed automatically, and a weekly cap on automatic closes (25 a week at Next.js).
14. **Guard against prompt injection.** Ignore instructions found in issue or repo text. By default, read only issues from maintainers (gh-aw integrity filter). Treat trigger payloads as untrusted (Claude Code scheduled tasks wrap them in `<routine-fire-payload>`).
15. **Plan for review capacity, not generation.** Every large deployment hit this limit: Google, Spotify, Simon Willison, and the 665-794 open agent PRs in 1.10.
    - Spotify's fixes: a PR inbox, auto-merge for docs PRs, migration owners approving their own PRs.
    - The general rule: schedule only as much output as people actually review, and measure the merge rate per job.

What this suggests for Hercule (inference, not from a source):

- Hercule's Task and Proposal triage is the natural place for these outputs. A scheduled job that files a Proposal, rather than a PR, is the "report first" pattern.
- These guardrails map to workflow features: a per-workflow cap on open output, a skip condition, expiry, a title prefix or label, a memory store, and an explicit noop.

---

## 4. Sources with URLs

GitHub Next / gh-aw
- githubnext/agentics sample list: https://github.com/githubnext/agentics
- agentics workflow sources (frontmatter quoted above): https://github.com/githubnext/agentics/tree/main/workflows (test-improver.md, perf-improver.md, repo-assist.md, code-simplifier.md, large-file-simplifier.md, duplicate-code-detector.md, ci-doctor.md, issue-triage.md, repo-status.md, update-docs.md)
- Welcome to Peli's Agent Factory: https://github.github.com/gh-aw/blog/2026-01-12-welcome-to-pelis-agent-factory/
- Meet the Workflows: Simple Triage: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows/
- Continuous Simplicity: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-continuous-simplicity/
- Continuous Refactoring: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-continuous-refactoring/
- Continuous Style: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-continuous-style/
- Continuous Improvement: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-continuous-improvement/
- Continuous Documentation: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-documentation/
- Issue & PR Management: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-issue-management/
- Fault Investigation: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-quality-hygiene/
- Metrics & Analytics: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-metrics-analytics/
- Operations & Release: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-operations-release/
- Security-related: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-security-compliance/
- Testing & Validation: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-testing-validation/
- Tool & Infrastructure: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-tool-infrastructure/
- Multi-Phase Improvers: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-multi-phase/
- Project Coordination: https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-campaigns/
- Agent of the Day, Architecture Guardian (noop lesson): https://github.github.com/gh-aw/blog/2026-10-22-agent-of-the-day/
- Agent of the Day, Test Quality Sentinel: https://github.github.com/gh-aw/blog/2026-10-21-agent-of-the-day/
- Safe outputs reference: https://github.github.com/gh-aw/reference/safe-outputs/
- GitHub blog, Automate repository tasks with agentic workflows: https://github.blog/ai-and-ml/automate-repository-tasks-with-github-agentic-workflows/
- Introducing Continuous AI: https://githubnext.com/posts/dsyme-introducing-continuous-ai/
- Repo Assist: https://githubnext.com/posts/dsyme-repo-assist-repository-assistant/
- Z3 Daily Perf Improver PRs (example closed one): https://github.com/Z3Prover/z3/pull/7892 ; enabling PR: https://github.com/Z3Prover/z3/pull/7871

Vendors' scheduled agents
- Claude Code scheduled tasks (routines): https://code.claude.com/docs/en/routines
- Google Jules scheduled tasks: https://jules.google/docs/scheduled-tasks/
- Google blog, Jules proactive updates (Stitch pod): https://blog.google/technology/developers/jules-proactive-updates/
- OpenAI Codex automations: https://openai.com/academy/codex-automations
- Devin can now schedule Devins: https://cognition.com/blog/devin-can-now-schedule-devins
- Devin scheduled sessions docs: https://docs.devin.ai/product-guides/scheduled-sessions
- Cursor Bugbot, building a better Bugbot: https://forum.cursor.com/t/building-a-better-bugbot/149040
- Cursor multi-agent judging: https://forum.cursor.com/t/cursor-2-2-multi-agent-judging/145826
- Codex cloud best-of-N write-up: https://codex.danielvaughan.com/2026/04/01/codex-cloud-exec-best-of-n-attempts/

Industry case studies
- Next.js, How we closed 1,500 GitHub issues: https://nextjs.org/blog/how-we-closed-1500-github-issues
- Elastic, self-correcting monorepos: https://www.elastic.co/search-labs/blog/ci-pipelines-claude-ai-agent
- Ona, Knip automation: https://ona.com/stories/knip-automation
- Spotify Honk part 1: https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1
- Spotify Honk at QCon (InfoQ): https://infoq.com/news/2026/03/spotify-honk-rewrite
- Airbnb LLM test migration: https://www.infoq.com/news/2025/03/airbnb-llm-test-migration/ and https://newsletter.pragmaticengineer.com/p/the-pulse-we-need-to-talk-about-migrations-b3d
- Google, AI for internal code migrations: https://arxiv.org/html/2501.06972v1
- Meta capacity efficiency agents: https://engineering.fb.com/2026/04/16/developer-tools/capacity-efficiency-at-meta-how-unified-ai-agents-optimize-performance-at-hyperscale/
- Uber Piranha: https://www.uber.com/blog/piranha/
- Renovate plus agent pipeline guide: https://visdom-maturity-matrix.virtuslab.com/guides/organization/library-bumps-version-upgrades-auto
- Anthropic claude-code bot outage investigation: https://dev.to/fruitriin/anthropic-may-have-forgotten-to-read-their-github-issues-for-two-months-1iim

Security research
- Anthropic, zero-days with Opus 4.6: https://www.anthropic.com/research/zero-days
- Anthropic, Claude Code Security: https://www.anthropic.com/news/claude-code-security
- anthropics/claude-code-security-review: https://github.com/anthropics/claude-code-security-review
- Sean Heelan, o3 and CVE-2025-37899: https://sean.heelan.io/2025/05/22/how-i-used-o3-to-find-cve-2025-37899-a-remote-zeroday-vulnerability-in-the-linux-kernels-smb-implementation/
- Google Project Zero, From Naptime to Big Sleep: https://projectzero.google/2024/10/from-naptime-to-big-sleep.html
- OpenAI, Introducing Aardvark (now Codex Security): https://openai.com/index/introducing-aardvark
- Google DeepMind CodeMender coverage: https://thehackernews.com/2025/10/googles-new-ai-doesnt-just-find.html
- Simon Willison on curl and AI findings: https://simonwillison.net/2025/Oct/2/curl/
- Daniel Stenberg weekly, 809 reports, ~15% confirmed: https://lists.haxx.se/pipermail/daniel/2025-October/000130.html
- Google OSS-Fuzz-gen results: https://security.googleblog.com/2024/11/leveling-up-fuzzing-finding-more.html

Testing research
- Meta ACH, mutation-guided test generation: https://arxiv.org/html/2501.12862v1
- Meta TestGen-LLM: https://arxiv.org/abs/2402.09171v1
- Anthropic, agentic property-based testing: https://www.anthropic.com/research/property-based-testing and https://arxiv.org/pdf/2510.09907
- Google, agentic bug reproduction: https://arxiv.org/html/2502.01821v2
- AssertFlip: https://arxiv.org/html/2507.17542v2
- FlakyFix: https://arxiv.org/html/2307.00012v3
- Agent action bias (when not to act): https://www.alphaxiv.org/abs/2605.07769

Agent PR acceptance studies
- Task-stratified acceptance of 7,156 agent PRs: https://arxiv.org/html/2602.08915v1
- Task-level evaluation of agents in OSS: https://arxiv.org/html/2602.02345v1

Large autonomous runs and patterns
- Anthropic, building a C compiler with parallel Claudes: https://www.anthropic.com/engineering/building-c-compiler
- Simon Willison on Cursor's scaling agents: https://simonwillison.net/2026/jan/19/scaling-long-running-autonomous-coding
- Cursor, scaling agents: https://cursor.com/blog/scaling-agents
- Geoffrey Huntley, Ralph: https://ghuntley.com/ralph/
- Simon Willison, async code research: https://simonwillison.net/2025/Nov/6/async-code-research/
- Simon Willison, parallel coding agents: https://simonwillison.net/2025/Oct/5/parallel-coding-agents/
- NVIDIA NemoClaw verify-stale skill: https://mcpservers.org/agent-skills/nvidia/nemoclaw-maintainer-verify-stale
- GitHub Models maintainer survey (triage demand): https://github.blog/open-source/maintainers/how-github-models-can-help-open-source-maintainers-focus-on-what-matters/
