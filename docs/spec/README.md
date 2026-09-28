# Hercule v1 spec

The buildable specification for Hercule v1: architecture, domain model, scope, and one document per subsystem. It consolidates the decisions worked on the [wayfinder map](https://github.com/theagenticage/hercule/issues/1) into normative text an implementer can build from without opening the tickets. The "why" behind each decision lives in the [ADRs](../adr/); the vocabulary lives in [CONTEXT.md](../../CONTEXT.md); the visual language and pinned UI semantics live in [design-language.md](../design-language.md).

**Status:** assembled 2026-08-28. Every decision the map closed is in here. The open questions that assembly surfaced are listed in [16-open-items.md](./16-open-items.md), each either handed to a follow-up ticket on the map, marked as an implementer's choice, or marked as a build-time verification. Implementation can start on any subsystem whose open items are implementer choices only; the ticketed items are amendments, not redesigns.

## How to read

Start with [01-overview-and-scope.md](./01-overview-and-scope.md) (what ships, what does not, and a walk of one event through the whole system) and [02-domain-model.md](./02-domain-model.md) (every entity and how they relate). Then read the subsystem you are building. Each document ends with a `## Sources` section naming the tickets and ADRs it consolidates, and a `## Post-v1` section listing what its area deliberately leaves for later and the constraint v1 keeps to make it possible.

| Document | Owns |
|---|---|
| [01-overview-and-scope.md](./01-overview-and-scope.md) | product overview, identity features, standing decisions, v1 scope in and out, architecture at a glance |
| [02-domain-model.md](./02-domain-model.md) | every entity: purpose, fields, relationships, status axes, identity rules, platform events |
| [03-controller-and-runners.md](./03-controller-and-runners.md) | controller/runner split, runner protocol, join, placement, runner states, execution substrate (workspaces, checkouts, teardown), promotion |
| [04-state-store.md](./04-state-store.md) | the SQLite store, repositories, event log and session streams, queues and cursors, retention, backups, migrations |
| [05-plugins.md](./05-plugins.md) | the plugin model: manifest, register/activate, extension points, host API and plugin capabilities, plugin state, lifecycle |
| [06-providers.md](./06-providers.md) | provider definitions and adapters, session spec, capability snapshots, the normalized event taxonomy, access modes, structured output, per-provider build notes |
| [07-workflows.md](./07-workflows.md) | workflow definitions, triggers, steps, routing and cycles, CEL, runs and re-runs, the agent-to-graph contract, built-in actions |
| [08-events-and-connections.md](./08-events-and-connections.md) | the event pipeline and envelope, event sources, subscriptions, Connections and their setup flows |
| [09-tasks.md](./09-tasks.md) | the Task model: fields, status axis, labels, provenance, search |
| [10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) | triage as a workflow pattern, spawn bounds, Notifications (record, router, sinks, bound actions), Intake and check-in model requirements |
| [11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) | the public API contract, actors, session tokens, permission enforcement, the `hercule` CLI, session subscriptions |
| [12-assistants.md](./12-assistants.md) | assistants, conversations, channel bindings, rotation, memory, heartbeat, channel plugins |
| [13-security.md](./13-security.md) | perimeter, secrets and master key, user auth, grants and shipped profiles, escalation, git credentials, taint, audit |
| [14-web-app.md](./14-web-app.md) | the web app: architecture, live topics, screens, check-in and Intake views, workflow editor, design language pointer |
| [15-packaging-and-operations.md](./15-packaging-and-operations.md) | the single binary, Hercule Home, service install, first run, migrations, upgrade, backups, Bun build notes |
| [16-open-items.md](./16-open-items.md) | the register of open questions, implementer choices, build-time verifications, and standing risks |
| [17-desktop-app.md](./17-desktop-app.md) | the desktop app: process model, reaching the controller, token storage, Electron security, the IPC contract, native behaviour, the Crew Bureau design system, performance budgets, slices |

## Conventions inside the documents

- Text is normative and in the present tense. Rationale is at most a clause, followed by a link to the ADR that holds it.
- Where a document consolidated a name or an enum from pinned facts (the tickets pinned the behaviour but not the spelling), it says so. Where it had to leave something open, it says so with one of these markers at the start of a line, one per line, so they can be harvested:
  - `**Open:**` a decision the sources do not make. Every one is indexed in [16-open-items.md](./16-open-items.md).
  - `**Verify at build time:**` a fact about a third-party system to confirm against the pinned version before relying on it.
  - `**Conflict:**` two sources disagree and the spec could not settle it from the later source alone.
  - `**Risk:**` a standing risk the decisions accepted knowingly.
- Field names, enums and interfaces are owned by exactly one document; other documents link rather than restate.

## How the spec evolves

Follow-up tickets on the map resolve the open items; each resolution amends the owning document in place (and its ADR, with a dated amendment note, if the "why" changes). The glossary gains terms as they are coined. Research findings stay on their `research/*` branches and are referenced, not copied. Prototype code stays on its `prototype/*` branches; the pinned semantics are in [design-language.md](../design-language.md).
