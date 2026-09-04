<!--
SPEC. Rules for any agent editing this file; keep these comments in place.
- AC and AD IDs are append-only. Never renumber or reuse one. Retire an item by striking it through with a reason.
- Every AC has a verification method. One that can't be verified is rewritten until it can be, or becomes an AD.
- Status goes draft -> locked. Changing a locked AC or AD needs a decision by the user, recorded in the WORKLOG.
-->

# SPEC: Tasks, Projects, and the event log (ticket #59)

**Status:** locked
**Created:** 2026-09-04 - **Locked:** 2026-09-04

## Goal

The user and the agents have nowhere to put intent. Hydra has no Task, no Project,
and an event log only the audit writer can reach. This ticket adds the Task and
Project domains, opens the event log for reading, and replaces the Tasks screen
placeholder with a real screen.

Success looks like: `hydra task create/query/read/update/delete` and
`hydra project ...` work against a running controller; `hydra event query` shows
the `task.*` rows those calls produced, each stamped with its actor; the Tasks
screen lists, filters, full-text searches and edits tasks in a right-hand drawer.

**Scale:** three new contract groups (12 operations), one migration adding four
tables and an FTS5 index, two new controller domains, one new reader service, one
rewritten screen, and about six new components in `@hydra/ui`.

**Stakes:** high and mostly one-way. The operation ids, routes and payload shapes
are the published API that the CLI, the web app, the derived client and the
built-in workflow actions all read; changing them later breaks every one at once.
The event log is the audit log, so a wrongly stamped row is a false security
record - which is exactly the bug the ticket comment reports.

## Non-goals

- No `/projects` route and no Projects screen. Spec 14 pins the URL space; in v1
  a Project is created from the CLI and the Tasks screen reads and sets its id.
- No `/tasks/{id}` route. Detail is a drawer over the list (AD-6).
- No label registry, no label colours or descriptions, no create-label operation.
- No trigger matching, no subscriptions, no held events. `event.query`'s
  `triggerId` and `runId` filters belong to the workflows ticket (AD-3).
- No task pruning, no map fog, no Kanban grouping, no vectors, no subtasks,
  dependencies, comments or assignees.
- No retention prune job. This ticket only reads the log.

## External contracts

| System | Contract | Verified how | Date |
|---|---|---|---|
| SQLite in Bun 1.4.0 (`bun:sqlite`) | SQLite 3.43.2, compile options include `ENABLE_FTS5`. `CREATE VIRTUAL TABLE ... USING fts5(a, b, tokenize='unicode61 remove_diacritics 2')` succeeds; `MATCH 'cafe'` finds the row `'Café Naïve'`; `bm25(t)` returns a negative rank. Script and captured output beside this file in `fts5check.md`. | `bun run fts5check.ts` against an in-memory `bun:sqlite`, on the version in `.bun-version` (1.4.0) | 2026-09-04 |
| `@effect/sql-sqlite-bun` 4.0.0-rc.112 | Migrations are `Effect` values yielding one tagged-template statement at a time (`apps/controller/src/db/migrations/0001-initial.ts`), applied by `SqliteMigrator` inside one transaction. A migration issuing many statements, including `CREATE VIRTUAL TABLE` and `CREATE TRIGGER`, is the established shape. | read `db/migrate.ts`, `db/migrations/index.ts`, `0001-initial.ts` | 2026-09-04 |
| `packages/cli` command tree | `tree.ts` derives every command from the `HttpApi` AST plus `OPERATIONS`, so the CLI needs no code. Constraints it imposes: a field is string, number, boolean, a list of one of those, or JSON; a list becomes a repeatable flag; a struct or a list of structs becomes one `json` flag; an operation counts as paged only if its query schema has a `sort` field. | read `packages/cli/src/commands/tree.ts` | 2026-09-04 |

## Architectural decisions

