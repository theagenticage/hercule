# Hercule on GitHub, 2026-10-09 to 2026-10-23: patterns for nightly automation

Repository: `theagenticage/hercule`. Data pulled with `gh` (REST and GraphQL) on 2026-10-23, plus `git log` on `origin/main`, the spec tree, and the repository wiki (`hercule wiki-page`). Read-only; nothing on GitHub was changed.

**Caveats about the data**

- **CI history is partial.** The Actions API has no runs between 2026-10-01 20:18 and 2026-10-16 22:16 UTC, although PR bodies from that time talk about CI failures (for example #578 on 10-12). The runs were probably deleted. The CI numbers below cover **2026-10-16 22:16 to 2026-10-23** only.
- **Job logs expire fast.** Job logs older than about 2 days return HTTP 410. The repository caps retention at 3 days ("Retention days cannot be greater than the maximum allowed retention set within the repository. Using 3 instead."). I took failing test names from check-run **annotations**, which do not expire.
- **No review happens on GitHub.** Across 128 PRs there are **0 review objects and 0 inline review threads**. Reviews run inside agent sessions: Opus reviewers on fixed axes, plus GPT-6.1 Sol as the adversarial reviewer. Their findings are recorded in the "Review" section of each PR body: 58 PRs have one, and 91 bodies mention Sol or adversarial review. Section 3 is built from those bodies, from 18 PR comments, and from in-PR fix commits.
- **One login does everything.** Every PR and issue is authored by the `rogierpennink` account (agents use it), so authorship cannot tell Rogier apart from agents. Rogier's own voice shows up as "Rogier decided / chose / paused" lines, as scoped review instructions, and in the bugs he files after using the app.

---

## 1. Volume and shape of work

### PR counts

| | Count |
|---|---|
| PRs created 10-09..10-23 | **125** |
| Merged | 119 |
| Closed without merge | 5 |
| Open | 1 (#712) |
| Also merged in the window but created 10-08 | 3 (#483, #499, #501) |

- **Merged per day:** 2, 10, 17, **18** (10-12), 11, 9, 7, 1, 7, 9, 8, 9, 2, 5, 4.
- **On `main`:** 118 merges, 946 non-merge commits, and **+359,234 / -22,370 lines over 2,320 files** in two weeks.

### Kinds of PR (by title)

| Kind | PRs | Median lines added |
|---|---|---|
| Feature (feat, feature slice) | **80** | **3,298** |
| Docs / spec amendment / ADR | 13 | 303 |
| Fix | 13 | 139 |
| CI / build / tooling | 8 | 70 |
| Test / de-flake | 7 | 58 |
| Perf | 3 | 175 |
| Prototype (throwaway, closed) | 1 | 2,135 |

Spec amendment is not really a separate kind of PR: **96 of 125 PRs (77%) touch `docs/spec`**, and 22 touch the glossary (`CONTEXT.md`, now `GLOSSARY.md`). Boyscouting appears as a "Boyscouting" section in 15 PR bodies, mostly flaky-test fixes found on the way.

### Size (merged PRs, additions + deletions)

| Bucket | PRs |
|---|---|
| < 100 lines | 21 |
| 100-999 | 32 |
| 1k-4.9k | 37 |
| 5k-9.9k | 19 |
| >= 10k | **10** |

- **Lines changed:** median **1,308**, p75 4,750, p90 9,567, max 21,806 (#653, the Android landing).
- **Files:** median 24 per PR; 18 PRs touch 100 or more files.
- **The biggest ones:** #653 Android (21.8k lines), #759 Android markdown (18.8k), #547 Intake (14.5k), #568 desktop workflow (13.7k), #757 Skill Library (13.0k), #815 Tracking slice 1 (13.1k), #837 sidebar groups (15.3k).

### Time open (created to merged)

- Median **1.4 h**, p75 4.2 h, p90 7.7 h, max 37.8 h.
- 49 PRs merged in under 1 h, and 83 in under 3 h.
- PRs of 5k lines or more merged after a median of 2.3 h.
- Agents run all their review rounds before they open the PR. So "time open" is mostly how long Rogier takes to merge, not review time.

### Commits and review rounds

- **Commits per PR:** median 4, max 53 (#547).
- **Half of all commits are rework.** Of 1,148 non-merge commits in merged PRs, **575 (50%)** are `fix(...)`, `test(...)` or "review" commits. Example: #547 has 31 such commits out of 53.
- **Adversarial rounds per PR**, as stated in the PR bodies:

| PR | Rounds |
|---|---|
| #653 | **12** |
| #777 | 8 |
| #815 | 7 |
| #558, #566, #710 | 6 |
| #619, #757, #750 | 5 |
| #565, #574, #627, #784, #816 | 4 |

### Areas touched (PRs touching each top-level area)

| Area | PRs |
|---|---|
| docs/spec | 96 |
| apps/desktop | 84 |
| apps/controller | 67 |
| packages/client-core | 54 |
| packages/contract | 38 |
| e2e | 38 |
| apps/runner | 29 |
| apps/web | 27 |
| CONTEXT.md | 22 |
| docs/design | 20 |
| docs/adr | 18 |
| packages/cli | 17 |
| packages/protocol | 12 |
| apps/android | 6 (but 541 file touches) |

### The work pattern

Work comes in **themed bursts**. For each theme, a spec and ADR PR comes first, then 4-7 slice tickets are built in parallel, often on the same day the tickets were filed:

| Theme | Spec / design | Slices |
|---|---|---|
| Intake | #523 (spec) | #524-#529 filed 10-10, all closed 10-11 |
| Desktop Workflows | #548 | #549-#553 in one day |
| Agent coordination | #679 (spec 19) | #685, #694, #695, #696 |
| Skills | #748 | #731-#735 filed 10-17, closed 10-18 |
| Composer skills | #771 (prototype) | #766-#769 |
| Tracking | #814 (pixel reference) | #801-#805 over 3 days |
| Pieces of work | - | #826-#828 |

Desktop is where most of the effort goes; the web app gets mostly removals (#537) and parity fixes.

---

## 2. Rework and regressions

### Fix PRs against work merged days before

Most of these come from Rogier using the app: they are UI and behaviour bugs, not test failures.

| Merged feature | Follow-up issue and PR | Gap |
|---|---|---|
| #574 GitHub checks signals (10-11) | #609 "a commit with many check suites fails the whole poll and sets the Connection to error", fixed by #610 | 1 day |
| #578 Sentry plugin (10-12) | #634 "real name instead of user id, Archive label that fits", fixed by #635 | 1 day |
| #547 / #557 Intake, #566 markdown (10-11) | #714 "unreadable key on the Reply button, and HTML in GitHub comments shows as source", fixed by #715 (4k lines; 3 inputs froze the renderer for 16-19 s); #779 "text in the Intake detail pane cannot be selected", fixed by #780 | 5-8 days |
| #707 Office every session (10-15) | #717, fixed by #719 (three adversarial rounds); #729, fixed by #730 | 2 days |
| #695 Edit Overlaps (10-15), #710 shell edits (10-17 11:57) | #720, fixed by #721 (10-17); #724, fixed by #728 (10-17, the **same day**); #744, #745, #716, #725, #726, #727 filed | 0-2 days |
| #710 (6 adversarial rounds) | **#749 / #750 reverses part of it the next day**: "The Codex and pi gates blocked the tool call ... It came in during #708's review round 5, when an AI reviewer raised 'gates failing open', and it went in without Rogier's approval. It also contradicted spec 19's own 'Advisory only'." Net -340 lines | 1 day |
| #776 Tiptap composer, #784 composer skills (10-19) | #819 "composer choices stick: one choice, one resolver" (2.9k lines). It redesigned how the composer holds choices because "changing the model reset effort / thinking / fast mode" | 3 days |
| #545 Permission Requests (10-10 23:53) | #563 "test(permissions): wait for the decision's input before the exit": a new test flaked within 14 h | 0.5 day |
| #501 desktop permission profiles (10-09) | #541 "a profile row's hairline stays straight at its rounded ends" | 1 day |
| Desktop thread rendering | Perf bugs found after landing: #778, #783, #785, #792, fixed by #781, #787, #788, #795; #782 and #790 still open | - |

**The Edit Overlaps cluster (10-15 to 10-18) is the clearest example of rework.**

- 5 PRs: #695, #710, #721, #728, #750.
- 11 issues: #708, #716, #720, #724, #725, #726, #727, #744, #745, #749, plus spec PR #746.
- About 10k lines landed. Then an AGENTS.md exception was added ("the edit watch of spec 19 §4.1 is best effort").

### PRs closed without merge (5)

| PR | Why it was closed |
|---|---|
| #697, #698, #700 | Three duplicates of #699, all opened within 6 minutes on 10-15 for a 12-line sidebar row ("Duplicate of #699, which has the same change plus the spec 17 amendment"). Either best-of-N on purpose, or a fan-out that went wrong |
| #518 | "Folded into #520, which ships the backend and both clients" |
| #771 | A throwaway prototype for sign-off (expected) |

### Stranded work

**#712** (assistant rotation, heartbeats and reminders, closes #94, the original v1 ticket from 09-02) has been open since 10-15 with 11,259 lines. It is `CONFLICTING`, `test-node (2)` and `(3)` failed on 10-16 ("the controller never moved the session"), and it has not been touched since 10-16.

### Merge-order friction between parallel PRs

- 30 merged PRs contain merge-from-main commits.
- Migration-number collisions had to be renumbered by hand. #557 and #558: "this PR's `0066-signal-snoozes` needs a new number; #558 ... will move to the next free number". Also #685 and #694, and #499 ("promotion is migration 0058; runner protocol is v6").
- The shared barrel and hotspot files that every slice edits are in section 6.

---

## 3. Recurring review findings

### Who reviews

| Reviewer | How |
|---|---|
| Opus lanes | Fixed axes: "code quality, naming and API surface; maintainability and robustness; security and performance", sometimes "UI fidelity" |
| GPT-6.1 Sol | Adversarial, "high effort, full access, read-only". Started with `hercule session spawn --instance <codex> --model gpt-6.1-sol` (wiki `tracking-pane-lessons`). Sol proves its findings with reproductions and probes, and re-checks the fixes |
| Architecture round | Later PRs (#760, #772, #777, #808, #815, #816, #818, #822, #836, #837) add one Sol round on architecture, which usually deletes code |
| Rogier | Does not review on GitHub. He scopes the work, decides, and reverses things after the fact (below) |

### Finding types

Counts are the number of PRs among the 58 with a Review section whose findings fall into each type. "Naming" is left out of the table: it is a fixed review axis, so a keyword count says nothing.

**1. Races, ordering and stale reads: 23 PRs.** This is the most common real defect, and it is mostly client-side code built on TanStack Query and live pushes.

- #568 "P1: a race between a save and the next read"
- #569 "a read that started before a save could revert it"
- #579 "the race between an action and a live read"
- #632 "Done/Undo ordering race"
- #816 "Five race and staleness defects in the client protocol"
- #822 "pushes lost during the first read"
- #837 "a toast race that could lose a newer Undo"
- #574, server side: "Same-second order ... Same-second close"
- Three wiki pages exist only for this class: `derived-shell-reads-and-query-races`, `desktop-thread-copies`, `try-again-lock-in-mutation-cache` ("Plan for several rounds when the bug class is 'state that must outlive a component'").

**2. Test quality: 23 PRs.** Tests that prove nothing, or that test a copy of the code instead of the code:

- #556 "the EXPLAIN tests ran a copy of the SQL"
- #730 "The plan test checked a copy of the SQL, not the repository's query"
- #507 "only compared two states that were identical even with the stylesheet rule broken"
- #760 "the resume e2e could pass on a failed turn"
- #712 "stopped importing expected values from the code under test"
- #707 "A test audit then removed six duplicate tests and three test-only exports"
- On the agent-written review posted from Rogier's account on #483: "Comparing empty session lists cannot detect session loss."

**3. Performance: 22 PRs.** Extra reads, re-renders, quadratic parsers, slow SQL:

- #520 "a busy sender re-read about once a second"
- #564 "walked a busy workflow's whole history (217 ms on 100k runs). It now takes 0.12 ms"
- #566 "a quadratic regex in our own code (an HTML block of 200k newlines took 13 s)"
- #694 "the revision list was reading every body ... about 32x faster"
- #715 "Three inputs that froze the renderer for 16 to 19 seconds at 200 KB"
- #764 "a hostile revision could stall the controller in `skill.diff` (22.9 s, now 0.36 s)"
- #816 "O(signals x Tasks x entries) matching"

**4. Spec drift: 18 PRs.** The code and the spec disagree, or the spec states something false:

- #719 "The spec, a docstring and the perf fixture said Threads are idle-unloaded after 15 minutes. They are not"
- #750: a reviewer-driven change "contradicted spec 19's own 'Advisory only'"
- Nearly every PR amends a spec section "where #N built differently" (#547: "docs(spec): amend specs 05, 10 and 11 where #524 built differently").

**5. Security: 18 PRs.**

- #574 terminal escape sequences (OSC, DCS) in check logs
- #619 fields named `__proto__` or `constructor` read inherited values
- #565 "Harness error output (stderr) could reach a persisted failure message, and with it a credential"
- #777 "a symlink escape to the user's skills"
- #815 "a raiser could bind `signal.handOff` aimed at another signal"

**6. Architecture rework, usually a net deletion: 16 PRs.**

- #816: Your work moved to a server read and "deleted about 1,100 lines"
- #808: "sync logic spread over seven places ... cut the net production lines from 1,269 to 1,078"
- #730: "+463 to +333 lines"
- #837 (wiki): "removed ~280 production and ~1150 test lines with byte-identical output"
- #822: "Lesson: don't trade a transient disagreement between two live reads for a permanent omission"

**7. Unbounded input, size and limits: 15 PRs.**

- #568 "`daysBack` had no upper bound"
- #815 "an unbounded GET and run history read on every push", "an unbounded sheet DOM"
- #764 "a 400,000-line patch mounted 400k elements"
- #777 "answers over the 2 MiB frame limit"
- Wiki: "an uncut label made a 'bounded' reply 1.2 MB"

**8. Silent failure: 11 PRs.**

- #573 "a failed next page retried silently, forever" (the same class is still open as #763)
- #760 "invisible refusals"
- #764 "a failed archive write left no visible error"
- #822 "a fallback read whose error was ignored"
- #837 "an old `thread` filter silently returning everything"

**9. Focus and keyboard: 8 PRs.**

- #815 "six focus edge cases"
- #822 "focus loss when the trip disappears"
- #837 "focus loss after a keyboard Done"

**10. Transactions and atomicity: 7 PRs.**

- #556 "The two reads in `list` could see different moments"
- #691 "a caller interrupted just as the runner answered could leave the call without its audit record"
- #772 "`rebuildPreparationInstruction` wrote outside a transaction"

**11. Missing cost measurement (ADR 0037): 3 PRs in their Review sections, 29 PR bodies overall.**

- #579 "the costs were not measured"
- #707 "missing performance measurements"
- #719 "P2: `pnpm test:desktop` was not run ... P2: bundle sizes not measured"

### What Rogier does

**He bounds scope.** From #483: "the scope should stay bounded ... Do not turn this into a matrix of session states ... Keep the added CI work within one minute."

**He enforces the rules in AGENTS.md and the ADRs.** From the #499 review, posted from his account:

- "[P1] Stream the transfer ... violates AGENTS.md's 'don't hold what you can stream'"
- "[P2] Move expiry scheduling into the controller daemon ... ADR 0033"

**He makes design decisions mid-review.** "Rogier's decisions after review" (#748), "Rogier chose macOS over re-recording on Linux" (#702), "Rogier accepted the miss" on a budget (#757), "Rogier deferred ..." (#836).

**He reverses AI-reviewer overreach.** #750 is the example above.

**He pauses expensive loops.** "Rogier paused desktop perf runs on 2026-10-21 until the perf script is made much faster" (#816, #817; issue #786).

**He reports bugs from hands-on use.** #714, #717, #720, #724, #779, #792, #810, plus the composer behaviour fixed in #819.

### Diminishing returns in long adversarial loops

- #566: "Rounds 3 to 6 found narrower and narrower cases in the footnote reader ... The last two fixes, from round 6, have not had another adversarial pass."
- #653: 12 rounds.
- #777: 8 rounds.

---

## 4. CI health and flakiness (2026-10-16 22:16 to 2026-10-23)

### Workflows

| Workflow | Runs | Result |
|---|---|---|
| CI | 141 (101 PR, 40 main) | see below |
| Build | 101 | 100 success, 1 cancelled |
| Claude Code (`@claude` mentions) | 116 | **all skipped**; the trigger is never used |

### Speed

- PR CI wall clock: median **5.5 min**, p90 8.2 min.
- Slowest jobs (median): android 5.0 min (macOS), desktop 4.8 min (macOS), test-react 2.9 min (3 shards).
- The speed work (#596, #598, #600, #602, #604, #608, #612 on 10-12) cut "about 20 minutes" to this.

### Main is effectively green

- 41 attempts. 4 failed, **all on flaky tests**: 10-18 17:47, 10-18 22:28, 10-19 14:26 (passed on re-run), 10-20 08:45.
- No real breakage reached `main`.

### Failure rate per job

| Job | Main | PRs |
|---|---|---|
| typecheck, lint, check (dep-lint), upgrade, edge-linux, edge-build, edge-publish | 0 failures | 0 failures |
| test-node (3 shards) | 4/123 | 11/318 |
| test-react (3 shards) | 0/123 | 4/318 |
| desktop (`compare:bureau`) | 0/41 | **5/106, all real pixel regressions** (799 to 1,659 px differ; #784, #815 x2, #816, #824) |
| android | 0/41 | 1/106 (passed on re-run) |

16 of 101 PR runs failed, on 11 of 42 branches.

### Of the 25 failed jobs, 12 were flaky and 13 were real

**The flaky tests**, named in the annotations:

| Test | Failures | Status |
|---|---|---|
| `apps/controller/src/sessions/sessions.integration.test.ts` "the library skills on a start frame > on a runner too old to load skills" | **5**: main x2, #760, #764, #776, #811 | Fixed 10-20 by fe1f3362 (boyscouting in #811: "it read the rows before the runner's `session.started` was stored") |
| `apps/controller/src/skills/service.test.ts:820` "lets a pass join the check that runs for a Skill with the same source" (`expected ['acme/skills','acme/skills'] to have a length of 1`) | **3**: main 10-18 and 10-20, #776 | **No fix commit and no issue** |
| `apps/controller/src/daemon/workflows/scheduler.integration.test.ts:291` "a cron trigger more than a minute late" (`expected '2026-10-18T02:00' to be '2026-10-19T02:00'`) | Failed on a run that started at **01:59 UTC** | The test computes "the latest 02:00" from `new Date()`, so it breaks near 02:00 UTC. **No issue.** A nightly job scheduled near 02:00 UTC would hit it |
| `apps/controller/src/runners/socket.integration.test.ts` "marks a runner that stops answering unreachable" | 1 | Fixed by #812 |
| `apps/controller/src/daemon/text-generation/generate.integration.test.ts:826` "keeps a slot until the runner answers" | 1 (10-22) | Its second deadline fix (1f409f93 on 10-14, 4aabbd91 on 10-22) |
| android Gradle job | 1 | Passed on re-run |

**The real failures:**

- `compare:bureau` x5.
- `apps/runner/src/sessions/context.test.ts` x2 on #777 (not portable to Linux; fixed in c434a7c8).
- `apps/desktop/src/renderer/app/queries.test.ts` "forgetGoneThread" timeouts x3 on #808.
- `composer.test.tsx` request count on #784.
- The rotation tests on the stranded #712 x2.

### Flakiness costs more on agent machines than in CI

There are about **30 test-timing fix commits** on `main` in two weeks. Examples:

- "give tests a 60 second hang limit so a busy machine does not fail correct tests" (#641)
- "make the sim test file survive a busy machine"
- "time the two chip counts in alternating rounds so load hits both alike"
- "drop the wall-clock bound from the listing's entry-cap test"

PR bodies and the wiki keep naming the same cause, the load average from other agent sessions on the Beelink and on atlas:

- "load average ~100 from other agent sessions" (#722)
- "at load 100-200 for part of the day" (#787)
- "often at a load average of 10-40" (wiki)

Open flaky-test issues nobody has picked up:

| Issue | Opened | Labels |
|---|---|---|
| #356 | 10-03 | ready-for-agent |
| #491 (desktop e2e `InvalidStateError`) | 10-08 | needs-triage |
| #639 (the umbrella: "replace time limits with signals and counters") | 10-13 | needs-triage |
| #722 | 10-17 | ready-for-agent |

### The Mac-only checks mostly do not run

- CI on PRs runs `build:desktop` and `compare:bureau`, but **not** `pnpm test:desktop`, which AGENTS.md asks for "on a Mac before a PR that changes the desktop app".
- Of **85 PRs touching `apps/desktop`**, only **28 say `test:desktop` or `e2e/desktop` ran**. 20 say it did not ("needs a Mac", "not run"), and 37 do not mention it.
- The wiki records `e2e/desktop/menu.test.ts` "Edit > Undo / Redo" failing **on main** (`tracking-pane-lessons`), so nothing gates that suite.

### The bundle budget is over and does not fail the build

From the #824 CI log:

> check-bundle-budget: the first screen is 448.8 kB gzipped across 24 chunks, of 109 built; the budget is 250.0 kB ... The budget is a guide for now, so the check passes.

- The earliest row in spec 17 §Performance records 84 kB. The latest row (#837) records **455.1 kB**.
- Main's startup file is **155.8 kB of a 160 kB budget (97%)**.
- GPU memory budgets are also missed and filed: #330 (+110 MB over 220 MB) and #370 (Office about 1.4 GB).

---

## 5. Backlog state

### Size and growth

- **295 open issues**, all filed from Rogier's account (many by agents).
- 212 created since 10-09, of which 97 are already closed. 129 issues closed since 10-09 (127 completed, 2 not planned).
- So the open count grew from about **212 to 295 (+39%)** in two weeks: about 15 issues are filed per day and about 9 closed.

### Labels on open issues

| Label | Issues |
|---|---|
| needs-triage | **171** |
| ready-for-agent | **79** |
| enhancement | 36 |
| bug | 22 |
| wayfinder:* (map, prototype, task, grilling, research) | 22 |
| needs-info | 1 |
| ready-for-human | 1 |
| no label at all | 11 |

45 open issues carry neither a triage label nor ready-for-agent.

### needs-triage is a write-only queue

- Median age **15 days**. 100 are older than 14 days, and 48 older than 30 days.
- **148 of 171 have zero comments.**
- **98 of 171 are mentioned in a merged PR body.** Nearly all of these are follow-ups agents filed while shipping: "Follow-ups: #616 ... #617 ...", "filed as #790", "#763".
- Rough themes by title:

| Theme | Issues |
|---|---|
| pi, Codex and Claude adapters | 18 |
| Desktop | 16 |
| Office | 16 |
| Research or experiment | 12 |
| Security | 11 |
| Plugins | 9 |
| Perf and memory | 8 |
| Flaky tests | 8 |
| Web | 8 |
| Promotion | 5 |

### ready-for-agent

- Median age **20 days**. 55 are older than 14 days, and 19 older than 30 days.
- **Many are not small:**
  - The v1 epics from 09-02: #88 Check-in view, #90 Gmail plugin, #94 Rotation, #95-#99 Discord, Slack and notification sinks, #101 Backups, #102 Release pipeline.
  - Android screens whose bodies run 15-30 KB (#673-#678).
  - #290 and #291, also 18-30 KB.
- **Small, self-contained ones exist** (body under about 1.5 KB, no blocker): #112 (`--url` for `hercule setup`), #110 (paging cursors not tagged with their filter), #357 (desktop e2e leaves scratch folders), #116 (embed only `index.html` and `assets/`), #197 (GFM task list bullet), #198 (one inline code chip), #361, #356, #722, #763.
- **12 ready-for-agent issues have every named blocker closed but are still idle:**
  - #412, #413, #417, #418: Desktop Settings, blocked by #410, idle since 10-04.
  - #455: assistant drawer.
  - #648-#651: Android, blocked by #645.
  - #673, #736, #806.

### Spot-checks for stale or duplicate issues (12 checked)

| Issue | Finding |
|---|---|
| #743 Composer skills | **Done.** All 4 sub-issues (#766-#769) are closed; the parent is still open |
| #345 Subagents | **Done?** All 11 sub-issues are closed |
| #542 Desktop Workflows design | **Done?** All 6 sub-issues are closed (#548-#553 shipped) |
| #196 nested-markdown freeze | **Stale.** It describes `react-markdown` in `apps/web/src/screens/thread/markdown.tsx`, which no longer exists: #566 moved parsing to `marked` in client-core. #567 is the current version of the same problem, so #196 duplicates #567 |
| #359 Office arrivals walk in through the door | **Partly done.** #706 / #709 shipped the door walks; route-end clearance and corners remain |
| #275 Desktop app threads | **Umbrella of a shipped milestone** (#302 on 09-30), still open with no sub-issues |
| #332 Office v1 map | Umbrella, 3 of 7 sub-issues closed. Valid, but its ready-for-agent children (#337-#340) are 20 days old |
| #94 Rotation | **Blocked by a stranded PR** (#712, conflicting, failing, idle 7 days) |
| #617 split `sessions.integration.test.ts` | Still valid and **getting worse**: the file grew from 5,781 to 6,527 lines, and it hosted the most frequent CI flake |
| #613 `GH_TOKEN` goes stale | Valid and **costly**: three wiki pages document workarounds (`gh-401-stale-token`, `desktop-thread-copies`, `derived-shell-reads-and-query-races`) |
| #356, #722, #639 flaky tests | Overlap: #639 is the umbrella of the other two |
| #782 and #790 | Same class of bug ("counts-only nudge re-reads"); both were filed from #788 |

Close candidates: #743, #345, #542, #196 (or merge it into #567), #275 (or reframe it). The duplicate clusters are listed in the table.

---

## 6. Churn hotspots (main, non-merge commits since 10-09)

### Files touched by the most commits

| Commits | File | Note |
|---|---|---|
| **179** | `docs/spec/17-desktop-app.md` | Now **899 KB, 4,452 lines**, up from 351 KB on 10-09 (2.6x). Its §Performance section alone is about 325 KB of measurement log |
| 99 | `packages/client-core/src/index.ts` | Barrel file; every slice adds exports |
| 86 | `docs/spec/11-public-api-and-agent-surface.md` | 304 KB |
| 65 | `apps/desktop/src/renderer/app/queries.ts` | 2,270 lines |
| 57 | `packages/contract/src/cli.ts` | 4,293 lines; the CLI-row rule |
| 56 | `packages/contract/src/index.ts` | |
| 44 | `docs/spec/06-providers.md` | 310 KB |
| 41 | `apps/desktop/src/renderer/specimens/shell-page.tsx` | |
| 36 | `apps/desktop/.../intake.tracking.integration.test.tsx` | |
| 36 | `apps/controller/src/http/routes.ts` | |
| 32 | `apps/controller/src/db/migrations/index.ts` | Migration-number collisions |
| 27 | `apps/controller/src/sessions/sessions.integration.test.ts` | 6,527 lines |

### File touches by area

| Area | File touches |
|---|---|
| desktop renderer `screens/` | 899 |
| client-core | 876 |
| docs/spec | 626 |
| android | 541 |
| contract | 415 |
| desktop `routes/` | 363 |
| controller `daemon/` | 341 |
| runner `providers/` | 294 |

### The spec as a whole

- The `docs/spec/` total grew from **1.89 MB to 3.37 MB (+79%)** in two weeks.
- An agent that reads spec 17 in full spends about 225k tokens.
- One reference to `CONTEXT.md` survives in spec 17 after the rename in #838.
- `README.md` still says "successor to agentick", against the AGENTS.md rule.

### Commit message patterns

- **Types:** fix 315, feat 209, docs 155, test 144, refactor 70, perf 31, ci 8, chore 5, build 4.
- The **315 fix commits are mostly review-round fixes inside feature PRs**, not fixes of `main`. Classifying their subjects:

| Class | Fix commits |
|---|---|
| Focus and keyboard | 42 |
| Races and ordering | 28 |
| Wording | 27 |
| Perf and re-reads | 26 |
| Errors made visible | 24 |
| Security | 23 |
| Layout | 21 |
| Bounds | 19 |

- Commit messages follow the house style: verb plus object, ticket reference. Examples: "fix(desktop): a late Delete reply closes only its own dialog (#416)", "fix(skills): bound a repository skills listing in entries and time (#768)".

---

## 7. What seems to work

- **Spec first, then parallel slices.** Ticket to merge often takes less than a day (Intake, Workflows, Skills, Tracking). The spec amendment rides along in the same PR, so the spec rarely lags the code for long.
- **Cross-model adversarial review with reproductions.** Sol's findings are proven by probes, and "every P1 is fixed with a regression test that fails without the fix" is the norm. The bugs it finds are real: races, unbounded reads, credential leaks, quadratic parsers. **Architecture rounds tend to delete code** (#816 deleted about 1,100 lines; #837 -280 production and -1,150 test lines).
- **`compare:bureau` as a PR gate.** All 5 of its failures were real pixel regressions caught before merge.
- **Fast, sharded CI with an upgrade gate.** It takes 5.5 min, and no real failure reached `main` in the window. The upgrade test gates the edge release (#483).
- **Boyscouting flaky tests on the way.** #578, #730, #811, #815, #837 and #694 each fixed a flaky test they did not cause.
- **The wiki as a lessons store.** 21 pages in 8 days, written right after each slice. The traps they record:
  - TanStack Query races
  - React Compiler memoization traps
  - many agents in one worktree
  - `GH_TOKEN` expiry
  - running the Mac-only checks from Linux
- **Rogier stays at the decision points**: scope, design choices, reversals. Mechanical review stays with agents.

---

## 8. Implications for nightly automation

The things that keep going wrong are mostly **mechanical, measurable and low-risk to detect**. Fixing them is riskier, because daytime agents work on the same hotspot files. So a nightly workflow should lean towards **detect, prove, and propose small isolated PRs or a morning report**, and away from large changes.

| # | Nightly workflow | Evidence | Output | Guardrails |
|---|---|---|---|---|
| 1 | **Flake hunter.** Run `pnpm test` on `main` N times (for example 5) while the machine is idle, plus 1-2 runs with artificial CPU load. Collect failures, dedupe against open "Flaky:" issues, and attempt a deterministic fix for the top flake ("signals and counters, not time limits", #639) | 12 of 25 failed CI jobs were flaky; 4 of 41 main runs; about 30 timing-fix commits; untracked flakes in `skills/service.test.ts:820` and `scheduler.integration.test.ts:291` | One issue per new flake, with its failure rate; at most one small fix PR per night | Do not schedule near **02:00 UTC** until the scheduler test is fixed. One PR, test files only |
| 2 | **Mac check runner on atlas.** Run `pnpm test:desktop`, `compare:bureau`, the desktop perf scenarios and the Android Gradle check on `main` HEAD | 57 of 85 desktop PRs show no `test:desktop` run; known failures on main (menu Undo/Redo); perf runs paused | A morning report: pass/fail diff against last night, perf trend | Needs Rogier's consent (atlas is his reserved MacBook); run only when it is idle |
| 3 | **Budget and size watcher** | Desktop first screen 448-455 kB against a 250 kB "guide"; main startup 155.8 of 160 kB; GPU misses #330 and #370; `sessions.integration.test.ts` at 6.5k lines; spec 17 at 899 KB | A nightly trend line, and an alert when a hard budget gets within 5% | Read-only |
| 4 | **Backlog groomer (proposes, never applies)** | 171 needs-triage (148 with no comment); umbrellas whose sub-issues are all closed (#743, #345, #542); stale issue #196; overlaps (#356/#722/#639, #782/#790); 12 unblocked ready-for-agent issues; stranded PR #712 | One digest: close candidates, duplicates, "ready, unblocked, small", and proposed labels with a reason | No label or close changes without Rogier; at most about 20 items per night |
| 5 | **Follow-up harvester** | PR bodies list "Known gaps / Follow-ups / Accepted, not fixed"; 98 needs-triage issues came from PR bodies; some gaps get no issue at all (the #702 Gradle dependency verification) | A check that every gap named in yesterday's merged PRs has an issue, and a draft for each that has none | Draft only |
| 6 | **Small-ticket implementer** | Small, unblocked ready-for-agent issues exist (#112, #110, #357, #116, #197, #198, #361, #763) | 1-2 PRs per night through the usual implement and review loop (Opus lanes plus one Sol round), each under about 300 lines | Choose issues that avoid the hotspot files (`client-core/src/index.ts`, spec 17, `contract/src/cli.ts`, `migrations/index.ts`); no new migrations; cap the adversarial rounds (rounds 3+ show diminishing returns, #566); **never make design decisions** (the #750 lesson) |
| 7 | **Test-quality audit** (the `test-audit` skill exists) | 23 of 58 Review sections found weak tests (SQL copies, duplicates, tests that prove nothing); #617 | One audit PR per area per night, mostly deletions | Do not lower coverage of spec rules |
| 8 | **Doc-drift linter** | Spec 17 still references `CONTEXT.md` after #838; README says "agentick"; 18 PRs found spec drift; the spec grew 79% | Report and tiny fix PRs; suggest moving the §Performance measurement log out of the normative spec (needs Rogier) | Never edit normative spec text without a ticket |

### What every nightly run needs

- **Credentials.** Long runs hit `GH_TOKEN` expiry (#613). Use the `hercule git-credential` recipe from wiki `gh-401-stale-token`, or fix #613 first.
- **Isolation.** One worktree per agent and pathspec commits (wiki `tracking-pane-lessons`). Never clean all of `/tmp` (an agent once deleted the PR evidence folder that way).
- **Machine load.** Run the heavy suites when the Beelink load is low, so results are trustworthy and daytime agents are not slowed.
- **Honest reporting.** Report when nothing was found, and report every skipped check (AGENTS.md: "Never silently substitute behaviour").
