<!--
WORKLOG. The state that survives sessions. Created empty at spec lock. The locked SPEC is the only design document; nothing from the interview lands here.
- Status, Findings and Decisions are kept current: latest truth wins, no duplicate rows.
- Journal is append-only: one entry per skill run, newest last. Never edit a past entry.
Any agent picking up work reads SPEC.md, then this file top to bottom. The last handoff block says where to resume.
Every skill run ends by appending a journal entry with a handoff block, even when it failed or was interrupted. `implement` also updates Status; `review` only updates Findings.
-->

# WORKLOG: Tasks, Projects, and the event log (ticket #59)

## Status

- **State:** done
- **Current slice:** 6 (last)
- **Blocked on:** none
- **Journey:** not recorded; the eight screenshots under `evidence/` stand in its place

| # | Slice | Status | Evidence |
|---|---|---|---|
| 1 | Contract, migration, paging primitives | done | AC-1: `vitest run packages/contract` -> 54 passed, the twelve new operations one-to-one with the table. AC-2: `vitest run apps/controller/src/db/migrations` -> 6 passed, four tables, partial indexes, `tasks_fts` and its three triggers, plus `vitest run apps/controller/src/db/migrate.test.ts` -> 12 passed, the set is a no-op twice. AC-9: `vitest run apps/controller/src/db/page.test.ts` -> 20 passed. `pnpm typecheck` is red, and 58 HTTP tests fail, only on the three new contract groups having no route handlers until slice 4 (F-2); `pnpm lint` and `pnpm dep-lint` are green. |
| 2 | The Task domain | done | AC-3, AC-4, AC-5, AC-6, AC-7, AC-10, AC-13: `vitest run apps/controller/src/tasks` -> 34 passed. AC-11: the same run, plus `vitest run packages/contract/src/groups/task.test.ts` -> 2 passed, the ref grammar as the package exports it. `pnpm lint` and `pnpm dep-lint` green; `pnpm typecheck` and 58 HTTP tests still red on F-2 alone, unchanged by this slice. |
| 3 | The Project domain | done | AC-12, AC-23: `bun --bun run vitest run --project node apps/controller/src/projects` -> 18 passed, the five operations, the join table both ways, a task keeping its `projectId` past its project's delete, and one `project.*` row per mutation. `pnpm lint` and `pnpm dep-lint` green; `pnpm typecheck` and 58 HTTP tests still red on F-2 alone, unchanged by this slice. |
| 4 | The event reader, the routes, and the actor fix | done | AC-8: `vitest run --project node apps/controller/src/http/task.integration.test.ts apps/controller/src/http/event.integration.test.ts` -> 16 passed, both default orders, the refused `text`+`sort` pair, an unknown sort field, and a seven-row walk at limit 2 with and without `text`. AC-14: the same run plus `vitest run --project node apps/controller/src/auth` -> 8 passed, `auth.login.failed` stamped `null` through the service and on the wire. AC-15: the same event run, both populations from one call, all four filters, `GET /events/{id}` and its 404. AC-16: `pnpm build:binary && pnpm test:binary` -> 8 passed (2 files), the twelve operations out of `./hydra`. AC-22 is reachable for the first time: `pnpm typecheck`, `pnpm lint`, `pnpm test` (606 + 139 passed), `pnpm dep-lint` all green. Transcript: `docs/plans/P001-tasks-projects-event-log/evidence/cli-session.md`. |
| 5 | The Tasks screen | done | AC-17, AC-18: `vitest run --project react apps/web/src/routes/_shell/tasks` -> 16 passed, the row anatomy, the four filters, search and status going to the controller, both empty states, the composer, and the drawer with its provenance, its any-to-any status and its Esc, plus the five the review round forced. AC-19: `vitest run --project react packages/ui/src/primitives/list.test.tsx` -> 15 passed, the four primitives and the glyph carrying no colour token. All four checks green, plus `pnpm build:binary && pnpm test:binary` -> 8 passed. Visual proof at 1440x900 against `./hydra serve` with a seeded project and eight tasks, in both themes: `evidence/tasks-empty-{light,dark}.png`, `evidence/tasks-list-{light,dark}.png`, `evidence/tasks-search-{light,dark}.png`, `evidence/tasks-drawer-{light,dark}.png`. |
| 6 | Spec documents and the finish pass | done | AC-20: `grep -n "Verify at build time" docs/spec/04-state-store.md docs/spec/09-tasks.md` returns nothing; 09 §Search names the tokenizer `unicode61 remove_diacritics 2` and the plain-words wrapper; 11 §2 carries the sort enums and defaults of `task.query`, `project.query` and `event.query`, `event.query`'s shipped filter subset with the note on what the workflows ticket adds, the `receivedAt` axis and both populations; 13 §11 lists the new `task.*` and `project.*` kinds. AC-21: `grep -n "Hard delete is allowed" docs/adr/0019-*.md` returns nothing, and the ADR carries a dated amendment pointing at spec 02 and spec 09. AC-22: all four checks green. |

## Findings

