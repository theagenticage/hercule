# 50. Archived Threads, and what happens to their workspaces

Date: 2026-11-02

## Status

Accepted by [Desktop Fleet: the design and its tickets (#972)](https://github.com/theagenticage/hercule/issues/972), decided with Rogier on 2026-11-02. Amends [ADR 0039](./0039-workspaces-preserve-runner-local-git-state-and-human-work.md), which keeps every Thread workspace until the user removes it and never lets automatic cleanup remove files Git does not have.

## Context

ADR 0039 made a Thread's workspace manually retained: a Thread can always be picked up again, so its workspace is never removed automatically. Done did not change that, because Done is a reversible mark: a Done Thread still takes input.

So Thread workspaces only grow. On a busy machine they fill the disk, and the Fleet screen shows it: many gigabytes of workspaces nobody has used for weeks. The user's only way out was to remove workspaces one at a time, after which their Threads could not be resumed, and nothing said why.

Three more facts shaped the decision:

- ADR 0039's cleanup refuses a workspace while `git status` shows tracked changes, untracked files or ignored files. Almost every workspace that ran `pnpm install` or a build holds ignored files (`node_modules`, build output), so that rule keeps nearly every workspace, a finished workflow run's included.
- Workspaces were designed to know as little about Git as possible. A workspace is a folder that holds checkouts; a checkout is what may be a Git worktree, and a multi-repo workspace holds several. Rules about Git state inside workspace removal make it harder to support work that is not in Git later.
- A harness keeps its own copy of each session's transcript in its Harness Home. Removing a workspace left those files behind.

## Decision

**A Thread can be Archived: a final state, set only by the user. An archived workspace, and a finished run's, is removed whole, with no look at Git.**

- **Archived is final.** An archived Thread can never be resumed, sent input or reopened. Its transcript stays readable on the controller. Done stays the user's reversible mark; archiving marks a Thread Done first.
- **Only the user archives,** from the thread's header, from the Done shelf, or from the Fleet screen's cleanup dialog. A session is refused whatever its grants, because an agent could otherwise make the user's work unresumable without the user seeing it. A working Thread (queued, starting or busy) cannot be archived. There is no undo.
- **Archiving acts on a row:** the Threads of a workspace together, and once all of them are archived, every Agent session in the workspace too, so a sidebar row is never left half archived.
- **Archived Threads leave every list.** There is no list of them in v1; one comes with search.
- **Cleanup.** When a workspace that has Threads has no Thread left unarchived, its retention goes back to automatic, and the released leases of its archived sessions are released again with the new retention `archived`: 7 days from the last session's exit, `workspace.archivedTtlDays`. An active lease is never released early.
- **Removed whole, without Git checks.** The sweep removes an archived workspace with everything in it, uncommitted and ignored files included; so it does a finished workflow run's workspace once its run's window has passed. Archiving is the user's explicit, final act on that work, and the confirmation says that everything in the workspace goes. Nothing can use a finished run's workspace again either.
- **Workspace and checkouts stay apart.** Removal first runs each checkout's own removal, which for a Git checkout unregisters its worktree, then deletes the workspace's folder. Only the checkout's removal knows Git. A later **workspace removal hook**, such as a Git plugin that refuses while a checkout holds uncommitted work, would sit there. No hook is built now.
- **The harness's files go with the workspace.** When an archived workspace is removed, the runner also deletes those sessions' files in their Harness Homes. A file it cannot delete becomes a warning on the removed workspace, never an error that keeps the workspace.

## Considered options

- **Remove a Done Thread's workspace after a while.** Rejected: Done is reversible by design, and the user would lose work they meant to pick up again.
- **Archive without removing anything; leave cleanup to the user.** Rejected: archiving would then free nothing, and the disk would keep filling.
- **Keep ADR 0039's Git check for archived and run workspaces.** Rejected: the sweep would refuse nearly every one of them for its `node_modules`, so archiving would free nothing by itself, and it would tie workspace removal to Git.
- **Let ignored files go, but keep uncommitted files blocking.** Rejected for the same reason: it adds Git rules to workspace removal, which a hook should own later.
- **Make archiving reversible for some days.** Rejected: it would bring back a second kind of Done, and the workspace could not be removed during those days anyway.
- **Let agents archive.** Rejected for the reason under "Only the user archives".

## Consequences

- A new final state on Sessions, set by one operation, `session.archive`, with its own audit entry.
- The sidebar, the Done shelf, Waiting on you and the Office read with `archived: false`.
- Every input path refuses an archived session with a message that names the reason, and an ended Thread's composer names the real reason it cannot be resumed.
- Thread workspaces stop growing without bound once their work is archived, and finished runs' workspaces go when their windows end, `node_modules` or not.
- Work the user never committed in an archived workspace is deleted a week after the last session in it ended. The confirmation states it before the user archives.
- `workspace.dispose` by hand keeps ADR 0039's check for a workspace that is not archived. Whether that check should move into a hook is a later question.
- Harness Adapters gain one method, `deleteSessionFiles`.
- A Thread in a main workspace keeps its harness files when archived, because the sweep never removes a main workspace and the Fleet screen never offers to.
