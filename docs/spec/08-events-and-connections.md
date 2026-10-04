# Events and Connections

Every event in Hercule - ingested by an event-source plugin, ticked by the scheduler, posted by hand, or emitted by the controller about its own runs and tasks - is normalized into one envelope and appended to one persisted event log. Plugins only emit; the core alone persists, matches, and dispatches, using durable-cursor transactions whose effect rows are unique per (trigger or subscription, event). External accounts are core-owned Connections: plugin-defined types, one ingest loop per Connection, every event stamped with the Connection it arrived through, and every trigger and outbound action naming its Connection explicitly. This document specifies the event envelope, the pipeline, the v1 event sources (GitHub, Gmail, cron, manual, platform events), subscriptions, the Connection record, and the Connection setup flows. Rationale lives in [ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md) and [ADR 0010](../adr/0010-external-accounts-are-core-owned-connections.md).

## 1. Pipeline overview

The pipeline has three roles with a hard boundary between them.

- **Emitters** produce normalized events. Event-source plugins (GitHub, Gmail) emit through the `events` host API capability (see [./05-plugins.md](./05-plugins.md)). Core emitters (cron scheduler, manual synthetic events, platform events) call the same internal emit path. An emitter never dispatches, never knows about triggers or subscriptions, and never reaches the store directly.
- **The event log** is one append-only table in the controller database ([./04-state-store.md](./04-state-store.md)). Every emitted event is persisted, whether or not anything matches it.
- **The matcher** is one durable-cursor consumer of the log. It reads events past its cursor, evaluates every active start trigger of every enabled workflow and every live subscription, fans out to all matches, inserts effect rows, and advances the cursor in the same transaction (section 4).

There is no in-memory event routing and no separate delivered-events table. Effects that must leave the database (chat posts, external API calls) go through outbox rows with retry, owned by [./04-state-store.md](./04-state-store.md). Delivery to external systems is at-least-once; state changes inside the database are exactly-once.

The controller needs no public endpoint: every v1 source is outbound-only (polling) or internal. See [./13-security.md](./13-security.md) for the perimeter.

## 2. Event shape

One envelope for every event, regardless of source.

| Field | Type | Set by | Notes |
|---|---|---|---|
| `id` | Hercule id | core | Identity of the event. The event log also carries a monotonic **position**, the cursor unit for the matcher and for live-topic replay ([./04-state-store.md](./04-state-store.md), [./14-web-app.md](./14-web-app.md)). |
| `source` | string | core | The emitting plugin id or core emitter name: `github`, `gmail`, `cron`, `manual`, `platform`. |
| `connectionId` | id or null | emitter | The Connection the event arrived through. Required for plugin-emitted events; null for core emitters. |
| `system` | string | emitter, then enrichment | The external system the event is *about*, defaulting to the source's own system (`github`, `gmail`). Writable after ingest (see below). |
| `kind` | string | emitter | Dotted, with a namespace before the first dot: `github.issue.opened`, `gmail.message.received`, `cron.tick`, `run.failed`, `task.updated`. The namespace is not always the event's `source`: `run.failed` and `task.updated` have the source `platform` *(amended 2026-09-29, [#276](https://github.com/theagenticage/hercule/issues/276))*. Each kind declares a payload schema at plugin registration; the catalog is persisted and readable by workflow validation and UI pickers. |
| `occurredAt` | timestamp | emitter | When it happened at the source. *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* A plugin emits it as an ISO 8601 timestamp with a time zone, and the core stores it in UTC. |
| `receivedAt` | timestamp | core | When the controller persisted it. |
| `dedupKey` | string | emitter | Plugin-supplied idempotency key, unique per Connection. A second emit with the same `(connectionId, dedupKey)` is a no-op ~~returning the existing event id~~. *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* A plugin's `emit` returns nothing ([./05-plugins.md](./05-plugins.md) section 4.3). Core emitters supply their own keys (e.g. `cron.tick` = ~~`triggerId + scheduledFor`~~ `workflowId + triggerId + scheduledFor` *(amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78), section 4)*). A platform event's key is random *(amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81), section 5.5)*. The key is unique per source as well: a manual event can no longer take a `cron.tick`'s key first and stop the tick from being written *(amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82))*. |
| `refs` | ExternalRef[] | emitter, then enrichment (append-only) | This spec's addition. Canonical identities of the things the event is about (`github:issue:owner/repo#42`, `gmail:thread:<id>`). The plugin defining the ref type owns canonicalization; the Connection is not part of the identity. Copied into Task provenance by triage and matched by the `task.query` guard ([./09-tasks.md](./09-tasks.md), [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)). |
| `url` | string or null | emitter, then enrichment | Source URL: where a human opens this event in its system ("Open in GitHub"). |
| `payload` | object | emitter | Per-kind payload conforming to the declared schema. This is what CEL filters and trigger input mappings read. |
| `raw` | object or null | emitter | Vendor payload passthrough for debugging and future kinds. Never read by filters or mappings. |
| `actor` | Actor or null | core | This spec's addition. Set on manual synthetic events and platform events caused by an API mutation (`user` or `session:<id>`); null for ingested and cron events. The envelope is the only place `actor` lives; platform-event payloads do not repeat it. |

Field names are pinned here; earlier tickets called them provisional. The envelope is ADR 0009's list plus the ticket 30 handoff's `system` and `url`; `refs` and `actor` are this spec's additions, motivated by Task provenance ([./09-tasks.md](./09-tasks.md)) and actor stamping ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)).

The event's `id` **is** the log position (`INTEGER PRIMARY KEY`); there is no second id column, and it is the one integer id in a system of UUIDv7s (resolved 2026-09-01, [Domain model residue](https://github.com/theagenticage/hercule/issues/46); [./04-state-store.md](./04-state-store.md) owns id formats).

**Immutability and enrichment.** An event is immutable after persist, except for enrichment: `system` and `url` may be overwritten and `refs` appended to after ingest, through one operation, `event.enrich` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)); `payload` and `raw` never change. Sentry, Tailscale, Hetzner and GitHub notices arrive *through* Gmail; recognising the system inside an email is enrichment, done either by a plugin sender rule at emit time or by the triage agent afterwards ("Open in Sentry" needs the URL from the mail body; the `task.query` guard needs the `sentry:issue:123` ref). An enrich gives the matcher one more look at that event, idempotently (section 4.2, [ADR 0025](../adr/0025-enrichment-re-matches-one-event-idempotently.md)). The UI marks the system and suffixes the Connection.

**Payload schemas.** A plugin registers each kind's payload schema in `register()` ([./05-plugins.md](./05-plugins.md)). The core validates the payload at emit (this spec's rule; ADR 0009 pins only that each kind declares a schema); a non-conforming emit is rejected with an error to the plugin ~~and a health warning~~, never persisted. *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* A plugin that passes the error on fails its poll, which counts toward the Connection's `error` status ([./05-plugins.md](./05-plugins.md) section 8.1). Kinds grow additively; a plugin never removes or reshapes a kind within one host API version. Schemas are authored in Effect Schema and persisted as JSON Schema in the catalog ([./05-plugins.md](./05-plugins.md) section 5).