| ID | Sev | Finding | Ref | Status | Rounds seen |
|---|---|---|---|---|---|
| F-1 | P2 | ADR 0019 still says "Hard delete is allowed", superseded by spec 09 and spec 02. Boyscouting, folded into slice 6. | AC-21 / `docs/adr/0019-*.md` | fixed | - |
| F-2 | P1 | The branch cannot be green between slices 1 and 3. Declaring the three groups in `api` leaves `HttpApiBuilder.layer(api)` without their handlers, which is 3 typecheck errors and 58 failing HTTP tests, every one of them the same "HttpApiGroup task not found". Fixed in slice 4: the three handler groups landed and all four checks are green. | Slices note / `apps/controller/src/http/routes.ts` | fixed | - |
| F-3 | P3 | The SPEC's Scale line and slice 4 said thirteen operations where AC-1 lists twelve (5 task, 5 project, 2 event). Both now say twelve. | SPEC Scale, slice 4 | fixed | - |
| F-4 | P1 | The offset cursor's scope did not include what the result set depends on, so page two of one search decoded cleanly against another and skipped rows. Fixed in slice 2: a relevance walk's scope is its match expression plus its filter, so a cursor replayed under other words or another filter is `validation`. | AD-9 / `apps/controller/src/tasks/repository.ts` | fixed | 2 |
| F-5 | P2 | Spec 09's `ProvenanceEntry` sketch still types `eventId` as a string, which spec 04 and spec 11 §1.4 contradict. Corrected in slice 6: the sketch types `eventId` as the integer log position. | D-7 / `docs/spec/09-tasks.md` | fixed | 1 |
| F-6 | P2 | The FTS triggers do not survive `INSERT OR REPLACE` on `tasks`: the displaced row is removed without firing the delete trigger, leaving stale terms in the index. The task repository writes only INSERT, UPDATE and DELETE, and a reviewer probing edits, soft deletes and status changes found no stale term. Slice 3 has no reason to write tasks at all. | `apps/controller/src/db/migrations/0003-tasks-and-projects.ts` | held | 2 |
| F-7 | P3 | A search whose text holds no letter or digit (`"+++"`) answers with an empty page rather than `validation`. Accepted: the index holds no punctuation either, so the search is one that can match nothing, not one that was refused. | AD-5 / `apps/controller/src/tasks/repository.ts` | accepted | 2 |
| F-9 | P2 | `project.query` shipped with no test: the keyset walk, its sort fields and its cursor scope were a new code path nothing exercised. Fixed in slice 3 with a full-walk test at page size 1 and 2 over three orders, and a cursor replayed under another field and another direction. | `apps/controller/src/projects/service.test.ts` | fixed | 1 |
| F-10 | P2 | A project's description could be set but never taken off again: `description` is optional on the row and the update payload had no way to spell "remove it". Fixed in slice 3: `project.update` takes `description: null`, as `task.update` takes `projectId: null`. | `packages/contract/src/groups/project.ts` | fixed | 1 |
| F-11 | P3 | A hand-edited cursor whose sort key is a number where the column holds text restarts the walk rather than failing, because SQLite orders every number below every string. Accepted: the token is opaque, the trigger is editing it, and the outcome is a repeated page rather than a skipped row. The clean fix is for the scope to carry the key's type, which is `db/page.ts` and touches every walk. | AD-9 / `apps/controller/src/db/page.ts` | accepted | 1 |
| F-12 | P3 | `ScalarChange` is declared identically in the task and the project service. Accepted: the task service pairs it with a `ListChange` a project has no use for, and lifting one of the pair into a shared module would split it. | `apps/controller/src/projects/service.ts` | accepted | 1 |
| F-13 | P3 | One description edit writes a `project.updated` payload holding both sides, so a worst case is two 64 KiB strings in one event row, and the log is kept 90 days. Task's `task.updated` has the same shape; Project is the second entity to take it, which makes it a pattern rather than a case. Held for a decision on whether a diff should carry a long field's value at all. | `apps/controller/src/projects/service.ts` | held | 1 |
| F-14 | P2 | A `since`/`until` window sorts the whole matched window on every page: the filter is on `received_at`, the order is on `id`, so SQLite reads `events_received_at` and then a temp b-tree. Measured at 200k rows: 15.7 ms per page for a whole-log window, and it does not get cheaper as the walk advances. Accepted: the fix is to translate the window into id bounds with two point lookups, which is real code for a cost only a very long window pays, and no criterion asks for it. Recorded so the ingest ticket can take it. | AD-3 / `apps/controller/src/events/reader.ts` | accepted | 1 |
| F-15 | P2 | One row the contract's `Event` cannot encode turns every listing that touches it into a 500, unfiltered `GET /events` included. Not reachable now - the audit writer is the only writer and it writes well-formed rows - so skipping the bad row would be handling a state the system rules out. Held for the ingest ticket, which is where a vendor payload first reaches the table. | `apps/controller/src/events/reader.ts` | held | 1 |
| F-16 | P2 | The CLI answers a JSON flag it cannot encode with the envelope `{"code":"internal"}` and exit 1, because `client-core` folds every failure that is not a decoded envelope into `internal`. `task.create --provenance` is the first JSON flag in the product, so this is newly reachable although the code is older than this ticket. Nothing was sent, so the honest answer is a command-line error. Fixed in slice 6: `client-core` tells a request that was never sent from a response it could not read and fails the first as `RequestError`, and the CLI reports it as a usage error naming the flag, exit 2. Tests in both packages. | `packages/client-core/src/errors.ts` | fixed | 1 |
| F-17 | P3 | AC-16 names `e2e/api.test.ts` and the flag `--label x`; the test shipped as `e2e/cli.test.ts` and the derived flag is `--labels`. `e2e/api.test.ts` runs against source under `pnpm test`, and AC-16 asks for the compiled binary, so a new file in the `binary` project is the only place the criterion can be met. The flag name is what the contract's field is called; a singular alias would be CLI code, which AC-16 forbids. | AC-16 / `e2e/cli.test.ts` | accepted | 1 |
| F-18 | P3 | `Unauthenticated` sits in the error union of the task, project and event services but `requireGrant` only ever fails `Forbidden`, so it is unreachable in all three. Accepted: cutting it from one of the three would make the three disagree, and it becomes reachable the moment a session actor exists. | `apps/controller/src/events/reader.ts` | accepted | 1 |
| F-8 | P3 | The priority rank is spelled in the migration's expression index and again in the repository, and nothing but a matching string makes SQLite use that index. A test now walks the four priorities one row at a time, which fails if either copy drifts. | `apps/controller/src/tasks/repository.ts` | accepted | 2 |
| F-19 | P2 | The Tasks screen ships no priority filter, although the ticket asked for one: `task.query` declares `refs`, `labels`, `status`, `projectId` and `text` and nothing for priority. Filtering the loaded page in the browser would show a filtered page over an unfiltered walk, which is the silent substitution the hard rules forbid. Recorded rather than built: adding `priority` to `TaskFilter` is a contract change and a decision. Accepted for this ticket and put to the reviewer on the pull request. | AC-17 / `packages/contract/src/groups/task.ts` | accepted | - |
| F-20 | P2 | One task the contract's `Task` cannot decode empties the whole Tasks screen, because the page decodes as a unit. The same shape as F-15 on the reader, and unreachable for the same reason - the only writer is `TaskService`, which writes what the schema says. Recorded against the ingest ticket, which is where a foreign row first reaches these tables. | `apps/web/src/routes/_shell/tasks/index.tsx` | held | - |
| F-21 | P3 | `pnpm test` collected the whole repository a second time out of `.claude/worktrees/<agent>`, so 137 tests failed on paths that are another agent's copy of this tree. Boyscouting, fixed in slice 5: the `node` project excludes `**/.claude/**`, and the directory is gitignored. | `vitest.config.ts` | fixed | - |
| F-22 | P1 | A write the controller refused said nothing at all: neither mutation read its error, so a 403 on `task.update` left the drawer showing the old status and a 500 on `task.create` left the composer sitting there. The write was lost in silence, which the hard rules forbid outright. Fixed in slice 5: both the composer and the drawer render the controller's own message, and two tests hold it. | `apps/web/src/routes/_shell/tasks/index.tsx` | fixed | 1 |
| F-23 | P1 | A task naming a project the picker did not hold - one past the page of projects that was read, or one whose project has been deleted, which the contract pins as a thing that happens - rendered a select whose value matched no option, so the browser showed the first: **No project**. The screen stated something untrue about the task. Fixed in slice 5: the select offers the task's own project, named by its id tail, and the row says the same. | `apps/web/src/routes/_shell/tasks/-detail.tsx` | fixed | 1 |
| F-24 | P1 | The drawer read its task out of the listing, so `?task=<id>` for a task on no fetched page opened nothing and said nothing, and an edit that took the task out of the current filter unmounted the panel the user was working in. Fixed in slice 5: the drawer reads `task.read` and falls back to the listed row only until that answers, so it survives both. | `apps/web/src/routes/_shell/tasks/index.tsx` | fixed | 1 |
| F-25 | P2 | Three smaller ones from the same round, all fixed in slice 5: the Labels filter asked the controller once per keystroke where the search box settles first; the drawer heard Escape on the document, so one press closed both the marks legend over it and the drawer; and it claimed `aria-modal` while the page behind it stayed focusable. Escape is now heard on the panel and the claim is gone. | `packages/ui/src/primitives/drawer.tsx` | fixed | 1 |
| F-26 | P2 | One edit invalidates `["tasks"]`, which refetches every page the user has loaded: three requests after two `Show more` clicks. Accepted: the alternative is patching the cached page in place, which means the client deciding what the server would have answered, and the walk is short by construction. | `apps/web/src/routes/_shell/tasks/index.tsx` | accepted | 1 |
| F-27 | P2 | The drawer's selects are controlled from the task, with no optimistic update, so on a slow controller a chosen status snaps back for the length of the round trip and the user clicks again. Accepted for now: an optimistic patch is a second copy of what the mutation does, and the failure it would mask is exactly what F-22 now shows. | `apps/web/src/routes/_shell/tasks/-detail.tsx` | accepted | 1 |
| F-28 | P2 | The task list is not virtualized, against spec 14's pinned performance guardrail 3, although it is unbounded by design: `Show more` appends pages without limit. No criterion asked for it and TanStack Virtual is a new dependency, so it is recorded rather than built. Accepted for this ticket and put to the reviewer on the pull request. | Spec 14 §Performance guardrails / `apps/web/src/routes/_shell/tasks/index.tsx` | accepted | 1 |
| F-29 | P3 | "Nothing matches these filters." is new copy: spec 14's pinned empty-state table has the no-tasks-at-all case and nothing for a filter that matched nothing. The screen needs both. Fixed in slice 6: the table has a **Tasks, filtered** row in the Tasks screen's voice. | `docs/spec/14-web-app.md` | fixed | 1 |
| F-30 | P3 | Spec 09's CLI table and its Provenance paragraph both said "hard delete", contradicting the same document's own Delete section. Boyscouting, fixed in slice 6 with the other spec edits. | `docs/spec/09-tasks.md` | fixed | - |
| F-31 | P1 | `hydra event read <id>` could not work for any input: the CLI resolved every positional named `id` as a UUID tail, so `42` was refused as too short and an eight-digit number swept the whole event log and matched nothing. One of the twelve shipped operations was unreachable from the binary. Fixed in the finish pass: a positional the contract types as a number is sent as that number, with no tail lookup, and a test in `packages/cli/src/index.test.ts` holds the route it reaches. | `packages/cli/src/commands/execute.ts` | fixed | 1 |
| F-32 | P2 | The duplicate-signal query drove from `tasks`, not from the ref: a correlated `EXISTS` over `task_provenance` made SQLite scan every live task and probe provenance once each, which is the opposite of what `task_provenance_ref` was created for. Fixed in the finish pass: the filter is `tasks.id IN (SELECT task_id FROM task_provenance WHERE ref IN ...)`, which seeks the ref index first. This runs before every triage. | `apps/controller/src/tasks/repository.ts` | fixed | 1 |
| F-33 | P2 | `hydra task read <tail>` pages `task.query` to the end to resolve an eight-character tail. Accepted: the mechanism is older than this ticket and is what keeps tails off the wire, but Task is the first unbounded entity it is applied to. Recorded for a CLI ticket, which is where a server-side tail lookup belongs. | `packages/cli/src/commands/execute.ts` | accepted | 1 |
| F-34 | P3 | The six Task and Project mutations stamp the literal user actor while `requireGrant` has already resolved one. Safe today, because the grant check refuses every non-user actor, and it is the repo's existing pattern. Accepted, and recorded because these are the first domains an agent will call as `session:<id>`: on that day all six call sites move together or the audit log says `user` untruthfully. | `apps/controller/src/tasks/service.ts` | accepted | 1 |
| F-35 | P3 | `AuditEntry.actor` is now nullable for every writer, although only the failed login needs it. Nothing else writes null and the one changed line has a test, but the type no longer stops a future mutation from writing an unattributed row. Accepted: narrowing it to the failed-login kind means a per-kind actor type, which is more machinery than the guarantee is worth today. | `apps/controller/src/events/audit-log.ts` | accepted | 1 |
| F-36 | P3 | AC-13 says no payload repeats the envelope's actor, and a provenance entry inside a `task.created` snapshot carries an `actor` of its own that today holds the same value. Accepted: that field is who recorded the provenance, part of the entity rather than a copy of the envelope, and a snapshot that dropped it would not be the task. | AC-13 / `apps/controller/src/tasks/service.ts` | accepted | 1 |
| F-37 | P3 | `GlyphTone` is declared in `@hydra/ui` and again in `@hydra/client-core`. Accepted: `@hydra/ui` is generic and does not depend on `client-core`, so its type is derived from its own tone map; a shared declaration would be the UI package learning about Hydra. | `packages/ui/src/primitives/priority-glyph.tsx` | accepted | 1 |
| F-38 | P3 | The projects query asks for the maximum page size and ignores `nextCursor`, so past 500 projects the composer and the filter bar silently omit some. Accepted for now: the drawer already names a project the picker does not hold (F-23), and a typeahead is the real answer at that size, not a longer walk. | `apps/web/src/app/queries.ts` | accepted | 1 |
| F-39 | P3 | The priority keyset filters rather than seeks, so page N of a priority walk reads the rows before it. The migration comment claimed the sort "walks the index". Accepted for the cost, and the comment is corrected to say what SQLite actually does. | `apps/controller/src/db/migrations/0003-tasks-and-projects.ts` | accepted | 1 |

