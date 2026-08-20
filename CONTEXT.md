# Hydra

Ubiquitous language for Hydra, a self-hosted agent orchestration platform. This glossary is the vocabulary the v1 spec is written in.

## Language

### Product

**Hydra**:
The product. A controller-plus-runners platform that orchestrates agents doing work on the user's behalf.
_Avoid_: agentick, agentick-next

### Work

**Task**:
A unit of human intent: a described piece of work someone wants done. Work-type-agnostic; a task is not itself an execution.
_Avoid_: ticket, issue (reserved for external trackers)

**Session**:
One conversation with a provider-backed agent, resumable and forkable. Maps onto a Claude Code session or Codex thread. A session can drive work directly (chat-first) and is not required to belong to a task or workspace.
_Avoid_: execution, thread (reserved for provider-native objects)

**Run**:
One execution of an execution plan, usually stamped from a workflow. Nothing else in the system is called a run.
_Avoid_: job, execution, workflow instance

**Execution Plan**:
The executable content a run executes: triggers, graph, actions. Frozen at run start; immutable thereafter. Usually stamped from a workflow, but may be generated ad-hoc by an agent and never stored.
_Avoid_: recipe, definition (for this), workflow instance

### Actors

**Agent**:
A configured identity that does work: prompt, provider, capabilities. Owned by the controller, not by any repo.
_Avoid_: persona, worker (as a noun)

**Assistant**:
An agent bound to a channel with persistent memory, oriented toward delegating work rather than doing it. A specialization of agent, not a separate concept.

### Organization

**Project**:
A grouping of related work and its materials. May span multiple resources (repos, folders, mailboxes); not bound to a single git repo.
_Avoid_: workspace (as a grouping term)

**Resource**:
A durable external thing a project works with: a git repo, a folder, a mailbox. A vocabulary term, not a promise of a common code interface.
_Avoid_: source, asset, material

**Workspace**:
A provisioned working copy on a runner, created from a checkout-able resource, in which sessions do their work.
_Avoid_: worktree (reserved for the git mechanism), playground

### Infrastructure

**Controller**:
The always-on brain: holds all state, receives events, schedules work. The single source of truth; repos hold no Hydra config.

**Runner**:
A daemon on a machine that executes sessions on the controller's behalf.

**Provider**:
An adapter wrapping an interactive coding harness (Claude Code, Codex, pi). Only this; integrations like GitHub are event sources, not providers.
_Avoid_: harness (for the adapter itself), integration

**Channel**:
A chat surface Hydra speaks through (Discord, Slack).

### Extension

**Plugin**:
A self-contained unit of functionality that extends Hydra through its APIs. The structuring principle of v1: internal features are built as plugins. Whether providers and channels are themselves plugins is a design question, not settled by this glossary.

### Automation

**Event Source**:
An origin of external events: GitHub, Gmail, cron, manual.
_Avoid_: integration, provider

**Event**:
A fact that happened, emitted by an event source ("issue #42 was labelled ready-for-agent").

**Workflow**:
A named, stored, editable source of execution plans. Owns its triggers; can be as small as one trigger plus one action. Editing a workflow never affects in-flight runs.
_Avoid_: recipe

**Trigger**:
A workflow's rule for when events enter it. Two kinds: a start trigger (static condition, spawns a new run) and a signal trigger (condition shape plus correlation key, resumes the live run that registered it). Lives inside the workflow, not as a standalone routing entity.
_Avoid_: rule, hook

**Subscription**:
A live, correlated claim on future events, held by a run or a session ("deliver events about PR #87 to me"). The runtime instantiation of a signal trigger, or registered directly by a session. Dies with its holder.
_Avoid_: watch, listener
