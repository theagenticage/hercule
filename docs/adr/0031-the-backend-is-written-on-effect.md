# 31. The backend is written on Effect

Date: 2026-09-02

## Status

Accepted. Decided by [Revisit Effect for the backend (#53)](https://github.com/rogierpennink/hydra/issues/53). Amends [ADR 0013](./0013-agents-operate-hydra-through-the-public-api.md) (RPC-framework adoption is no longer deferred; the contract language changes) and [ADR 0017](./0017-the-web-app-is-a-static-pure-client-of-the-public-api.md) (the WebSocket is Effect RPC). Refines [ADR 0004](./0004-controller-state-lives-in-one-sqlite-database.md) (the transaction mechanism) and [ADR 0007](./0007-provider-adapter-is-a-thin-interface-behind-a-normalized-event-stream.md) (the adapter's types).

## Context

The spec ruled Effect out in passing: ADR 0013 deferred *RPC frameworks* (tRPC, oRPC, Effect RPC) post-v1 with a Zod contract package as the pinned asset, and spec 14 stated that Hydra does not use Effect. Neither weighed Effect as the backend's programming model, and it is the one choice that cannot be retrofitted, so it was reopened before implementation started.

The controller and runner are daemons made of long-running concurrent workers: the runner's reconnect loop with disk-outbox replay, the matcher and outbox worker on durable cursors, the scheduler, assistant heartbeats, provider event streams, and one supervised harness subprocess of roughly 1 GiB per session that must never outlive it. In plain TypeScript every one of those is hand-rolled `AbortSignal` plumbing, and the failure modes are silent: a helper that ignores the signal, a timer that leaks on shutdown, an unhandled rejection, a zombie process. The service layer's contract (spec 11 §1.5: a closed list of error codes, first failing check wins) is a convention that `Promise<Session>` cannot express, so review and tests carry it.

Effect makes failures and dependencies part of a function's type, reaches interruption into every sleep, connect and pump, runs cleanup on every exit path (`acquireRelease`), expresses the backoff policy as a value (`Schedule`) and provider events as a `Stream`. The compiler then refuses code that ignores a failure, forgets a dependency, or drops a cleanup. That matters twice for Hydra: once because robustness is weighted above build cost, and once because most of this code will be written by agents, whose plain-TypeScript mistakes compile and leak while their Effect mistakes fail the build.

Verified before deciding (2026-09-01): Effect 4 is at release candidate with interfaces declared final and stable targeted for late 2026; v3 is frozen. Only the core (`Effect`, `Layer`, `Stream`, `Schedule`) is under strict semver; HttpApi, RPC, SQL and Schema are `effect/unstable/*` and may break on minor releases. Bun compile works: OpenCode ships twelve platform binaries built with `Bun.build({ compile })` on Effect. t3-code, the prior art the map follows, is Effect end to end (server, RPC, clients, contracts) on a v4 beta under Node. Effect Schema emits JSON Schema and OpenAPI and implements Standard Schema, so libraries that accept Zod accept it; nothing converts a Zod schema into an Effect one, so the two do not mix at the HttpApi boundary.

## Decision

The controller and runner are written on **Effect 4**: `effect` pinned to the current 4.0.0 release candidate exactly, moved to 4.0 stable when it ships, upgraded deliberately after that because the unstable modules may break on minors. **Effect Schema replaces Zod everywhere**: the contract package, plugin config, action and event payload schemas, the catalog's derived JSON Schema, the runner protocol and the WebSocket. There is no Zod in the codebase.

- **HttpApi is the contract.** Each operation is declared once - endpoint, input schema, output schema, error schemas - and the server routes, request validation, the OpenAPI document and the typed client are derived from it. The `hydra` CLI and `client-core` use the derived client. Hand-written proxies and separate OpenAPI tooling are gone.
- **Every operation is a method on an Effect service** (`Sessions.spawn(input)`). Permission enforcement and actor stamping live inside the method. A transport handler is one line that calls it; no operation logic lives in any handler, so an operation moves onto the WebSocket by adding one RPC handler line, never by moving logic. This is what "framework-free service layer" means from now on.
- **The transport split stands.** HttpApi carries every query and mutation; the WebSocket is Effect RPC carrying live-topic subscriptions only, each topic a streaming RPC method taking a cursor. The web app stays a TanStack Query client whose React code writes no Effect code: `effect` reaches it only transitively through the contract's schemas, used as inferred types and as Standard Schema validators for forms; `client-core` wraps the derived clients into promise functions and plain subscribe callbacks.
- **Effect SQL on `bun:sqlite`** (`@effect/sql-sqlite-bun`), with the per-entity repository seam kept: repositories are Effect services with hand-written SQL inside. The transaction is ambient in the effect context (`withTransaction`; a nested call joins through a savepoint; failure or interruption rolls back) instead of a handle passed by the caller. Hard rule: a transaction wraps one operation's write set and never spans a wait on anything outside the database - SQLite has one writer.
- **Internal interfaces are Effect-typed natively.** The plugin contract and the ProviderAdapter return `Effect`s and expose `Stream`s (`Stream<ProviderEvent>` replaces `AsyncIterable<ProviderEvent>`). Both are in-process built-ins in v1; a promise-shaped facade is a post-v1 option if third-party loading wants it.
- **Request lifetime and tracing.** Each HTTP request or RPC call runs as one fiber; the handler provides the current actor and a span as request-scoped context; a client disconnect interrupts the fiber and rolls back its open transaction. Every service operation and repository call carries a span from day one, exported nowhere in v1 beyond the log line; an OpenTelemetry exporter is a later layer swap.

## Considered options

- **Plain TypeScript with three rules**: one `HydraError` class carrying the closed code enum, an `AbortSignal` mandatory on every function that waits, one shared backoff helper plus `try/finally` around every resource, all enforced by review and tests. Simplest to read. Rejected because the rules erode across a hundred operations and dozens of workers written by agents, and nothing checks that they were followed.
- **Effect core only, Zod kept**: `Effect`, `Layer`, `Stream` and `Schedule` for control flow, with hand-written routes over Zod validation and repositories on raw `bun:sqlite`. Uses only the semver-stable part and leaves the contract decisions untouched. Rejected as two worlds where one would do: Zod parse errors rewrapped into Effect failures at every boundary, routes and clients still written by hand, and none of the derivation the contract package exists for.

## Consequences

- Reviewing backend code requires reading Effect. The cost lands on the maintainer, not the agents; it is accepted knowingly.
- Every promise-shaped boundary needs glue: the Agent SDK's async generator, Codex's stdio JSONL, the pi SDK, Bun's WebSocket server. `Stream.fromAsyncIterable` and `Effect.tryPromise` at the edge, Effect inside.
- Agents' training leans on Effect 3 idioms; expect renamed-API mistakes (`Context.Tag` to `Context.Service`, the reworked Schema) that surface as compile errors and are corrected in place. Zod familiarity is lost for post-v1 plugin authors.
- HttpApi, RPC, SQL and Schema are pinned exactly and upgraded on purpose; a minor bump is a change to review, not a routine.
- The parity guarantee gets a mechanical check: every operation is one HttpApi endpoint by construction.
- t3-code's code is now directly borrowable, in the same dialect. Its React binding (`@effect/atom-react`) is the named revisit if the transport split ever collapses onto the WebSocket.
- Whether the embedded SPA is served through the Effect HTTP server on Bun or beside it is verified at implementation start (spec 16 §C).
