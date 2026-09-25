# Hercule - agent instructions

Hercule is a self-hosted agent orchestration platform: one always-on controller, runners that host agent sessions, event-triggered workflows, and assistants with memory bound to chat channels. The product is called **Hercule**; "agentick" and "agentick-next" are retired names - never use them in code, docs, commits, or issues.

**Status: implementing v1 from an assembled spec.** The spec is normative. Your job is to build what it says, as simply as possible, and to surface conflicts instead of resolving them silently.

## The system in one breath

Three roles ship in one self-contained Bun binary: the **controller** (always-on brain; all state in one SQLite database; receives every event, matches triggers, interprets execution plans, places sessions, serves the public API and the web app), **runners** (daemons that dial the controller over one WebSocket and host agent sessions as bare processes in workspaces), and **clients** (the static web app, the `hercule` CLI, and the agents themselves - all clients of the same public API). Channels, event sources, providers, and workflow actions are all built internally as plugins. Work enters as events, is triaged by agents into Tasks and Proposals before the user sees it, and is executed by workflows whose runs freeze an immutable execution plan.

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

**Names carry their own context.**

1. A type or a field is named for what it stands for, in the project's vocabulary (a CONTEXT.md word where one exists; CONTEXT.md holds the application's concepts, not every module's details), qualified when look-alikes exist. Never for how it is encoded or transported, or for which caller uses it.
2. A function is named for what it does and to what: verb plus object (`excludeSecretFields(schema)`), or for a pure query, the question it answers about its argument (`requiresApproval(mode, toolName)`). The verb tells the truth about the work: `get` reads something that already exists, `compute`, `build` and `parse` produce something, and a boolean query reads as its question. `getHash` is wrong for a function that computes one. A name with no verb, or no subject, is not a name yet. The `<thing>Of(x)` shape (`resultOf`, `specOf`, `recordOf`) has no verb and is not a name: say what is done (`readSpec`, `buildRecord`, `decideResult`). The one exception is a method on a service or repository whose name already supplies the subject: `agents.list(request)` and `agents.delete(id)` read as verb plus object at the call site, and the method name alone is enough.
3. A name is read without the file, the folder or the call site. Bare nouns, bare adjectives or gerunds, and nicknames a comment invented fail this. `one`, `said`, `deepest`, `ends`, `normalizing` are not function names.
4. One concept has one spelling in every package it crosses. The owner of a shared contract names it once; callers import that name and never alias it.
5. A name stays true when the mechanism behind it changes.
6. The product name never appears inside an identifier. `endedBySystem`, not `endedByHercule`: the product can be renamed, and the code should not care.

**Comments are written for a newcomer.** The reader knows TypeScript but not this codebase. Write comments, docstrings and user-facing messages in plain, natural English, the way you would explain the code to a colleague.

1. A function's docstring starts with a verb that says what the function does: "Parses...", "Returns...", "Checks that...". It says what the function returns and when it fails. A reader who sees only the signature and the docstring can use the function without reading its body.
2. After that, say why, if the reason is not obvious. Inline comments only explain why, and never repeat what a line does.
3. Use the ordinary words of programming: returns, parses, validates, converts, fails, error, schema. Use CONTEXT.md words for domain concepts. Never invent a phrase to avoid a common word.
4. Things do not talk. Text does not "say" and a list does not "answer". Write what actually happens: "the YAML parses to", "the list is sorted by".
5. Use short sentences and active voice. If there are three or more rules or cases, write a bullet list, not one long sentence.
6. Each "it", "this" and "that" must be obvious. If the reader has to look back to find what it refers to, name the thing.
7. Read the comment aloud. If you have to read a sentence twice, or no person would say it that way, rewrite it.

A comment stands alone: a reader one year from now, human or agent, must understand it without the spec, the plan, the ticket or the review round that produced it. Never write "D-21:" or "per F-3" as the explanation. Citing a spec section is fine in addition to the explanation, never instead of it. A message that refuses a request says what was wrong, why, and what the caller should do instead.

**Think before coding.** State your assumptions. If multiple interpretations of the ticket or spec exist, present them - don't pick one silently. If a simpler approach than the ticket implies exists, say so and push back.

**Boyscouting.** Leave the codebase better than you found it. A warning, a lint error, a flaky test, a UI detail that looks off - fix it even when it's unrelated to your task, and mention that you did.

**Performance is a design property, not a tuning pass.** Choose the design that doesn't need optimizing: don't read what you don't need, don't re-query in a loop, don't hold what you can stream. But never micro-optimize at the cost of clarity without a measurement.

**UI is held to pixel perfection.** When testing end-to-end, be picky; spacing, alignment, and states matter as much as behaviour.

