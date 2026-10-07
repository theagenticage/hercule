# 36. A workspace is kept by leases its holders release

Date: 2026-09-27

## Status

Accepted. Decided and built by [Workspace leases (#263)](https://github.com/theagenticage/hercule/issues/263). Reverses two statements of the spec: "whether an ephemeral is kept for inspection is teardown policy read off its run" ([Domain model residue, #46](https://github.com/theagenticage/hercule/issues/46); [spec 02](../spec/02-domain-model.md) §Workspace, [spec 03](../spec/03-controller-and-runners.md) §6.3) and "the sweep tears down a run's ephemeral workspace by how the run ended", with the kept-until time read when the run is read ([#260](https://github.com/theagenticage/hercule/issues/260); [spec 03](../spec/03-controller-and-runners.md) §6.7, [spec 07](../spec/07-workflows.md) §4.4, [spec 11](../spec/11-public-api-and-agent-surface.md) §2). Keeps [ADR 0033](./0033-source-is-organized-by-domain-and-tests-are-colocated.md) (domains form a DAG).

**Amended 2026-10-07 ([#459](https://github.com/theagenticage/hercule/issues/459), [ADR 0039](./0039-workspaces-preserve-runner-local-git-state-and-human-work.md)):** leases continue to protect active use and credential eligibility, but a workspace's separate retention policy now limits automatic cleanup. A Thread opening or joining a Workspace makes retention `manual` in the lease-acquisition transaction, permanently after exit. Existing Thread workspaces are backfilled. The earlier example of a joined Thread expiring after its idle window is superseded: it stays until explicit discard. Automatic workflow workspaces still use the latest lease window until a Thread joins. No fake active lease implements retention.

Automatic cleanup never force-removes remaining tracked, untracked or ignored files. A refusal retains files with an actionable reason. Disposal reserves `disposing` before I/O; lease acquisition rechecks readiness in the same transaction and refuses that state. `deleted` is recorded only after successful removal, with refusal/retry handled truthfully. User-authorized discard affects only known managed paths; detachment never deletes an attached folder or its shared repository. The workspace live topic now distributes observed changes. The domain DAG, actor stamping and credential activity port remain unchanged.

## Context

An ephemeral workspace is deleted by a controller sweep every ten minutes. Until now the workspaces domain decided which workspaces to delete by reading other domains' tables:

- The sweep joined `runs` and counted `sessions`, live and resumable, in subqueries.
- One expiry branch per run outcome (`run-completed`, `run-cancelled`, `run-failed`, `run-kept`) sat beside the `orphan` and `idle` branches for threads.
- `workspace.dispose` refused an unfinished run's workspace through SQL over `runs`.
- The credential rule for a workspace step read `runs` and `run_steps` directly.
- `runs.keep_workspace` existed only so the sweep could read it later, and `Run.workspaceKeptUntil` was computed on every `run.read` from the current settings, which made `run.read` fail with a setting error.

ADR 0033 allows these reads, so nothing was broken. The problem was ownership. What a finished run or an exited session means for the disk was split between the holder's domain and the sweep, and every new kind of holder, an assistant for example, would add another join and another branch.

It also gave a wrong answer. A thread that joined a failed run's workspace, to look at what the run left, lost the workspace when the run's fourteen days ran out, whatever the thread was still doing.

## Decision

**Every session and run that uses a workspace holds a Workspace Lease on it, and the sweep reads only leases.**

- **Acquire.** A holder acquires its lease in the transaction that opens or joins the workspace. A resumed session acquires it again. There is one row per holder per workspace, so a resume reuses the row.
- **A released lease is kept only where it keeps something.** The sweep never deletes a primary, so a lease on a primary is deleted when it is released, and a resume acquires it afresh. A workspace that is gone takes its released leases with it. Only active leases stay on such a workspace, for the credential rule. The table therefore holds the leases of live ephemeral workspaces and the active leases, not every session and run that ever ended.
- **Release with a retention.** When the holder is done, it releases its lease and picks a retention. The workspaces domain owns each retention's length:

  | Retention | Kept for | Picked by |
  |---|---|---|
  | `none` | nothing | a run that completed, or was cancelled without `keepWorkspace` |
  | `orphan` | `workspace.orphanTtlHours`, 24 hours | a session that exited and cannot be resumed |
  | `idle` | `workspace.idleTtlDays`, 30 days | a session that exited and can be resumed |
  | `inspection` | `workspace.inspectionTtlDays`, 14 days | a run that failed, or was cancelled with `keepWorkspace` |

- **The kept-until time is stamped at release**, from the settings at that moment. A later settings change moves only later releases. The workspace reports the latest one as `Workspace.keptUntil`, and a run no longer reports anything about its workspace's lifetime.
- **The latest lease wins.** The sweep deletes an ephemeral workspace once no lease is active and every lease's kept-until time has passed. Example: a run fails on 1 Oct and keeps its workspace until 15 Oct. A thread joins it on 3 Oct and exits, resumable, on 4 Oct. The workspace is kept until 3 Nov, the thread's idle window.
- **A release may be repeated.** Releasing an already-released lease recomputes its kept-until time from its own release time. Deleting an assistant releases its conversations' exited sessions again as `orphan`, because nothing can resume them any more.
- **A workspace with no lease is never deleted.** Every workspace gets its first lease in the transaction that opens it. If one somehow has none, keeping its files is the safe way to be wrong.
- **Leases carry no actor.** The holder is the actor, and the `workspace.deleted` audit entry records the retention and the holder of the lease with the latest kept-until time, such as `inspection` from `run:<id>`.

**The credential rule for a workspace step goes through a port.** A run's `git.push` asks for a credential as the runner, naming the workspace, because no session runs the step. It must get one only while one of the run's workspace steps is running: a failed run holds its released `inspection` lease for fourteen days and must not push during that time, and an unfinished run holds its active lease through controller steps such as `wait`. So the lease is not the fact the rule needs. The workspaces domain declares a port, `WorkspaceStepActivity.isStepRunning(workspaceId, runnerId)`, and the runs domain implements it from its own step records. The runs domain already depends on workspaces, so no edge is added, as with `ConversationResponder`. The session-token rule reads the session's active lease in place of the `sessions` table.

## Considered options

- **The holder grants and revokes a credential flag on its lease.** Rejected. It stores "a step is running" a second time. Every path that ends a step must then clear the flag: completion, failure, timeout, cancel, a retired runner, and the cut-off after a controller restart. One missed path leaves a push credential open, which is the failure that matters most here. Asking the step records at the time of the request cannot go stale.
- **The controller daemon passes a boolean in.** The controller daemon already reads runs, so it could answer "a step is running" and hand the credential rule the result. Rejected. It splits one credential rule across two layers, and the workspaces domain could no longer be read on its own to learn who gets a token.
- **Keep reading the holders' tables, and add the missing thread case.** Rejected. It fixes the example above with one more join, and leaves the next kind of holder to add another.

## Consequences

- The workspaces domain reads only its own tables and its own settings. It has no SQL over `runs`, `run_steps` or `sessions`.
- Each holder states its own rule in its own domain: the run engine releases in the transaction that records how the run ended, and the session service releases in every write that moves a session to `exited`.
- `run.read` and `run.cancel` no longer read settings and no longer fail with a setting error. `runs.keep_workspace` is dropped: `keepWorkspace` only picks the retention at release.
- The setting `workspace.failedRunTtlDays` is renamed `workspace.inspectionTtlDays`, because it now applies to every `inspection` release, not only to failed runs.
- `workspace.dispose` refuses any workspace with an active lease, and names everything to stop: the run to cancel and the sessions to stop.
- There is no live topic for workspaces yet. A run's page reads the workspace again when the run ends, to learn its `keptUntil`.
- A new kind of holder, such as an assistant, needs a holder kind and a release rule of its own, and no change to the sweep.
