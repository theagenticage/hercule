# State store

The controller keeps everything it durably owns in one SQLite database file inside the Data Root, accessed through per-entity repository interfaces and driven by `bun:sqlite`. Truth is plain relational rows, not an event-sourced log; the two genuinely log-shaped data sets (the domain event log and the per-session normalized streams) are append-only tables written in the same transaction as the state they accompany. Queues, schedules, delivery attempts and consumer cursors are ordinary rows, so a restart reloads them and no broker exists. Every consumer of committed events reads from a durable cursor and produces effects at-least-once behind uniqueness constraints and outbox rows. Streaming deltas are coalesced in memory and flushed at message and turn boundaries. Workspace contents, provider-native session state and process logs live outside the store, and nothing in the file references an absolute path, so backup and promotion are one-artifact stories. Rationale for the engine and truth-model choices: [ADR 0004](../adr/0004-controller-state-lives-in-one-sqlite-database.md).

## Engine and driver

- The store is **one SQLite database file** in the Data Root (`~/.hydra/data/` by default; layout in [./15-packaging-and-operations.md](./15-packaging-and-operations.md)). No Postgres, no dialect-agnostic SQL layer, no second data file.
- The driver is **`bun:sqlite`**, which is blessed for `bun build --compile` (`research/bun-compile.md` on branch `research/bun-compile`). On macOS Bun uses Apple's system SQLite, on Linux its own statically linked build; both are newer than 3.27, so `VACUUM INTO` is available. No SQLite extensions are loaded (extension loading on macOS would require shipping a dylib; nothing needs one).
- The database runs in **WAL mode** (`PRAGMA journal_mode = WAL`).
- The controller is the **only writer process** ([ADR 0002](../adr/0002-orchestration-stays-on-the-controller.md): one brain). Runners never open the file; the runner entrypoint must not even import the DB engine ([ADR 0018](../adr/0018-hydra-ships-as-one-self-contained-binary.md) mode isolation).
- Repository SQL uses SQLite features freely: JSON functions, upserts, partial indexes, FTS5 (task search, see below). There is no lowest-common-denominator constraint.

**Verify at build time:** the pinned Bun version's bundled SQLite (Linux) and the minimum macOS system SQLite both ship FTS5 enabled; Hydra needs FTS5 for `hydra task query` and cannot load it as an extension on macOS.

## Repository interfaces

The swap seam is the **per-entity repository interface**, not a query builder.

- Every entity family (tasks, runs, sessions, workflows, events, notifications, connections, plugins, secrets, ...) is reached through a TypeScript repository interface. Callers (the service layer of [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md), the event pipeline, the scheduler) depend on the interface only.
- SQL lives inside repository implementations and commits to SQLite. A future engine swap rewrites repository internals; callers do not change.
- Multi-repository writes that must be atomic (a state change plus its log rows plus its effect rows) run inside one transaction. The sources pin the atomicity only; this spec's choice for the mechanism is that the caller opens the transaction and passes it to the repositories, and repositories never open their own transaction for a write that a caller may want to compose.
- **Tests run against `:memory:` SQLite**, opened with the same migrations as production. There are no mock repositories. The same repository implementation is exercised in tests and in production.

The domain entities and their fields are specified in [./02-domain-model.md](./02-domain-model.md); this document covers how they are stored, not what they contain.

## Truth model

State is **plain relational rows**. The current value of a task, run, session record, workflow, connection or plugin flag is the row itself; nothing is rebuilt from a log on boot, and there are no deciders, projectors or cursor bootstraps.

Two data sets are append-only and log-shaped, and they are stored as append-only tables:

1. **The event log** - every Event (external ingest, cron ticks, manual and synthetic events, platform events such as `run.completed`) plus internal audit entries (actor-stamped mutations, security events). One envelope per row; the envelope fields are specified in [./08-events-and-connections.md](./08-events-and-connections.md). This table is also the audit log (below).
2. **Per-session normalized streams** - the provider-agnostic session events (`session.*`, `turn.*`, `item.*`, `request.*`, coalesced `content.delta`, usage, runtime warnings) specified in [./06-providers.md](./06-providers.md), stored per Session as they arrive from runners.

Both tables are written **in the same transaction as the state they accompany**. When a run reaches a terminal state, the run row update, the `run.completed` event row and the resulting notification row commit together. When a session turn completes, the session record update and the `turn.completed` stream row commit together. One embedded database makes this atomic without an outbox between state and log.

