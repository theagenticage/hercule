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
- **Current slice:** 2
- **Blocked on:** none
- **Journey:** not recorded yet

| # | Slice | Status | Evidence |
|---|---|---|---|
| 1 | Contract, migration, paging primitives | done | AC-1: `vitest run packages/contract` -> 54 passed, the twelve new operations one-to-one with the table. AC-2: `vitest run apps/controller/src/db/migrations` -> 6 passed, four tables, partial indexes, `tasks_fts` and its three triggers, plus `vitest run apps/controller/src/db/migrate.test.ts` -> 12 passed, the set is a no-op twice. AC-9: `vitest run apps/controller/src/db/page.test.ts` -> 20 passed. `pnpm typecheck` is red, and 58 HTTP tests fail, only on the three new contract groups having no route handlers until slice 4 (F-2); `pnpm lint` and `pnpm dep-lint` are green. |
| 2 | The Task domain | pending | |
| 3 | The Project domain | pending | |
| 4 | The event reader, the routes, and the actor fix | pending | |
| 5 | The Tasks screen | pending | |
| 6 | Spec documents and the finish pass | pending | |

## Findings

| ID | Sev | Finding | Ref | Status | Rounds seen |
|---|---|---|---|---|---|
| F-1 | P2 | ADR 0019 still says "Hard delete is allowed", superseded by spec 09 and spec 02. Boyscouting, folded into slice 6. | AC-21 / `docs/adr/0019-*.md` | open | - |
| F-2 | P1 | The branch cannot be green between slices 1 and 3. Declaring the three groups in `api` leaves `HttpApiBuilder.layer(api)` without their handlers, which is 3 typecheck errors and 58 failing HTTP tests, every one of them the same "HttpApiGroup task not found". The SPEC anticipated the compile half; the failing tests are the same cause. Resolves when slice 4 lands the handlers; AC-22 is only reachable then. | Slices note / `apps/controller/src/http/routes.ts` | open | - |
| F-3 | P3 | The SPEC's Scale line and slice 4 said thirteen operations where AC-1 lists twelve (5 task, 5 project, 2 event). Both now say twelve. | SPEC Scale, slice 4 | fixed | - |
| F-4 | P1 | The offset cursor's scope is operation, field and direction, which does not include the search text, so page two of one search decodes cleanly against another and skips rows of a different result set. `CursorScope` documents the fix: a relevance walk puts what its order depends on into `field`. Slice 4 must do it. | AD-9 / `apps/controller/src/db/page.ts` | open | 1 |
| F-5 | P2 | Spec 09's `ProvenanceEntry` sketch still types `eventId` as a string, which spec 04 and spec 11 §1.4 contradict. Correct it with the other spec edits in slice 6; AC-20 does not list it. | D-7 / `docs/spec/09-tasks.md` | open | 1 |
| F-6 | P2 | The FTS triggers do not survive `INSERT OR REPLACE` on `tasks`: the displaced row is removed without firing the delete trigger, leaving stale terms in the index. The migration says tasks are never written with REPLACE; slices 2-3 must hold to it, or the database has to open with `PRAGMA recursive_triggers = ON`. | `apps/controller/src/db/migrations/0003-tasks-and-projects.ts` | open | 1 |

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
