# Hydra - agent instructions

Hydra is a self-hosted agent orchestration platform: one always-on controller, runners that host agent sessions, event-triggered workflows, and assistants with memory bound to chat channels. The product is called **Hydra**; "agentick" and "agentick-next" are retired names - never use them in code, docs, commits, or issues.

**Status: implementing v1 from an assembled spec.** The spec is normative. Your job is to build what it says, as simply as possible, and to surface conflicts instead of resolving them silently.

## The system in one breath

Three roles ship in one self-contained Bun binary: the **controller** (always-on brain; all state in one SQLite database; receives every event, matches triggers, interprets execution plans, places sessions, serves the public API and the web app), **runners** (daemons that dial the controller over one WebSocket and host agent sessions as bare processes in workspaces), and **clients** (the static web app, the `hydra` CLI, and the agents themselves - all clients of the same public API). Channels, event sources, providers, and workflow actions are all built internally as plugins. Work enters as events, is triaged by agents into Tasks and Proposals before the user sees it, and is executed by workflows whose runs freeze an immutable execution plan.

## Read this first, per task

Before writing code:

1. **`CONTEXT.md`** - the vocabulary. Use its terms exactly, in code identifiers too, and respect the "Avoid" lists.
2. **The spec document that owns your area** - `docs/spec/` (map in `docs/spec/README.md`). Normative text you can build from.
3. **The ADRs that touch your area** - `docs/adr/`. The "why" behind the spec.
4. **For UI work**: `docs/design-language.md`.

If what you're about to build contradicts the spec or an ADR, stop and say so explicitly ("Contradicts ADR-0007 because..."). Never silently deviate; never silently pick one of several possible readings. If the spec leaves your question open, check `docs/spec/16-open-items.md` first - it may already be marked an implementer's choice or handed to a ticket.

## Engineering philosophy

Development cost carries almost no weight here. Optimize, in order, for: correctness, simplicity, robustness, long-term maintainability, performance. "It was faster to build this way" justifies nothing.

**Simplicity first.** Write the minimum code that solves the problem.

- No features beyond what the ticket asks.
- No abstractions for single-use code. An abstraction earns its place with its second consumer, not with a prediction.
- No configurability, options, or "flexibility" nobody asked for.
- No error handling for states the types or the spec already rule out.
- If you wrote 200 lines and it could be 50, rewrite it before presenting it.

The test: would a senior engineer call this overcomplicated? Then it is.

**Think before coding.** State your assumptions. If multiple interpretations of the ticket or spec exist, present them - don't pick one silently. If a simpler approach than the ticket implies exists, say so and push back.

**Boyscouting.** Leave the codebase better than you found it. A warning, a lint error, a flaky test, a UI detail that looks off - fix it even when it's unrelated to your task, and mention that you did.

**Performance is a design property, not a tuning pass.** Choose the design that doesn't need optimizing: don't read what you don't need, don't re-query in a loop, don't hold what you can stream. But never micro-optimize at the cost of clarity without a measurement.

**UI is held to pixel perfection.** When testing end-to-end, be picky; spacing, alignment, and states matter as much as behaviour.

## Hard rules

These come from the spec and ADRs; restated here because violating them is expensive.

- **Effect 4 everywhere on the backend; Effect Schema is the only schema language. No Zod in the codebase.** (ADR 0031)
- **Every operation is a method on an Effect service.** Permission enforcement and actor stamping live inside the method; a transport handler is one line. No operation logic in any handler. (ADR 0031)
- **The web app writes no Effect code.** React components hold no domain logic; `client-core` wraps the derived clients into promise functions. (ADR 0017, ADR 0031)
- **One SQLite database; transactions are ambient** (`withTransaction`). A transaction wraps one operation's write set and never spans a wait on anything outside the database. (ADR 0004, ADR 0031)
- **Every mutation is stamped with an actor** (`user` or `session:<id>`). Widened later, never restructured.
- **No repo-local Hydra config.** The controller's state is the single source of truth; repositories hold no Hydra configuration.
- **Never edit generated files by hand** (derived clients, OpenAPI documents, lockfiles).
- **Never silently substitute behaviour.** Access-mode fallback, trigger pauses, dropped events: the system tells the user; so do you.

