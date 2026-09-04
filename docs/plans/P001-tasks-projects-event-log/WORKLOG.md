<!--
WORKLOG. The state that survives sessions. Created empty at spec lock. The locked SPEC is the only design document; nothing from the interview lands here.
- Status, Findings and Decisions are kept current: latest truth wins, no duplicate rows.
- Journal is append-only: one entry per skill run, newest last. Never edit a past entry.
Any agent picking up work reads SPEC.md, then this file top to bottom. The last handoff block says where to resume.
Every skill run ends by appending a journal entry with a handoff block, even when it failed or was interrupted. `implement` also updates Status; `review` only updates Findings.
-->

# WORKLOG: Tasks, Projects, and the event log (ticket #59)

## Status

- **State:** spec-locked
- **Current slice:** 1
- **Blocked on:** none
- **Journey:** not recorded yet

| # | Slice | Status | Evidence |
|---|---|---|---|
| 1 | Contract, migration, paging primitives | pending | |
| 2 | The Task domain | pending | |
| 3 | The Project domain | pending | |
| 4 | The event reader, the routes, and the actor fix | pending | |
| 5 | The Tasks screen | pending | |
| 6 | Spec documents and the finish pass | pending | |

## Findings

| ID | Sev | Finding | Ref | Status | Rounds seen |
|---|---|---|---|---|---|
| F-1 | P2 | ADR 0019 still says "Hard delete is allowed", superseded by spec 09 and spec 02. Boyscouting, folded into slice 6. | AC-21 / `docs/adr/0019-*.md` | open | - |

## Decisions

| ID | Question | Options (recommended first) | Status | Resolution |
|---|---|---|---|---|
| D-1 | The actor for a failed login | `actor: null` / a new `anonymous` actor value | resolved | `actor: null`, by the user, 2026-09-04 (AD-1) |
| D-2 | How `task.update` writes labels | `addLabels`/`removeLabels` / whole-array replace | resolved | add/remove, by the user, 2026-09-04 (AD-2) |
| D-3 | Which filters `event.query` declares now | the four buildable ones / all six | resolved | the four, by the user, 2026-09-04 (AD-3) |
| D-4 | Whether `event.query` returns audit entries too | both populations / pipeline only / a population filter | resolved | both, discriminated by `kind`, by the user, 2026-09-04 (AD-4) |
| D-5 | Where Task detail lives | a drawer over `/tasks` / a `/tasks/{id}` route | resolved | the drawer, by the user, 2026-09-04 (AD-6) |
| D-6 | `task.query` order when `text` is present and a `sort` is also given | refuse with `validation` / honour the sort / ignore it | resolved | refuse, spec author's call, 2026-09-04 (AD-7); open to override |

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