**The kind catalogue.** *(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* The kinds a trigger can listen for are one list. `eventKind.query` returns it and workflow validation reads it, so the editor never offers a kind that a save rejects. The **core kinds** are declared by the core beside the plugins' kinds, because the core is their source: ~~`cron.tick` (the Scheduler),~~ `run.completed`, `run.failed`, `run.cancelled`, `task.created` and `task.updated` (the controller). `task.deleted` (section 5.5) is not declared yet, so no trigger can name it. Each entry says whether a trigger on it names a Connection: a plugin's kind does, a core kind does not. Two rules keep one name to one kind:

- A plugin may not declare a core kind. A trigger names a kind by its name alone, so the name would mean two kinds; the plugin's registration fails.
- A trigger cannot name a kind of a plugin that is disabled or did not start. Its source ingests nothing, so the trigger could never match. The kinds stay in the catalogue, so old events of that plugin still render.

*(Amended 2026-09-29, [#276](https://github.com/theagenticage/hercule/issues/276).)* `cron.tick` is no longer in the list of kinds a trigger can listen for, and `eventKind.query` does not return it. A trigger fires on a schedule by writing a `Schedule` in its `on` ([./07-workflows.md](./07-workflows.md) section 2), and a trigger whose `EventSelector` names `cron.tick` is refused as an unknown kind, with a hint to write `on: schedule:`. `cron.tick` is still a core kind in the other senses: a plugin may not declare a kind with its name, and its events appear in the event log.

## 3. Persistence and retention

- **Persist-all.** Every event is written before matching. Unmatched events are kept exactly like matched ones; the Intake events view depends on this (section 10).
- **Retention.** Pipeline events are TTL-pruned, default 90 days; security events and actor-stamped mutations are kept at least 90 days; run records copy their triggering event and Task provenance keeps the `eventId` plus the refs it needs, so pruning never breaks audit or duplicate detection. [./04-state-store.md](./04-state-store.md) owns the retention statement; the `retention.events` and `retention.security` settings are listed in [./15-packaging-and-operations.md](./15-packaging-and-operations.md).
- **One log, two populations.** The same append-only table holds pipeline events and audit entries (actor-stamped mutations, security events such as login failure or token revocation; [./13-security.md](./13-security.md)). Consolidated reading: only pipeline events are matched against triggers and subscriptions; audit entries are never triggers.

**Open:** whether security audit entries should become matchable Platform Events later (e.g. "notify on repeated login failure"). Not in v1.

- **Baseline at now.** A new Connection's first sync records the source's current position (GitHub: current time / last-modified; Gmail: the mailbox's current `historyId`) and emits zero historical events. This is stampede guard one; spawn bounds are guard two. *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* As built, the first poll of each feed baselines, and so does the first poll of a GitHub repo that joins the watch list (section 5.1).

## 4. Matching and dispatch

The matcher is one consumer with one durable cursor over the event log. For each event past the cursor, in one transaction:

1. Evaluate every **active start trigger** of an enabled workflow ([./07-workflows.md](./07-workflows.md)): the trigger's ~~`source: EventSelector`~~ `on: EventSelector` *(amended 2026-09-29, [#276](https://github.com/theagenticage/hercule/issues/276); a cron trigger's `on` is a `Schedule` and admits only its own ticks)* (defined in 07: kind, optional `connectionId`, CEL condition over `event`) admits the event. Connection selection semantics are in section 8.3.
2. Evaluate every **live subscription** (section 7): kind/shape condition matches and the correlation resolves (event-side expression value equals the holder-side expression value).
3. **Fan out to all matches.** Delivery is non-exclusive: one event may spawn several runs and signal several subscribers.
4. Insert **effect rows**:
   - a pending run for each matched start trigger, ~~`UNIQUE(triggerId, eventId)`~~ `UNIQUE(workflowId, triggerId, eventId)` *(amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78), below)*;
   - a signal delivery for each matched run-held subscription, `UNIQUE(subscriptionId, eventId)`;
   - a queued session input for each matched session-held subscription, `UNIQUE(subscriptionId, eventId)`;
   - a **held event** for a matched start trigger whose spawn bound has tripped (section 4.1), ~~`UNIQUE(triggerId, eventId)`~~ `UNIQUE(workflowId, triggerId, eventId)` *(amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78), below)*.
5. Advance the cursor.

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* A trigger is identified by `(workflowId, triggerId)`, and a trigger id is unique only inside its workflow ([./07-workflows.md](./07-workflows.md) section 2). So each key in this document that names a trigger names its workflow too: pending-run and held-event rows are unique on `(workflowId, triggerId, eventId)`, a `cron.tick`'s dedup key is its workflow id, trigger id and `scheduledFor`, and the matcher routes a tick by the pair. With the trigger id alone, two workflows that each have a trigger `on_pr` would collide on one event, and one run would be lost.

Because effect rows are unique per (trigger or subscription, event), a crash between commit and cursor advance is harmless: redo re-derives the same rows and the uniqueness constraint absorbs them. Run spawning, signal delivery, and queued-input delivery are downstream consumers of the effect rows, not part of the matcher transaction.

**Errors evaluate as no-match.** A CEL filter or correlation expression that throws, references an unresolvable field, or times out is a no-match for that trigger or subscription. The failure is recorded as a visible health warning on the trigger or subscription (surfaced on the workflow and in the run view). The pipeline never crashes on user expressions.

The warning is a `health` field on the trigger row (and on the subscription row for correlation errors): `ok`, or `error` with the last message and time, overwritten on every evaluation. When a failing evaluation finds the field at `ok`, the same write also creates one informational Notification `core.trigger-error` naming the trigger, the workflow and the error; while the field stays `error`, later failures only refresh the message. A clean evaluation returns it to `ok` silently, and the next failure after that moves it to `error` again, with a new notification. No counters, no timers, no dedup table (pinned by [Notification lifecycle](https://github.com/theagenticage/hercule/issues/42)).

*(Amended 2026-09-28, [#84](https://github.com/theagenticage/hercule/issues/84).)* A subscription's correlation error raises its own kind, `core.subscription-condition-error`, by the same rule: one informational Notification, with the subscription as its subject and the error as its body, created in the routing transaction that moves the subscription's health from `ok` to `error`. `core.trigger-error` arrives with the trigger routing table in [#82](https://github.com/theagenticage/hercule/issues/82); until then the pipeline evaluates no trigger filter, so there is nothing to raise it for.

*(Amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82).)* **Triggers as built.** The event router evaluates start triggers now, through a routing table of its own beside the one for subscriptions ([./07-workflows.md](./07-workflows.md) section 2.1).

- It writes step 4's pending run, a **trigger effect**, in the routing transaction. A delivery starts the run from it later, one effect per transaction, in arrival order.
- Held-event rows are not written: they arrive with spawn bounds ([#87](https://github.com/theagenticage/hercule/issues/87), section 4.1).
- `core.trigger-error` is raised now, by the rule above, with one addition: a move from `ok` to `error` raises no notification when one about the same trigger was raised in the hour before. A filter that fails on every other event moves the health to `error` each time, and would otherwise raise one notification per event. As for an unreachable runner ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.2), the check reads the notifications already created, so it needs no counter and no timer. The trigger's health still shows every failure. Its subject is the trigger, `{ kind: "trigger", workflowId, triggerId }`, and its body is the error.
- A trigger's health records two more failures than its expressions, by the same rules and under the same kind, each with a title of its own: a cron schedule the Scheduler cannot read, because its timezone is not a known one, and a run the database refused to start, or whose start failed because of a bug in the controller ([./07-workflows.md](./07-workflows.md) sections 2.1 and 2.2).
- The health records which of the three failed: the evaluation, the scheduling or the start. Only the same stage clears it: a clean evaluation clears an evaluation error, the Scheduler clears a scheduling error when it next computes the trigger's fire time, and a run that starts clears a start error. So a trigger whose filter is fine but whose runs cannot start stays in `error`, instead of moving between `ok` and `error` on every event. A failure at another stage than the recorded one counts as a move to `error`, with a notification of its own.
- A trigger has no live topic of its own, so a change to its health is announced on the live topic `workflow`.
- Saving the workflow returns to `ok`, without a notification, each start trigger whose definition changed: its `on` (filter, event kind, Connection, schedule or timezone) or its input mapping. A trigger the save leaves as it was keeps its error, because the error is still true of it ([./07-workflows.md](./07-workflows.md) section 2).

**Expressions.** All four expression sites (start-trigger filters, signal-trigger correlation keys, step and edge conditions) use CEL, evaluated by `@marcbachmann/cel-js` behind a Hercule-owned wrapper, context variables dyn-typed ([./07-workflows.md](./07-workflows.md); research/expression-language.md (branch `research/expression-language`)). Filters see the whole envelope as `event`; the raw event never leaks into the frozen plan - the trigger's input mapping copies what the run needs.

### 4.1 Spawn bounds

Spawn bounds live on start triggers: `{ maxRuns, windowSeconds }` per trigger, default ~30 runs per hour. Exceeding it trips the trigger into a paused state; the matcher then writes held-event rows instead of pending runs, so matched events are kept visibly, a Notification fires, and the user resumes with one click (optionally discarding the backlog). The full breaker semantics, the resume operation, and the "Needs a call" surface belong to [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md).

*(Amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82).)* Not built yet ([#87](https://github.com/theagenticage/hercule/issues/87)): a start trigger starts a run for every event it matches ([./07-workflows.md](./07-workflows.md) section 2.5).

### 4.2 Enrichment re-match

`event.enrich` gives the matcher one more look at that single event, in the same transaction as the enrichment write ([ADR 0025](../adr/0025-enrichment-re-matches-one-event-idempotently.md)). Re-match is not re-delivery: consumers consume effect rows, never events, and effect rows are unique per (trigger or subscription, event), so everything that matched before hits the uniqueness constraint and is a no-op - the earlier consumer never sees the event again. Only *newly* matching triggers and live subscriptions produce rows, delivered normally, for the first time, reading the enriched envelope. A subscription whose holder has ended is not live and is not evaluated; the cursor never rewinds. Loop bound: the enriching run's own trigger cannot re-fire for the event (uniqueness), refs only grow, and spawn bounds cover pathology. Consequence for authors: a trigger may filter on enriched fields (`event.system == "sentry"`), understanding that it fires when the enricher writes, not when the event arrives.

## 5. Event sources

GitHub and Gmail are event-source plugins. Cron, manual, and platform events are core emitters into the same pipeline. Each source is described by what it emits, how, and what v1 deliberately does not cover.

### 5.1 GitHub (plugin)

- **Auth and Connection type:** `github/github`, credential = ~~a personal access token~~ an access token from the device flow through Hercule's own OAuth App, or a pasted personal access token *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))* (section 9.3).
- **Ingest:** three declared feeds per Connection ([./05-plugins.md](./05-plugins.md) section 4.3):
  - **`notifications`** (default 60 s; `poll()` floors the interval with `X-Poll-Interval`): the Notifications API (`GET /notifications`, `If-Modified-Since`; 304s cost no quota) - what notifies the user: mentions, assignments, review requests, state changes on subscribed threads.
  - **`repos`** (default 120 s): watched-repo polling for issue and PR lifecycle on the Connection's watch list, conditional requests (ETags), diffed against Connection-scoped state.
  - **`checks`** (default 60 s): check-suite polling for open PRs in watched repos updated in the last 7 days (window per-Connection config), one conditional request per PR head SHA.
  - *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The shortest interval a user can set is 60 s for `notifications` and `repos`, and 30 s for `checks`. The checks window is the config's `checksWindowDays`, 1 to 30. ~~The `notifications` feed lists unread threads only, which is GitHub's default.~~ A rate limit is not a failure: the poll returns the wait GitHub asks for as `nextAfterSeconds`. A rejected token (401) sends the Connection to `needs-reauth`.
  - *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* What each feed does on its first poll and after:
    - **`notifications`** asks with `all=true`, so it lists threads the user has already read too. Without it, a thread the user read on GitHub between two polls would never be emitted. The first poll asks for one thread, records where the feed stands, and emits nothing.
    - **`repos`** baselines a repo by recording every open issue and pull request, every closed one updated in the 7 days before the newest item's update time (GitHub's clock, not the controller's), and the newest item itself. Comments and reviews that exist at the baseline are never emitted. An issue missing from that record that shows up open is emitted as `github.issue.reopened` only when GitHub's `state_reason` says `reopened`.
    - **`checks`** follows the open PRs of a repo updated in the window, most recently updated first, up to 1,000 per repo; a repo with more has only those followed. Every poll asks again about the head commit of each PR in the window, with that commit's ETag, because a check can be run again after it finished. The first poll records the time and sends no request; a verdict completed before that time is never emitted.
    - A repo that fails, for example one the token cannot see, does not stop the others: they are polled, and the poll then fails naming every repo that failed, and saying to unlink its repo Resource or remove it from the Connection's extra repositories. A next-page link that points outside GitHub's API fails the poll, and the token is not sent to it ([./05-plugins.md](./05-plugins.md) section 4.4).
- **Watch list:** ~~per-Connection plugin config, seeded from the repo Resources that reference this Connection (read through the `resources` capability), user-editable and visible in the Connection's settings.~~ *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* the union of two lists, read again on every poll:
  - the repo Resources linked to this Connection whose remote is on github.com, read through the `resources` capability; *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* a remote that is not exactly `github.com/<owner>/<repo>`, with a valid owner and repo name, is skipped;
  - the extra repositories in the Connection's config (`repos`), edited in the Connection's settings.

  Each repo is written once, in lowercase, here and in subjects, refs and URLs. A repo that leaves the list loses its state, so it baselines again if it returns.
- **V1 kinds**, each with a declared payload schema; every payload carries a common `subject` block `{repo, number?, title?, author?, state?, url}` so refs and `url` derive uniformly:
  - `github.notification` - **one kind for the whole Notifications feed**; the payload carries the API's `reason` (`mention`, `assign`, `review_requested`, `state_change`, `comment`, `subscribed`, `ci_activity`, `security_alert`, ...) plus the subject. Filters select reasons in CEL (`event.payload.reason == "mention"`); reasons GitHub adds later cost nothing.
  - Issues: `github.issue.opened`, `github.issue.closed`, `github.issue.reopened`, `github.issue.labeled` (`{added, removed}` in one event), `github.issue.assigned`, `github.issue.commented`.
  - PRs: `github.pr.opened`, `github.pr.synchronized` (new head commit), `github.pr.review-submitted` (one per submitted review: `{reviewer, verdict: approved | changes-requested | commented}`), `github.pr.commented`, `github.pr.merged`, `github.pr.closed` (unmerged), `github.pr.labeled`.
  - CI: `github.pr.checks-completed` - **one event when every check suite on the head SHA is done** (*(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* and one more each time that SHA's verdict changes, such as a failure that turns into a success when a check is run again; a verdict already reported is not emitted twice), payload `{conclusion, suites[]}` rolled up. *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The roll-up is `failure` when any suite ended other than `success`, `neutral` or `skipped`; otherwise `success` when any suite succeeded; otherwise `neutral`. A suite with no check runs is left out. This is the coarse kind the one-signal-per-iteration rule demands ([./07-workflows.md](./07-workflows.md) section 4.3): a PR-monitoring workflow processes one green/red verdict, not thirty check runs.
  - Deliberately absent: `edited` kinds (title/body edits are noise; payloads carry current titles), per-check-run kinds, `github.release.*`, `github.push.*` (webhook territory, Post-v1). The PR-merged event is what the shipped "done means merged" convention correlates on ([./09-tasks.md](./09-tasks.md)); it lands at poll latency, which is acceptable.
- **Refs:** `github:issue:owner/repo#42`, `github:pr:owner/repo#87`, `github:repo:owner/repo`; `url` = the GitHub web URL of the subject.
- **Not covered in v1:** push and commit events, and Actions results. "On push to main" is not a v1 trigger. These need the webhook ingress core service (Post-v1).
- **Quota:** ~~PAT limit~~ the limit for an authenticated user, a PAT and an OAuth App token alike *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*, 5,000 requests/hour; 60 s polling of a handful of endpoints uses a few hundred per hour, and conditional 304s are free. The checks feed adds roughly one conditional request per open PR per tick (20 open PRs is about 1,200/hour worst case, mostly 304s); the 7-day window and per-Connection intervals keep it bounded. This polling cost is what raises the webhook ingress service's post-v1 priority.

The workflow-action roster is pinned in [./05-plugins.md](./05-plugins.md) section 4.4.

### 5.2 Gmail (plugin)

- **Auth and Connection type:** `gmail/gmail`, credential = OAuth refresh token from a BYO Google client (section 9.2).
- **Ingest:** one declared feed, `messages`, default 30 s with the standard per-Connection per-feed override ([./05-plugins.md](./05-plugins.md) section 4.3), polling `users.history.list` from the stored `historyId`. Quota is negligible (2 units per `history.list`, 20 per `messages.get`, against 6,000 units/min/user).
- **V1 kind:** exactly one, `gmail.message.received`, payload `{messageId, threadId, labelIds, from, to, subject, snippet, isFirstInThread}`. No kinds for label changes, archiving or sent mail: everything else is a filter over this kind, or an action. Bodies are never ingested; a workflow fetches them on demand through `gmail/message.read` / `gmail/thread.read` ([./05-plugins.md](./05-plugins.md) section 4.4). Mid-session mailbox queries by an agent use the gmail actions plus the session's MCP passthrough; this is the first named consumer of the post-v1 agent-tools extension point.
- **Refs:** `gmail:thread:<id>` and `gmail:message:<id>`; `url` = the Gmail web URL of the message.
- **Sender rules** stamp `system` at emit: a shipped sender-domain map (`*@sentry.io -> sentry`, `*@tailscale.com -> tailscale`, `*@hetzner.com -> hetzner`, `*@github.com -> github`), user-extendable per Connection. Sender rules stamp `system` only; extracting refs and URLs from a mail body is the triage agent's job (section 2; ref ownership in [./09-tasks.md](./09-tasks.md)).
- **Push-agnostic interface:** the plugin's emit path does not depend on polling, so the Pub/Sub pull upgrade (Post-v1) changes the loop, not the contract.
- **Token lifetime:** a Google OAuth app left in "Testing" status issues 7-day refresh tokens with Gmail scopes. The setup flow (section 9.2) requires publishing; the setup docs state the trap.

**Verify at build time:** Gmail returns an error when the stored `historyId` is too old to resume from; the loop must then re-baseline at now and record a visible note rather than fail permanently.

### 5.3 Cron (core)

Cron is core, not a plugin. There is no standalone schedule entity: the schedule lives in a workflow's cron start trigger, as its `on: { schedule, timezone? }` *(amended 2026-09-29, [#276](https://github.com/theagenticage/hercule/issues/276))*, timezone per trigger with the user's timezone setting as default ([./12-assistants.md](./12-assistants.md) section 5.2). Assistant heartbeats and reminders are Scheduled Wakes fired by the same Scheduler but outside the pipeline ([./12-assistants.md](./12-assistants.md) section 8). Triggers are queryable rows in their own table ([./07-workflows.md](./07-workflows.md)), so "all schedules" is one query. A workflow may carry several start triggers, cron or otherwise.

- A core scheduler keeps next-fire state as rows in the database (reloaded on boot, [./04-state-store.md](./04-state-store.md)) and emits `cron.tick {workflowId, triggerId, scheduledFor, previousFiredAt}` through the pipeline; the matcher routes by ~~`triggerId`~~ `(workflowId, triggerId)` *(amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78), section 4)*. `previousFiredAt` is when this trigger last actually fired (`null` on the first tick), so a batch consumer such as the shipped Triage workflow gets its window from the tick and a re-run replays the same window ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 2.1).
- Ticks missed while the controller was down are skipped, with a visible note on the trigger. No catch-up runs.
- A scheduled-task form is sugar over "create workflow {cron trigger, one step}" or "add a cron trigger to an existing workflow"; the one-step shortcut may use the fire-and-forget built-in ~~`workflow.run`~~ `run.start` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))* action. Whether v1's web app ships that form belongs to [./14-web-app.md](./14-web-app.md) (ruled post-v1 there).
- Assistant heartbeats are a scheduled wake; whether they ride a cron trigger and by what mechanism is Open in [./12-assistants.md](./12-assistants.md).

*(Amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82).)* The Scheduler as built is in [./07-workflows.md](./07-workflows.md) section 2.2. A tick's `source` and `system` are `cron`, its `connectionId` is null, and its `occurredAt` is its `scheduledFor`. `event.enrich` refuses a tick with `not_found`, as it refuses a platform event: the tick's payload names the one trigger it fires, and an added ref must not widen what it matches.

### 5.4 Manual (core)

"Manual" is two distinct things:

1. **Direct run creation**: the user or an agent starts a run of a workflow, is prompted for its declared inputs, and no event is produced ([./07-workflows.md](./07-workflows.md)).
2. **Synthetic events**: a public API operation that emits an event through the pipeline. The caller supplies `kind`, `payload`, optional `connectionId`, and optional `refs`; the core stamps `source: "manual"`, the actor, and `receivedAt`. Uses: testing a trigger's filter against a hand-written event, and agents poking subscriptions. Namespaced kinds mean a synthetic `github.issue.opened` matches a GitHub trigger like a real one; a filter that must exclude synthetic events tests `event.source != "manual"`.

*(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* Because a synthetic event starts the same workflows as one a plugin's event source sends through a Connection, and those workflows may act through that Connection, posting one needs the `connection.use` grant beside `event.emit`. `event.emit` accepts only a kind a plugin declares, so every synthetic event needs it; a caller without it is refused with `forbidden` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2). The shipped `assistant` profile holds `event.emit` and withholds `connection.use`, so it cannot post one ([./13-security.md](./13-security.md) section 6.2). `event.enrich` is not gated by `connection.use`.

### 5.5 Platform events (core)

The controller emits events about its own state, connection-less, through the same pipeline. This document owns the `run.completed` / `run.failed` payloads; [./09-tasks.md](./09-tasks.md) owns the `task.*` payloads. The actor of the causing mutation is on the envelope, never repeated in a payload. V1 kinds:

| Kind | Payload | Emitted when |
|---|---|---|
| `run.completed` | `{runId, workflowId?, triggerId?, origin, inputs, ~~outputs~~ output?, taskId?, triggerEventId?, startedAt, finishedAt}`; ~~`outputs`~~ `output` = the terminal step's output, absent when the run completed without a terminal step, the name the run record uses *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))*, `taskId` = the run's Task link; *(amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81): the payload as built is below the table)* | a run reaches `completed` |
| `run.failed` | the `run.completed` fields plus `failureReason`, `failedStepId?` and `failedEdge?`, the edge the run failed at as its index in the plan's edges and why that edge failed *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))* | a run reaches `failed` |
| `run.cancelled` | the `run.completed` fields | a run reaches `cancelled` (not a failure: a failure-notification workflow must not fire on a deliberate cancel) |
| `task.created` | full Task snapshot | a Task is created |
| `task.updated` | `{taskId, changes}`; `changes` carries `{old, new}` per scalar field and `{added, removed}` per array field; one update op = one event; provenance-only appends fire it too | a Task is updated |
| `task.deleted` | `{taskId, snapshot}`, the final row (the task is unreadable afterwards) | a Task is soft-deleted ([./09-tasks.md](./09-tasks.md) Delete) |

CEL routes on them like any event: `event.changes.status.new == "done"`, `has(event.changes.status)`. Kinds grow additively (e.g. learning workflows over run outcomes); no finer-grained task kinds exist. Task event shapes are owned by [./09-tasks.md](./09-tasks.md).

The payload set is pinned by [Plugin contribution interfaces](https://github.com/theagenticage/hercule/issues/41): the run-record subset above plus ~~`outputs`~~ `output?` *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))* and `taskId?`, so "done means merged" and check-in workflows route without a lookup.

*(Amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81).)* **The run events as built.** Every payload has `{ runId, workflowId, origin, inputs, startedAt?, finishedAt }`. `run.completed` adds `output?`. `run.failed` adds `failureReason`, `failedStepId?` and `failedEdge?`. `run.cancelled` adds nothing. Where this differs from the table:

- **`workflowId` is null, not absent,** for a run of a workflow sent with `run.start`, as on the run record ([./07-workflows.md](./07-workflows.md) section 7.2).
- **`startedAt` is optional.** A run cancelled while it was `pending` never started, and neither did a run the controller could not carry out before its first step.
- **`triggerId`, `taskId` and `triggerEventId` are not in the payload yet.** Each joins with the ticket that gives a run the field: triggers ([#82](https://github.com/theagenticage/hercule/issues/82)) and the ticket that links a run to a Task. *(amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82): a run a trigger starts carries the trigger's id and the event's id in `origin`, `{ kind: "trigger", triggerId, eventId }`, so the payload has them there; it gains no fields of its own for them)*
- *(Amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82).)* **`run.failed` adds `failureMessage?`**, the run record's sentence that says what did not validate, for a run that failed with `validation-error` ([./07-workflows.md](./07-workflows.md) section 7.1).
- **`failedEdge` is `{ index, message }`**, the same type as the run record's `failedEdge`: the edge's index in the run's `plan.edges`, and what went wrong there. The event does not carry the plan, so a consumer that needs the edge's steps reads the run with `run.read`. The event keeps the run record's shape rather than a shape of its own, so one concept has one spelling.
- **The actor.** The envelope's `actor` is the actor whose request ended the run: the user or a session calling `run.cancel`, or `run:<id>` when a step of another run cancelled it. It is `system` when the run ended on its own, by completing or failing, the stamp the controller uses for any write with no request behind it.
- **Platform events are never enriched.** `event.enrich` refuses a platform event with `not_found`, as it refuses an audit entry: a ref added to a run's event could make it match a subscription it was never about, and the controller's own account of what happened is not the caller's to amend.
- **`event.read` covers these payloads.** A run event carries the run's inputs and output, and a task event the Task. An actor holding `event.read` reads them in the log without `run.read` or `task.read`, as it already read task snapshots when they were audit entries. Only the security entries are narrowed further, by `event.audit` ([./13-security.md](./13-security.md)).
- **The dedup key is random.** A run emits once because its status changes once, in the same transaction as the event, not because of the key. A key built from the run's id would let a manual `event.emit` with that key take the platform event's place.
- **`task.created` and `task.updated` are routed now.** Before this change they were written as audit entries, which the event router never evaluates, so no trigger or subscription could see them ([./09-tasks.md](./09-tasks.md) Platform events). `task.deleted` is still an audit entry only (section 2).

Batching is the emitter's job: a workflow that reacts to CI results or reviews subscribes to a per-suite or per-review kind, not per-check or per-comment ones, because a run processes one signal firing per iteration ([./07-workflows.md](./07-workflows.md) section 4.3). The v1 GitHub kind roster ([./05-plugins.md](./05-plugins.md)) must offer those coarse kinds.

## 6. Start triggers versus subscriptions

Two ways an event enters work, both evaluated by the same matcher:

| | Start trigger | Subscription |
|---|---|---|
| Lives on | a workflow, as a stored row | a run (instantiated from a signal trigger) or a session (registered directly) |
| Condition | static: kind, Connection selection, CEL filter | kind/shape condition plus a correlation |
| Effect | spawns a new run (or a held event when the bound has tripped) | resumes the holder: signal delivery to the run, queued input to the session |
| Lifetime | while the workflow is enabled and the trigger is `active` (not `paused`) | while the holder is alive (section 7) |

## 7. Subscriptions

A Subscription is a live, correlated claim on future events held by a run or a session. It dies with its holder; nothing else ends it.

### 7.1 Run-held subscriptions

- **Instantiated at run start**, one per signal trigger in the frozen plan ([./07-workflows.md](./07-workflows.md)). Editing the workflow never affects them.
- **Correlate lazily.** A signal trigger declares two expressions: an event-side expression over `event` and a holder-side expression over run state (`inputs.*`, `steps.<id>.output.*`). Both evaluate at match time against the run's *current* state; they match when the values are equal. There is no resolvability analysis at run start: an unresolved reference (the step that produces the PR number has not run yet) is simply a no-match for that event.
- **Alive until the run reaches a terminal state** (completed, failed, cancelled). No timeouts in v1. A run waiting forever is visible in the run view and cancelable by the user. Consequence for workflow authors: design runs to end at the right moment (correlate on PR-merged, not PR-created).
- Delivery is a signal-delivery effect row; consuming it, the run fires the signal node's outgoing edges and records the firing as a step record ([./07-workflows.md](./07-workflows.md) section 2.4). A subscription may match any number of times over the run's life.
- **Not held before the key exists.** An event that arrives before the run-side correlation value resolves is a no-match and is never revisited; the matcher does not replay past events against later run state (Post-v1). The window is negligible in practice because the key appears in the same step that creates the thing the event is about.

### 7.2 Session-held subscriptions

- **Registered by the session itself** through the ordinary `subscription.create` operation (`subscription` grant), via the `hercule` CLI: the response to a spawn-type op teaches the follow-up (`subscribe for updates: hercule subscription create run:r_3`). The canonical long-wait pattern is start, subscribe, end turn; the event wakes the session. No polling surface and no blocking waits ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)).
- A registration names a **target**, one of four kinds ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2): `run` (the `run.*` kinds for that run), `session` (the `session.*` kinds for that session), `ref` (any event whose `refs` include that External Ref), `request` (the decision on a Permission Request). The controller expands the target into the pipeline's matching condition and stores both. No free-form CEL target in v1. *(Amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81): the controller accepts `ref` and `run` targets, and refuses `session` and `request` targets with `invalid_state` because nothing they wait on is emitted yet; [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2.)*
- **Delivered as queued input**: the matched event is rendered as text plus its structured payload and queued for the session's next turn boundary. It never steers a running turn by default.
- **Two load-bearing uses:** mid-session artifacts (an agent opens PR #87 mid-task and subscribes to its checks and reviews) and assistants (long-lived, no run to hold claims). An assistant conversation's subscriptions migrate to the successor session at rotation ([./12-assistants.md](./12-assistants.md)); a workflow agent step's session subscriptions die with that session.


## 8. Connections

A Connection is a core-owned record naming one external account. The core owns storage, listing, status, and the single connected-accounts screen; plugins declare which Connection types they service and drive the flow that establishes one.

### 8.1 Record

| Field | Notes |
|---|---|
| `id` | |
| `type` | The **qualified id** of a plugin-declared connection type, `<pluginId>/<word>`: `github/github`, `gmail/gmail`, `discord/discord`, `slack/slack`. The record carries no separate plugin id; the type names its plugin ([ADR 0034](../adr/0034-a-catalog-contribution-is-identified-by-its-qualified-id.md)). Two plugins wanting the same service each define their own type; the user authenticates twice (accepted cost, ADR 0010). |
| `label` | User-given: "work", "personal". Optional at setup: a new Connection given none is named after the account, its `displayName`, or the connection type's own name (such as "GitHub") when that is empty or only whitespace, cut to at most 128 UTF-16 code units without splitting a character. Editable afterwards; a reconnect keeps it *(amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323))*. |
| `displayName` | The account name the type's `validate` returns: the GitHub login, the Gmail address ([./05-plugins.md](./05-plugins.md) section 10.1). Not user-editable, and a rename leaves it as it was; only a new sign-in (a reconnect, or new credentials) updates it *(added 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323))*. That sign-in must be to the same account (section 8.4), so the name changes only when the account was renamed at the provider *(amended 2026-10-02, [#326](https://github.com/theagenticage/hercule/issues/326))*. |
| `accountId` | The provider's stable id for the account, which `validate` returns beside `displayName` (GitHub: the numeric user id). A rename of the account does not change it, so a reconnect checks it to stay on the same account (section 8.4). Required and never empty: the core treats a `validate` that returns an empty one as failed. Internal: the API never returns it *(added 2026-10-02, [#326](https://github.com/theagenticage/hercule/issues/326))*. |
| `credentials` | References into the secrets table, owner scope `connection` ([./13-security.md](./13-security.md)). Never returned by the API; references only. |
| `status` | `connected | needs-reauth | error | disabled` (the v1 enum, consolidated from pinned lifecycle facts: plugins report expiring tokens, disabled Connections stop ingest). Ingest runs ~~only in `connected`~~ in `connected` and `error` *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)*, so a Connection in `error` goes back to `connected` ~~after its next successful poll~~ *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* once every one of its feeds has polled successfully since its handle opened ([./05-plugins.md](./05-plugins.md) section 8.1). |
| `labels[]` | Bare strings, same flat namespace as Task labels. ~~At minimum the Connection's **default topic**, chosen at setup:~~ The Connection's topics: the Topic its events file into and the label triage puts on a Proposal unless content says otherwise ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)). May be empty, and a new Connection starts with none; edited afterwards with `connection.update`, where `[]` clears them *(amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323))*. |
| `config` | Per-Connection plugin config against the ~~plugin's declared schema (e.g. the GitHub watch list)~~ Connection type's `configSchema` (GitHub: extra repositories to watch, and the checks window) *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)*. Rendered as a generated form. |
| `feedIntervals` | *(Added 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The user's interval for each feed, in seconds: a map from feed name to seconds, empty by default. A feed left out polls at its default. `connection.update` replaces the whole map, and refuses a feed the type's event source does not declare or a value below the feed's floor. At most 32 entries, each at most 86,400 s. |
| `createdAt`, `updatedAt` | |

Channel accounts (Discord, Slack bot tokens) are Connections too, but channels are not event sources: inbound chat messages do not flow through the pipeline as Events in this spec (`source` has no `discord`/`slack` value); whether they should is Open in [./12-assistants.md](./12-assistants.md). Channel Bindings reference channel Connections ([./12-assistants.md](./12-assistants.md)), and notification delivery toggles are per channel Connection ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)). A connected account can play two roles: event source and Resource (a mailbox).