## Working conventions

- Work happens on tickets: GitHub issues via `gh` (see below). Reference the ticket in commits.
- Branch per ticket; PRs into `main`. Research findings live on `research/*` branches, prototypes on `prototype/*` branches.
- Definition of done: typecheck, lint, and tests green - including failures you didn't cause (boyscouting).

### Package map

One pnpm workspace. Every package is `@hydra/*`, `"type": "module"`, and exports its TypeScript source directly: nothing is compiled before it is imported. `apps/web` is the one package with a build of its own, `vite build`; everything else reaches a build only through `bun build --compile`.

| Path | Package | What lives here |
|---|---|---|
| `packages/hydra` | `@hydra/hydra` | The dispatcher. Reads `argv` and hands off to a role; the single `bun build --compile` entrypoint (`src/main.ts`) |
| `apps/controller` | `@hydra/controller` | The controller role (`hydra serve`) |
| `apps/runner` | `@hydra/runner` | The runner role (`hydra runner`). Its import graph must never reach the controller, the DB engine, the plugin host, or the web bundle |
| `packages/cli` | `@hydra/cli` | The CLI role. HTTP only |
| `packages/home` | `@hydra/home` | The Hydra Home: the global options that locate it, the layout inside it, and the build-time version (`@hydra/home/version`). A leaf every role links |
| `packages/contract` | `@hydra/contract` | The public API contract in Effect Schema |
| `packages/protocol` | `@hydra/protocol` | The controller-runner WebSocket protocol in Effect Schema |
| `packages/client-core` | `@hydra/client-core` | The client library. The only client package that writes Effect code |
| `packages/ui` | `@hydra/ui` | The React component library |
| `apps/web` | `@hydra/web` | The web app. Routes and presentation only |
| `plugins/*` | | One package per plugin, added by its own ticket |

`apps/controller/src/http/bundle.ts` is generated by `scripts/gen-web-bundle.ts` and is not checked in: it is the `with { type: "file" }` import per file in `apps/web/dist` that embeds the web bundle in the binary, so it is rewritten after every `vite build`. With no `dist/` it says there is no bundle and the controller serves the API alone.

`apps/web/src/routeTree.gen.ts` is generated by the TanStack Router Vite plugin from the files under `apps/web/src/routes`, and unlike the other two it **is** checked in, because it is what `vitest` and `tsc` read without a Vite build having run. It is excluded from eslint and from prettier. Adding a screen means adding a route file; the tree follows.

`packages/home/src/version.ts` is generated by `scripts/gen-version.ts` and is not checked in; it is reached as `@hydra/home/version`. A compiled binary has no `package.json` to read at runtime, so the version is baked in at build time. It lives in `@hydra/home` because that is the one leaf every role links: the dispatcher prints it for `hydra --version` and the controller answers it from `controller.read`, and neither may depend on the other.

### Source layout

Source is organized **by domain**, not by type: one folder per domain, named with the CONTEXT.md word for it, and its `index.ts` is the boundary other domains import through. `db/` and `config/` are the two infrastructure exceptions. Tests sit next to the code they test (`foo.test.ts` beside `foo.ts`); cross-package end-to-end tests live in `e2e/` at the repository root. See [ADR 0033](docs/adr/0033-source-is-organized-by-domain-and-tests-are-colocated.md).

### Check commands

Install first, then run the four checks. All four must be green before a PR; CI runs the same ones.

```
pnpm install

pnpm typecheck   # tsc over the backend, packages/ui, and apps/web
pnpm lint        # eslint --max-warnings 0, then prettier --check
pnpm test        # vitest across every package: the backend on Bun, the React packages on Node
pnpm dep-lint    # the runner entrypoint links no controller package
```

Two more, for packaging work:

```
pnpm format        # prettier --write
pnpm build:binary  # vite build, then bun build --compile, writing ./hydra
```

Toolchain versions are pinned exactly, in `package.json` (`packageManager`, every dependency), in `.bun-version`, and in `.npmrc` (`save-exact=true`). Upgrading any of them is a deliberate, reviewed change.

## Agent skills

### Issue tracker

GitHub Issues (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.