## Hard rules

These come from the spec and ADRs; restated here because violating them is expensive.

- **Effect 4 everywhere on the backend; Effect Schema is the only schema language. No Zod in the codebase.** (ADR 0031)
- **Every operation is a method on an Effect service.** Its service is its domain's service, or a controller daemon use case when the operation sends a frame to a runner or is the last resort for breaking a cycle in the domain graph. Touching a second domain is not, on its own, a reason to move an operation up. Permission enforcement and actor stamping live inside the method; a transport handler is one line. No operation logic in any handler. (ADR 0031, ADR 0033)
- **The web app writes no Effect code.** React components hold no domain logic; `client-core` wraps the derived clients into promise functions. (ADR 0017, ADR 0031)
- **One SQLite database; transactions are ambient** (`withTransaction`). A transaction wraps one operation's write set and never spans a wait on anything outside the database. (ADR 0004, ADR 0031)
- **Every mutation is stamped with an actor** (`user` or `session:<id>`). Widened later, never restructured.
- **No repo-local Hercule config.** The controller's state is the single source of truth; repositories hold no Hercule configuration.
- **Never edit generated files by hand** (derived clients, OpenAPI documents, lockfiles).
- **Every operation has a CLI row.** An operation added to `packages/contract` lands its row in the CLI table beside the operation table in the same change: spelling, purpose, examples and a line per field, or `hidden: true` with the reason. The row type and the tree tests refuse a contract without it. (Spec 11 §6.3)
- **Never silently substitute behaviour.** Access-mode fallback, trigger pauses, dropped events: the system tells the user; so do you.
- **Never touch `~/.hercule`.** That is the user's live Hercule Home: its database, credentials, runner state and backups. Any run you start (a proof run, an e2e check, a migration try-out, a `hercule` command that writes) uses a throwaway home: `HERCULE_HOME=<scratch dir>` or `--home <scratch dir>`, created for that run and deleted after. Reading `~/.hercule/config.toml` to learn a port is fine; running a controller, runner, or migration against it is not, even when you believe the change is additive. A migration edited in place is the standing example: the live database already ran the old version and would break on the new one.
- **Never kill processes by pattern.** `pkill -f vite`, `pkill -f node`, `killall bun` and the like reach every worktree and every session on this machine, not just yours; another agent's dev server, controller or test run dies with no trace of why. Stop only what you started, by the PID you captured when you started it (or the port you bound), and leave anything you did not start alone.

## Working conventions

- Work happens on tickets: GitHub issues via `gh` (see below). Reference the ticket in commits.
- Branch per ticket; PRs into `main`. Research findings live on `research/*` branches, prototypes on `prototype/*` branches.
- Definition of done: typecheck, lint, and tests green - including failures you didn't cause (boyscouting).

### Package map

One pnpm workspace. Every package is `@hercule/*`, `"type": "module"`, and exports its TypeScript source directly: nothing is compiled before it is imported. `apps/web` is the one package with a build of its own, `vite build`; everything else reaches a build only through `bun build --compile`.

| Path | Package | What lives here |
|---|---|---|
| `packages/hercule` | `@hercule/hercule` | The dispatcher. Reads `argv` and hands off to a role; the single `bun build --compile` entrypoint (`src/main.ts`) |
| `apps/controller` | `@hercule/controller` | The controller role (`hercule serve`) |
| `apps/runner` | `@hercule/runner` | The runner role (`hercule runner`). Its import graph must never reach the controller, the DB engine, the plugin host, or the web bundle |
| `packages/cli` | `@hercule/cli` | The CLI role. HTTP only |
| `packages/home` | `@hercule/home` | The Hercule Home: the global options that locate it, the layout inside it, and the build-time version (`@hercule/home/version`). A leaf every role links |
| `packages/contract` | `@hercule/contract` | The public API contract in Effect Schema |
| `packages/protocol` | `@hercule/protocol` | The controller-runner WebSocket protocol in Effect Schema |
| `packages/plugin-host` | `@hercule/plugin-host` | The API a plugin is written against: its manifest, its hooks and the services the host passes them, and the contributions it registers (providers, event sources, Connection types, workflow actions with `ActionContext` and `ActionError`). Uses no controller internals |
| `packages/client-core` | `@hercule/client-core` | The client library. The only client package that writes Effect code |
| `packages/ui` | `@hercule/ui` | The React component library |
| `apps/web` | `@hercule/web` | The web app. Routes and presentation only |
| `plugins/*` | | One package per plugin, added by its own ticket |