## Decisions

| ID | Question | Options (recommended first) | Status | Resolution |
|---|---|---|---|---|
| D-1 | The actor for a failed login | `actor: null` / a new `anonymous` actor value | resolved | `actor: null`, by the user, 2026-09-04 (AD-1) |
| D-2 | How `task.update` writes labels | `addLabels`/`removeLabels` / whole-array replace | resolved | add/remove, by the user, 2026-09-04 (AD-2) |
| D-3 | Which filters `event.query` declares now | the four buildable ones / all six | resolved | the four, by the user, 2026-09-04 (AD-3) |
| D-4 | Whether `event.query` returns audit entries too | both populations / pipeline only / a population filter | resolved | both, discriminated by `kind`, by the user, 2026-09-04 (AD-4) |
| D-5 | Where Task detail lives | a drawer over `/tasks` / a `/tasks/{id}` route | resolved | the drawer, by the user, 2026-09-04 (AD-6) |
| D-6 | `task.query` order when `text` is present and a `sort` is also given | refuse with `validation` / honour the sort / ignore it | resolved | refuse, spec author's call, 2026-09-04 (AD-7); open to override |
| D-7 | The type of `eventId` on a provenance entry | integer / string | resolved | integer, implementer's call, 2026-09-04: spec 09's TypeScript sketch says `string`, but spec 04 owns id formats and pins the event id as the integer log position, which spec 11 §1.4 and AC-15 repeat. Open to override. |
| D-8 | Whether `description` is required on `task.create` | required / optional | resolved | required, implementer's call, 2026-09-04: spec 11 §2 marks every optional input with `?` and `description` carries none. Empty string is accepted. Open to override. |
| D-9 | The default order of `project.query` | `name asc` / `updatedAt desc` | resolved | `name asc`, implementer's call, 2026-09-04: the SPEC pins the defaults of `task.query` and `event.query` and leaves this one open. A project list is read to pick one out of a few, which is what alphabetical order serves; recency is what a task list needs. Open to override. |
| D-10 | Which column `event.query`'s `since` and `until` bound | `receivedAt` / `occurredAt` | resolved | `receivedAt`, implementer's call, 2026-09-04: neither the SPEC nor spec 11 §2 pins it, and the two are equal for every row that exists today. Arrival is the log's own axis and the one the id runs with, so a window and the page order never disagree; `occurredAt` is the emitter's unverified claim. The sentence is now on the contract's fields, and spec 11 §2 should take it in slice 6. Open to override. |
| D-11 | AC-20's second verification, `grep -n "FTS5" docs/spec/16-open-items.md` returning nothing, can never pass | amend the method / delete the resolved lines | resolved | amend, implementer's call, 2026-09-04: 16-open-items strikes a resolved item in place and writes the resolution beside it, so the word survives inside the struck lines. Deleting them would lose the record the file exists to keep. AC-20's verification text is amended and its id stands; the struck entries are read instead of grepped for. |

