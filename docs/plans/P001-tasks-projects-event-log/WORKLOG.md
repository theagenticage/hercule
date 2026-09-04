<!--
WORKLOG. The state that survives sessions. Created empty at spec lock. The locked SPEC is the only design document; nothing from the interview lands here.
- Status, Findings and Decisions are kept current: latest truth wins, no duplicate rows.
- Journal is append-only: one entry per skill run, newest last. Never edit a past entry.
Any agent picking up work reads SPEC.md, then this file top to bottom. The last handoff block says where to resume.
Every skill run ends by appending a journal entry with a handoff block, even when it failed or was interrupted. `implement` also updates Status; `review` only updates Findings.
-->

# WORKLOG: Tasks, Projects, and the event log (ticket #59)

## Status

- **State:** in progress
- **Current slice:** 4
- **Blocked on:** none
- **Journey:** not recorded yet

| # | Slice | Status | Evidence |
|---|---|---|---|
| 1 | Contract, migration, paging primitives | done | AC-1: `vitest run packages/contract` -> 54 passed, the twelve new operations one-to-one with the table. AC-2: `vitest run apps/controller/src/db/migrations` -> 6 passed, four tables, partial indexes, `tasks_fts` and its three triggers, plus `vitest run apps/controller/src/db/migrate.test.ts` -> 12 passed, the set is a no-op twice. AC-9: `vitest run apps/controller/src/db/page.test.ts` -> 20 passed. `pnpm typecheck` is red, and 58 HTTP tests fail, only on the three new contract groups having no route handlers until slice 4 (F-2); `pnpm lint` and `pnpm dep-lint` are green. |
| 2 | The Task domain | done | AC-3, AC-4, AC-5, AC-6, AC-7, AC-10, AC-13: `vitest run apps/controller/src/tasks` -> 34 passed. AC-11: the same run, plus `vitest run packages/contract/src/groups/task.test.ts` -> 2 passed, the ref grammar as the package exports it. `pnpm lint` and `pnpm dep-lint` green; `pnpm typecheck` and 58 HTTP tests still red on F-2 alone, unchanged by this slice. |
| 3 | The Project domain | done | AC-12, AC-23: `bun --bun run vitest run --project node apps/controller/src/projects` -> 18 passed, the five operations, the join table both ways, a task keeping its `projectId` past its project's delete, and one `project.*` row per mutation. `pnpm lint` and `pnpm dep-lint` green; `pnpm typecheck` and 58 HTTP tests still red on F-2 alone, unchanged by this slice. |
| 4 | The event reader, the routes, and the actor fix | pending | |
| 5 | The Tasks screen | pending | |
| 6 | Spec documents and the finish pass | pending | |

## Findings

| ID | Sev | Finding | Ref | Status | Rounds seen |
|---|---|---|---|---|---|
| F-1 | P2 | ADR 0019 still says "Hard delete is allowed", superseded by spec 09 and spec 02. Boyscouting, folded into slice 6. | AC-21 / `docs/adr/0019-*.md` | open | - |
| F-2 | P1 | The branch cannot be green between slices 1 and 3. Declaring the three groups in `api` leaves `HttpApiBuilder.layer(api)` without their handlers, which is 3 typecheck errors and 58 failing HTTP tests, every one of them the same "HttpApiGroup task not found". The SPEC anticipated the compile half; the failing tests are the same cause. Resolves when slice 4 lands the handlers; AC-22 is only reachable then. | Slices note / `apps/controller/src/http/routes.ts` | open | - |
| F-3 | P3 | The SPEC's Scale line and slice 4 said thirteen operations where AC-1 lists twelve (5 task, 5 project, 2 event). Both now say twelve. | SPEC Scale, slice 4 | fixed | - |
| F-4 | P1 | The offset cursor's scope did not include what the result set depends on, so page two of one search decoded cleanly against another and skipped rows. Fixed in slice 2: a relevance walk's scope is its match expression plus its filter, so a cursor replayed under other words or another filter is `validation`. | AD-9 / `apps/controller/src/tasks/repository.ts` | fixed | 2 |
| F-5 | P2 | Spec 09's `ProvenanceEntry` sketch still types `eventId` as a string, which spec 04 and spec 11 §1.4 contradict. Correct it with the other spec edits in slice 6; AC-20 does not list it. | D-7 / `docs/spec/09-tasks.md` | open | 1 |
| F-6 | P2 | The FTS triggers do not survive `INSERT OR REPLACE` on `tasks`: the displaced row is removed without firing the delete trigger, leaving stale terms in the index. The task repository writes only INSERT, UPDATE and DELETE, and a reviewer probing edits, soft deletes and status changes found no stale term. Slice 3 has no reason to write tasks at all. | `apps/controller/src/db/migrations/0003-tasks-and-projects.ts` | held | 2 |
| F-7 | P3 | A search whose text holds no letter or digit (`"+++"`) answers with an empty page rather than `validation`. Accepted: the index holds no punctuation either, so the search is one that can match nothing, not one that was refused. | AD-5 / `apps/controller/src/tasks/repository.ts` | accepted | 2 |
| F-9 | P2 | `project.query` shipped with no test: the keyset walk, its sort fields and its cursor scope were a new code path nothing exercised. Fixed in slice 3 with a full-walk test at page size 1 and 2 over three orders, and a cursor replayed under another field and another direction. | `apps/controller/src/projects/service.test.ts` | fixed | 1 |
| F-10 | P2 | A project's description could be set but never taken off again: `description` is optional on the row and the update payload had no way to spell "remove it". Fixed in slice 3: `project.update` takes `description: null`, as `task.update` takes `projectId: null`. | `packages/contract/src/groups/project.ts` | fixed | 1 |
| F-11 | P3 | A hand-edited cursor whose sort key is a number where the column holds text restarts the walk rather than failing, because SQLite orders every number below every string. Accepted: the token is opaque, the trigger is editing it, and the outcome is a repeated page rather than a skipped row. The clean fix is for the scope to carry the key's type, which is `db/page.ts` and touches every walk. | AD-9 / `apps/controller/src/db/page.ts` | accepted | 1 |
| F-12 | P3 | `ScalarChange` is declared identically in the task and the project service. Accepted: the task service pairs it with a `ListChange` a project has no use for, and lifting one of the pair into a shared module would split it. | `apps/controller/src/projects/service.ts` | accepted | 1 |
| F-13 | P3 | One description edit writes a `project.updated` payload holding both sides, so a worst case is two 64 KiB strings in one event row, and the log is kept 90 days. Task's `task.updated` has the same shape; Project is the second entity to take it, which makes it a pattern rather than a case. Held for a decision on whether a diff should carry a long field's value at all. | `apps/controller/src/projects/service.ts` | held | 1 |
| F-8 | P3 | The priority rank is spelled in the migration's expression index and again in the repository, and nothing but a matching string makes SQLite use that index. A test now walks the four priorities one row at a time, which fails if either copy drifts. | `apps/controller/src/tasks/repository.ts` | accepted | 2 |

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