### AD-1: A failed login is stamped `actor: null`, not a new actor value
The envelope's `actor` is already `Actor or null` in spec 08 §2 and the `events.actor`
column is already nullable. The contract gains `NullableActor = Schema.NullOr(Actor)`
for the Event schema, `AuditEntry.actor` widens to `Actor | null`, and
`auth.login.failed` passes `null`. The actor vocabulary in `ids.ts` is untouched.
- **Rationale:** null already means "no actor caused this" for ingested and cron
  events. An `anonymous` value would amend spec 11 §3.1 and spec 02 §Actor to say
  something null already says. Rejected.
- **Check:** tool: AC-14's test.

### AD-2: `task.update` takes `addLabels?` / `removeLabels?`, never a whole `labels` array
`provenance?` on update means append; entries are never edited or removed.
- **Rationale:** the user and a triage agent write the same task. A whole-array
  replace silently clobbers a concurrent edit; add/remove does not. Spec 09's
  `task.updated` payload already reports labels as `{added, removed}`.
- **Check:** reviewer: `task.update`'s payload schema has no `labels` key.

### AD-3: `event.query` declares `connectionId?`, `kind?`, `since?`, `until?` only
`triggerId` and `runId` from spec 11 §2 are added by the workflows ticket, which
completes this operation rather than changing it. Spec 11 records that.
- **Rationale:** triggers, runs and held events do not exist. Declaring a filter
  that always answers empty is a silent substitution.
- **Check:** reviewer: spec 11 §2 carries the note.

### AD-4: `event.query` returns both populations, discriminated by `kind`
Pipeline events and audit entries come back from one operation behind one grant,
`event.read`. No population filter.
- **Rationale:** the ticket's motivation is that the user reads failed logins in
  this log. Cost accepted: any holder of `event.read` reads every security entry.

### AD-5: FTS5 is an external-content table over `tasks`, tokenizer `unicode61 remove_diacritics 2`
Callers pass plain words in `text`. The service tokenizes on whitespace, quotes
each token, and joins them with `AND` to build the `MATCH` expression. Raw FTS5
`MATCH` syntax is never exposed. Synchronising triggers on `tasks` keep the index
current; the search joins back to `tasks` and filters `deleted_at IS NULL` there.
- **Rationale:** verified available (External contracts). `remove_diacritics 2`
  is the Unicode-correct setting. Exposing raw `MATCH` would make a syntax error
  in a search box a 500 and would leak the storage engine into the public API.
- **Check:** tool: AC-6, AC-7.

### AD-6: Task detail is a right-hand drawer over `/tasks`
Opening a task sets a search parameter on `/tasks`; Esc and the backdrop close it.
No `/tasks/{id}` route.
- **Rationale:** spec 14 pins the URL space and the design language pins detail to
  a right-hand drawer, never a page or a permanent split. The `Drawer` primitive
  is new in `@hydra/ui` and Intake will reuse it.
- **Check:** tool: AC-18.

### AD-7: When `text` is present the order is relevance and an explicit `sort` is refused
`task.query` with `text` orders by `bm25` ascending and pages by offset, per spec
11 §1.6. With `text` and an explicit `sort`, the operation fails `validation`
naming both. Without `text`, sort is keyset over `updatedAt|createdAt|priority|status`,
default `updatedAt desc`. `event.query` sorts on `id` only, default `id desc`, keyset.
- **Rationale:** honouring both would mean two paging strategies chosen silently
  per request; ignoring the sort is a silent substitution, which the hard rules
  forbid. Refusing says what happened.
- **Check:** tool: AC-8.

### AD-8: `task.*` rows are appended through the existing audit writer
`task.created/updated/deleted` are matchable platform events and `project.*` are
audit kinds, but nothing matches anything yet and both populations share the
`events` table. One row per operation, written in the mutation's transaction
through `AuditLog.append`. The workflows ticket introduces the matchable-kind list.
- **Rationale:** a second writer for the same table, with no matcher to serve,
  is an abstraction with one consumer.