## Journal

### 2026-09-04 spec (session 1)
Wrote and locked the plan for ticket #59 without an interview: the six decisions
were settled by the user in advance and are recorded as AD-1 to AD-6, with AD-7
the one call made here. Verified FTS5 is compiled into Bun 1.4.0's SQLite 3.43.2,
including `unicode61 remove_diacritics 2` and `bm25`; the script is kept beside
the SPEC. Two things the code survey turned up that shape slice order: `db/page.ts`
requires a UUID in every cursor, so event paging needs a widened primitive, and
`HttpApiBuilder` builds all groups or none, so the HTTP routes for all three
families land together in slice 4. The repo has no screenshot tooling, so the two
UI criteria verify structure and behaviour through `renderApp` and the visual pass
is a residual manual check.

```yaml
handoff:
  state: spec-locked
  next: implement slice 1
  produced:
    - docs/plans/P001-tasks-projects-event-log/SPEC.md
    - docs/plans/P001-tasks-projects-event-log/WORKLOG.md
    - docs/plans/P001-tasks-projects-event-log/fts5check.md
  findings: [F-1]
  pending: []
```

### 2026-09-04 implement slice 1 (session 2)
Contract, migration and paging primitives. The tests were written first from the
SPEC alone by an agent that never saw the implementation, and confirmed failing
for the right reasons before a line of it existed.