### 8.2 Per-Connection ingest

~~An event-source plugin runs one ingest loop per Connection of its type, started at plugin `activate()` for every `connected` Connection and stopped when the Connection leaves that status, is deleted, or the plugin is disabled. Per-Connection loop state (cursors, watch-list diffs) lives in plugin KV keyed by Connection id.~~ Every emitted event carries `connectionId`. ~~Event polling pauses during controller promotion ([./03-controller-and-runners.md](./03-controller-and-runners.md)).~~

*(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The core opens one ingest handle per Connection of the source's type that is `connected` or `error` while the plugin is active. It closes the handle when the Connection is deleted, disabled or `needs-reauth`, or the plugin stops, and closes and reopens it when the Connection's `config` or `feedIntervals` change. The core compares what is open with what should be open every 2 seconds. Per-Connection state (cursors, snapshots) lives in the `connection_state` table, deleted with the Connection or by Reset plugin state ([./05-plugins.md](./05-plugins.md) section 6). Promotion is not built, so nothing pauses for it yet. *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* When the controller shuts down, it stops each running plugin: it closes the plugin's handles, then deactivates it ([./05-plugins.md](./05-plugins.md) section 8). An ingest handle cannot write to a Connection that was deleted or left `connected` and `error`: its emits and state writes are refused from the moment that change commits.

### 8.3 Explicit Connection selection

- **Triggers** on a Connection-bearing source select their Connections explicitly through the `EventSelector`'s `connectionId` ([./07-workflows.md](./07-workflows.md)): a named Connection id, or a deliberate `any` (the field omitted on purpose). There is no silent "all": the editor and the API make "any" an explicit choice when the kind belongs to a plugin source, never a default. Triggers on core emitters (cron, manual, platform) carry no selection.
- **Outbound actions** name the Connection they act as. The Connection is reachable from workflow inputs like any envelope field: the start trigger maps `event.connectionId` onto an input, the action step references `inputs.connection`. Reply-as-the-triggering-account needs no other machinery. Acting via a Connection requires the ~~`connections.use`~~ `connection.use` grant; creating or editing one requires ~~`connections.manage`~~ `connection.manage` ([./13-security.md](./13-security.md)). *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The grants are spelled as in [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2~~, where `connection.use` is checked only when `run.start` is sent a workflow~~. *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* That section lists every operation that checks `connection.use`: whoever chooses the Connection a step acts through needs it, whether by saving the workflow, by sending one to `run.start`, by giving a Connection input a value, or by posting a synthetic event (section 5.4).
- **Resources** may reference the Connection used to reach them: a mailbox Resource references its `gmail` Connection, a repo Resource the `github` Connection that clones it ([./02-domain-model.md](./02-domain-model.md)). Git credentials for checkouts derive from that reference ([./13-security.md](./13-security.md), [ADR 0016](../adr/0016-git-credentials-derive-from-connections.md)). Consolidated rule (not pinned by a ticket): deleting a Connection that Resources or triggers reference is refused until they are re-pointed. *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* So is deleting a Connection that a workflow step names as a literal id in its `connection` param. The refusal is `invalid_state` and lists everything that names the Connection. Every trigger counts, start or signal, active or paused: a paused trigger can be resumed, and it would then wait for events from a Connection that no longer exists.

### 8.4 Health

A plugin reports credential trouble (refresh failure, revoked token) by setting the Connection's status to `needs-reauth` or `error` and emitting a Notification through the `notifications` plugin capability. *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* For ingest, the core sets the status from what `open` and `poll` return: an `AuthError` sets `needs-reauth` and raises no Notification, and 5 failures in a row set `error` and raise `core.connection-error` ([./05-plugins.md](./05-plugins.md) section 8.1). *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* An `AuthError` is ignored when the Connection's credentials changed while the open or the poll ran, so a reconnect that lands in the middle is not undone by the old token's rejection. The `notifications` capability is not built yet. The Connections screen shows status per Connection and offers reconnect, which re-runs the setup flow and (consolidated rule) keeps the Connection id, so triggers and Resources stay attached. It also keeps the Connection's label, topics and config; a token flow started for a reconnect refuses them, and `connection.update` changes them *(amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323))*. *(Amended 2026-10-02, [#326](https://github.com/theagenticage/hercule/issues/326).)* A reconnect must sign in to the same account, because the kept id would otherwise move the Connection's triggers, Resources and outbound actions to another account without telling anyone. How the core checks the account, and how each setup flow reports a refusal, is in [./05-plugins.md](./05-plugins.md) section 10.1. A channel handle's `status()` maps into the same axis: `disconnected` becomes `error` (with detail), `degraded` stays `connected` with a warning line; `needs-reauth` always means credential failure.

## 9. Connection setup flows

Policy (from [./13-security.md](./13-security.md)): bring-your-own OAuth client where the provider demands ~~one~~ a client secret, no Hercule-hosted OAuth relay, paste-a-token as the universal fallback. A public client id for a device flow is shippable *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*. Credential storage, encryption, and refresh mechanics are owned by [./13-security.md](./13-security.md); this section states only what each Connection needs and how the user gets there. Facts from research/connection-setup-ux.md (branch `research/connection-setup-ux`).

### 9.1 ~~Two~~ Three flow shapes

The plugin declares its setup flow through the `connections` capability; the core renders it in the Connections screen and stores the result. The declaration shape (setup step list, `validate`, the core OAuth2 client, pending-setup rows and `state` routing; the device flow client and its pending device setup rows, *amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183)*) is pinned in [./05-plugins.md](./05-plugins.md) section 10.1.

1. **Token paste** (universal): the user pastes a token, the plugin validates it against the provider (e.g. `GET /user`), the core stores it and sets `connected`. Primary path for ~~GitHub,~~ Slack, Discord; the fallback for GitHub *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*.
2. **OAuth redirect** to the controller's own origin: the core serves `/oauth/callback` on whatever origin the user's browser already uses to reach Hercule, and **displays the exact redirect URI to register**, derived from that request origin. The flow carries a state parameter bound to the pending Connection; the callback exchanges the code, stores the tokens it receives as the `oauth.tokens` secret, and sets `connected`. Primary path for Google.
3. **Device flow** (RFC 8628) through an OAuth App whose public client id the plugin ships *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*. The core asks the provider for a code and shows the user the code and the provider's verification page. The user enters the code there and approves; meanwhile the client (the web app, or `hercule connection poll-device-flow`) polls the controller, and the controller asks the provider whether the user has approved. When the provider issues the token, the plugin validates it, and the core stores it and sets `connected`. No redirect URI and no client secret are involved. Primary path for GitHub.

*(Amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183).)* **A type may offer more than one flow, and the user picks one for each Connection.** GitHub offers the device flow and token paste, so a work account behind an org that blocks third-party OAuth apps can paste a token while a personal account signs in. The flow belongs to the Connection, not to its type: the core reads it from the secrets the Connection holds (a token set, or the pasted fields). A reconnect offers the same choice as a first setup, and replaces whichever secrets the Connection held. It keeps the Connection's label, topics and config *(amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323))*, and whichever flow it uses, it must sign in to the same account (section 8.4) *(amended 2026-10-02, [#326](https://github.com/theagenticage/hercule/issues/326))*. A type never offers both a redirect flow and a device flow. The rules are in [./05-plugins.md](./05-plugins.md) section 10.1.

Tailscale Funnel is never required: the browser performing the redirect can already reach the controller. The only public-endpoint case (webhooks) is post-v1.

### 9.2 Google (Gmail)

Device flow is a dead end: Google's limited-input device flow excludes Gmail scopes. The setup steps Hercule documents and its setup screen walks through:

1. Serve Hercule on an HTTPS tailnet origin: enable MagicDNS and HTTPS in Tailscale, run `tailscale cert`, serve at `https://<node>.<tailnet>.ts.net`. Google validates the redirect URI *string* (HTTPS, not a raw IP, host under a public-suffix domain - `ts.net` qualifies), not reachability. Private LAN IPs and `.local` / `.internal` names are rejected.
2. Create a GCP project, enable the Gmail API, configure the consent screen with user type External, and **publish it to production without verification** (sanctioned for personal use under 100 users). Workspace accounts choose Internal instead and skip the warning. Staying in "Testing" yields 7-day refresh tokens and is unacceptable for an always-on controller.
3. Add the authorized domain and the redirect URI Hercule displays (`https://<node>.<tailnet>.ts.net/oauth/callback`), create a Web application client, paste client id and secret into the Gmail plugin's settings (client id = plugin config, client secret = plugin-owned secret; one client serves every `gmail/gmail` Connection, [./05-plugins.md](./05-plugins.md)).
4. Connect; click through the "unverified app" warning once (Advanced > Go to app). Result: a non-expiring refresh token.

**Localhost fallback:** `http://localhost:<port>` / `http://127.0.0.1:<port>` are exempt from Google's HTTPS rule but resolve on the *browser's* machine, so they work only when the user browses from the controller host. Hercule documents this as a same-machine fallback, never the default.

**Documented expectation:** Gmail-scoped refresh tokens die on a Google password change; the Connection then goes `needs-reauth` and the user reconnects.

### 9.3 GitHub

- ~~**Primary: PAT paste.** A classic PAT gives full API coverage; a fine-grained PAT works where its gaps do not bite (no Packages, no Checks API, single org, no outside-collaborator access). Setup is: settings page, generate, paste. GitHub removes classic PATs unused for a year.~~
- ~~**Optional: device flow.** Works with full OAuth scopes and non-expiring tokens and needs no redirect URI, but requires the user to create their own OAuth app and enable device flow on it first; strictly more ceremony than a PAT for one user. Offered as an optional path, not the default.~~

*(Amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183).)* The `github/github` type offers two flows, and the user picks one per Connection.

