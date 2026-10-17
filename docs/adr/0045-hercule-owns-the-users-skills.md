# 45. Hercule owns the user's skills

Date: 2026-10-18

## Status

Accepted. Decided by [Hercule manages the user's skills, and every runner gets them (#312)](https://github.com/theagenticage/hercule/issues/312), and written into the spec by [#731](https://github.com/theagenticage/hercule/issues/731). Amends [ADR 0032](./0032-threads-link-the-users-own-material.md), which carries a dated note: for skills only, this decision replaces the links that [#75](https://github.com/theagenticage/hercule/issues/75) built. Instructions, agents, commands and rules keep those links.

## Context

[ADR 0032](./0032-threads-link-the-users-own-material.md) lets a Thread see the user's own material. As built by [#75](https://github.com/theagenticage/hercule/issues/75), the runner reads it from each harness's default install locations, such as `~/.claude/skills` and `~/.agents/skills`, and only on the controller's local runner. A Thread on any other runner runs plain.

Skills are the part of that material users most want everywhere. A Thread on a remote build box should run `/implement` the same way a Thread on the laptop does. Skills also suit being moved:

- **A skill is a self-contained folder.** It holds a `SKILL.md` and the files next to it, and needs nothing else from the machine.
- **Skills already have an update ecosystem.** Tools such as `npx skills` install skills from public GitHub repositories and record where each came from in `.skill-lock.json`. So a skill can be checked against its source and updated.

ADR 0032 already named the destination for this: shape (3), Hercule-owned knowledge as controller state, materialized fleet-wide.

## Decision

**Hercule keeps the user's skills as controller state, in a Skill Library, and delivers them to every runner.**

- **The Skill Library is controller state.** It holds every Skill. A Skill has a name, a current Skill Revision and a Skill Source. A Skill Revision is an immutable set of files, identified by a hash of its content. The files live under the Data Root, and the database holds the rows. The UI calls the library "Skills".
- **Delivered by revision hash.** A session's start frame lists its skills by name and revision hash. The runner keeps a cache keyed by that hash and fetches a missing revision from the controller, checking the hash, as it does for attachments. This works on every runner, not only the local one.
- **One immutable folder per session.** At every start and resume the runner builds the session's own skills folder from copies of the cached revisions. A running session keeps its set. A change to the library applies from the session's next start or resume.
- **Each harness gets the folder its own way.** The route lives only in that harness's adapter. Claude Code loads the folder as a plugin, Codex adds it as an extra skills root, and pi takes it as a `--skill` path ([spec 06 §9.4](../spec/06-providers.md)).
- **Skills only.** Instructions, agents, commands and rules keep the #75 links on the local runner. Until [#733](https://github.com/theagenticage/hercule/issues/733) (Claude) and [#734](https://github.com/theagenticage/hercule/issues/734) (Codex, pi) build the delivery, the #75 skill links remain.
- **Who gets what.** Today every Thread gets every Skill in the library. Assistant sessions and workflow steps get none and stay isolated. ADR 0032's shape (3) is knowledge per Agent; this decision builds one shared set for every Thread first. Naming skills per Agent or per workflow step is [#737](https://github.com/theagenticage/hercule/issues/737). The start frame already lists the session's own skills, never "the library", so #737 can give sessions different sets without changing the frame.
- **Nothing changes a skill by itself.** An import or an upload applies at once, and needs `skill.apply`. An update found upstream, or a revision a session proposes, waits until someone applies it. A session needs the `skill.apply` grant to apply one, and a session that has read third-party messages cannot apply at all ([spec 13](../spec/13-security.md)).

The model is in [spec 02](../spec/02-domain-model.md), storage in [spec 04](../spec/04-state-store.md), the operations in [spec 11 §2](../spec/11-public-api-and-agent-surface.md), the protocol in [spec 03 §2.2](../spec/03-controller-and-runners.md), delivery on runners in [spec 06 §9.4](../spec/06-providers.md), grants and taint in [spec 13](../spec/13-security.md), and the desktop screen in [spec 17](../spec/17-desktop-app.md).

## Considered options

- **Two-way sync between the library and `~/.agents/skills`.** Rejected. It makes two sources of truth, so an edit on either side can conflict with an edit on the other. It also puts a Hercule writer on the user's own disk.
- **Mirroring a folder as the only source.** Hercule would read the user's skills folder and serve what it finds. Rejected. It works on one machine only: a runner on another machine cannot see the folder. It also keeps no history and leaves no place for an update or a proposed revision to wait. A folder on a runner as one kind of Skill Source, beside GitHub and upload, is [#738](https://github.com/theagenticage/hercule/issues/738).
- **Claude's `additionalDirectories`.** Rejected. It needs project settings, which breaks the isolation of spec 06 §9.1. It gives the session write access to the folder. And a skill with the same name elsewhere silently hides the library's skill.

## Consequences

- **Skills reach remote runners.** A Thread on any runner gets the same skills, at the same revisions.
- **Updates and proposals become possible.** A GitHub-sourced skill can be checked for changes, and a session holding `skill.write` can propose a revision. Among the shipped profiles only `unrestricted`, which is user parity, holds a `skill` grant.
- **A new way to change approvals.** On Claude Code, a skill's `allowed-tools` and `hooks:` can let tools run without Hercule's approval card (spec 06 §9.1). Until now such a skill came only from the user's own disk. With the library it can also arrive from a GitHub update or from a session. The guard is that nothing is applied by itself, a tainted session cannot apply, and the Skills screen warns when a revision carries `allowed-tools` or `hooks`.
- **The #75 skill routes retire.** #733 and #734 remove Claude's `skills` link, the real `HOME` for Codex Threads, pi's two `--skill` flags and `UserMaterial.skillDirs`. The rest of User Material stays as ADR 0032 has it.
- **The controller grows a file store.** Skill Revisions are files under the Data Root, so they move with promotion. Like Attachments, they are not in the database snapshots that backups take ([spec 04](../spec/04-state-store.md#backups)).