Three decisions the SPEC left open were taken here and are open to override:
D-7 (`eventId` is an integer), D-8 (`description` is required on create), and
one more that needed no row because the SPEC pins it: `deletedAt` is declared on
the wire `Task` and `Project` although no live response can carry it, because
spec 09 and spec 02 pin it on the row and `task.deleted` hands back a snapshot.

Two things the primitives gained beyond a literal reading of AD-9. The id cursor
and the offset cursor both carry a bare number, so each names its kind inside the
cursor: without that, a walk that changed from keyset to offset would read one
as the other and quietly return a page whose boundary means nothing, which is
the exact failure the scope tag already exists to prevent. And `tasks_priority`
is an expression index over a rank, because sorting the four priority words
alphabetically would order them high, low, normal, urgent.

F-2 is the state of the branch: it does not typecheck and 58 HTTP tests fail,
all on the same missing route groups, until slice 4.

One review round, one reviewer that tried to break the diff. It found and could
not break: cursor cross-feeding in all six directions, malformed and
prototype-polluting cursors, the External Ref grammar over 25 cases, the
uninhabited `at`/`actor` on provenance input through OpenAPI and the CLI's AST
walk, the array query parameters over a repeated query string, the FTS triggers
under every write shape including a `VACUUM INTO` copy, and the migrator's
single transaction. Six findings were fixed here: the keyset cursor's sort key
is now `string | number`, because the priority walk orders on an integer rank
and SQLite sorts every number below every string, so a rank handed back as text
would have ended the walk after page one in silence; `isPosition` uses
`isSafeInteger`, so a hand-edited offset can no longer turn a query into a 500;
the field and direction are checked before the payload shape, so a replay under
another sort says so; the event id is at least one; a comment carrying a ticket
and an AC id is gone; and the migration's index and trigger comments now say
what they actually do. F-4, F-5 and F-6 are left open against the slices that
own them.

Boyscouting: the CLI derived `--projectId` on `task.update` as a JSON flag,
because `Schema.NullOr(Id)` is a union and the AST walk fell through to JSON.
`packages/cli/src/commands/tree.ts` now takes the null off a `X | null` union
first, so a nullable field is typed on the command line the way the field it
holds is.

