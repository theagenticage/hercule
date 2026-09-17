# 33. Source is organized by domain and tests are colocated

Date: 2026-09-04

## Status

Accepted. Decided by [State store and first run (#56)](https://github.com/rogierpennink/hydra/issues/56). Follows from [ADR 0031](./0031-the-backend-is-written-on-effect.md) (every operation is a method on an Effect service).

## Context

The first real controller code landed with #56 and the source layout was never decided, so it drifted into by-type folders: `repositories/` next to `keys/`, and the domains themselves nowhere.

ADR 0031 fixes the shape of every feature: a domain carries a repository, a service whose methods are the operations, and a one-line transport handler. By-type folders smear that one feature across three trees, so reading or changing a feature means holding three paths in your head and deleting one means visiting three places. The number of domains is known from the spec and it is large - tasks, runs, sessions, events, connections, plugins, workflows, notifications - so this only gets worse.

Test placement was equally undecided, and it interacts: a mirrored `tests/` tree is a fourth copy of the same structure.

## Decision

Source under an app or package is organized **by domain**, one folder per domain, named with the CONTEXT.md word for it. A domain folder's `index.ts` is its boundary: it exports what other domains consume and nothing more. Cross-domain imports go through that `index.ts`, never at a file inside another domain.

- **`db/` and `config/` are the exceptions**: infrastructure every domain sits on, named for what they are. Adding a third is a deliberate decision, recorded by amending this ADR.
- **Migrations stay in `db/`.** One migration spans domains - a single statement list that creates tables for all of them - so it cannot live in any one of them.
- **Tests are colocated**: `foo.test.ts` beside `foo.ts`.
- **`e2e/` at the repository root** holds tests that cross package boundaries and belong to no single package.

## Considered options

- **By-type folders** (`repositories/`, `services/`, `routes/`). Familiar, and it makes "show me every repository" a directory listing - a question nobody asks. Rejected: it splits every feature three ways and makes cohesion invisible.
- **A mirrored `tests/unit/...` tree.** Rejected on one decisive ground: most of this code is written and refactored by agents, and a mirrored tree rots under that. An agent that moves or renames a module reliably updates its imports; it does not reliably walk a parallel tree to move the test. Colocated tests move with the code because they are in the way.

## Consequences

- Cohesion: a folder maps to a spec section, and deleting a feature is one `rm -r`.
- Tests survive refactoring, and an unpaired `x.test.ts` is a visible signal that `x.ts` went away.
- Domain boundaries must be known before writing code. When a new area has no obvious domain word, that is a CONTEXT.md gap to close first, not a folder to invent.
- Cross-domain imports need discipline: reaching past an `index.ts` compiles fine, so review has to catch it.
- Unit and integration tests are told apart by name, not by directory. In practice the distinction is thin here: spec 04 forbids mock repositories, so most controller tests are small integration tests against a `:memory:` database already.

## Amendment: the web app's layout (2026-09-04)

Recorded by [The web app shell (#58)](https://github.com/rogierpennink/hydra/issues/58). The web app has no domains of its own - it renders the controller's - so the decision above needs three names for it, and the test rule needs one clarification.

- **`apps/web/src/app/` is the third non-domain folder**, the web app's equivalent of `db/`: the wiring that every screen sits on. It holds the router, the router context, the shared query options, the entry guard, the form adapter, and the test harness. **Nothing that renders a screen.**
- **`apps/web/src/screens/` holds presentation shared across screens that knows about Hydra**: the centered frame outside the shell, the fallback screens, the timezone control, the Connect rows. `apps/web/src/routes/` holds the screens themselves, and a `-` prefixed file there is local to its route folder.
- **Presentation that knows nothing about Hydra lives in `packages/ui`**, not in a screen and not in the shell. A screen importing presentation from the shell puts the shell's whole module graph on the screen's chunk, which the bundle budget in [spec 14](../spec/14-web-app.md) pays for.
- **Tests come in three tiers, told apart by name.** A unit test is `foo.test.ts` beside `foo.ts`. An integration test drives several modules together through one entry point - an HTTP transport, the whole rendered app - and is `<entry>.integration.test.ts` beside the module it enters. An end-to-end test runs against the compiled binary and lives in `e2e/` at the repository root. Only the unit tier carries the pairing signal above.

## Amendment: the controller daemon is the layer above the domains (2026-09-17)

Recorded by [The controller daemon (#208)](https://github.com/rogierpennink/hydra/issues/208). Some work belongs to no single domain: placing a session reads settings, providers and runners, writes session and workspace rows, and ends in a frame to a machine. Put in the domain that owns the rows, that work made the controller's domain graph a cycle - the thing the decision above is meant to prevent.

- **`apps/controller/src/daemon/` is a layer above the domains**, "the controller daemon". One file per use case, beside a shared helper or two (`absorbing.ts`, `resuming.ts`), and a use case is anything that sequences a write set across domains together with a message to a runner: placement, dispatch, inbound, inputs, retirement, and provisioning (the workspace provision and dispose operations, the re-send on arrival and the expiry sweep). It is the only module that sends frames to runners and the only consumer of what they report, but for the one exception below; a domain below it holds rows and their lifecycle rules and produces frames as values, and a runner publishes what it hears and calls nobody. It is not a fourth infrastructure folder beside `db/` and `config/`: those sit under the domains, this one sits above them.
- **The import graph of `apps/controller/src` is a DAG**, enforced by `pnpm dep-lint` with no allowlist of edges. A write that crosses a domain comes from above; a read across domains - a repository query, a SQL predicate, a pure function, a type - stays sideways and is fine. Only `http/` imports the controller daemon; no domain may.
- **Some operations' service methods live in the controller daemon**, not in the domain that owns the rows: `session.spawn`, `session.input`, `workspace.provision` and `runner.retire` are controller daemon use cases. The rule of [ADR 0031](./0031-the-backend-is-written-on-effect.md) is unchanged - an operation is still one method on an Effect service, and its handler is still one line.
- One exception remains: the providers domain still sends its own frames to runners (login, probe, harness install). Same principle, no cycle today; tracked in [#209](https://github.com/rogierpennink/hydra/issues/209).
