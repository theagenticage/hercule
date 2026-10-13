# 30. Sessions copy their configuration, and a Thread has no Agent

Date: 2026-09-01

## Status

Accepted. Decided by [Domain model residue](https://github.com/theagenticage/hercule/issues/46). Refines [ADR 0013](./0013-agents-operate-hercule-through-the-public-api.md) (session tokens still resolve to one permission profile) and [ADR 0001](./0001-runs-freeze-an-execution-plan.md) (the same freeze-at-start rule, applied to sessions).

**Amended 2026-10-13 ([#593](https://github.com/theagenticage/hercule/issues/593)):** A session may start or fork a Thread, when the user has allowed it. This replaces the sentence "Only the user may spawn one; a session, run or plugin actor must name an Agent" in the Decision below. It also narrows the sentence before it: a Thread is built from the user's thread defaults only when the user starts it. A Thread a session starts is built from the calling session. The rest of the Decision stands.

- **Who may.** The user, as before. A session actor whose grants hold `thread.start` may also start a Thread (`session.spawn` without `agentId`) or fork one (`session.continue` on a Thread). Its grants are its profile's grants plus the grants a Permission Request decided `session`. It needs `session.spawn` as well: the operation's static check is unchanged, and the method checks `thread.start` itself, because only the method knows that the call starts a Thread. A session without `thread.start` is refused 403 naming `thread.start`. Run and plugin actors stay refused: they have no permission profile, so the user has nothing to control them with.
- **What the new Thread gets.** Each field is the value in the call, else the calling session's own value, else the instance's default. The Thread copies the caller's instance, its model and options (only when the instance is the caller's), its requested access mode, its permission profile, its project (while it exists) and its GitHub Connection. It does not copy the caller's workspace or runner. It never copies an Agent caller's system prompt, disallowed tools or output schema, because a Thread has no Agent. A copied project limits the Thread's workspace like a named one: every repo in it must be filed under that project. The user's `thread.*` settings are not read for a session caller. A session actor carries no user id and the sessions table has no owner column, so reading the user's settings would need a concept of who owns a session. That is multi-user machinery, and the actor stamp is the only multi-user seam the spec allows. Copying also keeps the rule above: sessions copy, never reference. A fork already copies its parent this way.
- **What the caller may override.** Everything, as the user can, including `full-access`. The one exception is the permission profile: it is refused 403 naming `thread.start` when it grants anything outside the caller's profile grants. Grants decided `session` by a Permission Request do not count, as in the Agent rule of spec 13 section 6.3. A narrower profile is allowed. Without this exception, `thread.start` on any profile would amount to `unrestricted`: the caller could start an `unrestricted` Thread and drive it.

The old rule guarded against three risks. Each is now controlled or consented to:

| Risk the rule guarded against | What controls it now |
|---|---|
| A Thread takes `thread.profileId` (shipped: `unrestricted`), so a narrow session could gain API grants. | A Thread a session starts never reads the user's `thread.*` settings. Its profile defaults to the caller's, and an override must grant nothing beyond the caller's profile grants. This is the subset rule that already applies to an Agent spawn. |
| A session could start work at a more permissive access mode. | Lifted on purpose. Holding `thread.start` is the user's consent, given per permission profile, to let the caller ask for any mode. |
| A Thread on the controller's local runner sees User Material ([ADR 0032](./0032-threads-link-the-users-own-material.md)), whose skills and hooks can approve tools without asking. | Lifted on purpose, under the same consent. Only a profile the user gave `thread.start` can do it. The shipped `assistant` and `worker` profiles do not hold it, so a session on a profile without it stays isolated. The migration gave the grant to the shipped `unrestricted` profile, so every session, Agent and workflow step on `unrestricted` gains it, not only the user's Threads. |

**Why a grant, and not a rule about the kind of actor** such as "only a Thread may start a Thread":

- The user decides per permission profile in Settings, and can change it later.
- A refused agent can ask for the grant with a Permission Request, because the 403 names it.
- It follows the pattern of one operation needing a second grant that its method checks. Posting a manual event needs `connection.use` beside `event.emit`.

The shipped `unrestricted` profile holds `thread.start`. `assistant` and `worker` do not.

## Context

Every session carried a required `agentId`, and a session token resolved its permission profile through it (`token -> session -> agent -> profile`). That made the Agent the only way to start a session, so the hand-started, t3-code-style session the Sessions home screen is built around needed an Agent behind it too. The first proposal was a built-in "interactive" Agent per provider instance. It kept the resolution chain intact and cost only three hidden rows, but it put the wrong concept in the user's face: to the user, a session they open by hand is a thread, not an agent - nothing survives it, nothing about it is reusable in a later session - and every future provider plugin would have had to ship a built-in agent that adds nothing.

The deeper issue was reference versus copy. A session that reads its model, access mode or profile through its agent changes behaviour when the agent is edited, and a past session no longer shows the configuration it actually ran with.

## Decision

**Sessions copy, never reference.** An Agent supplies values at spawn; the Session row holds its own copy of everything that shaped it - its `SessionSpec` (already stored byte for byte) and its `permissionProfileId` - and no property of a running or past session is ever read through its `agentId`. Profile resolution is `token -> session -> profile`, one hop. `agentId` is optional lineage.

**A Thread is a session with no Agent.** It is a Session row with `agentId: null`, assembled from the user's thread defaults in the settings store (`thread.instanceId`, `thread.model`, `thread.accessMode`, `thread.profileId`) plus whatever the user changes in the create form for that one thread. Only the user may spawn one; a session, run or plugin actor must name an Agent, otherwise the thread profile would be an escalation path. User-facing copy says "thread"; the provider-native "Codex thread" and the container level "Slack thread" are always qualified.

## Consequences

- Reassigning an agent's profile or changing its defaults affects sessions spawned afterwards, not running ones. Editing a profile's *grants* still applies live, because the session points at the profile row.
- Agents are what workflows and assistants use. A user who never touches workflows or Intake sees only threads and experiences Hercule as another t3-code.
- Adding a provider adds no agent. Deleting an agent is refused while a non-exited session references it; exited sessions keep the id as history.
- "Chat" is reserved for a possible post-v1 non-agentic conversation surface and is not a synonym for thread.
