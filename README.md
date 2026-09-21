# Hercule

A self-hosted agent orchestration platform. One always-on **controller** holds all state and makes every orchestration decision; **runners** on any number of machines host agent sessions driven by interactive coding harnesses (Claude Code, Codex, pi); everything else - the web app, the `hercule` CLI, and the agents themselves - is a client of one public API.

Five features define v1:

1. **Controller/runner split** - orchestrate from one place, execute anywhere.
2. **Event-triggered workflows** - GitHub, Gmail, cron, and platform events start and resume runs through one persisted pipeline.
3. **Workflows as stored definitions** - editable in the controller; each run freezes its own immutable execution plan.
4. **Assistants with memory** - agents bound to Discord and Slack that remember across conversations.
5. **Agents operate everything the user can** - through the same public API, bounded by permission profiles.

The value center is **Intake**: agents triage, group, and enrich incoming signals into prepared Proposals before the user sees them, so decisions are made on high-value material rather than raw input.

Hercule is the successor to agentick (Python), built from scratch in TypeScript. Nothing is imported.

## Status

**Spec complete, implementation starting.** The v1 spec was assembled 2026-08-28 from the decisions worked as child issues of the [wayfinder map](https://github.com/theagenticage/hercule/issues/1); remaining open items are indexed in [docs/spec/16-open-items.md](docs/spec/16-open-items.md), each tied to a follow-up ticket or marked as an implementer's choice.

## Documentation

| Where | What |
|---|---|
| [docs/spec/](docs/spec/README.md) | The normative v1 spec: one document per subsystem, buildable without opening the tickets |
| [docs/adr/](docs/adr/) | Architecture decision records - the "why" behind the spec |
| [CONTEXT.md](CONTEXT.md) | The ubiquitous language: every domain term, with the synonyms to avoid |
| [docs/design-language.md](docs/design-language.md) | The visual language and pinned UI semantics for all surfaces |
| [AGENTS.md](AGENTS.md) | Instructions for coding agents working in this repo |

Start with [the overview](docs/spec/01-overview-and-scope.md): what ships, what doesn't, and a walk of one event through the whole system.

## Tech

TypeScript throughout, one repository. The controller and runner are written on [Effect 4](https://effect.website) with Effect Schema as the contract language ([ADR 0031](docs/adr/0031-the-backend-is-written-on-effect.md)); state lives in one SQLite database ([ADR 0004](docs/adr/0004-controller-state-lives-in-one-sqlite-database.md)); everything ships as one self-contained Bun binary ([ADR 0018](docs/adr/0018-hercule-ships-as-one-self-contained-binary.md)). The web app is a static SPA and a pure client of the public API ([ADR 0017](docs/adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)).

Research findings land on `research/*` branches under `research/`; prototype code on `prototype/*` branches.
