# How Claude Code routines feed CI events into a running session

Research for hydra issue #49 (part of #1). All claims verified against official Anthropic
docs, the Claude Code CHANGELOG, the Agent SDK reference and the `claude-code-action` source
on 2026-08-29. Claude Code CHANGELOG head at time of reading: v2.1.251. Routines, Auto-fix and
channels are all marked "research preview" in the docs, so the behaviour below can change.

## Summary

The premise of the question is half right. Anthropic ships three different ways for CI/PR
events to reach Claude Code, and none of them injects an event into a running model call:

| Surface | Session per | Delivery into a busy session | Batching |
| :-- | :-- | :-- | :-- |
| **Routines** (GitHub trigger, API `/fire`) | **event** (fresh cloud VM, fresh clone) | none: every event is a new session | none; excess events over hourly caps are **dropped** |
| **Auto-fix pull requests** (web, `/autofix-pr`) | PR (one long-lived cloud session) | queued as a *task notification*; next turn | not documented; duplicate handling is left to the model |
| **Channels** (local MCP push, the documented "CI pushes the failure into the session" path) | session | queued; **everything that arrived while busy is delivered together on the next turn and handled as a group** | yes, by the harness |

Answers to the four questions:

1. **Delivery.** Routines: new session per event, no reuse, no coalescing. Auto-fix and
   channels: the event becomes a queued user-side message in one persistent session and is
   processed as the next turn. Nothing steers a turn mid-generation. The only "mid-turn"
   delivery the harness does is for *human-typed* queued messages, which it passes to the
   model at the next tool-call boundary within the same turn.
2. **Granularity.** Routines can only subscribe to `pull_request.*` and `release.*`; there is
   no check/suite/workflow event. The documented way to react to CI with a routine is to call
   the `/fire` API from a failed CI job (one fire per failed workflow run). The GitHub Action
   example for CI auto-fix triggers on `workflow_run` *completed* and hands all failed jobs of
   that run to one Claude invocation. Auto-fix reacts per event ("when a check fails"). No
   primary source states which granularity works best.
3. **Lifetime and bounds.** Routines: fresh session, no resume, per-account daily run cap and
   per-routine hourly webhook cap; no attempt cap, no max runtime, no documented self-trigger
   guard beyond pushing to `claude/` branches. Auto-fix: one session per PR that stays
   subscribed until toggled off (so it does see the outcome of its own pushes); cloud VMs
   expire after unspecified inactivity. Action: `--max-turns`, workflow timeouts, concurrency
   groups, `allowed_bots` and a branch-prefix guard against self-triggering.
4. **Cost/latency.** Routines and Auto-fix bill as ordinary subscription usage, no VM charge;
   scheduled runs stagger "a few minutes". No published per-event vs batched cost or latency
   comparison exists.

**Recommendation for hydra (section 6):** (b) coalesce queued firings into one iteration.
That is what Anthropic's harness itself does for pushed events. (c) is not evidenced anywhere
as mid-generation steering; the nearest thing is tool-boundary merging and it is a harness
capability, not something a workflow engine should promise. The signal node needs to carry
the coalesced batch as a list, a dedup key, and enough identity (head SHA, check name,
conclusion) for the agent to discard stale events.

## 1. Delivery mechanism

### 1.1 Routines: one fresh session per event