- **Check:** reviewer: no second insert path into `events`.

### AD-9: Paging primitives widen rather than fork
`db/page.ts` gains an integer-id keyset cursor (event ids are integers, and the
existing `decodeCursor` requires a UUID) and an offset cursor for relevance paging.
Both carry the same `CursorScope`, so a cursor stays valid only for the identical walk.
- **Check:** tool: AC-9.

### AD-10: Provenance entries are child rows, and `task.query` returns them inline
Spec 04 pins child rows, spec 11 §1.3 pins `<entity>.query` returning `<Entity>[]`.
One join per page, never a query per task.
- **Check:** reviewer: no per-row query in the task repository.

## Acceptance criteria

| ID | Criterion | Verification |
|---|---|---|
| AC-1 | The contract declares `task.query/read/create/update/delete`, `project.query/read/create/update/delete`, `event.query/read` with the routes and grants of spec 11 §1.4 and §6.1, and the `OPERATIONS` table and the `HttpApi` declaration stay one-to-one. `grants.test.ts` still passes. | test @ `packages/contract`: `pnpm test` (`api.test.ts`, `grants.test.ts`) |
| AC-2 | Given a fresh database, when the migration set applies, then `tasks`, `projects`, `task_provenance` and `project_resources` exist; every index on `tasks` and `projects` is partial `WHERE deleted_at IS NULL`; the FTS5 table and its three triggers exist. Applying the set twice is a no-op. | test @ `TestDatabase` + `sqlite_master`: `pnpm test` (`db/migrations` test) |
| AC-3 | Given `TaskService.create({title, description})`, then the returned Task has `status: "open"`, `priority: "normal"`, `labels: []`, `provenance: []`, equal `createdAt`/`updatedAt`/`statusChangedAt`, and a canonical UUIDv7 id. A title outside 1..N or a missing title is `validation`. | test @ `TaskService.create`: `pnpm test` (`tasks/service.test.ts`) |
| AC-4 | Given a Task, when `TaskService.update` changes only `description`, then `statusChangedAt` is unchanged and `updatedAt` moves; when it changes `status`, both move. `addLabels`/`removeLabels` add and remove without touching the rest; adding a label twice yields one. `provenance` on update appends and never removes. An unknown id is `not_found`. | test @ `TaskService.update`: `pnpm test` (`tasks/service.test.ts`) |
| AC-5 | Given a Task, when `TaskService.delete` runs, then `deletedAt` is set, `read` answers `not_found`, `query` and full-text search exclude it, and the row still exists in `tasks`. Deleting twice is `not_found`. | test @ `TaskService.delete`: `pnpm test` (`tasks/service.test.ts`) |
| AC-6 | `TaskService.query` matches `refs`, `labels`, `status` and `projectId` by exact identity, any-of within a field and AND across fields: two statuses match either, a status plus a label matches only tasks with both. An empty filter returns every live task. | test @ `TaskService.query`: `pnpm test` (`tasks/service.test.ts`) |
| AC-7 | Given tasks whose title or description hold the words, `query({text: "café naive"})` matches on either field, matches regardless of diacritics and case, and never matches on a label or a ref. `text: "AND OR \"("` is treated as plain words and returns a result set, not an error. | test @ `TaskService.query`: `pnpm test` (`tasks/service.test.ts`) |
| AC-8 | `task.query` without `text` defaults to `updatedAt desc` and pages by keyset; with `text` it orders by relevance and pages by offset; with `text` and an explicit `sort` it fails `validation` naming both. An unknown sort field is `validation`. `event.query` accepts `id` only, defaults to `id desc`. A full walk of seven rows at limit 2 returns each row exactly once, with and without `text`. Exactly-once is over the snapshot the walk started on: the keyset walk holds against a row inserted or deleted under it, while the relevance walk resumes by offset, so a matching row created between two pages makes one row repeat and a deleted one makes one row skip. | test @ `GET /tasks`, `GET /events`: `pnpm test` (`http/task.integration.test.ts`, `http/event.integration.test.ts`) |
| AC-9 | A cursor is `validation` when replayed on a different operation, field or direction, for the UUID keyset, the integer keyset and the offset cursor alike; an edited or foreign cursor is `validation`; a cursor round-trips its key and id unchanged. | test @ `db/page.ts`: `pnpm test` (`db/page.test.ts`) |
| AC-10 | A provenance entry with none of `ref`, `eventId`, `runId` is `validation`, on `create` and on `update`. `at` and `actor` are core-stamped and are refused if supplied. Entries are only ever appended. | test @ `TaskService.create`/`update`: `pnpm test` (`tasks/service.test.ts`) |
| AC-11 | An External Ref is accepted only as `<system>:<kind>:<identity>` with a lowercase system and no whitespace; `github:issue:owner/repo#42` is accepted, `GitHub:issue:x`, `github:issue`, and `github:issue:a b` are each `validation`. Two tasks may carry the same ref. | test @ the contract's `ExternalRef` schema and `TaskService.create`: `pnpm test` (`packages/contract/src/groups/task.test.ts`, `tasks/service.test.ts`) |
| AC-12 | `project.create/read/update/delete` behave as AC-3 to AC-5 do for Task: soft delete, `read` answers `not_found`, `query` excludes. A resource may join many projects and a project many resources through `project_resources`; a soft-deleted project leaves its tasks' `projectId` set. | test @ `ProjectService`: `pnpm test` (`projects/service.test.ts`) |
| AC-13 | Every Task mutation writes exactly one event row in the mutation's transaction, and none when the mutation fails: `task.created` carries the full snapshot, `task.updated` carries `{taskId, changes}` with `{old,new}` per scalar and `{added,removed}` per array (provenance `removed` always empty), `task.deleted` carries the final snapshot. Every row carries the caller's actor, and no payload repeats it. | test @ `TaskService` + `AuditLog.listByKind`: `pnpm test` (`tasks/service.test.ts`) |
| AC-14 | Given a login with a wrong password, when it fails, then the `auth.login.failed` row's `actor` is `null` and no row claims `user`. The contract's Event `actor` decodes `null`. | test @ `POST /auth/login`: `pnpm test` (`auth/service.test.ts`, `http/event.integration.test.ts`) |
| AC-15 | `GET /events` filters by `connectionId`, `kind`, `since` and `until`, any of them combined, and returns both populations: a `task.created` row and an `auth.login.failed` row come back from one unfiltered call, told apart only by `kind`. `GET /events/{id}` returns one row and `not_found` for an unknown id. Event ids are integers on the wire. | test @ `GET /events`, `GET /events/{id}`: `pnpm test` (`http/event.integration.test.ts`) |
| AC-16 | Against the compiled binary, `hydra task create`, `hydra task query --status open --label x`, `hydra task read <8-char tail>`, `hydra task update`, `hydra task delete`, `hydra project create`, `hydra project query` and `hydra event query --kind task.created` each succeed and print the expected row; `hydra task --help` lists the five verbs with no CLI code added. | test @ `hydra` binary: `pnpm build:binary && pnpm test:binary` (`e2e/api.test.ts`) |
| AC-17 | Rendering `/tasks` with a stubbed API shows one row per task with its title, priority glyph, status, labels and project; typing in the search box calls `task.query` with `text`; choosing a status filter calls it with `status`; with no tasks it shows the pinned copy "No tasks yet." and its lead sentence verbatim. | test @ `renderApp({path: "/tasks"})` + `stubApi`: `pnpm test` (`routes/_shell/tasks.integration.test.tsx`) |
| AC-18 | Clicking a task row opens a right-hand drawer showing status, priority, labels, project and the provenance list; changing status calls `task.update` and any status reaches any other; Esc closes the drawer; the browser URL never becomes `/tasks/<id>`. | test @ `renderApp({path: "/tasks"})` + `stubApi`: `pnpm test` (`routes/_shell/tasks.integration.test.tsx`) |
| AC-19 | The new `@hydra/ui` primitives (`Drawer`, `PriorityGlyph`, `Textarea`, `ListRow`) render their states, and `PriorityGlyph` fills 1-3 bars using `--faint`/`--muted`/`--ink` and no colour token. | test @ `@hydra/ui`: `pnpm test --project react` (`primitives/*.test.tsx`, `styles.test.ts`) |
| AC-20 | The spec records the decisions: 09 §Search names the tokenizer and the plain-words wrapper and no longer says "verify at build time"; 04 §Engine no longer says "verify at build time" for FTS5; 11 §2 records `event.query`'s declared filter subset and the sort enums of `task.query` and `event.query`; 16-open-items no longer lists the FTS5 availability or tokenizer entries. | tool: `grep -n "Verify at build time" docs/spec/04-state-store.md docs/spec/09-tasks.md` returns nothing. ~~and `grep -n "FTS5" docs/spec/16-open-items.md` returns nothing~~: 16-open-items strikes a resolved item in place rather than deleting it, so the word survives inside the struck lines and the grep can never be empty (D-11). The struck entries are read instead. |
| AC-21 | ADR 0019's sentence "Hard delete is allowed" is replaced by the soft-delete rule spec 09 and spec 02 pin, with the supersession noted. | tool: `grep -n "Hard delete is allowed" docs/adr/0019-*.md` returns nothing |
| AC-22 | `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm dep-lint` are green, and the runner entrypoint still links no controller package. | tool: the four check commands |
| AC-23 | Every Project mutation writes exactly one event row in the mutation's transaction, and none when the mutation fails: `project.created` and `project.deleted` carry the snapshot, `project.updated` carries per-field diffs. Every row carries the caller's actor. | test @ `ProjectService` + `AuditLog.listByKind`: `pnpm test` (`projects/service.test.ts`) |