- **Primary: device flow through Hercule's own OAuth App.** The user presses Connect, Hercule shows an 8-character code and links to `github.com/login/device`, and the user approves there. There is no token to generate and no app to register. The GitHub plugin ships the app's public client id; the device flow needs no client secret and no callback URL, which is also how `gh` signs in. Scopes are `repo read:org notifications workflow`, the set a classic PAT needs for the same coverage. `workflow` is what lets an agent push a change under `.github/workflows`; it also lets the token edit the repository's CI. A user who wants narrower access pastes a fine-grained PAT instead. An OAuth App token does not expire and comes with no refresh token, so it is never refreshed. When GitHub rejects it (the user revoked it, or GitHub removed it), the Connection goes `needs-reauth` and the user reconnects.
- **Fallback: PAT paste.** For an account the device flow cannot reach, such as one in an org that blocks third-party OAuth apps. A classic PAT gives full API coverage; a fine-grained PAT works where its gaps do not bite (no Packages, no Checks API, single org, no outside-collaborator access). Setup is: settings page, generate, paste. GitHub removes classic PATs unused for a year.
- **A standing commitment.** Hercule's OAuth App lives under a GitHub account or org that keeps it, with device flow enabled in its settings. Turning device flow off stops new sign-ins, because GitHub then refuses to start a device flow for the app. Whatever makes GitHub reject the app's tokens, such as deleting the app, sends every device-flow Connection to `needs-reauth` at once.
- The redirect flow also works against the tailnet origin (GitHub's rules are lenient) but buys nothing over device flow; not offered. It would also need a client secret at the token exchange, which a shared app cannot ship (PKCE does not replace it at GitHub).
- **Device-code phishing.** The client id is shared and public, so anyone can start a device flow as Hercule's app and trick a user into entering the attacker's code. The user would then grant the attacker a token. GitHub's approval page shows the app's name and the scopes it asks for. The user should enter only a code their own Hercule showed them. Hercule cannot prevent this; it comes with every device flow ([./13-security.md](./13-security.md) §12).
- **Deleting a Connection does not revoke its token.** Revoking an OAuth App token at GitHub needs the app's client secret, which Hercule does not ship. The web app's delete confirmation says that Hercule does not revoke the credential at the provider, and the docs point to `github.com/settings/applications`. The same holds for a pasted PAT, which the user revokes where they created it.

### 9.4 Slack and Discord

Token paste. Discord: one bot token, validated with `GET /users/@me`. Slack: **two** tokens - the bot token (`xoxb-`) and the app-level token (`xapp-`, scope `connections:write`) that Socket Mode needs - validated with `auth.test` and `apps.connections.open`. The plugin's setup flow shows the platform-side checklist (Discord intents and invite URL; Slack Socket Mode, event subscriptions and scopes) and ends with pairing the owner's platform identity by DMing the bot a one-time code ([./12-assistants.md](./12-assistants.md) sections 4.1 and 11.5). Enabling notification delivery on the connection asks for a notification container (a channel or the owner's DM).

## 10. The events view

The Intake and check-in screens read per-Connection events straight from the pipeline: the events view is the event log filtered by `connectionId` since the user's "last checked" marker, joined to the trigger-effect rows and subscription effect rows the matcher wrote, to the Tasks whose provenance carries the event, and to the Notifications that list it in `subject`. Each event row is stamped with what triage made of it - "→ *task*" (proposal or attached), offer, FYI, unsure, known, held, pending triage, no action - derived from those joins alone; nothing is stored on the event, and the stamp table is owned by [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 3. Held events from a tripped spawn bound appear there with the rest. The view needs nothing beyond persist-all, the effect rows and the entities triage wrote; the drawer is owned by [./14-web-app.md](./14-web-app.md).

## Post-v1

- **Webhook ingress core service**: a capability plugins request; unlocks GitHub push/commit and Actions triggers. Strongly desired and non-negotiable post-v1; priority raised again by the checks-polling cost (section 5.1). V1 keeps the emit path push-agnostic and the kind namespace open so webhook-fed kinds land additively.
- **Gmail Pub/Sub pull ingress**: second-level latency upgrade; the plugin interface stays push-agnostic in v1, and polling remains the fallback Google itself recommends.
- **Platform-auto subscription detection** (the controller noticing "this session opened PR #87" and subscribing it): explicit session subscription (section 7.2) is the v1 primitive it builds on.
- **Subscription timeouts**: none in v1; a forever-waiting run is visible and cancelable.
- **OAuth-identity dedup across Connection types**: v1 accepts double authentication when two plugins want one service.
- **Per-agent git identity** (agent to Connection association): v1 identity follows the repo ([./13-security.md](./13-security.md)).
- **Agent-tools extension point** for mid-session mailbox queries: v1 covers it with Gmail action steps plus MCP passthrough.
- **Scheduled-tasks view** over cron triggers: the trigger table is already queryable; the view is ruled post-v1 by [./14-web-app.md](./14-web-app.md).

## Sources

Tickets:

- Event & trigger ingress design - https://github.com/theagenticage/hercule/issues/14
- Research: event ingress options - https://github.com/theagenticage/hercule/issues/5
- Research: smoothest Connection-setup path - https://github.com/theagenticage/hercule/issues/32
- Prototype: the Intake view - https://github.com/theagenticage/hercule/issues/30
- Triage engine & user-set bounds - https://github.com/theagenticage/hercule/issues/15
- Agent-operates-system surface - https://github.com/theagenticage/hercule/issues/16
- Security & secrets model - https://github.com/theagenticage/hercule/issues/18
- Plugin architecture - https://github.com/theagenticage/hercule/issues/11
- Workflow model - https://github.com/theagenticage/hercule/issues/13
- Task model - https://github.com/theagenticage/hercule/issues/29
- Controller state store - https://github.com/theagenticage/hercule/issues/9
- Assistant design - https://github.com/theagenticage/hercule/issues/17
- Assemble the v1 spec (ticket 30 handoff comment) - https://github.com/theagenticage/hercule/issues/21
- Plugin contribution interfaces and v1 event kinds - https://github.com/theagenticage/hercule/issues/41

ADRs:

- [ADR 0009 - All events flow through one persisted pipeline](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)
- [ADR 0010 - External accounts are core-owned Connections](../adr/0010-external-accounts-are-core-owned-connections.md)
- [ADR 0011 - Triage is a workflow pattern inside core-enforced bounds](../adr/0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md)
- [ADR 0016 - Git credentials derive from Connections](../adr/0016-git-credentials-derive-from-connections.md)
- [ADR 0025 - Enrichment re-matches one event, idempotently](../adr/0025-enrichment-re-matches-one-event-idempotently.md)
- [ADR 0004 - Controller state lives in one SQLite database](../adr/0004-controller-state-lives-in-one-sqlite-database.md)
- [ADR 0034 - A catalog contribution is identified by its qualified id](../adr/0034-a-catalog-contribution-is-identified-by-its-qualified-id.md)

Research: research/event-ingress.md (branch `research/event-ingress`), research/connection-setup-ux.md (branch `research/connection-setup-ux`), research/expression-language.md (branch `research/expression-language`).