- "A GitHub trigger starts a new session automatically when a matching event occurs on a
  connected repository. Claude Code doesn't reuse sessions across events, so two PR updates
  produce two independent sessions."
  [Routines: Add a GitHub trigger](https://code.claude.com/docs/en/routines#add-a-github-trigger)
- "Each run creates a new session alongside your other sessions".
  [Routines: Create a routine](https://code.claude.com/docs/en/routines#create-a-routine)
- API trigger: "Each successful request creates a new session. There is no idempotency key.
  If a webhook caller retries, the endpoint creates multiple sessions." and "The request
  returns once the session is created. It does not stream session output or wait for the
  session to complete."
  [Trigger a routine through the API](https://platform.claude.com/docs/en/api/claude-code/routines-fire)
- No batching, debouncing or dedup is documented. The only limiter is a cap that *drops*:
  "GitHub webhook events are subject to per-routine and per-account hourly caps. Events
  beyond the limit are dropped until the window resets."
  [Routines](https://code.claude.com/docs/en/routines#add-a-github-trigger)
- No concurrency rule ("skip if a run is active", "queue behind the active run") is
  documented anywhere in the routines doc or the fire API doc. NOT FOUND.
- How the fired prompt lands: as a task notification with subkind `scheduled-trigger`,
  framed as the session's assigned task. "the notification is a routine's stored prompt,
  delivered because one of the routine's triggers fired: its schedule, its API trigger, its
  GitHub trigger, or Run now. Claude Code frames these to the model as the session's assigned
  task". Requires v2.1.213+.
  [Agent SDK TypeScript reference: task notification subkinds](https://code.claude.com/docs/en/agent-sdk/typescript)
  CHANGELOG 2.1.214: "Fixed scheduled tasks refusing their own configured prompt as untrusted
  input — the fired prompt is now delivered as the session's assigned task". CHANGELOG 2.1.183:
  "Fixed scheduled task and webhook trigger deliveries being treated as keyboard input; they
  now classify as task notifications".
  [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

**The launch post said something different.** The April 2026 announcement: "Claude opens one
session per PR and will continue to feed updates from that PR to the session, so it can
address follow-ups like comments and CI failures."
[Introducing routines in Claude Code, 2026-04-14](https://claude.com/blog/introducing-routines-in-claude-code).
The current docs explicitly say sessions are *not* reused across events. Treat the docs as
current. The "one session per PR fed with updates" model is what shipped as Auto-fix
(section 1.2), not as routines.

### 1.2 Auto-fix pull requests: one persistent session per PR, per-event turns

This is the feature the issue describes ("feed each CI event into the running session as it
happens"), and it is a web-session feature, not a routine.

- "Claude subscribes to GitHub activity on the PR, and when a check fails or a reviewer
  leaves a comment, Claude investigates and pushes a fix if one is clear."
- "When auto-fix is active, Claude receives GitHub events for the PR including new review
  comments and CI check failures. For each event, Claude investigates and decides how to
  proceed". Three documented outcomes per event: clear fix (push and explain), ambiguous
  (ask the user), and "Duplicate or no-action events: if an event is a duplicate or requires
  no change, Claude notes it in the session and moves on".
- Dedup is therefore done by the model, per event, in context. No platform-side coalescing is
  documented.
- Gap they document: "GitHub does not emit a webhook when the base branch advances and
  creates a merge conflict, so auto-fix can't react to conflicts on its own."
  [Claude Code on the web: Auto-fix pull requests](https://code.claude.com/docs/en/claude-code-on-the-web#auto-fix-pull-requests)
- `/autofix-pr` from the CLI: "Spawn a Claude Code on the web session that watches the current
  branch's PR and pushes fixes when CI fails or reviewers leave comments".
  [Commands](https://code.claude.com/docs/en/commands)
- Delivery classification: PR activity is a task notification without subkind. "Every other
  task notification has no `subkind`. That includes scheduled tasks that fire on your own
  machine, PR activity delivered into a session, and background events such as a finished
  task." Task notifications carry a notice that "no human input has occurred, so the model
  doesn't treat the notification as a user instruction or approval."
  [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- Whether several PR events that arrive while the session is busy are merged into one turn is
  NOT documented for Auto-fix specifically. The general harness rule for pushed events is in
  1.3, and the SDK interrupt receipt notes the harness "can merge several into one turn"
  (section 5).

### 1.3 Channels: pushed events are grouped on the next turn

Channels are the documented answer to "CI pushes the failure into the session". The
scheduled-tasks page: "To react to events as they happen instead of polling, see Channels:
your CI can push the failure into the session directly."
[Scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)

- "A channel is an MCP server that pushes events into a Claude Code session so Claude can
  react to things happening outside the terminal."
- Delivery rule, verbatim: **"Events queue into the session and are processed in order. If
  several notifications arrive while Claude is busy, they're delivered together on the next
  turn and Claude handles them as a group. To process independent event streams concurrently,
  run separate sessions."**
- No ack: "Claude Code doesn't acknowledge notifications. The `await` on `mcp.notification()`
  resolves when the message is written to the transport, not when Claude has processed it."
  [Channels reference](https://code.claude.com/docs/en/channels-reference)
- On the SDK stream an injected channel/peer turn "reaches the stream as a replay whether it
  was delivered during an active turn or started a new turn while the session was idle."
  [Agent SDK TypeScript reference: SDKUserMessageReplay](https://code.claude.com/docs/en/agent-sdk/typescript)

### 1.4 Local scheduled tasks: strictly between turns, no catch-up

- "The scheduler checks every second for due tasks and enqueues them at low priority. A
  scheduled prompt fires between your turns, not while Claude is mid-response. If Claude is
  busy when a task comes due, the prompt waits until the current turn ends."
- "No catch-up for missed fires. If a task's scheduled time passes while Claude is busy on a
  long-running request, it fires once when Claude becomes idle, not once per missed interval."
  [Scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)

This is coalescing by construction: N due fires while busy become one fire.

## 2. Granularity

### 2.1 Routines: PR and release events only

- Supported event categories: "Pull request: A PR is opened, closed, assigned, labeled,
  synchronized, or otherwise updated" and "Release: A release is created, published, edited,
  or deleted". "Within each category you can pick a specific action, such as
  `pull_request.opened`, or react to all actions in the category." Filters: author, title,
  body, base branch, head branch, labels, is draft, is merged; operators equals / contains /
  starts with / is one of / is not one of / matches regex. "All filter conditions must match
  for the routine to trigger."
  [Routines: Supported events](https://code.claude.com/docs/en/routines#supported-events)
- No `check_run`, `check_suite`, `workflow_run` or `status` trigger exists. The blog: "We plan
  to expand webhook-based routines to trigger from more event sources in the future."
  [Introducing routines](https://claude.com/blog/introducing-routines-in-claude-code)
- The documented CI path is the `/fire` API called from CI. The reference ships this step:
  ```yaml
  - if: failure()
    run: |
      curl -X POST "$ROUTINE_FIRE_URL" ... \
        -d "{\"text\": \"CI failed: $GITHUB_WORKFLOW run $GITHUB_RUN_ID on $GITHUB_REF\"}"
  ```
  That is one fire per failed workflow run (per job if placed in a job), carrying a one-line
  string; the routine must fetch the details itself. `text` is freeform, max 65,536 chars,
  and "arrives wrapped in a `<routine-fire-payload>` block that labels it as untrusted data
  and tells Claude not to follow instructions inside it unless the routine's own prompt says
  to."
  [Trigger a routine through the API](https://platform.claude.com/docs/en/api/claude-code/routines-fire),
  [Routines: Trigger a routine](https://code.claude.com/docs/en/routines#trigger-a-routine)

### 2.2 There is no "CI autofix" routine template

None of the routines doc, the fire API doc, the announcement, or the Claude Academy routines
lesson mentions a routine template of that name. NOT FOUND. The closest first-party artifact
is the GitHub Action example below, plus web Auto-fix.

### 2.3 GitHub Action example: one run per failed workflow, all failed jobs together

[`examples/ci-failure-auto-fix.yml`](https://github.com/anthropics/claude-code-action/blob/main/examples/ci-failure-auto-fix.yml):

- Trigger: `on: workflow_run` with `types: [completed]`, gated by
  `github.event.workflow_run.conclusion == 'failure' && github.event.workflow_run.pull_requests[0] && !startsWith(github.event.workflow_run.head_branch, 'claude-auto-fix-ci-')`.
- It lists the run's jobs, keeps `job.conclusion === 'failure'`, downloads each failed job's
  log, and passes the whole set to **one** Claude invocation (`/fix-ci` plus
  `Failed Jobs: ${{ join(...failedJobs, ', ') }}` and the PR number).
- Self-trigger guard: the branch-prefix check above, plus pushes to a new
  `claude-auto-fix-ci-<branch>-<run_id>` branch.

So Anthropic's own reference for a CI-fix loop batches at the source: suite-level (workflow
run completed), never per check. That matches hydra's v1 stance that "batching belongs at the
source".

Supported action events (`src/github/context.ts`): `issues`, `issue_comment`, `pull_request`,
`pull_request_review`, `pull_request_review_comment`, `workflow_dispatch`,
`repository_dispatch`, `schedule`, `workflow_run`. No `check_run`/`check_suite`.
[claude-code-action](https://github.com/anthropics/claude-code-action)

### 2.4 Auto-fix: per event

"when a check fails" is per check; the doc gives no suite-level grouping.
[Auto-fix pull requests](https://code.claude.com/docs/en/claude-code-on-the-web#auto-fix-pull-requests)

### 2.5 Guidance on best granularity

NOT FOUND. No primary source compares per-check, per-suite and per-PR delivery.

## 3. Session lifetime and loop bounds

### 3.1 Routines

- Fresh workspace every run: "Each repository you add is cloned on every run. Claude starts
  from the repository's default branch unless your prompt specifies otherwise." Output goes to
  `claude/`-prefixed branches; pushes elsewhere are checked (protected branch, someone else's
  open PR, foreign commits).
  [Routines: Repositories and branch permissions](https://code.claude.com/docs/en/routines#repositories-and-branch-permissions)
- A run session can be continued by a human afterward ("Open the session URL in a browser to
  watch the run in real time, review changes, or continue the conversation manually") but no
  trigger resumes it.
- Bounds: "routines have a daily cap on how many runs can start per account"; "The minimum
  interval is one hour; expressions that run more frequently are rejected."; "One-off runs do
  not count against the daily routine cap." Plan numbers from the blog: Pro 5, Max 15,
  Team/Enterprise 25 runs per day. Fire API returns `429 rate_limit_error` with `Retry-After`
  when "The account's routine run limit or usage limit has been reached."
  [Routines: Usage and limits](https://code.claude.com/docs/en/routines#usage-and-limits),
  [Introducing routines](https://claude.com/blog/introducing-routines-in-claude-code),
  [Fire API: Errors](https://platform.claude.com/docs/en/api/claude-code/routines-fire)
- Max runtime per run, attempt caps, "stop after N fixes", and a self-trigger guard for
  routine-created PRs: NOT FOUND. Because sessions are not reused, a routine never sees the
  outcome of its own push; at most a supported `pull_request` event starts another fresh
  session.

### 3.2 Auto-fix

- Lifetime is the PR: "Auto-fix is a per-PR toggle. To stop monitoring, open the CI status
  bar in the web session and clear the Auto-fix toggle, or tell Claude to stop watching the
  PR." Because the session stays subscribed, a fix push whose checks fail again arrives as the
  next event in the same session; the docs give no attempt cap.
- VM lifetime: "Cloud sessions stop after a period of inactivity and the session's VM is
  reclaimed." Reopening "provision[s] a fresh VM with your conversation history restored";
  in-flight background work is not restored. No number is given.
- Loop warning is about comment-triggered automation, not CI: "Claude can reply on your
  behalf, which can trigger those workflows."
  [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)

### 3.3 GitHub Action

- Cost/loop controls: "Set `--max-turns` in `claude_args` to limit iterations", "Set
  workflow-level timeouts to avoid runaway jobs", "Use GitHub's concurrency controls to limit
  parallel runs". Self-trigger: "the Claude Code GitHub Action rejects a bot actor unless you
  list it in `allowed_bots`, which keeps bots from triggering Claude in a loop", and commits
  made with the default `GITHUB_TOKEN` do not trigger workflows.
  [GitHub Actions](https://code.claude.com/docs/en/github-actions)

## 4. Cost and latency

- Billing: "Routines draw down subscription usage the same way interactive sessions do."
  Over the daily cap or usage limit, accounts with usage credits continue "on metered
  overage"; otherwise "additional runs are rejected until the window resets." "API accounts
  aren't supported for routines."
  [Routines: Usage and limits](https://code.claude.com/docs/en/routines#usage-and-limits)
- Web sessions: "Running multiple tasks in parallel consumes more rate limits proportionately.
  There is no separate compute charge for the cloud VM."
  [Claude Code on the web: Limitations](https://code.claude.com/docs/en/claude-code-on-the-web#limitations)
- Latency: only for schedules. "Runs may start a few minutes after the scheduled time due to
  stagger. The offset is consistent for each routine."
  [Routines: Add a schedule trigger](https://code.claude.com/docs/en/routines#add-a-schedule-trigger)
- Trigger-to-start latency for GitHub/API triggers, per-run token guidance, and any published
  comparison of drip-in versus batched delivery: NOT FOUND.

## 5. Runtime primitives: what the harness can actually do with a message during a turn

This is the load-bearing evidence for (b) vs (c). Claude Code has exactly three behaviours for
input that arrives while a turn is running, and none of them touches an in-flight model call.

1. **Queue, then merge at the next tool-call boundary within the same turn** (human input in
   the interactive CLI): "Type a message and press `Enter` while Claude is working. Claude
   Code queues the message instead of interrupting the turn". "if you queue a message while
   Claude is running tool calls, Claude Code passes it to Claude as soon as those tool calls
   finish, within the same turn. When the turn ends with messages still queued, Claude Code
   sends only the oldest as the next turn." Esc "keeps what you queued and sends it right
   away."
   [Interactive mode: queue messages](https://code.claude.com/docs/en/interactive-mode)
   CHANGELOG history: 0.2.75 "Hit Enter to queue up additional messages while Claude is
   working"; 0.2.108 "You can now send messages to Claude while it works to steer Claude in
   real-time"; 2.0.68 "Fixed an issue where steering messages could be lost while a subagent
   is working"; 2.1.86 fixed `--bare` mode "silently discarding messages enqueued mid-turn".
   [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
   This is what Anthropic calls "steering". It is delivery between tool calls, never between
   tokens.
2. **Queue, then deliver as a group on the next turn** (channels, section 1.3) or **wait for
   idle and fire once** (scheduled tasks, section 1.4).
3. **Interrupt.** `Query.interrupt()` "Interrupts the query. Only available in streaming input
   mode." With `interrupt_receipt_v1` (v2.1.205+) it returns `still_queued`, "the UUIDs of user
   messages that survive the interrupt ... Claude Code processes the listed messages after the
   interrupt unless you cancel them first, and can merge several into one turn." Raw control
   clients can pass `cancel_queued: true` (v2.1.219+).
   [Agent SDK TypeScript reference: SDKControlInterruptResponse](https://code.claude.com/docs/en/agent-sdk/typescript)

SDK surface an orchestrator would use:

- Streaming input: `query({ prompt: AsyncIterable<SDKUserMessage> })` and
  `Query.streamInput(stream)` ("Stream input messages to the query for multi-turn
  conversations"). Single-message mode "does not support ... Dynamic message queueing /
  Real-time interruption".
  [Streaming vs single mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode),
  [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- Context without a turn: "Set `shouldQuery` to `false` to append the message to the
  transcript without triggering an assistant turn. The message is held and merged into the
  next user message that does trigger a turn. Use this to inject context, such as the output
  of a command you ran out of band, without spending a model call on it."
  [TypeScript reference: SDKUserMessage](https://code.claude.com/docs/en/agent-sdk/typescript)
- Max-turns interaction: "a message that is still queued when a turn ends at the max-turns
  limit stays queued. Claude Code doesn't add it to that turn's last model call. It starts a
  new turn for the message".
  [Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- Provenance: `SDKMessageOrigin.kind` is one of `human | channel | peer | task-notification
  (subkind scheduled-trigger | peer-send-message) | coordinator | auto-continuation |
  unclassified`; `queued_turn_count` on the result reports human-origin messages still waiting.
  [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- Cloud sessions from a script: `claude -p "msg" --cloud <session-id>` "queues the message into
  the session and exits without waiting for a reply. Use it to steer a long-running session,
  queue the next step while the current one is still finishing, or send follow-ups from a CI
  script."
  [Claude Code on the web: Send follow-ups from the CLI](https://code.claude.com/docs/en/claude-code-on-the-web#send-follow-ups-from-the-cli)

## 6. What this means for hydra

### 6.1 Reading the evidence against the v1 decision

- hydra v1's "one queued iteration per firing, next turn of the same session" is already the
  Auto-fix shape (one persistent session per PR, one turn per event), and strictly better than
  routines (fresh VM and clone per event). The v1 spec is not behind the state of the art.
- The prediction "one check result per turn is too slow and expensive" is supported
  indirectly, not by published numbers. Nobody publishes cost or latency for drip-in vs
  batched. What Anthropic does instead is telling: (1) their reference CI-fix loop batches at
  the source (`workflow_run` completed, all failed jobs in one prompt), (2) their generic
  event-push mechanism groups everything that queued while busy into one next turn, (3) their
  scheduler collapses missed fires into one, and (4) Auto-fix, the only per-event surface,
  explicitly budgets for "duplicate or no-action events" the model has to notice and skip,
  i.e. wasted turns.
- "Steer the running turn" does not exist as mid-generation injection anywhere in the
  product. The strongest form is merging a queued human message at the next tool-call
  boundary, which is a harness feature, opaque to the caller (the SDK gives no way to say
  "deliver at the next tool boundary" vs "next turn"; it only lets you queue, and reports what
  was still queued on interrupt).

### 6.2 Recommendation: (b) coalesce queued firings into one iteration

Adopt (b) as the Post-v1 default for signal nodes firing into a busy agent step, matching the
channels rule verbatim: firings that arrive while the step is running queue, and when the
current iteration completes they run as **one** iteration whose prompt sees the whole batch.

Why not (a): it is the routines shape, and routines mitigate it with a cap that drops events.
hydra's `maxTraversals` would instead fail the run with `iteration-limit` after N noisy
firings from one CI run, which is worse.

Why not (c): not evidenced. The one thing that looks like steering (tool-boundary merge) is
something hydra's provider adapter can *opt into* later by pushing the signal into the live
session through streaming input and letting the harness decide when to surface it. That is an
adapter capability ("this harness accepts mid-turn input"), not a workflow-graph semantic,
because the graph cannot observe or promise where in the turn the message lands, and other
harnesses hydra targets may not support it at all. Keep it out of the plan schema; if it is
ever added, model it as a per-provider delivery hint, and fall back to (b).

Keep source-side batching as the first line of defence, exactly as v1 says: subscribe to
suite-level kinds (`workflow_run`/`check_suite` completed), not per-check. (b) is the second
line, for what still arrives while busy.

### 6.3 What the signal node needs to carry

Today a signal node's output is one event envelope and `maxTraversals` counts firings. For
(b):

- `coalesce` on the signal node (default off in the spec change, on for the shipped
  PR-monitoring workflows): when set, firings that arrive while the target is busy are
  accumulated instead of queued one-per-firing, and the queued batch runs as one iteration
  once the current one completes. A firing that arrives while the target is idle runs
  immediately as its own iteration; coalescing only ever applies to the busy window, so
  latency for the first event is unchanged.
- `coalesce.key` (optional CEL over `event`, e.g. `event.payload.checkName` or
  `event.payload.headSha + "/" + event.payload.workflowName`): when present, a later event
  with the same key replaces the earlier one in the batch (latest wins), so a check that
  flips failed -> passed -> failed within the window is seen once with its final state.
  Without a key, the batch keeps every event in arrival order. Dedup by key is the only
  coalescing hydra should do; deciding "this batch needs no action" stays with the agent, as
  it does in Auto-fix.
- Output shape when coalescing: `steps.<signalId>.output` becomes
  `{ count, events: [envelope...], latest: envelope }` instead of a bare envelope, so prompts
  and edge conditions can read `steps.checks-failed.output.events` and
  `steps.checks-failed.output.latest.payload.headSha`. The step record for the signal node
  holds the batch, so the run view shows "fired 4 times, delivered as 1 iteration".
- Per-event fields the batch must preserve for the agent to discard stale work: `occurredAt`,
  `refs` (PR number, head SHA, check/workflow name, run id), `payload.conclusion`, and `url`.
  The agent needs the head SHA above all: any event for a SHA older than the branch head it
  just pushed is stale, which is how it avoids fixing a failure its own push already
  superseded (the Auto-fix docs make the model do exactly this judgement).
- `maxTraversals` counts delivered iterations, not raw firings, when coalescing is on. The
  cap is the loop bound the user reasons about ("at most 3 fix attempts"), and a noisy CI run
  must not burn it. Record the raw firing count on the step record for visibility.
- A hard ceiling on batch size (e.g. 50 events, then the run fails with `iteration-limit`
  style reason `signal-flood`) so an event storm is loud rather than an unbounded prompt,
  matching hydra's "nothing is dropped silently" rule and standing in for the routines' hourly
  cap without dropping.

## Sources

Fetched 2026-08-29.

- [Automate work with routines](https://code.claude.com/docs/en/routines)
- [Trigger a routine through the API](https://platform.claude.com/docs/en/api/claude-code/routines-fire)
- [Introducing routines in Claude Code (2026-04-14)](https://claude.com/blog/introducing-routines-in-claude-code)
- [Use Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Commands](https://code.claude.com/docs/en/commands)
- [Channels](https://code.claude.com/docs/en/channels) and [Channels reference](https://code.claude.com/docs/en/channels-reference)
- [Scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)
- [Interactive mode](https://code.claude.com/docs/en/interactive-mode)
- [GitHub Actions](https://code.claude.com/docs/en/github-actions)
- [claude-code-action: examples/ci-failure-auto-fix.yml](https://github.com/anthropics/claude-code-action/blob/main/examples/ci-failure-auto-fix.yml)
- [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Agent SDK: Streaming vs single mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Agent SDK: Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- hydra workflow spec, sections 2.4 and 4.3: `docs/spec/07-workflows.md` on branch `spec/v1`