```yaml
handoff:
  state: in-progress
  next: implement slice 2 (the Task domain)
  produced:
    - packages/contract/src/groups/task.ts
    - packages/contract/src/groups/project.ts
    - packages/contract/src/groups/event.ts
    - apps/controller/src/db/migrations/0003-tasks-and-projects.ts
    - apps/controller/src/db/page.ts
  findings: [F-1, F-2, F-3]
  pending: []
```

### 2026-09-04 implement slice 2 (session 3)
The Task domain. The tests were written first from the SPEC alone by an agent
that never saw the implementation and confirmed failing on the missing module;
the implementation then made all of them pass without an assertion changing.

`TaskService` is one service over a repository that is a plain function rather
than a second layer, because it has exactly one consumer. Input is decoded at
the service against the contract's own schemas, which is why `task.create`'s and
`task.update`'s payloads are now named exports of the contract instead of
inline structs: a built-in workflow action calls these methods directly and is
held to the title cap, the External Ref grammar and the rule that a provenance
entry names something, exactly as a request is. The mapping from a decode
failure to the wire's `issues` list moved from the transport into the contract
as `issuesOf` / `validationOf`, so both callers produce the same error for the
same bad input; the transport behaviour is unchanged.

Two things the tests did not force. A task pointing at a project that is not
there would otherwise have been a foreign-key `SqlError` and a 500, so create
and update check the project and answer `not_found`; that check has its own
test. And an update that asks for the values the task already holds now writes
nothing and emits nothing: the alternative was a `task.updated` row with an
empty `changes`, which is a false audit entry and a trigger surface that wakes
workflows for no change.

One review round, one reviewer that tried to break the diff. It could not break
the MATCH wrapper (FTS5 operators, unicode, punctuation, a full 512 characters),
the four keyset walks under ties, cursor cross-feeding in six directions, the
filter composition including empty arrays, the FTS index under edits and soft
deletes, or the transaction integrity of a failed mutation. Three findings were
fixed here: the relevance cursor now scopes on its filter as well as its terms,
so page two of one search cannot skip rows of another (F-4); a label named on
both `addLabels` and `removeLabels` is reported as neither, because it is still
on the task and `"proposed" in event.changes.labels.removed` is a shipped filter;
and the no-op update above. F-7 and F-8 are the two it found that were accepted
rather than fixed, with the reasons in the table.

F-2 is unchanged: the branch does not typecheck and 58 HTTP tests fail, all on
the three route groups having no handlers until slice 4.

```yaml
handoff:
  state: in-progress
  next: implement slice 3 (the Project domain)
  produced:
    - apps/controller/src/tasks/service.ts
    - apps/controller/src/tasks/repository.ts
    - apps/controller/src/tasks/service.test.ts
    - packages/contract/src/groups/task.ts
    - packages/contract/src/errors.ts
  findings: [F-1, F-2, F-5, F-7, F-8]
  pending: []
```

### 2026-09-04 implement slice 3 (session 4)
The Project domain. The tests were written first from the SPEC alone by an
agent that never saw the implementation and confirmed failing on the missing
module; the implementation then made all of them pass without an assertion
changing.

`ProjectService` mirrors `TaskService` over a repository that is a plain
function: five operations, a keyset walk, a soft delete, and one `project.*`
event per mutation written inside the mutation's transaction. `project.created`
and `project.deleted` carry the snapshot, `project.updated` carries a
`{old, new}` per changed field and nothing for the fields it left alone. There
is no search, no filter and no relevance walk, because a project has nothing to
search on but its name and there are few of them.

`project_resources` needed no code. The join table is what the many-to-many
is; no operation in the contract reaches it, so the criterion is verified
against the table itself, and it will grow an owner when Resources do.

`ProjectCreateInput` and `ProjectUpdateInput` are now named exports of the
contract, as the task inputs are, so the service decodes an in-process caller
against exactly what a request is decoded against.

D-9 is the one call taken here and open to override: `project.query` defaults
to `name asc` rather than the `updatedAt desc` a task list uses.

One review round, one reviewer that tried to break the diff. It could not break
the keyset walk (18 full walks over duplicate names, a case-only difference and
shared timestamps), cursor cross-feeding in either direction and from
`task.query`, transaction integrity under failure and concurrency, the update
diff at the field caps, or input validation through the service. Two findings
were fixed here: `project.query` had no test at all (F-9), and a description
could be set but never removed (F-10). Three were accepted or held with their
reasons in the table.

F-2 is unchanged: the branch does not typecheck and 58 HTTP tests fail, all on
the three route groups having no handlers until slice 4.

```yaml
handoff:
  state: in-progress
  next: implement slice 4 (the event reader, the routes, and the actor fix)
  produced:
    - apps/controller/src/projects/service.ts
    - apps/controller/src/projects/repository.ts
    - apps/controller/src/projects/service.test.ts
    - packages/contract/src/groups/project.ts
    - apps/controller/src/events/audit-log.ts
  findings: [F-1, F-2, F-5, F-11, F-12, F-13]
  pending: []
```

