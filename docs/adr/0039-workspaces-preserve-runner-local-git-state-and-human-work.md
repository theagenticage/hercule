# 39. Workspaces preserve runner-local Git state and human work

Date: 2026-10-07

## Status

Accepted by [Workspace lifecycle (#459)](https://github.com/theagenticage/hercule/issues/459). Supersedes the managed-only main workspace, standalone-primary clone, ephemeral-only setup and Thread TTL behavior in specs 02, 03, 11, 14 and 17. Amends [ADR 0036](./0036-a-workspace-is-kept-by-leases-its-holders-release.md) by separating retention from active use. Keeps ADRs 0004, 0016, 0017, 0031, 0033 and 0037: one controller database, Connection-derived credentials, client-core interpretation, Effect services, the domain DAG and typed desktop IPC.

## Context

Each runner previously used a bare cache for ephemeral worktrees and a standalone clone for main. Branch discovery in main therefore offered local branches absent from the repository used to create a new worktree. Desktop folder selection discovered the remote and then left the user's checkout aside. Provisioning could treat existing directories as successful setup after restart. Thread workspaces could eventually be removed after session exit despite unfinished human work.

Existing-checkout registration was previously rejected because the controller could not reconstruct a runner request carrying its path. Persisting explicitly runner-scoped attachment intent solves that recovery problem without making a machine path a portable Resource property. Paths and unpushed commits must remain independent on each runner.

## Decision

**Choose one local Git repository for each Resource/Runner pair, record preparation outcomes durably, and retain human work until explicit discard.** The same operations and Git implementation apply to every supported runner. Locality only decides whether a native folder picker can select that runner's path.

*(Amended 2026-10-07, [#459](https://github.com/theagenticage/hercule/issues/459), following Rogier's naming decision.)* Workspace ownership uses `managed | adopted`. Adoption means registering an existing checkout, not taking ownership of its files. The operation remains `workspace.attach`, and repository mode remains `managed | existing`: generated managed worktrees may use an existing, user-owned source repository.

- **Two explicit modes.** Existing mode registers a user-selected checkout root and discovers its Git common directory. Managed mode establishes a runner-owned bare repository; newly created main and ephemeral working copies are worktrees of it. A workflow-only runner needs no unused main working copy. The established selection is fixed; duplicate intent is idempotent and conflicting mode/path/repository choices are refused.
- **Preserve registration.** `workspace.attach` persists the user-authorized runner path and selected remote before delivery. The runner normalizes the checkout root and validates its canonical remote identity, accepting linked worktrees. Registration never clones, fetches, switches branch, runs setup, rewrites persistent configuration or deletes files. Session actors cannot submit external paths. A missing attachment fails visibly without another-directory fallback; reattachment of the same restored path validates it again.
- **Use explicit commits and refs.** A new Checkout starts from current committed state, a named local branch or a fetched remote branch/default. Existing mode defaults to current; managed mode defaults to fetched remote default. Local/current requires no fetch, and remote requires successful fetch without local fallback. Persist the requested choice and resolved commit. Replay uses that commit, even if the branch advances. New worktrees create new branches and do not copy dirty tracked files. `.workspaceinclude` stays restricted to the main workspace on the same runner, with visible warnings.
- **Coordinate the actual Git repository.** First-use selection/bootstrap is coordinated per Resource/Runner pair, then shared mutations by canonical Git common directory and index mutations by the actual checkout. Independent repositories remain concurrent. Never hold these locks through arbitrary setup or an agent's lifetime, delete external Git locks or force occupied branches.
- **Record preparation before ready.** Freeze creation/setup instructions. Persist in-progress and terminal preparation states, result and warnings in the runner registry before reporting. Replay returns terminal results without repeating setup. Interrupted arbitrary setup remains interrupted, because directory existence cannot establish success and exactly-once shell side effects cannot be promised. Fresh attempts use distinct managed directories. An unreadable registry is a recovery error, never an empty registry permitting recreation.
- **Apply setup to creation.** Every newly created managed working copy runs applicable setup once, including new managed main. Attachment, join, resume and completed replay run it zero times. Keep existing environment scrubbing, credential restrictions and deadlines.
- **Observe at decisions.** Inspect actual Git and filesystem facts on menu decisions, explicit refresh, start/resume and completed turn/exit, coalesced per workspace. Persist observation time and publish workspace-topic changes. Persisted reads remain distinct from fresh inspection. Offline inspection fails actionably; stale facts show their age. No idle polling or per-token work is added.
- **Separate ownership, retention and use.** Attached main directories are user-owned; generated worktree paths are managed even when their common repository is user-owned. Thread use permanently sets manual retention in the lease-acquisition transaction, including a Thread joining a workflow workspace. Existing Thread workspaces are backfilled. Active leases still determine runtime use and credential eligibility. Automatic workflow lease windows and transient workspace-less scratch directories retain their meaning.
- **Remove only authorized files.** Automatic cleanup uses no force and refuses tracked changes, untracked files, ignored files and multi-repo-root files with an actionable retained reason. Ignored dependencies can therefore retain a workspace. Preflight multi-repo cleanup; truthfully report partial removal and preserve remaining files. Explicit user discard may force only known managed paths after a discard choice. Committed branches, source repositories and attached folders remain. Detach forgets an attached registration and explains derived worktrees, which keep their source binding.
- **Reserve disposal before I/O.** Check holders/retention/ownership and record `disposing` in a database transaction. Admission, resume and join recheck readiness in their lease transaction. Perform filesystem I/O outside transactions. Mark deleted only on successful removal; refusal restores available state with its reason and transport interruption retains retriable intent.

The owning schemas and public routes live in spec 11; workspace semantics live in spec 03 section 6.8. Each added public operation has an Effect-service implementation, permission/actor enforcement and CLI row. Unsupported runner capabilities are refused visibly, never silently downgraded.

## Legacy preservation

New migrations do not edit old migrations or change existing IDs, files, HEADs, branches or provider transcript associations. Existing standalone main clones remain selected for new local worktrees; existing cache-derived worktrees retain their original cache. A cache-only managed selection stays bare. No files move, branches copy, checkouts reset or clones convert automatically. Each new Checkout records its actual repository, so later registration changes cannot reinterpret old worktrees. Legacy reads remain supported; newer attachment, revision, inspection and safe-disposal requests require negotiated runner support.

## Considered options

- **Keep two repositories and copy branches.** Rejected. Branch copies become stale and obscure which local state the UI selected. Discovery and creation must use the same repository.
- **Infer existing mode on a Mac.** Rejected. Platform/locality cannot authorize attachment; either mode must work on every supported runner.
- **Recreate or convert existing directories during upgrade.** Rejected. Cleaner topology does not authorize rewriting files containing unfinished work. Preserve old topology through explicit source bindings.
- **Rerun setup whenever directories exist after restart.** Rejected. Arbitrary setup can have external effects, and interrupted success cannot be inferred. Persist outcomes and expose interruption.
- **Keep Thread leases active forever.** Rejected. Retention is authorization for collection, while active use controls admission and credentials. A permanent lease would confuse both rules.
- **Force automatic cleanup of ignored files.** Rejected. Ignored files can contain private configuration or unfinished work. Explicit discard is the boundary for removing them.

## Consequences

Worktrees isolate working files while sharing refs and repository configuration. They provide no exclusivity against the user's editor, external Git or arbitrary agent shell commands. Users wanting an independent repository select managed mode. No cross-runner transfer of local commits or dirty files is implied.

The controller stores an explicitly supplied absolute path only as opaque intent for its named runner. It never resolves the path on the controller machine. Promotion moves that intent unchanged while runner disks remain in place; controller-owned paths remain relative to the Data Root.

Managed main setup now matches fresh worktree setup. Human work survives stopped sessions and historic TTLs, at the cost of explicit disposal and disk use. Safe automatic cleanup conservatively retains ignored dependencies as well as private files. Interrupted setup needs a fresh workspace, not an automatic replay of arbitrary commands.

Desktop choices explain existing versus managed storage separately from sharing versus a new worktree. Starting a Thread in main files preserves its branch. An explicit stored default is honored; without one, a project-level coding Thread starts in a new workspace. Workspace details expose observed facts, retention and next actions. Domain interpretation stays in client-core; full editor/diff integration, repository replacement and live filesystem migration remain outside scope.
