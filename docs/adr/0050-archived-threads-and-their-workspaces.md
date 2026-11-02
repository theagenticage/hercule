# 50. Archived Threads, and what happens to their workspaces

Date: 2026-11-02

## Status

Accepted by [Desktop Fleet: the design and its tickets (#972)](https://github.com/theagenticage/hercule/issues/972), decided with Rogier on 2026-11-02. Amends [ADR 0039](./0039-workspaces-preserve-runner-local-git-state-and-human-work.md), which keeps every Thread workspace until the user removes it. One part, that ignored files do not block removing an archived workspace, is the spec author's proposal and waits for Rogier's review in the pull request that adds this ADR.

## Context

ADR 0039 made a Thread's workspace manually retained: a Thread can always be picked up again, so its workspace is never removed automatically. Done did not change that, because Done is a reversible mark: a Done Thread still takes input.

So Thread workspaces only grow. On a busy machine they fill the disk, and the Fleet screen shows it: many gigabytes of workspaces nobody has used for weeks. The user's only way out was to remove workspaces one at a time, after which their Threads could not be resumed, and nothing said why.

Two more facts shaped the decision:

- ADR 0039 also lets nothing remove ignored files without the user's explicit discard. Almost every workspace that ran `pnpm install` or a build holds ignored files (`node_modules`, build output), so a "clean" workspace is rare in practice.
- A harness keeps its own copy of each session's transcript in its Harness Home. Removing a workspace left those files behind.

## Decision

**A Thread can be Archived: a final state, set only by the user. A workspace whose Threads are all archived returns to automatic cleanup.**

- **Archived is final.** An archived Thread can never be resumed, sent input or reopened. Its transcript stays readable on the controller. Done stays the user's reversible mark; archiving marks a Thread Done first.
- **Only the user archives,** from the thread's header, from the Done shelf, or from the Fleet screen's cleanup dialog. A session is refused whatever its grants, because an agent could otherwise make the user's work unresumable without the user seeing it. A Thread that is working cannot be archived. There is no undo.
- **Archiving acts on a row:** the Threads of a workspace together, and once all of them are archived, every Agent session in the workspace too, so a sidebar row is never left half archived.
- **Archived Threads leave every list.** There is no list of them in v1; one comes with search.
- **Cleanup.** When a workspace that has Threads has no Thread left unarchived, its retention goes back to automatic, and its leases are released again with the new retention `archived`: 7 days from the last session's exit, `workspace.archivedTtlDays`. The sweep then removes it like any automatic workspace, unless it has uncommitted changes or something else still holds it.
- **Ignored files do not block removing an archived workspace** *(proposed; for Rogier's review)*: one with at least one Thread, every one archived. A workspace no Thread used, such as a workflow run's, keeps ADR 0039's rule. Archiving is the user's explicit, final act on that work, and an archived workspace can never be used again by anything in Hercule. Its ignored files are dependencies, build output, and copies that `.workspaceinclude` made from the main workspace. Tracked changes and untracked files still block, and only the user's explicit discard removes them.
- **The harness's files go with the workspace.** When an archived workspace is removed, the runner also deletes those sessions' files in their Harness Homes. A file it cannot delete becomes a warning on the removed workspace, never an error that keeps the workspace.

## Considered options

- **Remove a Done Thread's workspace after a while.** Rejected: Done is reversible by design, and the user would lose work they meant to pick up again.
- **Archive without removing anything; leave cleanup to the user.** Rejected: archiving would then free nothing, and the disk would keep filling.
- **Make archiving reversible for some days.** Rejected: it would bring back a second kind of Done, and the workspace could not be removed during those days anyway.
- **Keep ADR 0039's rule for ignored files in archived workspaces too.** This is the alternative to the proposal above. It keeps one rule for every workspace. Its cost: the sweep refuses nearly every archived workspace, and the user removes them by hand in the cleanup dialog, with "discard changes" ticked for workspaces that hold no changes at all.
- **Let agents archive.** Rejected for the reason under "Only the user archives".

## Consequences

- A new final state on Sessions, set by one operation, `session.archive`, with its own audit entry.
- The sidebar, the Done shelf, Waiting on you and the Office read with `archived: false`.
- Every input path refuses an archived session with a message that names the reason, and an ended Thread's composer names the real reason it cannot be resumed.
- Thread workspaces stop growing without bound once their work is archived.
- Harness Adapters gain one method, `deleteSessionFiles`.
- A Thread in a main workspace keeps its harness files when archived, because the sweep never removes a main workspace and the Fleet screen never offers to.
- A workflow run's workspace that installed dependencies is still kept by ADR 0039's rule after its run ends. That is outside this decision; [#973](https://github.com/theagenticage/hercule/issues/973) has the related bug.
