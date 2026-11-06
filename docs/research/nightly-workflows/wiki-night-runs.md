Learned on 2026-10-24 while setting up the nightly Bug hunt (`7e523471`) and Performance hunt (`4890db19`) workflows. Both run one area per run: Opus (high) hunts and hands each finding to Sonnet subagents to prove and fix, the `hunt-reviewer` agent (Opus, xhigh, edit/write disallowed) reviews with at most 4 rounds back, and the shipper (Sonnet) commits and writes the PR text; `git.push` and `github/pr.create` open the PR. Proving nothing ends in a `bughunt.nothing-proven` / `perfhunt.nothing-proven` notification.

## What limits a run at night
- **Every workflow run lands on beelink.** atlas is reserved (and sleeps), bosgame was offline, and a workflow cannot name a runner yet.
- **beelink has 13 session slots, and idle Threads keep theirs.** A Thread has no idle unload, so on 2026-10-24 8 of 13 slots were held by Threads (6 idle), leaving 5 for runs. Extra runs queue at placement. A run's step sessions unload 5 s after each turn, so a run holds at most one slot at a time, but a queued later run can take the slot between two steps of an earlier one.
- **A usage limit fails the step** (#625): the run fails with `session-failed`, its ephemeral workspace is kept for inspection, and every run queued behind it fails fast the same way.
- **Agents in a workflow cannot start runs or sessions** (the `worker` profile). Fan out with a `run.start` action, or with Claude Code subagents inside one step.
- **`scheduler.integration.test.ts` fails around 02:00 UTC** because it reads the wall clock. A night run that runs the whole suite then sees a failure that is not its own.
- **The hercule resource has no setup command and no `.workspaceinclude`**, so a fresh worktree has no node_modules: the prompt must say `pnpm install` first.

## Writing such a workflow
- A param that is exactly one `{{ expr }}` keeps its JSON type (spec 07 §5), so `draft: "{{ steps.review.output.verdict == 'escalate' }}"` fills a boolean.
- A YAML double-quoted string turns `\n` into a real newline, and CEL refuses a newline inside a single-quoted string. Write a multi-line param as a block scalar with `{{ }}` parts instead.
- Tell agents not to ask questions (nobody answers at night), never to use `git stash` (it is shared between worktrees), and to check "fails before the fix" by reverse-applying a patch or in a throwaway `git worktree` outside the checkout.
- Set `timezone: Europe/Amsterdam` on cron triggers; the clocks go back on 2026-10-25.