Every append-only table carries a **monotonic position** (a single integer sequence assigned at insert, per table for the event log and per session for streams). Positions are what consumers store as cursors and what live topics replay from on reconnect ([./14-web-app.md](./14-web-app.md): append-only streams carry payload deltas with cursor replay; mutable records get invalidation nudges and an HTTP refetch). [./08-events-and-connections.md](./08-events-and-connections.md) uses the event log position as the event's `id`.

This document owns the id format for Hydra-owned entities. It is not pinned:

**Open:** the id format for Hydra-owned entities (UUID variant, ULID, or integer rowid) is a build-time choice; tickets write typed references such as `run:1234` and `session:<id>` without fixing the format behind them. Related and equally unpinned: whether the event table's primary key is the log position itself (as 08 currently uses for `id`) or a Hydra id plus a separate position column. Whatever is chosen, the position column stays the cursor unit and the ordering the matcher and live topics rely on.

Stream rows come from runners over the runner protocol, which numbers runner-to-controller events with a monotonic sequence and replays a disk-backed outbox after a disconnect ([./03-controller-and-runners.md](./03-controller-and-runners.md)). The stream insert MUST be idempotent on that runner sequence number so replay after a reconnect or a promotion never duplicates rows.

Run records **copy their triggering event** into the run row at run start ([ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)), so pruning the event log never breaks a run's audit trail. Runs also freeze their execution plan ([ADR 0001](../adr/0001-runs-freeze-an-execution-plan.md)); the frozen plan, resolved inputs, triggering event, per-step records and failure reason are all columns or child rows of the run, never references into mutable workflow rows ([./07-workflows.md](./07-workflows.md)).

## Queues and scheduling are rows

There is no Redis, no broker, no in-process-only queue. Every piece of "what happens next" state is a row reloaded on boot:

| Row family | What it holds | Owner doc |
|---|---|---|
| Pending runs | runs created by the matcher or by direct creation, waiting for placement | [./07-workflows.md](./07-workflows.md) |
| Placement queue | runs or sessions waiting for a runner that is at `maxConcurrentSessions`; visible in the UI, never spilled to another runner | [./03-controller-and-runners.md](./03-controller-and-runners.md) |
| Queued Input | user or subscription input held for a session until its running turn completes; editable and cancelable until flushed on `turn.completed` | [./06-providers.md](./06-providers.md) |
| Cron triggers | each cron start trigger as a queryable row with `{schedule, timezone}` and its next fire time; missed ticks while the controller was down are skipped with a visible note | [./08-events-and-connections.md](./08-events-and-connections.md) |
| Subscriptions | live correlated claims held by runs and sessions; die with their holder | [./08-events-and-connections.md](./08-events-and-connections.md) |
| Held events | events matched by a trigger whose spawn bound tripped; held visibly until the user resumes or discards | [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) |
| Outbox rows | external side effects with attempt counts and retry state (chat posts, channel notification deliveries, plugin API calls) | this document |
| Consumer cursors | the durable position of every core consumer of committed events (matcher, notification router, channel deliverers); plugins only emit and never consume the log | this document |

The scheduler and every consumer start from these rows on boot. A crash between committing an effect row and performing the effect is recovered by re-reading the row, which is why effects are at-least-once (next section).

## Side-effect consumers: durable cursors, at-least-once

Every consumer of committed events reads from a **durable cursor** stored in the database and advances it in the same transaction that records its output. The rejected alternative is an in-memory pub/sub bridge between the log and side effects, which loses effects on crash ([ADR 0004](../adr/0004-controller-state-lives-in-one-sqlite-database.md), [ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)).

**The matcher** is the canonical consumer. In one transaction it: reads events past its cursor; evaluates every enabled start trigger and every live Subscription; fans out to all matches; inserts the resulting **effect rows** (a pending run, a signal delivery to a run, a Queued Input for a session); advances its cursor. Filter or correlation errors evaluate as no-match and record a health warning; they never abort the transaction.

**Effect-row uniqueness replaces a delivered-events table.** Effect rows carry UNIQUE constraints on `(trigger id, event id)` and `(subscription id, event id)`. If the controller crashes after committing some effects and before advancing the cursor, re-processing the same events hits the constraints and produces nothing new. There is no separate delivery-tracking table.

**Outbox rows for anything that leaves the database.** Chat posts, channel deliveries of a Notification, and plugin-initiated external API calls are inserted as outbox rows in the transaction that decides them, then performed by a worker that records each attempt (attempt count, last error, next retry) on the row. Where the external system offers an idempotency key, the outbox row's id is used as that key. Delivery attempts are rows, never process memory.

