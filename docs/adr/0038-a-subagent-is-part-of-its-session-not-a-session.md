# 38. A subagent is part of its session, not a Session

Date: 2026-10-03

## Status

Accepted. Decided by [What a subagent is in Hercule's domain model](https://github.com/theagenticage/hercule/issues/350), part of [Subagents: see and steer every subagent of a session](https://github.com/theagenticage/hercule/issues/345).

## Context

All three harnesses delegate work to subagents: Claude Code through its `Agent` tool, Codex through collab agents that are child threads, and pi through a `subagent` tool that Hercule will ship in its own pi extension. The user must be able to see every subagent a session ran, open its transcript like any session's, and act on it. That needs a place in the domain model.

The obvious home is a Session row per subagent, so the transcript view, the live topic and the CLI work unchanged. t3code took that road: for Claude and Codex, every subagent becomes a full t3code thread. But no harness gives a subagent what a Session is made of:

- **No process of its own.** A Claude subagent runs inside the parent's CLI process. Codex and pi children use the parent's approval policy, sandbox and working directory.
- **No placement, token or access mode of its own.** An API call made by a subagent uses the parent's session token.
- **No resume or fork of its own.** A Claude subagent continues only when the main model messages it. A Codex V2 child resumes only through its parent. A pi child ends with its parent.

As a Session, a subagent would need exceptions in nearly every rule that treats a session as the unit of agent work:

- `session.input`, fork and stop would each need a check.
- The session list would be crowded with subagents.
- The Thread rule ("a Session with no Agent") would wrongly match every subagent, since a subagent has no Agent either.
- `nativeSessionId` would have to hold ids that are not session ids.

t3code shows these costs in practice:

- a read-only bar in place of the composer;
- a special status node for child threads, which have no runs;
- child threads hidden from the sidebar, with their approvals moved back onto the parent;
- each child copying its parent's branch and PR links.

## Decision

**A Subagent is its own entity, owned by its session the way a Turn is.**

- **Identity:** the harness's own stable id for the child, scoped to its session. That is the Claude agent id (not the `Agent` tool-use id), the Codex child thread id, or the child id from Hercule's pi extension. Because the id comes from the harness, a subagent continued after its session resumes, or seen again in a replay, lands on the same record with no lookup.
- **Nesting:** a pointer to the subagent that started it, empty when the session's own agent started it, plus the id of the `subagent` item that started it in its parent's transcript. Depth is computed from the chain, not stored.
- **Turns:** a subagent has turns of its own. Codex child turns pass through as they arrive. For Claude and pi, the adapter opens a turn when a subagent starts or is continued, and closes it when that agent finishes.
- **Status:** computed from its turns, the same way a session's is. It is `running` while a turn is open; otherwise it takes the ending of its last turn: `completed`, `failed`, or `stopped` (the turn's `interrupted`). An ended subagent goes back to `running` when its parent continues it. When the session's process exits, every open subagent turn is closed as interrupted. A subagent can outlive the turn that started it, but never its session's process. A forked session starts with no subagents.
- **Transcript:** the part of the session's normalized stream that is attributed to the subagent. The main transcript is the part attributed to no subagent. Both views go through the same reading and grouping code, only with a different filter.

**One rule keeps Session intact: an event attributed to a subagent never changes the session's own state.** That covers its status, its open Request, an assistant's reply and the session's turn notifications. This filter is needed whatever the model. Without it, a subagent's text ends up in its parent's reply, as in [A Claude subagent's text leaks into its parent's reply](https://github.com/theagenticage/hercule/issues/343).

## Consequences

- Session keeps its CONTEXT.md meaning: one run of a provider-backed agent, with its own process and transcript, resumable and forkable. Turn widens to cover a subagent's episodes, and a session's status follows its own agent's turns only.
- A subagent can make many events, and they all land in its parent session's stream. So the attribution is stored where reading the main transcript can skip it cheaply, and a client watching the main transcript is not sent a subagent's events.
- A future Hercule session spawned by another session would be a real Session with a "spawned by" link of its own. It is not a Subagent and not a fork (`parentSessionId` stays fork lineage). A session's list of subagents may later show such sessions too. That future link is left open here, and so is whether it is needed at all.