`apps/controller/src/http/bundle.ts` is generated by `scripts/gen-web-bundle.ts` and is not checked in: it is the `with { type: "file" }` import per file in `apps/web/dist` that embeds the web bundle in the binary, so it is rewritten after every `vite build`. With no `dist/` it says there is no bundle and the controller serves the API alone.

`apps/web/src/routeTree.gen.ts` is generated by the TanStack Router Vite plugin from the files under `apps/web/src/routes`, and unlike the other two it **is** checked in, because it is what `vitest` and `tsc` read without a Vite build having run. It is excluded from eslint and from prettier. Adding a screen means adding a route file; the tree follows.

`packages/home/src/version.ts` is generated by `scripts/gen-version.ts` and is not checked in; it is reached as `@hercule/home/version`. A compiled binary has no `package.json` to read at runtime, so the version is baked in at build time. It lives in `@hercule/home` because that is the one leaf every role links: the dispatcher prints it for `hercule --version` and the controller answers it from `controller.read`, and neither may depend on the other.

### Source layout

Source is organized **by domain**, not by type: one folder per domain, named with the CONTEXT.md word for it, and its `index.ts` is the boundary other domains import through. `db/` and `config/` are the two infrastructure exceptions, sitting under every domain; in the controller, `daemon/` - the controller daemon - is the one layer above the domains, holding the wire to runners, the execution behind the ports domains declare, the drivers and boot, and the rare operation that breaks a cycle in the domain graph. The controller daemon has one folder per concern (`sessions/`, `events/`, `workspaces/`, `runners/`, `permissions/`, `workflows/`, `runs/`), each with an `index.ts` the rest of the controller daemon imports it through; its top level keeps only `boot.ts`, `index.ts`, `testing.ts` and the helpers more than one folder uses. A new use case goes in the folder of its concern. Tests sit next to the code they test and are told apart by name: a unit test is `foo.test.ts` beside `foo.ts`, and an integration test - one that drives several modules together through a single entry point, an HTTP transport or the whole rendered app - is `<entry>.integration.test.ts` beside the module it enters. End-to-end tests run against the compiled binary and live in `e2e/` at the repository root. See [ADR 0033](docs/adr/0033-source-is-organized-by-domain-and-tests-are-colocated.md).

#### Web app layout

1. One screen is one route file under `apps/web/src/routes/`, exporting `Route` with `staticData: { title }`; it splits into `routes/<screen>/-<part>.tsx` only past ~150 lines.
2. Screens import presentation from `@hercule/ui` (generic) or `apps/web/src/screens/` (knows Hercule), never from `shell/`; the layout routes `_shell.tsx` and `_shell/settings.tsx` are the exemption, because mounting the shell is their job - eslint enforces this.
3. A `-` prefixed route file is imported only as `./-<name>` from its own folder - eslint enforces this.
4. `apps/web/src/app/` is wiring only: router, context, queries, entry guard, form, testing. Nothing that renders a screen.
5. Reads are `queryOptions`, writes are `useMutation`; no component hand-rolls fetch state.
6. Anything that interprets domain data goes to `@hercule/client-core` with its own test.
7. A component is either presentational or orchestrating. A presentational component takes values and callbacks and reads nothing: no query cache, no router, no live connection. An orchestrating component reads the cache where it uses the data, never higher, and never forwards what it does not read; it earns its place by owning a mutation or a piece of client state, not by routing data. The route file is the first orchestrator: its loader prefetches everything the screen reads, so nothing below it suspends in practice. Interpretation of what is read is a client-core function (point 6), so two orchestrators reading one record can never disagree about what it means.

### Check commands

Install first, then run the four checks. All four must be green before a PR; CI runs the same ones.

```
pnpm install

pnpm typecheck   # tsc over the backend, packages/ui, and apps/web
pnpm lint        # eslint --max-warnings 0, then prettier --check
pnpm test        # vitest across every package: the backend on Bun, the React packages on Node
pnpm dep-lint    # the runner entrypoint links no controller package; the controller's domains, and the controller daemon's folders, form a DAG
```

Then the packaging pair, which CI runs after those four. `pnpm test:binary` runs the
release binary rather than building one, so it needs the build before it and fails
saying so when there is none. Building rewrites `apps/web/dist` and the generated
file list, which is why it is not part of `pnpm test`.

```
pnpm build:binary  # vite build, the bundle budget check, then bun build --compile, writing ./hercule
pnpm test:binary   # ./hercule serves the embedded web app beside the API
```

And one more, any time:

```
pnpm format        # prettier --write
```

Toolchain versions are pinned exactly, in `package.json` (`packageManager`, every dependency), in `.bun-version`, and in `.npmrc` (`save-exact=true`). Upgrading any of them is a deliberate, reviewed change.

## Agent skills

### Issue tracker

GitHub Issues (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.