**Guarantee statement.** Exactly-once applies to in-database state changes only, because they commit atomically with the cursor. External effects are at-least-once. Implementers of a consumer MUST assume they can observe the same event twice and make the second observation harmless through uniqueness or idempotency keys.

Runner-side effects (starting a session, delivering Queued Input) ride the runner protocol's sequence and ack mechanism ([./03-controller-and-runners.md](./03-controller-and-runners.md)); the controller-side record of what has been acknowledged is again a row.

## Streaming deltas are coalesced

Provider streaming deltas (`content.delta` with `streamKind` `assistant_text`, `reasoning_text` or `command_output`) are **never persisted per token**. The controller buffers deltas per item in memory and flushes one coalesced stream row per item at message boundaries (item completion) and at turn boundaries (`turn.completed`). The persisted stream therefore contains completed messages and command outputs, not a token history.

Actively watched sessions still see tokens live: the web app's live topic passes deltas through ephemerally while a client is watching ([./14-web-app.md](./14-web-app.md)); on reconnect the client falls back to the coalesced rows. A crash mid-turn loses only the not-yet-flushed tail of the running item; the runner's provider-native transcript remains resumable ([ADR 0003](../adr/0003-sessions-run-as-bare-processes.md)).

**Open:** the flush cadence within a long-running item (for example a command whose output runs for minutes) is unspecified. Ticket 9 pins message and turn boundaries only; an implementer needs a decision on whether a partial flush happens on a size or time threshold inside one item.

## What is in the store and what is not

Rule: **if it is durable and domain-relevant, it is a row in the one file.** In the store:

