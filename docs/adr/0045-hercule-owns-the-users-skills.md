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
- **Nothing changes a skill by itself.** An import, which includes "Upload new version", is the user's own files and applies at once. Only the user can import: a session is refused whatever it holds. Only a session can propose: the user imports instead. An update found upstream, or a revision a session proposes, waits until someone applies it. A session needs the `skill.apply` grant to apply one, and no shipped profile holds it ([spec 13 §6.2](../spec/13-security.md)). So a session's only way to change a skill is to propose a revision that someone then applies.

The model is in [spec 02](../spec/02-domain-model.md), storage in [spec 04](../spec/04-state-store.md), the operations in [spec 11 §2](../spec/11-public-api-and-agent-surface.md), the protocol in [spec 03 §2.2](../spec/03-controller-and-runners.md), delivery on runners in [spec 06 §9.4](../spec/06-providers.md), grants and taint in [spec 13](../spec/13-security.md), and the desktop screen in [spec 17](../spec/17-desktop-app.md).

## Considered options

- **Two-way sync between the library and `~/.agents/skills`.** Rejected. It makes two sources of truth, so an edit on either side can conflict with an edit on the other. It also puts a Hercule writer on the user's own disk.
- **Mirroring a folder as the only source.** Hercule would read the user's skills folder and serve what it finds, through the same delivery by revision hash, so remote runners would get the skills too. Rejected, for two reasons:
  - A change to the folder reaches Hercule only while the machine that holds the folder is on and reachable. When the laptop is closed, a remote build box cannot learn of an edit made there.
  - Updates and proposed revisions need somewhere to wait, and the user's folder is the wrong place. Either Hercule writes them into the user's folder, and then Hercule and the user's own tools are two writers on one folder that fight, or Hercule keeps them in its own state, and then Hercule's state decides what a session gets. That is ownership, which is this decision. A folder on a runner as one kind of Skill Source, beside GitHub and upload, is [#738](https://github.com/theagenticage/hercule/issues/738).
- **Claude's `additionalDirectories`.** Rejected. It needs project settings, which breaks the isolation of spec 06 §9.1. It gives the session write access to the folder. And a skill with the same name elsewhere silently hides the library's skill.

## Consequences

- **Skills reach remote runners.** A Thread on any runner gets the same skills, at the same revisions.
- **Updates and proposals become possible.** A GitHub-sourced skill can be checked for changes, and a session holding `skill.write` can propose a revision. `unrestricted` holds `skill.read`, and `assistant` holds `skill.read` and `skill.write`, so an assistant can propose. No shipped profile holds `skill.apply`. `skill.write` and `skill.apply` are the first grants user parity leaves out. `unrestricted` is the default profile of every Thread, so with parity any Thread that read a hostile README could change the skills every future Thread loads. The user adds the two grants to a profile on purpose.
- **A new way to change approvals.** On Claude Code, a skill's `allowed-tools` and `hooks:` can let tools run without Hercule's approval card (spec 06 §9.1). Until now such a skill came only from the user's own disk. With the library it can also arrive from a GitHub update or from a session. The guards ([spec 13 §8](../spec/13-security.md)):
  - nothing is applied by itself, no session can import, and no shipped profile holds `skill.apply`;
  - beyond the shipped `assistant` profile's `skill.write`, only the user gives a profile `skill.write` or `skill.apply`: a session holding `permission.write`, as every `unrestricted` Thread does, cannot add them to a profile or decide a request for them;
  - the Skills screen and the CLI warn when a revision carries `allowed-tools` or `hooks`, and the list says "Update may change approvals" before an update that changes them, or that has hooks, is applied;
  - a tree an update check fetches from GitHub passes the same content rules as an import.

  Taint is not one of the guards yet. Spec 13 §10 refuses an apply from a session that has read third-party messages, but no session stores a taint flag today. [#736](https://github.com/theagenticage/hercule/issues/736) builds the flag, passes it on to the sessions a tainted session starts, forks or sends input to, and adds the check. Until then the grant is the guard.
- **The #75 skill routes retire.** #733 and #734 remove Claude's `skills` link, the real `HOME` for Codex Threads, pi's two `--skill` flags and `UserMaterial.skillDirs`. On Claude, #733 also deletes the `skills` link the runner already made in each instance home, because the runner revisits only the entries it still lists ([spec 06 §9.4](../spec/06-providers.md)). The rest of User Material stays as ADR 0032 has it.
- **The controller grows a file store.** Skill Revisions are files under the Data Root, so they move with promotion. Like Attachments, they are not in the database snapshots that backups take ([spec 04](../spec/04-state-store.md#backups)).