### 2026-09-04 implement slice 4 (session 5)
The event reader, the twelve route handlers, and the actor fix. The tests were
written first from the SPEC alone by an agent that never saw the implementation:
the HTTP ones failed on the three route groups having no handlers, the auth one
on a failed login claiming the user, and the binary one on a `hydra` older than
the contract.

The branch is green for the first time since slice 1. F-2 is closed: all twelve
operations are reachable over HTTP, `pnpm typecheck`, `pnpm lint`, `pnpm test`
and `pnpm dep-lint` all pass, and so do `pnpm build:binary && pnpm test:binary`.

`EventService` is one file with no repository beside it, unlike the task and the
project domains. It reads one table, has one consumer and holds no policy past
the grant check and the decode, so a second module would have been a layer with
nothing in it.

Two things the criteria did not force. `since` and `until` bound `received_at`
(D-10), and the reason is now a comment on the contract's own fields rather than
only in the controller. And a fourth migration adds `events_kind_id`: `?kind=`
is the query the log is opened for, and without the index every page of it
scanned the whole table - 4.3 ms per page at 200k rows, worse the rarer the kind
and the longer the log is kept, against 0.0 ms with it.

The one behaviour change outside this slice's files is in `server.test.ts`,
which asserted `actor: "user"` on `auth.login.failed`. That assertion was the
bug the ticket reports, so it now reads `null`.

One review round, one reviewer that tried to break the diff. It could not break
the keyset walk (four full walks at limits 1 and 500, rows inserted mid-walk),
cursor cross-feeding in either direction and from both other listings, hand-
edited and prototype-polluting cursors, malformed timestamps and injection-
shaped filter values, or `GET /events/{id}` at zero, negative, fractional and
past 2^53. Three findings were fixed here: the missing `kind` index, the
undocumented time axis, and the connection-carrying path shipping with no test
at all - a row written straight to the table now proves the filter and the
`connectionId` round-trip that ingest will land on. F-14 to F-18 are the rest,
accepted or held with their reasons in the table.

The transcript of a real session against the compiled binary is in
`evidence/cli-session.md`: a project, two tasks with provenance refs, a status
and label edit, a full-text search, the `task.*` rows those commands wrote, and
a failed login coming back from `hydra event query` stamped `"actor": null`.

```yaml
handoff:
  state: in-progress
  next: implement slice 5 (the Tasks screen)
  produced:
    - apps/controller/src/events/reader.ts
    - apps/controller/src/db/migrations/0004-reading-the-event-log.ts
    - apps/controller/src/http/routes.ts
    - apps/controller/src/http/task.integration.test.ts
    - apps/controller/src/http/event.integration.test.ts
    - e2e/cli.test.ts
    - docs/plans/P001-tasks-projects-event-log/evidence/cli-session.md
  findings: [F-1, F-5, F-14, F-15, F-16, F-17, F-18]
  pending: []
```

### 2026-09-04 implement slice 5 (session 6)
The Tasks screen, the four primitives it is built from, and the two readings of
task data that are not presentation. The tests were written first from the SPEC
alone by an agent that never saw the implementation and confirmed failing on the
missing controls and the missing exports.

`/tasks` is a folder route rather than one file: past a hundred and fifty lines
the screen splits into `-composer` and `-detail`, and eslint holds a `-` file to
its own folder, so the screen itself moved to `tasks/index.tsx`. The drawer is
opened by `?task=<id>` and closed by taking it off again; there is no
`/tasks/<id>` and no second read behind it - the drawer renders the task the
listing already answered with, so opening one costs nothing.

Four things the criteria did not force. The listing follows `nextCursor` behind
a **Show more** rather than stopping at the first page, because a list that
showed fifty of two hundred without saying so is the silent truncation the spec
forbids on every other surface. The first page and the projects are answered in
the route loader, so the screen never renders as a frame around nothing. A
narrowed filter keeps the rows it had until the new ones arrive. And the search
box waits two hundred milliseconds, so a typed word is one question rather than
nine.

`priorityGlyph`, `taskRecedes` and `provenanceTarget` are in `client-core` with
their own tests: four priorities have to reach three bars, and which of them
recede is a reading of the domain, not a component's business. `formatStamp`
joins `formatTimeContext` there for the same reason. The glyph's four readings
are bars and grey together - low one faint bar, normal two muted, high three
muted, urgent three ink - because the two axes the design language allows are
the only two there are, and four steps do not fit on one.

The contract gained three things the screen needed and nothing else could give:
`TASK_STATUSES` and `TASK_PRIORITIES` as plain arrays behind the two `Literals`,
so a picker reads the axis rather than restating it, and `TaskCreateForm`, the
create payload as a Standard Schema, so the composer is checked against exactly
what the controller checks.

Visual proof rather than a person's eye: eight screenshots at 1440x900 against
the compiled binary with a seeded project and eight tasks, in both themes, in
`evidence/`. Three things they caught and this slice fixed: the stamp column
wrapped onto two lines and made every row 52px tall, the filter bar ran to the
viewport edge while the list stopped at 940px, and Chrome drew its own blue
clear button inside the search field - the one hue this palette has no place
for. The one thing they did not settle: the priority glyph now trails its select
in the drawer, which keeps every control on one left edge at the cost of that
one select ending 23px early.

Boyscouting: `pnpm test` was collecting a second copy of the whole repository
out of another agent's worktree under `.claude/`, which failed 137 tests on
paths that are not this tree (F-21). The `node` project now excludes it and it
is gitignored.

