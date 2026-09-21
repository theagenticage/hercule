# 30. Sessions copy their configuration, and a Thread has no Agent

Date: 2026-09-01

## Status

Accepted. Decided by [Domain model residue](https://github.com/rogierpennink/hydra/issues/46). Refines [ADR 0013](./0013-agents-operate-hercule-through-the-public-api.md) (session tokens still resolve to one permission profile) and [ADR 0001](./0001-runs-freeze-an-execution-plan.md) (the same freeze-at-start rule, applied to sessions).

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