- All domain entities: Tasks (with provenance entries as child rows and an FTS5 index over title and description for `hydra task query`, [./09-tasks.md](./09-tasks.md)), Projects, Resources, Workspaces and Checkouts as records, Agents, Assistants, Conversations and session lineages, Sessions as records with their SessionBinding to a provider-native id, Runs with frozen plans and step records, Workflows and their triggers, Connections, Notifications, runner records (identity, labels, probed facts, state, and the hash of the runner's credential: an opaque random token stored hashed like every other token, ticket 18).
- The event log and per-session streams.
- Queues, schedules, subscriptions, held events, outbox rows and cursors (above).
- Workflow definitions. A Workflow is a stored, editable record; there is no repo-local config and no workflow file on disk ([./01-overview-and-scope.md](./01-overview-and-scope.md)).
- Assistant memory: the `core` document and topic documents are rows, canonical on the controller ([ADR 0014](../adr/0014-assistants-remember-through-distilled-memory-not-merged-sessions.md), [./12-assistants.md](./12-assistants.md)).
- Plugin state: enabled flag, config against the manifest schema, the persisted contribution catalog, namespaced KV (below).
- Secrets, encrypted per value (below).
- User credentials: the password hash and the hashes of every opaque token (login bearer tokens, API keys, session tokens, runner credentials). All tokens are opaque-random and stored hashed; there are no cookies or web session records ([./13-security.md](./13-security.md), [ADR 0017](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)).
- Controller identity: the controller id and its key material, created at install and carried in the promotion bundle ([ADR 0005](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)).
- Setup state and the one-time setup token for first run ([./15-packaging-and-operations.md](./15-packaging-and-operations.md)).
- Configuration other than pre-DB-open keys. `config.toml` holds only what is needed before the database opens (data root, bind address, log level); every other setting is a row.

Outside the store:

- **Workspace contents and provider-native session state.** These live on runner disk under the runner's own storage directory; the controller stores runner-owned paths only as opaque facts keyed by id ([./03-controller-and-runners.md](./03-controller-and-runners.md)). Losing a runner loses resumability and workspaces, never history.
- **Process logs** of the controller and runners: rotated files under `~/.hydra/logs/`, machine-bound.
- **Backups**: `~/.hydra/backups/`, machine-bound.
- **The master key**: OS keychain (macOS `security` CLI via subprocess; keytar is archived), or a plain key file on headless Linux. It never enters the database and never leaves its machine.

There is **no controller-side blob directory** in v1. Artifacts are out of v1 scope; when blob storage arrives it MUST live inside the Data Root so it moves with the bundle (ticket 10). Promotion duration growing with blob volume is the accepted cost; streaming or resumable transfer is the known escape hatch.

## Relocatable Data Root, no absolute paths

The Data Root is the unit promotion moves ([ADR 0005](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)), so the database must be valid wherever the directory lands:

- **No absolute paths in the database.** Anything the controller stores about its own machine is expressed relative to the Data Root. Repositories MUST reject or normalize absolute paths on write. The Data Root's own location comes from `config.toml` or `HYDRA_HOME`, never from a row.
- **Runner-side paths are runner-owned opaque facts keyed by id.** The controller never rewrites them; they stay valid across promotion because runner disks do not move.
- The promotion bundle is the database file plus packed secrets (re-encrypted under a key derived from the promotion token). During transfer the old controller holds the store **read-only**: event polling and mutations pause, in-flight sessions keep running on runners and buffer to their outboxes, and their streams replay into the new controller's store after the switch. Ceremony and sealing are in [./03-controller-and-runners.md](./03-controller-and-runners.md).

## Secrets table

All secret values (Connection credentials, plugin secrets, runner-scoped secrets, core secrets) are rows in **one owner-scoped secrets table** with owners `connection | plugin | runner | core`. The `runner` owner kind is reserved for runner-scoped secrets; the per-runner credential itself is not in this table, it is a token stored hashed on the runner record (above). Each value is encrypted per value under the Master Key; the SQLite file itself stays plain, so any copy of the file, backup or bundle is inert without the key. Secret values never appear in the event log, in API responses or in process logs; other rows hold references to secret rows, never values. The plugin secrets service is a scoped view over this table (owner `plugin`, namespaced by plugin id). Promotion export enumerates and re-encrypts these rows under a token-derived key and the new controller re-wraps them under its own Master Key. Everything else about secrets, keys and credentials is in [./13-security.md](./13-security.md) and [ADR 0015](../adr/0015-secrets-are-encrypted-per-value-under-a-keychain-held-master-key.md).

**Open:** the location of the plain-key-file fallback (headless Linux) is unspecified. It must sit outside the Data Root and outside `backups/`, otherwise the bundle and offsite backups stop being inert; the packaging layout in ticket 24 names no directory for it.

## Plugin namespaced KV

Plugin state is a **namespaced key-value table inside the same database**: `(plugin id, key) -> JSON value`. The host API hands each plugin a KV service bound to its own namespace; a plugin cannot read or write another plugin's keys. Values are JSON so nothing non-serializable crosses the host API. Plugin config (validated against the manifest schema) and the enabled flag are separate rows owned by the core, not KV entries; a plugin reads its config through the host API. The contribution catalog produced by `register()` at boot is persisted so workflow validation and UI pickers read the catalog, never the live plugin ([./05-plugins.md](./05-plugins.md), [ADR 0006](../adr/0006-plugins-request-capabilities-and-register-contributions-in-code.md)).

## Event log as audit log, and retention

The event log **is** the audit log; there is no separate audit subsystem.

- Every mutation through the service layer is stamped `actor: user | session:<id>` and recorded as an event log entry (ticket 16). Task priority changes, status changes and provenance appends are examples: `task.updated` carries `{taskId, actor, changes}`.
- Security event kinds are part of the log: login success and failure, API key minted and revoked, permission request raised and decided, secret created and rotated ([./13-security.md](./13-security.md)).
- Hard-deleting a Task removes the row; the event log keeps the audit ([./09-tasks.md](./09-tasks.md)).

Retention (this document owns the final statement; other documents link here):

- **The event log and the per-session streams are TTL-pruned, default 90 days** ([ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md); [ADR 0004](../adr/0004-controller-state-lives-in-one-sqlite-database.md) as amended 2026-08-28, which withdraws its original "keep everything in v1"). Events are persisted whether or not they match; the prune runs periodically on the controller.
- **Security events and actor-stamped mutations are kept at least 90 days** (ticket 18), independently of the event TTL.
- **Domain rows are never pruned.** Tasks, Runs, Sessions, Workflows, Connections, Notifications and the rest stay until the user deletes them. Run records copy their triggering event, so pruning the log never leaves a run without its cause.
- The two windows are the controller-state settings `retention.events` and `retention.security` ([./15-packaging-and-operations.md](./15-packaging-and-operations.md)).

**Open:** the concrete defaults for `retention.events` and `retention.security` are not pinned beyond "~90 days" (ADR 0009) and "90 days" (ticket 18); ticket 18 also calls the event TTL "short" relative to the security window, so the two defaults may be meant to differ.

## Backups

- **Daily online backup**: `VACUUM INTO` from the running controller to `backups/<timestamp>.db` under Hydra Home (`~/.hydra/backups/`), with short retention. `VACUUM INTO` produces a consistent single-file snapshot without stopping writers and works under WAL. Secrets inside the snapshot stay encrypted; offsite backup is the user copying that directory, which is honest because the snapshot is inert without the Master Key.
- **Backup before migrations**: a timestamped copy of the database file is taken before any boot-time migration runs (next section).
- Restore is a file replacement while the controller is stopped; there is no in-app restore in v1. (This spec's reading of ticket 24, which pins backups only; restore mechanics are not pinned.)

**Open:** "short retention" for daily backups has no number (count or days) in ticket 24 or ADR 0018.

**Open:** the time of day for the daily backup and whether it is user-configurable are unspecified.

## Migrations on boot

- Migrations are **forward-only** and **embedded in the binary** as inline SQL strings or embedded files (`with { type: "file" }` or `--asset`); never loaded from filesystem-relative `.sql` paths, which do not exist inside a compiled binary (`research/bun-compile.md`).
- On `hydra serve`, after the pre-migration backup, all pending migrations run **inside one transaction**; the schema version is recorded in the database.
- An **older binary meeting a newer database refuses to start** with a clear message. There are no down migrations.
- First run on an empty Data Root creates the file and applies every migration as part of auto-initialization; the CLI never prompts ([./15-packaging-and-operations.md](./15-packaging-and-operations.md)).
- Tests apply the same migration set to `:memory:`, so migration drift is caught by every test run.

## Post-v1

- Live replication or continuous backup (Litestream-style) for the store; v1 keeps the single-file, single-writer layout that makes it a drop-in.
- Controller-side blob or artifact storage; v1 pins that it must live inside the Data Root.
- Engine swap away from SQLite if multi-tenant hosting ever arrives; v1 keeps the repository seam and no SQL outside repositories.
- Retention beyond TTL prune (archival export of old events); v1 keeps run rows self-contained so pruning is safe.
- Memory document version history (flagged in ticket 31, owned by [./12-assistants.md](./12-assistants.md)); the retrofit is an additive table.

## Sources

Tickets:

- Controller state store - https://github.com/rogierpennink/hydra/issues/9
- Controller promotion & portability - https://github.com/rogierpennink/hydra/issues/10
- Plugin architecture: API shape, loading, dogfooding - https://github.com/rogierpennink/hydra/issues/11
- Provider adapter interface (queue as controller-owned state, coalesced deltas) - https://github.com/rogierpennink/hydra/issues/12
- Workflow model: recipes, triggers, human gates (run record contents) - https://github.com/rogierpennink/hydra/issues/13
- Event & trigger ingress design - https://github.com/rogierpennink/hydra/issues/14
- Triage engine & user-set bounds (held events) - https://github.com/rogierpennink/hydra/issues/15
- Agent-operates-system surface (actor stamping in the event log) - https://github.com/rogierpennink/hydra/issues/16
- Security & secrets model - https://github.com/rogierpennink/hydra/issues/18
- Web app architecture (cursor replay, live delta passthrough) - https://github.com/rogierpennink/hydra/issues/19
- Controller packaging & install story - https://github.com/rogierpennink/hydra/issues/24
- Task model (FTS search, hard delete) - https://github.com/rogierpennink/hydra/issues/29
- Research: Bun compile feasibility matrix - https://github.com/rogierpennink/hydra/issues/34
- Controller/runner architecture: registration, placement, scheduling (runner outbox, state ownership) - https://github.com/rogierpennink/hydra/issues/7

ADRs:

- [ADR 0001 - Runs freeze an execution plan](../adr/0001-runs-freeze-an-execution-plan.md)
- [ADR 0002 - Orchestration stays on the controller](../adr/0002-orchestration-stays-on-the-controller.md)
- [ADR 0003 - Sessions run as bare processes](../adr/0003-sessions-run-as-bare-processes.md)
- [ADR 0004 - Controller state lives in one SQLite database](../adr/0004-controller-state-lives-in-one-sqlite-database.md)
- [ADR 0005 - Promotion is migration behind a stable controller identity](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)
- [ADR 0006 - Plugins request capabilities and register contributions in code](../adr/0006-plugins-request-capabilities-and-register-contributions-in-code.md)
- [ADR 0009 - All events flow through one persisted pipeline](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)
- [ADR 0014 - Assistants remember through distilled memory](../adr/0014-assistants-remember-through-distilled-memory-not-merged-sessions.md)
- [ADR 0015 - Secrets are encrypted per-value under a keychain-held master key](../adr/0015-secrets-are-encrypted-per-value-under-a-keychain-held-master-key.md)
- [ADR 0018 - Hydra ships as one self-contained binary](../adr/0018-hydra-ships-as-one-self-contained-binary.md)

Research: `research/bun-compile.md` (branch `research/bun-compile`).