One test fixture was corrected rather than the code: it stamped a provenance
entry `session:01a06d02`, which the contract's `Actor` refuses, so the page it
was in decoded as nothing at all. That is F-20, recorded and held.

One review round, one reviewer that tried to break the diff. It could not break
the paging (a filter changed mid-walk starts one clean listing and never mixes
old pages into it), a `?task=` carrying script tags, nulls or a very long value,
two writes racing, focus restoration when the row that opened the drawer is
gone, the class merging on any of the four primitives, or the contract change -
`Schema.Literals(TASK_STATUSES)` builds the identical AST, so the CLI's walk and
the generated document are untouched. Three P1s it did find are fixed here, each
with a test: a refused write that said nothing (F-22), a task claiming it has no
project when the picker simply did not hold the one it names (F-23), and a
drawer that read its task out of the listing, so a deep link opened nothing and
the user's own edit could unmount the panel they were working in (F-24). Three
smaller ones are fixed with them (F-25) and three are accepted or recorded
(F-26, F-27, F-28). Its last catch is boyscouting the boyscouting: `eslint` was
still walking the agent worktree that `vitest` had stopped walking.

```yaml
handoff:
  state: in-progress
  next: implement slice 6 (spec documents and the finish pass)
  produced:
    - apps/web/src/routes/_shell/tasks/index.tsx
    - apps/web/src/routes/_shell/tasks/-composer.tsx
    - apps/web/src/routes/_shell/tasks/-detail.tsx
    - packages/ui/src/primitives/{drawer,list-row,priority-glyph,textarea}.tsx
    - packages/client-core/src/task-display.ts
    - docs/plans/P001-tasks-projects-event-log/evidence/tasks-*.png
  findings: [F-1, F-5, F-19, F-20, F-28, F-29]
  pending: []
```

### 2026-09-04 implement slice 6 and the finish pass (session 7)
The spec documents and the close. The decisions this ticket took are now in the
documents that own them rather than only in this file: 09 §Search names the
tokenizer and the plain-words wrapper and the relevance order that refuses an
explicit sort, 09's provenance sketch types `eventId` as the integer log
position, 04 §Engine records FTS5 as verified, 11 §2 carries the three sort
enums with their defaults, `event.query`'s shipped filter subset and what the
workflows ticket adds to it, the `receivedAt` axis and both populations, 13 §11
lists the new `task.*` and `project.*` kinds, 16 strikes the two resolved FTS5
items, and ADR 0019's hard delete carries a dated amendment pointing at the soft
delete spec 02 and spec 09 pin. Two pieces of boyscouting went with them: 09's
CLI table and its provenance paragraph still said hard delete against that same
document's Delete section (F-30), and spec 14's pinned empty-state table had no
row for a filter that matched nothing, which the Tasks screen needs and ships
(F-29).

AC-20's second verification was amended and its id kept (D-11). It asked for
`grep -n "FTS5" docs/spec/16-open-items.md` to return nothing, which that file
can never do: it strikes a resolved item in place and writes the resolution
beside it, so the word survives inside the struck lines. Deleting them would
throw away the record the file exists to keep.

F-16 is fixed rather than left as a decision. `client-core` now tells a request
that never left the process from a response it could not read: `run` provides
its own `fetch` and flips a flag when the request reaches it, so a schema
failure before that is a new `RequestError` carrying the contract's own issues.
The CLI turns that into a usage error naming the flag, exit 2, instead of the
envelope `{"code":"internal"}` and exit 1 for something no server ever saw.

One whole-branch review round over `git diff main...HEAD`, by a reviewer that
tried to break it. It could not break the cursors (all three shapes seal their
operation, field and direction, the two numeric shapes tag their payload, and
the relevance scope folds the filter in, so no cursor decodes in another walk),
the soft delete (read, query, the FTS join, the provenance join, the refs filter
and the project join all filter `deleted_at IS NULL`, and the FTS walk filters
after the join so a deleted row never consumes an offset slot), transaction
integrity or the grant check's position in all twelve methods. It built the
shipped schema on the pinned Bun and vacuumed it to see whether an external
content FTS table could be orphaned by renumbered rowids; it was not.

Its one P1 is fixed here with a test: `hydra event read <id>` could not work for
any input, because the CLI resolved every positional named `id` as a UUID tail,
so `42` was refused as too short and an eight-digit number swept the whole log
and matched nothing. One of the twelve shipped operations was unreachable from
the binary, and AC-16 did not catch it because its list names `event query` and
not `event read`. A positional the contract types as a number is now sent as
that number (F-31). One P2 is fixed with it: the duplicate-signal query drove
from `tasks` rather than from the ref, so the index created for it was probed
once per live task instead of seeked once (F-32). The rest are accepted with
their reasons in the table (F-33 to F-39), and one migration comment that
claimed more than SQLite does is corrected.

```yaml
handoff:
  state: done
  next: ship
  produced:
    - docs/spec/{04,09,11,13,14,16}-*.md
    - docs/adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md
    - packages/client-core/src/errors.ts
    - packages/cli/src/commands/execute.ts
    - apps/controller/src/tasks/repository.ts
  findings: []
  pending: []
```