### Residual manual checks

- AC-17, AC-18: the repo has no screenshot or visual-diff tooling, so spacing,
  alignment, drawer motion and the 0.66 opacity on low-priority and finished rows
  are a person's eye on `pnpm --filter @hydra/web dev`. The rendering tests cover
  structure and behaviour only.

## Slices

| # | Slice | Covers | Done when |
|---|---|---|---|
| 1 | Contract, migration, paging primitives | AC-1, AC-2, AC-9 | The three contract groups are declared and one-to-one with `OPERATIONS`; the migration creates the four tables, the partial indexes and the FTS5 table with its triggers; `db/page.ts` carries the integer keyset and offset cursors. |
| 2 | The Task domain | AC-3, AC-4, AC-5, AC-6, AC-7, AC-10, AC-11, AC-13 | `TaskService` implements all five operations over a real database, with FTS, soft delete, provenance and the three `task.*` events. |
| 3 | The Project domain | AC-12, AC-23 | `ProjectService` implements all five operations, the join table works, and `project.*` rows land in the log. |
| 4 | The event reader, the routes, and the actor fix | AC-8, AC-14, AC-15, AC-16 | `event.query/read` read the log; all twelve operations are reachable over HTTP and from the compiled binary; `auth.login.failed` is stamped `null`. |
| 5 | The Tasks screen | AC-17, AC-18, AC-19 | `/tasks` lists, filters and full-text searches, and the drawer edits a task. |
| 6 | Spec documents and the finish pass | AC-20, AC-21, AC-22 | The decisions are written into the spec, the open items are struck, ADR 0019 is corrected, and the four checks are green. |

Slice 4 carries the HTTP routes for all three families rather than each slice
carrying its own, because `HttpApiBuilder` builds all groups or none: a half-built
route layer does not compile, so the routes land once every service exists.
