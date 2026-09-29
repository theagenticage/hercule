# 33. Source is organized by domain and tests are colocated

Date: 2026-09-04

## Status

Accepted. Decided by [State store and first run (#56)](https://github.com/theagenticage/hercule/issues/56). Follows from [ADR 0031](./0031-the-backend-is-written-on-effect.md) (every operation is a method on an Effect service).

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

Recorded by [The web app shell (#58)](https://github.com/theagenticage/hercule/issues/58). The web app has no domains of its own - it renders the controller's - so the decision above needs three names for it, and the test rule needs one clarification.

- **`apps/web/src/app/` is the third non-domain folder**, the web app's equivalent of `db/`: the wiring that every screen sits on. It holds the router, the router context, the shared query options, the entry guard, the form adapter, and the test harness. **Nothing that renders a screen.**
- **`apps/web/src/screens/` holds presentation shared across screens that knows about Hercule**: the centered frame outside the shell, the fallback screens, the timezone control, the Connect rows. `apps/web/src/routes/` holds the screens themselves, and a `-` prefixed file there is local to its route folder.
- **Presentation that knows nothing about Hercule lives in `packages/ui`**, not in a screen and not in the shell. A screen importing presentation from the shell puts the shell's whole module graph on the screen's chunk, which the bundle budget in [spec 14](../spec/14-web-app.md) pays for.
- **Tests come in three tiers, told apart by name.** A unit test is `foo.test.ts` beside `foo.ts`. An integration test drives several modules together through one entry point - an HTTP transport, the whole rendered app - and is `<entry>.integration.test.ts` beside the module it enters. An end-to-end test runs against the compiled binary and lives in `e2e/` at the repository root. Only the unit tier carries the pairing signal above.

## Amendment: the controller daemon is the layer above the domains (2026-09-17)

Recorded by [The controller daemon (#208)](https://github.com/theagenticage/hercule/issues/208). Some work belongs to no single domain: placing a session reads settings, providers and runners, writes session and workspace rows, and ends in a frame to a machine. Put in the domain that owns the rows, that work made the controller's domain graph a cycle - the thing the decision above is meant to prevent.

- **`apps/controller/src/daemon/` is a layer above the domains**, "the controller daemon". One file per use case, beside a shared helper or two (`absorbing.ts`, `resuming.ts`), and a use case is anything that sequences a write set across domains together with a message to a runner: placement, dispatch, inbound, live, retirement, and provisioning (the workspace provision and dispose operations, the re-send on arrival and the expiry sweep). It is the only module that sends frames to runners and the only consumer of what they report, but for the one exception below; a domain below it holds rows and their lifecycle rules and produces frames as values, and a runner publishes what it hears and calls nobody. It is not a fourth infrastructure folder beside `db/` and `config/`: those sit under the domains, this one sits above them.
- **The import graph of `apps/controller/src` is a DAG**, enforced by `pnpm dep-lint` with no allowlist of edges. A write that crosses a domain comes from above; a read across domains - a repository query, a SQL predicate, a pure function, a type - stays sideways and is fine. Only `http/` imports the controller daemon; no domain may.
- **Some operations' service methods live in the controller daemon**, not in the domain that owns the rows: `session.spawn`, `session.input`, `workspace.provision` and `runner.retire` are controller daemon use cases. The rule of [ADR 0031](./0031-the-backend-is-written-on-effect.md) is unchanged - an operation is still one method on an Effect service, and its handler is still one line.
- One exception remains: the providers domain still sends its own frames to runners (login, probe, harness install). Same principle, no cycle today; tracked in [#209](https://github.com/theagenticage/hercule/issues/209).

## Amendment: the controller daemon has one folder per concern (2026-09-24)

Recorded by [Split the controller daemon into one folder per concern (#247)](https://github.com/theagenticage/hercule/issues/247). One flat folder of use cases stopped scaling at about fifteen files: a reader asking "where does a session get placed?" had to scan the whole list.

- **The controller daemon's use cases are grouped in one folder per concern**, named with the CONTEXT.md word for what they act on:
  - `sessions/`: placement, dispatch, the operations that reach a live session, the sweep of lost runners' sessions, and the resume check they share;
  - `events/`: the event router, the pipeline, enrichment, and `events/routing/` with the routing tables and deliveries;
  - `workspaces/`: provisioning, disposal and the workspace sweep;
  - `runners/`: handling what runners report (inbound), and runner retirement;
  - `permissions/`: deleting a permission profile;
  - `connections/`: the connections domain's `ConnectionReferences` port, read from the resources and workflows domains: the records that still name a Connection and block its delete (step 2 of the ladder below). *(Amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82).)*
  - `runs/`: the run engine.
  - `workflows/`: the workflows domain's `WorkflowRuns` and `TriggeredRuns` ports, both served by the runs domain: whether a workflow has an unfinished run, and starting the run of a start trigger's match. Also the Scheduler, the loop that fires cron triggers. *(Amended 2026-09-29, [#82](https://github.com/theagenticage/hercule/issues/82).)*
- **Each folder's `index.ts` is its boundary.** Another folder of the controller daemon imports it through that `index.ts`, the same rule domains follow. `daemon/index.ts` re-exports only what the rest of the controller uses.
- **The top level keeps only what belongs to no one folder**: `boot.ts`, `index.ts`, `testing.ts`, and helpers more than one folder uses (`absorbing.ts`). A new use case goes in the folder of its concern, and a new concern gets a new folder.
- **The folders import each other without a cycle**: `events/` and `runners/` use `sessions/`, and every folder may use the top-level helpers.
- **`pnpm dep-lint` enforces both rules.** Beside the domain graph, where the controller daemon is one node, it checks a second graph inside the controller daemon. Each folder is a node there, and so is each top-level file: `index.ts` imports every folder and every folder imports `absorbing.ts`, so one node for the whole top level would be a cycle by construction. The check fails on a cycle between these nodes, and on an import that reaches past another folder's `index.ts`.
- **`dep-lint` resolves each import against the file it is in**, rather than matching the text `../<domain>`. A file one folder down reaches a domain as `../../sessions`, and its own `../sessions` is a sibling folder of the controller daemon, which the text match would have misread.

## Amendment: a domain owns what happens; the controller daemon owns where and how it runs (2026-09-25)

Recorded by [The run engine moves into the runs domain (#253)](https://github.com/theagenticage/hercule/issues/253). The 2026-09-17 amendment defined a controller daemon use case as "anything that sequences a write set across domains together with a message to a runner", and said a write that crosses a domain "comes from above". CONTEXT.md read it more widely still: "every piece of work that spans more than one domain". Under that reading, any rule that touched a second domain moved up into the controller daemon, and the domains kept their rows and little else. The run engine is the standing example: it sends nothing to a runner, and most of it is the run's own lifecycle.

- **A domain owns what happens: its rows, the rules of their lifecycle, and the orchestration that carries those rules out.** The runs domain holds the whole run engine: starting a run, executing it step by step, routing, cancelling, and which runs to resume at boot.
- **A domain is infrastructure-agnostic.** It describes its work as effects and never decides where they run: no long-lived fibers, no process lifetime, no sockets. When its work must run apart from the request, it owns a port that says so in its own words (`RunExecutor`: "execute this run", "stop these runs"), and the controller daemon implements that port.
- **A domain may import and call other domains, to read or to write, as long as the domain graph stays a DAG.** `pnpm dep-lint` enforces the DAG. Touching a second domain is not, on its own, a reason to move work up. This replaces "a write that crosses a domain comes from above". Example: a run's `task.create` step calls the task service in the transaction that ends the step record.
- **A cycle is resolved by climbing a ladder, and the controller daemon is its last step:**
  1. **Model the domains again.** A cycle often means a concept sits in the wrong domain. *(Amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92).)* When the cycle is between service layers rather than imports, a domain may split a smaller service out of itself, one that holds the writes the other layer needs and depends on nothing that needs it back. This is step 1 applied inside one domain, so it is tried before step 2. Examples: conversations' `ConversationMessages` and assistants' `AssistantMessages`, which append conversation messages without needing the full service of their domain.
  2. **Invert the control.** The domain keeps the whole orchestration and declares a domain-shaped port for what it needs from the other domain. The controller daemon provides the port by wiring in the other domain. Example: workflows declares `WorkflowRuns` to ask whether a workflow has an unfinished run, and the controller daemon answers it from runs. *(Amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92).)* A domain may also implement another domain's port itself, when doing so keeps the domain graph a DAG; boot wires it in. Example: assistants implements conversations' `ConversationResponder`.
  3. **Move the operation into the controller daemon**, only when both steps above are clearly impractical. Record why in the use case's docstring.
- **The controller daemon owns where and how work runs:**
  - **the wire**: sending frames to runners, handling everything they report, and passing each result to the domain that owns it through that domain's methods. It knows *when* to tell a domain something, not what the domain then does;
  - **execution**: the fibers, scopes and process lifetime behind the ports domains declare (`RunExecutor`, and later `WorkspaceSteps`, [#254](https://github.com/theagenticage/hercule/issues/254));
  - **the drivers and boot**: the loops that run for the life of the controller (the event pipeline, the sweeps), and the order the controller starts in;
  - **the implementations of the ports** that break cycles (step 2 of the ladder), unless a domain implements one itself (step 2), and the rare operation that reached step 3.
- **The folder list changes.** `daemon/runs/` now holds only the `RunExecutor` implementation. The engine lives in the runs domain. `daemon/workflows/` provides the `WorkflowRuns` port.
- [#235](https://github.com/theagenticage/hercule/issues/235) and [#213](https://github.com/theagenticage/hercule/issues/213) apply this rule. They do not decide it again. Deleting a permission profile went straight to step 3 before the ladder existed, and [#255](https://github.com/theagenticage/hercule/issues/255) takes it back through the ladder.
