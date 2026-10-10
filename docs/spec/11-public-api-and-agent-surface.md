# Public API and agent surface

Hercule has one public API. The web app, the `hercule` CLI, agents inside sessions, built-in workflow actions and plugins all operate the system through the same set of operations, defined once in a framework-free service layer and described once in a shared contract package of Effect Schema declarations. HTTP routes are derived from that contract and call the service layer; the `hercule` CLI is a thin client over HTTP. Agents reach the API with a per-session token that carries their agent's permission profile; the user reaches it with an API key. Every mutation is stamped with its actor in the event log. No endpoint blocks: long waits are expressed as subscriptions whose matches arrive as queued input. This document pins the contract structure, the operation vocabulary, the transports and route style, the error envelope, the operation catalogue, the credential and attribution rules, the `hercule` CLI (including `hercule memory`), session subscriptions and the no-blocking rule. Rationale lives in [ADR 0013](../adr/0013-agents-operate-hercule-through-the-public-api.md), [ADR 0020](../adr/0020-assistant-memory-is-reached-only-through-the-api.md), [ADR 0021](../adr/0021-one-operation-vocabulary-coarse-grants-explicit-routes.md) and [ADR 0031](../adr/0031-the-backend-is-written-on-effect.md).

## 1. Contract structure

### 1.1 Service layer

A framework-free TypeScript service layer defines every operation: each operation is a method on an Effect service (`Tasks.create(input)`), the backend being written on Effect ([ADR 0031](../adr/0031-the-backend-is-written-on-effect.md)). *(Amended 2026-09-17, [#208](https://github.com/theagenticage/hercule/issues/208): the example was `session.spawn`. For an operation that ~~spans domains or~~ sends a frame to a runner, or that is the last resort for breaking a cycle in the domain graph, the service is the controller daemon rather than the domain that owns the rows (amended 2026-09-25, [#253](https://github.com/theagenticage/hercule/issues/253): touching a second domain no longer moves an operation up); the controller daemon is the layer above the controller's domains, [ADR 0033](../adr/0033-source-is-organized-by-domain-and-tests-are-colocated.md).)* "Framework-free" means: **no operation logic in any transport handler.** An HttpApi handler is a one-line call into the service method, and an RPC handler would be the same one line, so an operation can later be exposed over the WebSocket by adding one handler line, never by moving logic. Every consumer goes through it:

| Consumer | How it calls |
|---|---|
| HTTP routes | derived from the contract's HttpApi declaration (input validated and output encoded by the derived route); one-line call into the service method |
| `hercule` CLI (agent and ops) | over HTTP |
| Web app | over HTTP (plus one WebSocket for live topics, see [./14-web-app.md](./14-web-app.md)) |
| Built-in workflow actions (~~`workflow.run`~~ `run.start`, `notification.create`, `task.create`, `task.update`, `task.query`; `wait` calls no operation *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))*) | in-process, same service layer |
| Plugins holding the public-API client capability | in-process, same service layer ([./05-plugins.md](./05-plugins.md)) |

Permission enforcement (section 5) and actor stamping (section 3) sit inside the service layer, so they bind every consumer identically.

**Request lifetime.** Each HTTP request or RPC call runs as one fiber. The transport handler resolves the credential and provides the current actor and a tracing span as request-scoped context, which service methods read (`CurrentActor`), never a context parameter threaded through signatures. A client disconnect interrupts the fiber, and an open transaction rolls back with it ([./04-state-store.md](./04-state-store.md)). Every service operation and repository call carries a span from day one; v1 exports spans nowhere beyond the log line, and an OpenTelemetry exporter is a later layer swap ([ADR 0031](../adr/0031-the-backend-is-written-on-effect.md)).

**Parity guarantee (hard rule):** nothing is reachable in-process that is not reachable over HTTP. A service operation without an HTTP route is a defect. The WebSocket carries live-topic subscriptions only; every query and mutation stays on HTTP ([ADR 0017](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)).

### 1.2 Contract package

`packages/contract` holds, per operation: its id, an Effect Schema input schema, an Effect Schema output schema, its error schemas, the grant it requires (section 5), and its HTTP route (section 1.4), all as one Effect HttpApi declaration. It is the pinned, expensive-to-retrofit asset. Consumers of the package: server-side validation, the `hercule` CLI, the web app (`client-core`, [./14-web-app.md](./14-web-app.md)), the plugin public-API client, and the workflow editor's schema-driven autocomplete.

From that declaration the server routes, request validation, the OpenAPI document and the typed client are derived ([ADR 0031](../adr/0031-the-backend-is-written-on-effect.md)); the route table of section 1.4 is what the declaration follows. The `hercule` CLI and `client-core` use the derived client. The same package holds the Effect RPC group for the WebSocket's live topics ([./14-web-app.md](./14-web-app.md)); every query and mutation stays on HttpApi (section 1.1). The deferral of RPC-framework adoption in [ADR 0013](../adr/0013-agents-operate-hercule-through-the-public-api.md) is withdrawn by its 2026-09-02 amendment.

### 1.3 Operation vocabulary

One identifier names an operation on every surface ([ADR 0021](../adr/0021-one-operation-vocabulary-coarse-grants-explicit-routes.md)):

- **Operation id** = `<entity>.<verb>`, entity singular: `task.create`, `session.spawn`, ~~`workflow.submit`~~ `run.start` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))*, `runner.drain`. Every entity is its own operation family.
- **Built-in workflow action id** = the operation id, unchanged. The built-in actions *are* the operations ([./07-workflows.md](./07-workflows.md) section 8). *(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* `wait` is the one exception: it pauses a run, changes nothing, and has no operation.
- **CLI** = a command spelled for a terminal, written per operation in the contract's CLI table and one-to-one with the operations (section 6.3): `hercule task list`, `hercule session spawn`, `hercule runner join-token create`. One spelling per command, no aliases; `--help` names the operation id. *(Amended 2026-09-15, [#126](https://github.com/theagenticage/hercule/issues/126): was "the id split on the dot".)*
- **Grant** = `<family>.<verb>` in the coarse grant vocabulary of [./13-security.md](./13-security.md) section 6.1. Grant families are *not* one-to-one with operation families: `infra.write` covers `runner.*`, `plugin.*`, `provider.*` and `controller.*`. The operation-to-grant mapping is an explicit table in the contract package; a 403 and the CLI's `--help` both name the grant, so an agent never has to guess it.

Standard verbs, used with the same meaning on every entity that has them:

| Verb | Meaning |
|---|---|
| `query` | the one list operation of an entity: filters (including `text` where full-text search exists) plus pagination; no filters lists everything; returns `items: <Entity>[]`. There is no `list` and no `search` anywhere in the catalogue. |
| `read` | one entity by id |
| `create` / `update` / `delete` | the obvious; `update` is a partial patch |
| custom verbs | `spawn`, `steer`, `run`, `submit`, `emit`, `cancel`, `rerun`, `drain`, ...: named per entity in section 2 |

**Rule:** `<entity>.query` returns `<Entity>[]`. Something that returns another type is another entity's operation (transcript passages are `transcript.query`, not `session.query { text }`).

**Named exception:** `memory` keeps the verbs `list`, `read`, `search`, `write`, `append`, `delete` pinned by [ADR 0020](../adr/0020-assistant-memory-is-reached-only-through-the-api.md) and tested with real agents in [Prototype: assistant memory interface](https://github.com/theagenticage/hercule/issues/31). `list` returns the index and `search` returns matches, so they could not be one `query` under the rule above anyway.

### 1.4 Transports and route style

Two transports, one contract:

1. **HTTP** on the controller's origin. Bearer authentication (`Authorization` header) with either credential kind (section 4). Plain HTTP on LAN/tailnet by default ([./13-security.md](./13-security.md)).
2. **The `hercule` CLI** (section 6): the same binary in every role, speaking HTTP to `HERCULE_API_URL`.

The web app additionally holds one WebSocket for live topics (subscriptions only), connected with a short-lived single-purpose ticket fetched over HTTP; bearer auth, no cookies. Details in [./14-web-app.md](./14-web-app.md).

A Hercule MCP server is not a v1 transport (section 10).

**Ids on the wire** are canonical lowercase UUIDv7 strings, except event ids, which are integers ([./04-state-store.md](./04-state-store.md)). The CLI accepts a full id or an unambiguous tail of eight or more characters for any id argument whose CLI row names the listing that resolves it (`conflict` if ambiguous; section 6.3, [#126](https://github.com/theagenticage/hercule/issues/126)) and prints tails in human output; `--json` always prints full ids. *(Amended 2026-09-04, [#57](https://github.com/theagenticage/hercule/issues/57).)* **Tail resolution is a CLI-side behaviour**: the CLI resolves a tail through the entity's `query` operation and reports `conflict` itself when more than one id matches. The wire carries canonical ids only - no `{id}` path parameter and no input schema accepts a tail - so a tail costs an extra round trip and needs the entity's read grant.

**Routes are resource paths with HTTP methods**, under `/api/v1/`. Every operation's `{ method, path }` is written explicitly in the contract's route table; the conventions below are what the table follows, and any exception (an irregular plural, a nested resource) is simply written in the table. One CI test asserts that operations and routes are one-to-one.

| Operation shape | Route | Example |
|---|---|---|
| `X.query` | `GET /api/v1/<xs>` + query string | `GET /api/v1/tasks?label=bug&label=ui&status=open&text=crash` |
| `X.read` | `GET /api/v1/<xs>/{id}` | `GET /api/v1/sessions/s_12` |
| `X.create` | `POST /api/v1/<xs>` | `POST /api/v1/tasks` |
| `X.update` | `PATCH /api/v1/<xs>/{id}` | `PATCH /api/v1/tasks/t_9` |
| `X.delete` | `DELETE /api/v1/<xs>/{id}` | `DELETE /api/v1/tasks/t_9` |
| custom verb on one entity | `POST /api/v1/<xs>/{id}/<verb>` | `POST /api/v1/sessions/s_12/interrupt`, `POST /api/v1/runs/r_3/rerun` |
| custom verb without an entity | `POST /api/v1/<xs>/<verb>` | `POST /api/v1/workflows/submit`, `POST /api/v1/events/emit` |
| owned sub-resource | `.../{id}/<sub>...` | `GET /api/v1/sessions/s_12/transcript`, `PUT /api/v1/assistants/a_1/memory/core` |

Path nouns are plural (`/tasks`) although operation ids are singular; that is the one place the two spellings differ. Query strings repeat the key for list-valued filters (`label=a&label=b`); the derived client serializes from the operation's input schema, so neither the CLI nor the web app hand-builds URLs. `me` is accepted wherever an id names the caller's own ~~session or assistant~~ session, assistant or Agent (`/api/v1/assistants/me/memory`, `agentId: "me"` on `transcript.query`): a session token resolves it, a user credential gets 400 `validation`, and so does a session that runs as no Agent, such as a Thread, where the id names an Agent or an assistant *(amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92))*. *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85).)* `me` is also accepted as `sessionId` inside the input of a bound answer that a session creates with `notification.create`: the core replaces it with the creating session's id before it checks and stores the answer, and a run's step that uses it gets `validation` ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4). No other operation resolves `me` yet ([./16-open-items.md](./16-open-items.md) B).

### 1.5 Success and error shapes

**Success** bodies are the operation's output schema, bare: no `{ data: ... }` wrapper.

**Errors** use one envelope; the HTTP status is derived from the code:

```json
{ "error": { "code": "forbidden", "message": "missing grant session.spawn", "details": { "grant": "session.spawn" } } }
```

- `code` is a closed enum in the contract, extended additively: `unauthenticated` (401), `forbidden` (403), `validation` (400), `not_found` (404), `conflict` (409), `invalid_state` (409), `cap_exceeded` (422), `internal` (500). *(Amended 2026-10-09, [#103](https://github.com/theagenticage/hercule/issues/103).)* Promotion adds two codes ([./03-controller-and-runners.md](./03-controller-and-runners.md) section 8):
  - `promotion_in_progress` (409): a promotion is copying this controller's data, so it accepts no change. Every operation that changes something returns it until the switch, a cancel, or the promotion token's expiry. Reads still answer: every `GET` and `HEAD`, and the operations that change nothing but take a body, which the operation table marks `readOnly` (`workflow.validate`).
  - `controller_sealed` (503): this controller has moved to another machine and no longer serves. Every operation except `setup.read` returns it. The message names the new address and the `hercule login` command for it.
- `details` is typed per code: `forbidden` carries `{ grant }`; `cap_exceeded` carries `{ size, cap }` or `{ count, cap }`; `validation` carries `{ issues: { path: string[]; message: string }[] }`, mapped from the schema library's parse issues; the wire contract names no schema library. *(Amended 2026-10-09, [#103](https://github.com/theagenticage/hercule/issues/103).)* `controller_sealed` carries `{ newAddress }`, the URL of the controller the data moved to. It is not signed: only a runner holds a key to check a signature with, and a runner learns the move from the signed `ForwardingPointer` frame instead ([./03-controller-and-runners.md](./03-controller-and-runners.md) section 8.3).
- `message` is for people and is never parsed.
- **One response is not in the envelope.** A request body larger than the controller's cap is answered `413` by the transport, bare, before any of the body is read. Reading it to answer in the envelope is the cost the cap exists to avoid.

  *(Amended 2026-10-08, [#465](https://github.com/theagenticage/hercule/issues/465).)* **The cap is per route.** One check wraps the whole app, before routing, so it covers the derived routes, the runner join route and unmatched paths alike. It reads nothing first:

  - `POST /api/v1/attachments` (`attachment.create`) may carry up to 10 MiB (`MAX_ATTACHMENT_BYTES`). The listener's own cap is exactly 10 MiB, so the transport answers an upload of 10 MiB + 1 byte with a bare `413`.
  - Every other request whose `Content-Length` is over 2 MiB is answered with a bare `413`.
  - Every other request with `Transfer-Encoding` and no `Content-Length` is answered with a bare `411`, so a chunked body cannot get around the 2 MiB cap. The upload route needs no such rule, because the listener's 10 MiB cap bounds it.
  - The check sits inside the CORS layer, so a cross-origin client such as the desktop app sees the `413` or `411` with CORS headers.
  - Frames on the runner WebSocket stay capped at 2 MiB, a separate limit ([./13-security.md](./13-security.md) section 1).
- **One error per response.** The service layer runs its checks in a fixed order and the first failing check is the response: `unauthenticated`, then the static grant check (`forbidden`, before any entity is touched), then `validation`, then `not_found`, then entity-dependent `forbidden` (the `memory` scope rule, section 6.4), then business rules (`conflict`, `invalid_state`, `cap_exceeded`), then `internal`. A caller lacking a grant learns that before learning whether the entity exists. `validation` is the one code that reports everything wrong at once, so a caller fixes every field in one retry.

  *(Amended 2026-09-04, [#57](https://github.com/theagenticage/hercule/issues/57).)* On HTTP the derived route decodes and validates the payload before it ever reaches a handler, so the fixed order only holds if the grant check runs earlier: **the static grant check is performed by transport middleware, before payload decoding**. The contract's operation-to-grant table (section 1.3) is therefore load-bearing at request time, not documentation. Service methods keep the same check inside the method, for in-process callers (built-in workflow actions, plugins) that reach no transport; a caller over HTTP is simply checked twice, identically.

  *(Amended 2026-10-09, [#103](https://github.com/theagenticage/hercule/issues/103).)* Two gates run before the credential is read, so the full order of checks on HTTP is:

  1. the body cap: a bare `413` or `411` (above);
  2. the promotion gate: `controller_sealed`, or `promotion_in_progress` for an operation that changes something;
  3. the pre-setup gate: `unauthenticated` for every operation but `setup.read` and `setup.complete` until setup is complete;
  4. the credential: `unauthenticated`;
  5. the static grant check: `forbidden`;
  6. payload decoding: `validation`;
  7. the service method's own checks, in the order above.

  The promotion gate comes first because a sealed or frozen controller refuses the request whoever sends it. So a caller with no credential, or a wrong one, still learns that the controller has moved, and where to.

The `hercule` CLI prints `message` (and, for `forbidden`, the grant on its own line); `--json` prints the envelope verbatim.

### 1.6 Pagination and sorting

Every `query` operation takes `{ limit?, cursor?, sort? }` and returns `{ items, nextCursor? }`. Cursors are opaque strings; the default `limit` is 50 and the hard maximum 500. ~~`sort` is `{ field, direction }` over an enum of allowed fields declared per operation.~~ *(Amended 2026-10-03, [#300](https://github.com/theagenticage/hercule/issues/300).)* `sort` is an ordered list of keys `{ field, direction? }` over an enum of allowed fields declared per operation, sent as one repeated query parameter per key (`sort=priority:desc&sort=createdAt:desc`). The first key sorts; each later key orders only the rows equal on the keys before it; after the caller's keys, rows are ordered by the listing's unique tie-break key, in the direction of the last key. A field may appear once; a repeated field is `validation`. A key with no direction is `asc`; with no `sort`, each operation keeps its default order. Inside the cursor the controller uses keyset pagination for stable sorts and an offset for relevance-sorted full-text results; callers never see the difference. There are no page numbers and no total counts in v1: the web app pages forward ("load more"), and jumping to a range is done with filters (`run.query { since, until }`), not pagination.

## 2. Operation catalogue

The catalogue below is normative for operation ids, the grant each requires and the route family. Input and output shapes are the contract package's; entity semantics belong to the linked document. Every `query` takes the pagination parameters of section 1.6 in addition to the filters listed.

### task

Semantics: [./09-tasks.md](./09-tasks.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `task.query` | `TaskFilter` (below) | `task.read` | `GET /tasks` |
| `task.read` | `{ taskId }` | `task.read` | `GET /tasks/{id}` |
| `task.create` | `{ title, description, priority?, labels?, projectId?, provenance? }` | `task.create` | `POST /tasks` |
| `task.update` | `{ taskId, title?, description?, status?, priority?, projectId?, addLabels?, removeLabels?, provenance? }` (`projectId: null` detaches; `provenance` appends) | `task.update` | `PATCH /tasks/{id}` |
| `task.delete` | `{ taskId }` (soft: sets `deletedAt`, [./09-tasks.md](./09-tasks.md) Delete) | `task.delete` | `DELETE /tasks/{id}` |

```ts
interface TaskFilter {
  refs?: string[]        // provenance External Refs, canonical form, exact match
  labels?: string[]
  status?: TaskStatus[]
  projectId?: string
  text?: string          // SQLite FTS over title + description
}
```

Within one field the values are **any-of**; across fields the filter is **and**. No `or` across fields and no negation in v1. `TaskFilter` is defined once in the contract and used by the `task.query` operation and the identically named built-in action; the guard-before-agent pattern in [./07-workflows.md](./07-workflows.md) is `task.query` with `refs` set and `text` absent.

`task.query` sorts over `updatedAt | createdAt | priority | status`, default `updatedAt desc`, keyset. *(Amended 2026-10-03, [#300](https://github.com/theagenticage/hercule/issues/300).)* `priority` ascends `low, normal, high, urgent`, and `status` ascends `open, in-progress, done, cancelled`. With `text` the order is relevance and the walk pages by offset; `text` together with an explicit `sort` is `validation` naming both ([./09-tasks.md](./09-tasks.md) Search). `task.update` never takes a whole `labels` array: labels move one at a time through `addLabels` and `removeLabels`, so a concurrent edit by the user and a triage agent cannot clobber each other.

### workflow, trigger, run

Semantics: [./07-workflows.md](./07-workflows.md); breaker semantics in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `workflow.query` | `{ enabled? }` (~~`text?`~~, below) -> `{ items: { id, name, description?, enabled, updatedAt }[] }` (~~parse-time denormalized columns~~ read from the stored definition; newest `updatedAt` first; *amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78)*) | `workflow.read` | `GET /workflows` |
| `workflow.read` | `{ workflowId }` -> `{ id, enabled, source, createdAt, updatedAt }`; `source` is the stored YAML text, and no parsed object is returned - clients parse it themselves with the contract schema ([./07](./07-workflows.md) section 1; resolved 2026-09-01, [#45](https://github.com/theagenticage/hercule/issues/45)) | `workflow.read` | `GET /workflows/{id}` |
| `workflow.create` / `update` / `delete` | `{ source: string }` (YAML) or `{ definition: object }` (rendered to canonical YAML by the controller; the object form is the agents' convenience); `enabled` is a separate field on update ([./07](./07-workflows.md) section 1); `create` and `update` answer `{ workflow, warnings }`, `delete` answers `{}` (*amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78)*) | `workflow.write` *(and `connection.use` in the cases under `connection` below; amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89))* | `POST` / `PATCH` / `DELETE /workflows[/{id}]` |
| `workflow.validate` | `{ source }` or `{ definition }` -> `{ errors, warnings }`; checks as a save does and stores nothing *(added 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78))* | `workflow.read` | `POST /workflows/validate` |
| ~~`workflow.run`~~ | ~~~~`{ workflowId, inputs }`~~ `{ id, inputs? }` (`id` in the path) -> `{ runId }` (*amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79)*, below)~~ | ~~`workflow.run`~~ | ~~`POST /workflows/{id}/run`~~ |
| ~~`workflow.submit`~~ | ~~`{ source \| definition, inputs }` -> `{ runId }` (same input union as `workflow.create`; `inputs` is optional, *amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79)*)~~ | ~~`workflow.submit`~~ | ~~`POST /workflows/submit`~~ |
| `run.start` | exactly one of `workflowId`, `source` and `definition`, beside `inputs?` -> `{ runId }` (replaces `workflow.run` and `workflow.submit`; *added 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79)*, below) | `run.start` *(and `connection.use` in the cases under `connection` below; amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89))* | `POST /runs/start` |
| `trigger.query` | `{ workflowId?, kind?, on?, eventKind?, status? }` -> every field of every trigger across workflows: `{ items: { workflowId, workflowName, triggerId, kind, ~~eventKind, connectionId?, filter?, schedule?, timezone?,~~ on, status?, createdAt, updatedAt }[] }`, newest `createdAt` first (*amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78)*; `on` *amended 2026-09-29, [#276](https://github.com/theagenticage/hercule/issues/276), below*); each item also has `health?`, `nextFireAt?`, `lastFiredAt?` and `skippedTicks?` *(amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82), below)* | `workflow.read` | `GET /triggers` |
| ~~`trigger.read`~~ | ~~`{ triggerId }` (includes the held-event count)~~ retired (*2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78)*; below) | ~~`workflow.read`~~ | ~~`GET /triggers/{id}`~~ |
| `trigger.pause` | ~~`{ triggerId }`~~ `{ workflowId, triggerId }` in the path -> the `Trigger` *(amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82), below)* | `workflow.write` | ~~`POST /triggers/{id}/pause`~~ `POST /workflows/{workflowId}/triggers/{triggerId}/pause` |
| `trigger.resume` | ~~`{ triggerId, discardHeld?: boolean }`~~ `{ workflowId, triggerId }` in the path -> the `Trigger`; `discardHeld` lands with held events ([#87](https://github.com/theagenticage/hercule/issues/87)) *(amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82), below)* | `workflow.write` | ~~`POST /triggers/{id}/resume`~~ `POST /workflows/{workflowId}/triggers/{triggerId}/resume` |
| `run.query` | `{ workflowId?, status?, since?, until?, actor?, originalRunId? }` (`originalRunId` *added 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81)*) -> `{ items: RunSummary[], nextCursor? }`, newest `createdAt` first (*amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79)*, below) | `run.read` | `GET /runs` |
| `run.read` | ~~`{ runId }`~~ `{ id }` in the path -> `Run` (frozen plan, inputs, trigger event, step records, failure reason, final output, live subscriptions). The trigger event~~, final output~~ and live subscriptions are not returned yet *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79), below)*. The final output is returned *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))*. The trigger event is returned *(amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82))*. Live subscriptions are returned *(amended 2026-10-04, [#83](https://github.com/theagenticage/hercule/issues/83))*. | `run.read` | `GET /runs/{id}` |
| `run.cancel` | ~~`{ runId }`~~ `{ id }` in the path -> the cancelled `Run`; `invalid_state` for a run that has ended (*amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79)*) | `run.write` | `POST /runs/{id}/cancel` |
| `run.rerun` | ~~`{ runId, mode?: "re-stamp" \| "replay" }`~~ `{ id }` in the path, `{ mode?: "re-stamp" \| "replay" }` in the body *(amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81), below)* -> `{ runId }` | ~~`workflow.run`~~ `run.start` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))* *(and `connection.use` in the cases under `connection` below; amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89))* | `POST /runs/{id}/rerun` |
| `workflowAction.query` | `{}` -> every action a step can name now: `{ id, displayName, description, inputSchema }[]`, `inputSchema` as JSON Schema *(added 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78))*. *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* Each action also has `runsIn` (since [#257](https://github.com/theagenticage/hercule/issues/257)) and, when it acts through a Connection, `connection: { type }`; its `inputSchema` then leaves out the `connection` param | `workflow.read` | `GET /workflow-actions` |
| `eventKind.query` | `{}` -> every event kind a trigger can name now: `{ kind, description, connectionRequired }[]` *(added 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78))*; `cron.tick` is not among them *(amended 2026-09-29, [#276](https://github.com/theagenticage/hercule/issues/276): a cron trigger writes a `Schedule`, [./07](./07-workflows.md) section 2)* | `workflow.read` | `GET /event-kinds` |

~~`workflow.submit` starts~~ `run.start` with `source` or `definition` starts *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))* a run from a workflow definition that is not stored: the same `Workflow` shape minus `id` and timestamps, validated exactly as a stored one. ~~`workflow.run`~~ `run.start` with `workflowId` loads the stored definition and takes the same internal path. The outside world, agents included, only ever writes *workflows*; the frozen execution plan on a run is internal vocabulary. A run's held events are read with ~~`event.query { triggerId }`~~ `event.query { workflowId, triggerId }` *(amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78): a trigger id is unique only inside its workflow, below)*.

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* The rows above now describe what shipped. Five facts do not fit in the rows:

- **Saves.** `create` and `validate` take exactly one of `source` and `definition`. `update` takes at most one of them, beside `enabled`, and at least one field. A save answers `{ workflow, warnings }`: `workflow` is the record `workflow.read` answers, and the warnings belong to the save, not to the workflow. A new workflow is off. Each write appends one audit entry (`workflow.created`, `workflow.updated`, `workflow.deleted`) that names the workflow and never holds its source, because the source holds the prompts of the workflow's agents and the log is read more widely. Each committed write publishes one `invalidate` on the live topic `workflow` ([./14-web-app.md](./14-web-app.md)).
- **No `text` on `workflow.query`.** The list is short, and no screen needs full-text search over it yet.
- **`workflow.validate` needs `workflow.read`**, not `workflow.write`, because it stores nothing. Like a save, it tells the caller whether the Agents and Connections a workflow names exist. A workflow with problems is a successful check, because the problems are the answer; only a request that sends no content, or both kinds, is refused.
- **`trigger.read` is retired.** A trigger is small, so `trigger.query` answers every field of it, the workflow's name included, and a read of one trigger would add nothing. The held-event count it was to carry lands with held events ([#87](https://github.com/theagenticage/hercule/issues/87)). A trigger is identified by `(workflowId, triggerId)` ([./07](./07-workflows.md) section 2), so `trigger.pause`, `trigger.resume` and the held-events filter of `event.query` take both when they are built *(amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82): `trigger.pause` and `trigger.resume` are built, below)*.
- **The two catalog queries** answer the whole list with no paging, as `plugin.query` does, because each is short and ends. Each answers only what can be named now: the built-in actions and the core kinds, and the actions and kinds of every plugin that is enabled and started. They need `workflow.read` because they are read to write a workflow, and neither has a grant family of its own.

*(Amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82).)* **Triggers as built.**

- **`trigger.pause` and `trigger.resume`** set a start trigger's `status` and return the trigger. They are `not_found` for a trigger the workflow does not declare, and `invalid_state` for a signal trigger, which has no status. Setting the status a trigger already has changes nothing and writes no audit entry. Any other call appends one audit entry, `trigger.paused` or `trigger.resumed`, on the live topic `workflow`, because a trigger has no live topic of its own. The CLI spells them `hercule trigger pause <workflowId> <triggerId>` and `hercule trigger resume <workflowId> <triggerId>`.
- **A pause lasts** across saves of the workflow, until `trigger.resume`. The events a paused trigger would have matched start no run, then or after it resumes ([./07](./07-workflows.md) section 2.5).
- **`trigger.query`** items carry a start trigger's `health`, and a cron trigger's `nextFireAt`, `lastFiredAt` and `skippedTicks` ([./07](./07-workflows.md) sections 2.1 and 2.2).

*(Amended 2026-09-29, [#276](https://github.com/theagenticage/hercule/issues/276).)* A `trigger.query` item follows the trigger's definition: `on` is an `EventSelector` (`kind`, `connectionId?`, `filter?`) or a `Schedule` (`schedule`, `timezone?`), as written in the source ([./07](./07-workflows.md) section 2). It replaces the flat `eventKind`, `connectionId`, `filter`, `schedule` and `timezone`. The filter gains `on: "event" | "schedule"`: `schedule` lists the cron triggers, and `event` lists the triggers that accept events. `eventKind` matches only triggers that accept events of that kind, so a cron trigger never matches it. The CLI lists the cron triggers with `hercule trigger list --on schedule`. Filtering on `eventKind: cron.tick` fails with `validation`, pointing to `on: schedule`, because no trigger names it and an empty list would hide the mistake.

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* The run rows now describe what shipped. The semantics are in [./07](./07-workflows.md) sections 7.1, 7.2 and 9; the facts that do not fit in the rows:

- ~~**Starting a run.** `workflow.run` takes the workflow's id in the path, as every other operation on one record does, and `inputs` in the body. `workflow.run` and `workflow.submit` answer `{ runId }` at once and never wait for a step. Both are refused with `validation` (every problem at its path, no run created) when the workflow does not validate, has an element runs cannot execute yet, or is given inputs that are not valid. `workflow.run` is `not_found` for an unknown workflow and runs a disabled one.~~ Replaced by `run.start`, below *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))*.
- **`run.query`** filters on `workflowId`, `status` (one status), `since` and `until` (both on `createdAt`, inclusive) and `actor`: who started the run, as an actor stamp. `user` and `session:<id>` find the runs that the user or a session started, and `run:<id>` finds the runs that the ~~`workflow.run`~~ `run.start` steps of run `<id>` started. It pages as section 1.6 says, with the one sort field `createdAt`, newest first by default. Each item is a `RunSummary`: `{ id, workflowId, workflowName, origin, status, failureReason?, failedStepId?, createdAt, startedAt?, finishedAt? }`. `workflowName` is read from the run's plan, so it is the name the workflow had when the run started. A summary has no plan and no step records, because both are long; `run.read` returns them. A summary has no `failedEdge` either, because an edge's index means nothing without the plan it points into *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80))*.
- **`run.read`** returns the `Run` of [./07](./07-workflows.md) section 7.2. The trigger event joins with trigger effects ([#82](https://github.com/theagenticage/hercule/issues/82))~~, the final output with terminal steps ([#80](https://github.com/theagenticage/hercule/issues/80)),~~ and live subscriptions with signal triggers ([#83](https://github.com/theagenticage/hercule/issues/83)). *(amended 2026-09-25, [#80](https://github.com/theagenticage/hercule/issues/80): the final output is built. A completed run that a terminal step ended has `output`, the terminal step's output; `hercule run read <id>` prints it under the inputs)*. *(amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82): the trigger event is built too. A run a start trigger started has `triggerEvent`.)* *(amended 2026-10-04, [#83](https://github.com/theagenticage/hercule/issues/83): live subscriptions are built too. `subscriptions` lists the run-held Subscription of each signal trigger in the plan while the run is live, and is empty once the run has ended or when the plan has no signal trigger. Each step record of an agent step has `sessionId`.)*
- **`run.cancel`** needs `run.write` and returns the cancelled `Run`. A run that has already completed, failed or been cancelled is refused with `invalid_state`.
- **`workflow.delete`** is refused with `invalid_state` while a run of the workflow is `pending` or `running` ([./02-domain-model.md](./02-domain-model.md) Deletion rules). A run that has ended keeps the workflow's id and its own plan.
- **The CLI rows**: ~~`hercule workflow run <id>` and `hercule workflow submit` (the source on stdin, section 6.3)~~ `hercule run start` (below) prints the new run's id and ~~the command that reads it~~ the subscription hint *(amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81), section 8)*; `hercule run list`; `hercule run read <id>` prints a summary, the inputs and one line per step, and `--json` the whole record, plan included; `hercule run cancel <id>`. `run read` and `run cancel` take a full id or a tail of eight or more characters, resolved by `run list`.

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* **One operation starts a run.** `run.start` replaces `workflow.run` and `workflow.submit`, and its grant `run.start` replaces their two grants; migration `0026` gives every permission profile that held either old grant the new one. One operation did the work of both: they differed only in whether the workflow was stored or sent, and a caller that wants a run should not have to pick between two operations and two grants for it.

- **Input.** `{ workflowId?, source?, definition?, inputs? }`, with exactly one of the first three. The fields sit side by side rather than in a nested union, so a request reads the same in JSON, in the derived client and on the command line. A request that names no workflow, or more than one, is refused with `validation`, one issue at the path `[]`, before anything is read.
- **Route.** `POST /runs/start`: a verb on runs with no run to act on yet, so the path is the collection's plus the verb.
- **Errors.** `validation` and `not_found` as `workflow.run` and `workflow.submit` had them (above). `cap_exceeded`, with `{ count, cap }`, when a run's `run.start` step would start a run nested deeper than the controller setting `run.nestingLimit` ([./07](./07-workflows.md) section 8). A request from the user or a session starts a run 1 deep, so it never meets this error.
- **Origin.** `manual` when the user calls it, `api` when a session does, whichever kind of workflow the request names; `action` for a run's step ([./07](./07-workflows.md) section 7.2).
- **The CLI row**: `hercule run start --workflow <id>` runs a stored workflow, by a full id or a tail of eight or more characters; `hercule run start --source-stdin` runs the YAML piped in, once, without storing it. `--inputs` takes the inputs as one JSON object. `definition` is hidden, because a command line sends YAML text. The command prints the new run's id and ~~`hercule run read <id>`~~ the subscription hint *(amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81), section 8)*.
- **`run.cancel`** also cancels every unfinished run the cancelled run started, however deep ([./07](./07-workflows.md) section 7.2).

*(Amended 2026-09-25, [#260](https://github.com/theagenticage/hercule/issues/260).)* **Cancelling chooses what happens to the run's workspace, and a run says until when it keeps one.**

- **`run.cancel`** takes `{ keepWorkspace? }` in its body, default `false`. It applies to the run and to every descendant run cancelled with it. Not kept, the run's ephemeral workspace is deleted by the next workspace sweep; kept, it is kept like a failed run's ([./03-controller-and-runners.md](./03-controller-and-runners.md) section 6.7). A primary workspace is never deleted by a run, whatever the choice.
- **The CLI row** gains `--keep-workspace true`: `hercule run cancel <id> --keep-workspace true`. A boolean on this CLI is always written `--flag true` or `--flag false`; there is no bare flag.
- ~~**`Run.workspaceKeptUntil`** is present only for a run with an ephemeral workspace that failed, or was cancelled with `keepWorkspace`: the run's `finishedAt` plus the controller setting `workspace.failedRunTtlDays` (default 14), read at the time of the request. It stays after the workspace is deleted, so a client reads the workspace's own `status` and `disposedAt` to learn whether it still exists.~~ *(Struck 2026-09-27, [#263](https://github.com/theagenticage/hercule/issues/263): the workspace answers `keptUntil`, fixed when the run releases its lease, below; `run.read` and `run.cancel` no longer read settings and no longer fail with a setting error.)*
- **`workspace.dispose`** refuses a workspace whose run is `pending` or `running` with `invalid_state`, and the message says to cancel the run first. Disposing of a kept workspace is how a user dismisses a failed run; there is no dismiss operation for runs.

*(Amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81).)* **Re-running a run.** The semantics are in [./07](./07-workflows.md) section 7.4.

- **Route.** `POST /runs/{id}/rerun`, with the run's id in the path, as every other operation on one run has it, and `{ mode? }` in the body. It needs the `run.start` grant, because it starts a run. It does not also need `run.read`, though it reads the original run: the new run's steps already act with every grant, so `run.start` gives more than `run.read` does.
- **Errors.** `not_found` for an unknown run. `invalid_state` for a run that has not ended, and for a re-stamp of a run with no stored workflow to re-stamp from; the message tells the caller to replay. `validation` when the new run cannot start, as for `run.start`; when a re-stamp fails because the stored workflow cannot run or does not accept the original run's inputs, the message points to replay. A missing runner does not, because a replay needs the same runners. `cap_exceeded` when the new run would be nested too deep, as for `run.start`.
- **`run.query`** takes `originalRunId` and then lists only the re-runs of that run. A `RunSummary` has no `originalRunId`; `run.read` returns it.
- **The CLI rows**: `hercule run rerun <id> [--mode re-stamp|replay]` prints the new run's id and the subscription hint (section 8), as `hercule run start` does. `hercule run list --original-run <id>` lists the re-runs of a run. Both take a full id or a tail of eight or more characters.


### session, input, transcript

Semantics: [./06-providers.md](./06-providers.md), [./12-assistants.md](./12-assistants.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `session.query` | `{ status?, agentId?, permissionProfileId?, thread?, ~~assistantId?~~, conversationId?, runnerId?, runId?, actor?, since?, until? }` (`thread: true` = sessions with no agent; `permissionProfileId` answers the sessions carrying one Permission Profile, which is what a refused `profile.delete` is about - *Amended 2026-09-20, [#76](https://github.com/theagenticage/hercule/issues/76)*; `conversationId` answers the sessions of one assistant conversation, and the newest of them is the conversation's current session ([./12-assistants.md](./12-assistants.md) section 2). There is no `assistantId` filter: an assistant's id is its Agent's id, so `agentId` already answers an assistant's sessions *(amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92))*; `runId` answers the sessions of a run's agent steps, on the CLI `hercule session list --run <id>` *(amended 2026-10-04, [#83](https://github.com/theagenticage/hercule/issues/83))*) | `session.read` | `GET /sessions` |
| `session.read` | `{ sessionId }` (the record: status, agent, runner, workspace, usage) | `session.read` | `GET /sessions/{id}` |
| `session.spawn` | `{ agentId?, prompt, attachments?, instanceId?, model?, options?, accessMode?, workspace? }` -> `{ sessionId }`; without `agentId` the session is a Thread built from the `thread.*` settings plus the overrides given, allowed for actor `user` only (`forbidden` otherwise; [./02-domain-model.md](./02-domain-model.md) Thread) | `session.spawn` | `POST /sessions` |
| `session.continue` | `{ sessionId, mode: ~~"resume" \|~~ "fork", prompt, attachments? }` -> the new `Session` | `session.spawn` | `POST /sessions/{id}/continue` |
| `session.update` | `{ sessionId, model?, options? }` -> the `Session` | `session.steer` | `PATCH /sessions/{id}` |
| `session.input` | `{ sessionId, text, attachments?, model?, options?, steer? }` (`steer` *added 2026-10-10, [#511](https://github.com/theagenticage/hercule/issues/511)*: see below) -> `{ inputId, result: "opened" \| "steered" \| "queued" }` | `session.steer` | `POST /sessions/{id}/input` |
| `session.interrupt` / `session.stop` | `{ sessionId }`; `session.interrupt` also takes `subagentId?` *(added 2026-10-05, [#355](https://github.com/theagenticage/hercule/issues/355))* | `session.steer` | `POST /sessions/{id}/interrupt` / `.../stop` |
| ~~`session.respond`~~ `session.respondToApprovalRequest` *(renamed 2026-10-01, [#309](https://github.com/theagenticage/hercule/issues/309))* | `{ sessionId, requestId, decision: "allow" \| "allow_always" \| "deny" \| "cancel" }` | `session.steer` | ~~`POST /sessions/{id}/respond`~~ `POST /sessions/{id}/respond-to-approval-request` |
| `session.respondToQuestion` *(added 2026-10-01, [#309](https://github.com/theagenticage/hercule/issues/309))* | `{ sessionId, requestId, answers: Record<header, string \| string[]> }` | `session.steer` | `POST /sessions/{id}/respond-to-question` |
| `input.query` | `{ sessionId }` (the controller-owned queue) | `session.read` | `GET /sessions/{id}/inputs` |
| `input.update` / `input.cancel` | `{ sessionId, inputId, text, attachments? }` / `{ sessionId, inputId }`, each answering the row | `session.steer` | `PATCH` / `DELETE /sessions/{id}/inputs/{inputId}` |
| `input.steer` | `{ sessionId, inputId }` -> `{ inputId, result: "steered" \| "opened" \| "queued" }` (`queued` *amended 2026-09-26, [#92](https://github.com/theagenticage/hercule/issues/92)*: see below) | `session.steer` | `POST /sessions/{id}/inputs/{inputId}/steer` |
| `attachment.create` *(added 2026-10-08, [#465](https://github.com/theagenticage/hercule/issues/465))* | `{ name }` in the query, the image's raw bytes as the body (`application/octet-stream`) -> `201` with the `Attachment` `{ id, name, mimeType, sizeBytes }` | `session.steer` | `POST /attachments?name=<file name>` |
| `attachment.readContent` *(added 2026-10-08, [#465](https://github.com/theagenticage/hercule/issues/465))* | `{ id }` in the path -> the image's bytes, streamed, with its `content-type` | `session.read` | `GET /attachments/{id}/content` |
| `attachment.delete` *(added 2026-10-08, [#465](https://github.com/theagenticage/hercule/issues/465))* | `{ id }` in the path -> `{}` | `session.steer` | `DELETE /attachments/{id}` |
| `transcript.read` | `{ sessionId, subagentId?, cursor? }` -> the normalized transcript of the session's own agent, or of one subagent *(`subagentId` added 2026-10-05, [#355](https://github.com/theagenticage/hercule/issues/355))* | `session.read` | `GET /sessions/{id}/transcript` |
| `session.querySubagents` *(added 2026-10-05, [#355](https://github.com/theagenticage/hercule/issues/355))* | `{ sessionId }` -> `items: Subagent[]`, oldest first | `session.read` | `GET /sessions/{id}/subagents` |
| `transcript.query` | `{ text, sessionId?, agentId?, ~~assistantId?~~, actor?, since?, until? }` -> `items: Passage[]` (there is no `assistantId` filter: an assistant's id is its Agent's id, so `agentId` already answers an assistant's transcripts *(amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92))*) | `session.read` | `GET /transcripts` |

*(Amended 2026-09-08, [#66](https://github.com/theagenticage/hercule/issues/66).)* Three rows changed to match what shipped, rather than the code churning to match the table.

- `session.input` answers `queued` as well as `opened` ~~and `steered`~~. ~~Section 5 of [./06-providers.md](./06-providers.md) requires a path that stores the input instead of sending it - a `starting` session, a busy one carrying a model change, a provider with no steering - and answering `steered` for an input that was not delivered would be the silent substitution this spec forbids everywhere else.~~ `opened` is the runner's own word for what it did; `queued` is the controller's, and it means the input is a stored row the caller can still edit, cancel, or steer by hand with `input.steer`. *(Amended 2026-10-10, [#511](https://github.com/theagenticage/hercule/issues/511).)* `queued` also answers a `steer` whose row the flush at the turn's end claimed first: that row is already on its way to the runner and can no longer be edited, cancelled or steered.

  *(Amended 2026-09-08, [#152](https://github.com/theagenticage/hercule/issues/152).)* Section 5 of [./06-providers.md](./06-providers.md) now requires a path that stores every busy or not-yet-idle input rather than sending it, whatever the provider or the input; the "busy one carrying a model change" reason is gone, because the model is no longer a field an input carries ([./06-providers.md](./06-providers.md) section 4). `session.input`'s idle path never *chooses* `steered` - it delivers to what it believes is an idle session and reports back whatever the runner's `delivery` actually was, which is ordinarily `opened` but reads `steered` on the rare race where a turn opened on the runner between the status read and the send. ~~`input.steer` is the only path that asks the runner to fold a row into a turn on purpose.~~ *(Amended 2026-10-10, [#511](https://github.com/theagenticage/hercule/issues/511).)* Two paths ask the runner to fold a row into a turn on purpose: `input.steer` for a row already queued, and `session.input` with `steer: true` for a new row. Both take the same steer path in the controller, so they claim, send and fall back the same way.
- The input's text field is spelled `text`, not `content`, wherever it appears: `session.input`, `input.update` and the stored row ([./02-domain-model.md](./02-domain-model.md) Queued Input).
- *(Amended 2026-10-10, [#511](https://github.com/theagenticage/hercule/issues/511).)* `input.update` makes the row the caller's: it replaces the row's actor with the caller's, and sets its `source` to `user`, a row a subscription created included. The actor of an input names whoever wrote its current text, so the sender the receiving agent is told about ([./06-providers.md](./06-providers.md) section 4) is always the one whose words it reads, images included. Without the new actor, one session could rewrite another session's queued message, or the owner's, and pass its own text off as theirs; without the new source, it could pass its text off as a subscription's notice, which names no sender. The row keeps the subscription and event it came from, so the event still cannot queue a second row, and the row is still cancelled when its subscription ends.
- `session.continue` answers the whole new `Session`, and so does `session.spawn`, whose row above still writes the `{ sessionId }` it never shipped: a caller that has just created a session needs its status and its runner as much as its id.
- `input.query` lists every input the session was ever given, oldest first, whatever became of each, not only the rows still queued. A queue you cannot look back through cannot tell you what was delivered. *(Amended 2026-10-05, [#83](https://github.com/theagenticage/hercule/issues/83).)* An input's status is `queued`, `sent`, `delivered` or `cancelled`. `sent` is an agent step's prompt that left the controller and that the runner never confirmed ([./06-providers.md](./06-providers.md) section 5). `hercule input list` prints it as "sent, not confirmed", because the bare word would suggest the runner took the prompt. The web app and the desktop app show only the rows still `queued`, so they do not show it.

*(Amended 2026-09-26, [#92](https://github.com/theagenticage/hercule/issues/92).)* `input.steer` answers `queued` as well: steering is a guarantee of every session, and on a provider that cannot steer natively the running turn is interrupted and the row is sent as the next turn, so the answer is the controller's `queued` rather than a delivery the runner never made ([./06-providers.md](./06-providers.md) section 5). It is no longer refused for the provider's lack of steering.

*(Amended 2026-10-10, [#511](https://github.com/theagenticage/hercule/issues/511).)* **`session.input` takes `steer?: boolean`**, so a sender can store a message and steer it in one call. Queueing stays the default. The rules per session status are [./06-providers.md](./06-providers.md) section 5:

- On a `busy` session the row is stored and steered in the same operation. The answer is the runner's `delivery` on a provider that steers natively (`steered`, or `opened` if the turn ended while the frame was in flight), and `queued` on any other, whose running turn is interrupted, as `input.steer` answers. It is also `queued` when the flush sends the row first.
- On a session in any other status the call is the same as without the flag: `opened`, `queued`, or the refusal the call would get anyway. The flag never fails a call because of the session's status.
- A steer that does not go through, because the runner refused it, is not connected, or did not answer in time, does not fail the call either. The row is stored and waiting, with the reason on `reason`, so the answer is `queued` with its `inputId`, and the flush at the turn's end sends it. A sender that got an error would send the message again, and the agent would get it twice. The answer is `queued` only while the row still waits: a row the failed steer left cancelled (the session exited while the steer was out), or sent with no confirmed answer, fails the call with the steer's error.
- The grant is `session.steer`, which `session.input` and `input.steer` already both require, so the flag needs no grant of its own.
- The CLI row gains `--steer true` (a boolean flag always takes its value, section 6.3): `echo "The fix is merged, rebase on main" | hercule session input <session-id> --steer true`.

*(Amended 2026-10-05, [#431](https://github.com/theagenticage/hercule/issues/431).)* `input.cancel` refuses the input a session starts with while the session has not started. While the session is `queued`, that input is its oldest waiting row, not yet sent; while it is `starting`, it is the row on the wire with the start. The refusal is `invalid_state`, and its message says to stop the session instead: the input is the session's only reason to start, so a start is never sent without one. `input.update` works on that input while the session is `queued`. Once the session is `starting`, the input is on the wire, and `input.update` refuses it as it refuses any row already sent to the runner ([./06-providers.md](./06-providers.md) section 5). An input the runner refused is put back to waiting and is then an ordinary waiting input, which `input.cancel` cancels.

*(Amended 2026-09-11, [#160](https://github.com/theagenticage/hercule/issues/160).)* `session.input` takes the same `model` and `options` fields `session.update` takes, optional, and applies them in the transaction that stores the input row, before the row exists: a composer's submission is one operation, and no client is left to order an update ahead of an input. The input row itself still carries no model ([./06-providers.md](./06-providers.md) section 4); a queued input opens its turn on whatever the session's model is at that boundary, and cancelling the row does not undo a change the submission already made. `session.update` stays for a caller that changes the model without saying anything, and `options` lands on both with [#155](https://github.com/theagenticage/hercule/issues/155). `options` merges over the session's stored options; a call whose `model` differs from the stored one starts from `{}`, because the choices belong to the model that offered them.

*(Amended 2026-09-16, [#68](https://github.com/theagenticage/hercule/issues/68).)* A session actor may call `session.continue` - unlike `session.spawn`, whose product is a Thread and so the user's alone - but only on a parent that carries its own permission profile; any other parent is refused 403 naming `session.spawn` ([./13-security.md](./13-security.md) section 6.3). *(Amended 2026-10-04, [#75](https://github.com/theagenticage/hercule/issues/75).)* A session actor may never continue a Thread. A fork of a Thread is a new Thread, and only the user opens one, so a parent with no Agent is refused 403 naming `session.spawn` for every actor but the user.

*(Amended 2026-09-12, [#162](https://github.com/theagenticage/hercule/issues/162).)* `session.continue` takes `mode: "fork"` only; `resume` is dropped. Nothing justified a new session for a resume: fork branches, resume does not. An `exited` session whose provider-native transcript is still on its runner is instead resumed in place, under its own id, by the next `session.input` ([./06-providers.md](./06-providers.md) section 4.1). `session.input` therefore also resumes: on an `exited` and `resumable` session it answers `queued`, the session walks `starting` -> `idle` -> `busy`, and the stored row opens a turn on the resumed native transcript; on an `exited` session that is not resumable it is refused `invalid_state` naming why.

*(Amended 2026-09-13, [#70](https://github.com/theagenticage/hercule/issues/70).)* ~~`session.respond` is not built: approvals are their own ticket.~~ `session.respond` answers the whole `Session`, like `session.interrupt`, and refuses `invalid_state` where the session is parked on no request or on a different one, and `validation` where the decision is not one the open request offers ([./06-providers.md](./06-providers.md) section 6.5). It leaves `openRequest` standing: it is cleared when the machine resolves it (`request.resolved`) or when the turn or session it belongs to ends. *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85): in the same operation it resolves the `core.approval` decision about that request as `decided`, with the matching answer, and refuses `invalid_state` where that decision is already resolved, because the request was answered before or its wait was ended ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.6).)*

*(Amended 2026-09-14, [#70](https://github.com/theagenticage/hercule/issues/70), D-28.)* The payload above resolves an **approval** only: `{ sessionId, requestId, decision }`, one of the four `ApprovalDecision` values and never free text. ~~Answering a **question** (kind `question`, [./06-providers.md](./06-providers.md) section 6.5) will take `{ sessionId, requestId, answers: Record<header, string | string[]> }` in place of `decision` - keyed by each question's `header`, each value one or more of the offered option labels or a custom string the user typed - and is not built yet; until it is, a question offers `deny` and `cancel` and the surfaces say so.~~

*(Amended 2026-10-01, [#309](https://github.com/theagenticage/hercule/issues/309).)* `session.respond` is renamed `session.respondToApprovalRequest`; every mention of `session.respond` in this document holds under the new name. A **question** (kind `question`, [./06-providers.md](./06-providers.md) section 6.5) is answered with its own operation, `session.respondToQuestion { sessionId, requestId, answers }`: keyed by each question's `header`, each value one or more of the offered option labels or a custom string the user typed. They are two operations because an approval and a question take different inputs and are turned down differently. Each operation's CLI flags then name exactly what it needs: `hercule session respond-to-question <id> --request <r> --answers '{"Storage":"localStorage"}'`. A question takes no decision. To turn one down, the user stops the turn (`session.interrupt`), which resolves it as `cancel`. The two operations refuse with `validation`, naming the field, when:

- a decision is sent to a question (`decision`); the message names `session.respondToQuestion` and `session.interrupt`;
- answers are sent to an approval (`answers`);
- an answer names a header the request does not have, a question is left unanswered, or a question that takes one answer gets several (`answers.<header>`);
- a value is empty or only spaces, a value is longer than `MAX_MESSAGE_LENGTH`, there are more than 64 headers or more than 64 items in a list, or the answers, headers included, are longer than `MAX_ANSWERS_LENGTH` (under `answers`).

A single-select answer may be a one-item list. A question raises no notification, so a second `session.respondToQuestion` to it is not refused the way a second decision on an approval is: it is sent to the runner, and the adapter ignores it because the harness's wait has ended. The audit entry `session.answered { sessionId, runnerId, requestId }` never holds the answers, because the log is read more widely than the transcript and an answer can be one the agent asked to keep secret. The bound form of the operation, `SessionRespondToApprovalRequestCall`, covers approvals only: only the core binds it ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.6).

*(Amended 2026-09-19, [#76](https://github.com/theagenticage/hercule/issues/76).)* Three things about the `session.spawn` row. A session actor may spawn from an Agent, but only from one whose permission profile grants nothing beyond its own; any wider Agent is refused 403 naming `session.spawn`, and the user actor passes every profile ([./13-security.md](./13-security.md) section 6.3). The input takes `outputSchema?`, what every turn of the session must answer with, linted at spawn against the subset of [./06-providers.md](./06-providers.md) section 7 and refused as `validation` naming the rule it broke. On the CLI that field is the inline JSON flag `--output-schema` rather than a stdin document, because the prompt owns stdin. It is also bounded: a schema whose JSON is longer than `MAX_OUTPUT_SCHEMA_LENGTH` (32 KiB, `@hercule/protocol`) is refused as `validation` before any row is written, because the document is stored, sent over the runner socket and, on pi, handed to the harness in its environment.

```ts
interface Passage { sessionId: string; subagentId?: string; turnId: string; at: string; excerpt: string }  // subagentId added 2026-10-05, #355
```

`transcript.query` is full-text search over normalized transcripts and is the transcript-recall operation of [./12-assistants.md](./12-assistants.md): an assistant recalls its own conversations with ~~`assistantId: "me"`~~ `agentId: "me"`, where `"me"` is the Agent the calling session runs as *(amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92))*, and any agent granted `session.read` searches any session (a learning workflow reading past sessions uses the same operation). `actor: "me"` on `session.query` and `transcript.query` is the shortcut for "sessions this session spawned"; it is a filter on the actor stamp, not a permission.

*(Amended 2026-10-05, [#355](https://github.com/theagenticage/hercule/issues/355); decided by [#352](https://github.com/theagenticage/hercule/issues/352), [#353](https://github.com/theagenticage/hercule/issues/353) and [#377](https://github.com/theagenticage/hercule/issues/377); [ADR 0038](../adr/0038-a-subagent-is-part-of-its-session-not-a-session.md).)* **Subagents are read through their session.** A Subagent ([./02-domain-model.md](./02-domain-model.md) Subagent) is part of its session, so it has no root noun, no grant and no write operation of its own.

- **`transcript.read`** without `subagentId` returns the transcript of the session's own agent: only the events that belong to no subagent. Before this change it returned every event. With `subagentId`, it returns that subagent's transcript, read through the same code. There is no mode that returns every agent at once; a caller lists the subagents and reads each one.
  - A subagent's `subagent.started`, and the `subagent` item that started it, belong to the agent that started it, so the main transcript shows the subagents its own agent started.
  - The cursor records the `subagentId`, beside the session and the direction, so a cursor from one transcript is refused on another (`validation`).
  - An unknown `subagentId` is `not_found`, also while the subagent's events are still held back before its `subagent.started` ([./06-providers.md](./06-providers.md) section 13.2). The read never answers an empty transcript for it.
Session and Subagent records expose optional `usageReport: { status: "complete" | "incomplete", counts }`. Complete counts are exact; incomplete counts are the known subtotal and remain incomplete across process resumes. Their legacy `usage` field is omitted when incomplete, so existing clients cannot display an earlier exact count. A client displays incomplete Token Usage with an incomplete label, and a missing report as not reported ([06-providers.md](./06-providers.md) section 6.6).

- **`session.querySubagents`** lists a session's subagents as a flat list of Subagent records, paged by `startedAt` as `conversation.queryMessages` is. A client builds the tree from `parentSubagentId`. Every field of the record is written at ingest, so a list row needs no second read: what the subagent is, what it is doing now or how it ended, how many tool calls it made, and its Token Usage. There is no `session.readSubagent`, because nothing needs one yet.
- **`session.read`** answers `openRequests` in place of `openRequest`: the Requests of every agent of the session, each naming its asking subagent ([./02-domain-model.md](./02-domain-model.md) Session). *(Amended 2026-10-06, [#453](https://github.com/theagenticage/hercule/issues/453).)* A subagent's Request names it by id, `subagentId`, and by name, `subagentName`, on `session.read` and `session.query` alike. It also answers the session's `usage`, which covers its subagents ([./06-providers.md](./06-providers.md) section 6.6).
- **`session.interrupt { sessionId, subagentId }`** stops that subagent and every subagent below it, and leaves the rest of the session running. It is `not_found` for a subagent the session does not have. Like an interrupt of the session's own agent, it is sent whatever the subagent's recorded status, because the record lags behind the runner; the adapter ignores it for a subagent with no open turn. Without `subagentId` it stops all work in the session: its own agent's turn and every running subagent ([./06-providers.md](./06-providers.md) section 13.4). `session.respondToApprovalRequest` and `session.respondToQuestion` are unchanged: they are keyed by request id, and any open Request can be answered, in any order.
- **`transcript.query`** searches every agent's transcript. A `Passage` from a subagent carries its `subagentId`.
- **The CLI rows:**
  - `hercule transcript read <session-id> --subagent <id>`. Human output of a filtered read leaves out `subagentId`, which is the same on every row. A `subagent` item's row prints `subagentIds=...`, so an agent sees which id to pass.
  - `hercule session subagent list <session-id>`, by the nested-noun rule of section 6.3.

*(Amended 2026-10-08, [#465](https://github.com/theagenticage/hercule/issues/465).)* **Images in prompts.** An Attachment is an image the user attaches to a prompt ([./04-state-store.md](./04-state-store.md) section What is in the store).

- **`attachment.create`** uploads one image and answers `201` with the `Attachment`. The body is the raw bytes, never base64 JSON, which would add a third to a 10 MiB body. The request declares no media type: the controller reads the file's first bytes, and that is the only type it records. Accepted types are `image/png`, `image/jpeg`, `image/gif` and `image/webp` (`IMAGE_MIME_TYPES`); any other file is refused as `validation` with a message that names the accepted types. A file is at most 10 MiB (`MAX_ATTACHMENT_BYTES`, section 1.5) and a name at most 255 characters (`MAX_ATTACHMENT_NAME_LENGTH`), with no control characters. One actor may hold at most 200 MiB of uploads that no input references yet. The limit counts only such uploads younger than the sweep's 24 hours, and the check and the insert run in one transaction, so two parallel uploads cannot both slip under it. An upload past it is refused as `validation`, with a message that says how long to wait, for example "try again in about 3 hours", or to send or remove some images first. The row is stamped with the caller's actor.
- **`attachment.readContent`** streams the bytes with the image's `content-type`, plus the headers in [./13-security.md](./13-security.md) section 1. It serves an attachment that some input references, or one that no input references yet and that the caller's actor uploaded; anything else is `not_found`. *(Amended 2026-10-10, [#478](https://github.com/theagenticage/hercule/issues/478).)* It also serves an image an agent's tool returned, which a transcript references as a `ToolResultImage` ([./06-providers.md](./06-providers.md) section 6.3). Its grant is `session.read`, the grant that reads the transcript, so whoever may read a session's transcript may read its images. No second operation is needed: an Attachment owned by a tool result is stored and served like one owned by an input ([./04-state-store.md](./04-state-store.md)). The bearer never goes into a URL: `@hercule/client-core` fetches the bytes with the bearer and returns a `Blob`, and a UI makes an object URL from it and revokes the URL when the image leaves the screen.
- **`attachment.delete`** deletes an upload of the caller's actor that no input references yet, row and file, and answers `{}`. Any other id is `not_found`, including an image an agent's tool returned: it belongs to the session's transcript and lives as long as the transcript does ([./04-state-store.md](./04-state-store.md)). A client calls it when the user removes an image from the composer's shelf, so the image stops counting against the 200 MiB limit at once.
- **`attachments`** is an optional list of `AttachmentId`s, at most 10 (`MAX_ATTACHMENTS_PER_INPUT`), on `session.spawn`, `session.input`, `session.continue` and `input.update`. Their order is the order the agent sees them in. `input.steer` takes none: it sends a row that already exists. On `input.update`, `attachments` replaces the row's list, and when it is absent the list is kept; an attachment dropped from the list becomes sweepable.
- **Text or images.** `prompt` and `text` may be empty when at least one image is attached. A payload with neither is `validation`: "A prompt needs text or at least one image." `MAX_PROMPT_LENGTH` still holds, and still fits one runner frame, because a frame carries references only. A Thread's title falls back to the first image's name, for example `image.png`, when the prompt text is blank.
- **The claim.** The ids are checked inside the transaction that stores the input: each must exist and must have been uploaded by the caller's actor. Otherwise the whole input fails as `validation` and nothing is stored. An id that the 24-hour sweep has deleted fails with an issue at path `["attachments", i]` and the message "This image expired; attach it again." A composer maps that path to the image's tile.
- **The model and runner gates.** In the same transaction the input is refused as `validation` when the session's runner did not negotiate images or the model the turn runs on does not accept them, with the messages of [./03-controller-and-runners.md](./03-controller-and-runners.md) section 2.2. A queued input is checked again when it is sent.
- **`session.continue`** (fork) references the parent's attachment rows; no file is copied.
- **What reads return.** The `Input` record (`input.query`, `input.update`) carries `attachments: Attachment[]` in order; `input.query` reads the attachments of every listed row in one batched query. A transcript's `user_message` item carries `detail.attachments` ([./06-providers.md](./06-providers.md) section 6.3). *(Amended 2026-10-10, [#511](https://github.com/theagenticage/hercule/issues/511).)* A `user_message` that another session's agent sent also carries `detail.senderSessionId`, the sending session's id (same section).
- **The CLI rows.** The three attachment operations are `hidden: true`, with the reason "images are uploaded through `--image` on `session spawn`, `session input` and `session continue`" (section 6.3).
  - `hercule session interrupt <session-id> --subagent <id>`.
  - `--subagent` takes the harness's full id, or a tail of eight or more characters matched within that session.

### subscription

Semantics: [./08-events-and-connections.md](./08-events-and-connections.md) section 7; the session-side behaviour is section 7 of this document.

| Operation | Input | Grant | Route |
|---|---|---|---|
| `subscription.create` | `{ target: SubscriptionTarget }` -> `{ subscriptionId }` | `subscription.write` | `POST /subscriptions` |
| `subscription.query` | `{ holder?: { kind: "session" \| "run", id }, target?: SubscriptionTarget }` | `subscription.read` | `GET /subscriptions` |
| `subscription.cancel` | `{ subscriptionId }` | `subscription.write` | `DELETE /subscriptions/{id}` |

```ts
type SubscriptionTarget =
  | { kind: "run";     runId: string }       // run.* events for that run
  | { kind: "session"; sessionId: string }   // session.* events for that session (ended, needs approval)
  | { kind: "ref";     ref: string }         // any event whose refs include this External Ref (a PR's checks, reviews, merge)
  | { kind: "request"; requestId: string }   // the decision on a Permission Request
```

The controller expands a target into the pipeline's matching condition and stores both, so the web app shows "waiting on run r_3" without parsing anything. A session token with no `holder` lists its own subscriptions; a user credential must name a holder. `subscription.cancel` accepts session-held subscriptions only; a run-held one (instantiated from a signal trigger) ends with its run, and cancelling it directly is 409 `invalid_state` *(amended 2026-10-04, [#83](https://github.com/theagenticage/hercule/issues/83): built; the message says the subscription ends when its run ends, and to cancel the run instead)*. No free-form CEL target in v1: the four kinds already compose into everything the tickets asked for, and CEL is the escape hatch if dogfooding proves them short.

*(Amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81).)* **Targets as built.** `subscription.create` accepts two of the four kinds:

- `ref`, as above.
- `run:<id>`, which receives that run's `run.completed`, `run.failed` or `run.cancelled` event ([./08-events-and-connections.md](./08-events-and-connections.md) section 5.5). The controller reads the run through the runs domain's own read, so the caller also needs the `run.read` grant, and is refused with `forbidden` without it. An unknown run is refused with `not_found`. A run that has already ended is refused with `invalid_state`, because no event of it would ever come. A run id that is not a UUID is refused with `validation`. The stored condition also requires `event.source == "platform"`, so an event a plugin emits under a `run.` kind cannot pass for the run's own.

`session` and `request` targets are still refused with `invalid_state`: no `session.*` events are emitted yet, and Permission Requests do not exist yet.

*(Amended 2026-10-04, [#83](https://github.com/theagenticage/hercule/issues/83).)* **Run-held subscriptions as built.**

- **The holder** is `{ kind: "session", id }` or `{ kind: "run", id }`, written `session:<id>` or `run:<id>`. Example: `hercule subscription list --holder run:<run id>` lists what a run waits on.
- **The target union** has a fifth kind, `{ kind: "signal", triggerId }`, which only a run-held subscription has. It names the signal trigger in the run's plan. `subscription.create` never accepts it: only a run opens a run-held subscription, when it starts ([./08-events-and-connections.md](./08-events-and-connections.md) section 7.1).
- **`subscription.cancel`** refuses a run-held subscription with 409 `invalid_state`, as above.

### notification

Record and router: [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `notification.query` | `{ kind?, status?, since? }` | `notification.read` | `GET /notifications` |
| `notification.read` | `{ notificationId }` | `notification.read` | `GET /notifications/{id}` |
| `notification.create` | producer input `{ kind, title, body?, actions?, subject? }` -> `{ notificationId }` | `notification.write` | `POST /notifications` |
| `notification.withdraw` | `{ notificationId, reason }` - own notifications only (`producer` match) | `notification.write` | `POST /notifications/{id}/withdraw` |
| `notification.act` | `{ notificationId, actionId }` | `notification.write` | `POST /notifications/{id}/act` |

`notification.create` is the operation the tickets called `notify`; the built-in action carries the operation's name. `notification.act` decides a decision notification and executes its bound operation (section 3.2). `notification.withdraw` resolves a decision as `withdrawn` when its question has stopped existing; a producer may withdraw only what it produced, and there is no other mutation - records are immutable apart from resolution, and there is no per-record read state ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) sections 7.1, 7.7).

*(Amended 2026-09-28, [#84](https://github.com/theagenticage/hercule/issues/84).)* `notification.create` refuses the user with `forbidden`, although the user holds every grant: a notification is a message to the user, so only a session or a run's `notification.create` step creates one. Its `kind` may not start with `core.`. `notification.withdraw` refuses a run with `forbidden`, and a notification that is already resolved, informational ones included, with `invalid_state`. `notification.query` pages by `createdAt`, newest first unless `sort=createdAt:asc`.

~~Two per-operation facts in the contract's operation table serve bound actions ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4): a **`bindable`** flag, default true, `false` for the `credential`, `secret`, `infra` and `permission` families, `connection.manage` and bulk-destructive-tagged operations (the core may still bind those; other producers may not), and a **`describe(input) -> string`** renderer, the core-rendered line shown on every bound action so the click is informed.~~

*(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85).)* Bound actions are built, and the paragraph above is replaced by these facts:

- **A curated list, not a flag.** A `bindable` flag that defaults to true makes every new operation bindable unless its author remembers otherwise. Instead the contract holds one list, `BINDABLE_OPERATIONS` in `packages/contract/src/bound-operations.ts`, of the operations an answer may run: `task.update`, `run.start` (a stored workflow only, `{ workflowId, inputs? }`), `session.input` and `session.respond`. It applies to every producer, the core included. Each entry's input is the operation's whole input as one object, so an id the route carries in its path is a field (`taskId`, `sessionId`); the built-in workflow actions `task.update` and `run.start` share those schemas. A test refuses an entry whose operation needs a grant in the `credential`, `secret`, `infra` or `permission` family, or `connection.manage`. Rules and what is not on the list yet: [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4.
- **`describe(input)`** is declared by the operations on the list only. The core writes the result as a describe line, a list of parts `{ kind: "text" | "marked", text }` with the live names and the values the answer sends or sets as `marked` parts, and returns it as `describeLine` on each answer of an open decision from `notification.query` and `notification.read`.
- **`notification.create`** checks each answer's operation against the list and decodes its input with that operation's schema, and stores the decoded input. An answer that fails is a `validation` error naming the answer's path. It also checks which producer may bind what: `session.respond` is the core's alone; a session binds `session.input` only to itself, and a session in an assistant's conversation not at all; a run binds `session.input` to any session. Each refusal is a `validation` error that names the answer and says what to bind instead ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4).
- **Reads stay unscoped; describe lines are the user's.** *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85).)* A session or a run holding `notification.read` reads every notification, whoever produced it, as [./13-security.md](./13-security.md) section 6.1 sets for every grant. An assistant needs this to talk about a notification posted into its conversation ([./12-assistants.md](./12-assistants.md) section 4.3). Only the user's reads carry describe lines, because only the user takes an answer ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4).
- **`notification.act`** takes one answer of an open decision. Only the user may call it: a session or a run is refused with `forbidden` even when its profile holds `notification.write`, because proposing is not doing and taking the answer is the user's act. It checks the answer's operation again, then runs it as actor `user` and resolves the decision as `decided` with that answer, `origin: "web"` for the web app's login token and `origin: "api"` for an API key. It returns the resolved notification. A failed check is `validation`; a failed operation returns the operation's own error; in both cases the decision stays open. A decision already resolved, including one that a concurrent `notification.act` resolved first, is `invalid_state`. The CLI command is `hercule notification act <id> --action <actionId>`.

### event

Pipeline: [./08-events-and-connections.md](./08-events-and-connections.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `event.query` | `{ connectionId?, kind?, since?, until? }` | `event.read` | `GET /events` |
| `event.read` | `{ eventId }` | `event.read` | `GET /events/{id}` |
| `event.emit` | `{ kind, payload, connectionId? }` -> `{ eventId }` (the `manual` source) | `event.emit` *(and `connection.use` in the cases under `connection` below; amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89))* | `POST /events/emit` |
| `event.enrich` | `{ eventId, system?, url?, refs? }`; `system`/`url` overwrite, `refs` append-only; re-matches the event idempotently ([./08-events-and-connections.md](./08-events-and-connections.md) section 4.2) | `event.emit` | `POST /events/{id}/enrich` |

*(Amended 2026-09-04, [#59](https://github.com/theagenticage/hercule/issues/59).)* `event.query` ships with `connectionId`, `kind`, `since` and `until`. The ~~`triggerId`~~ trigger filter, `workflowId` with `triggerId` *(amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78): a trigger id is unique only inside its workflow, section 2)*, and the `runId` filter (joined to effect rows; the trigger filter lists a paused trigger's held events) are added by the workflows ticket, which completes this operation rather than changing it: triggers, runs and held events do not exist yet, and a filter that always answers empty is a silent substitution.

`since` and `until` bound **`receivedAt`**, when the log took the event, not `occurredAt`, when the source says it happened. Arrival is the log's own axis and the one its ids run with, so a window and the order a page comes back in never disagree; an emitter's claim about when something happened is neither.

`event.query` returns **both populations** behind the one `event.read` grant: pipeline events and audit entries come back from one call, told apart only by `kind`. There is no population filter, because reading what the system did about a piece of work beside the event that caused it is what the log is opened for. The security entries are the one exception: they sit behind `event.audit` (~~any holder of `event.read` therefore reads every security entry~~, amended 2026-09-15, [#68](https://github.com/theagenticage/hercule/issues/68)). The log is walked by `id` only, default `id desc`, keyset. Event ids are integers on the wire (section 1.4).

*(Amended 2026-09-15, [#68](https://github.com/theagenticage/hercule/issues/68); replaces the conflict recorded 2026-09-04, [#59](https://github.com/theagenticage/hercule/issues/59).)* **The security entries sit behind `event.audit`.** `event.read` exposed security-entry metadata - `secret.created`, `secret.rotated`, `secret.deleted`, `auth.apiKey.minted`, `auth.login.failed`, `user.passwordChanged` name the secret, its owner, the key, the username that failed - which is the metadata of the very families [./13-security.md](./13-security.md) section 6.2 withholds from `assistant` and `worker`, both of which hold `event.read`. The session-actor ticket closes that conflict with a second verb rather than by taking `event.read` away: the audit kinds under the `secret.`, `auth.` and `user.` prefixes are returned only to an actor that also holds **`event.audit`**. The static grant on `event.query` and `event.read` is unchanged, and so is every other entry in the log; the filter is applied inside the service, in the query itself, so a page stays as full as it was asked for and a cursor stays valid. An `event.read` of a withheld entry answers the same not-found as an id the log does not hold, so the log cannot be probed by id. The user has parity and reads everything; `unrestricted` holds `event.audit`; neither shipped agent profile does.

### connection

Semantics: [./08-events-and-connections.md](./08-events-and-connections.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `connection.query` / `connection.read` | `{ type?, status? }` (`type` is the qualified id, `github/github`) / `{ connectionId }` (status, labels, credential *references*) | `connection.read` | `GET /connections[/{id}]` |
| `connection.create` / `update` / `delete` | record fields ~~incl. labels and default topic~~; on create, `label` (defaults to the account name) and `labels` (defaults to none) are optional; on update, `labels: []` clears the topics *(amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323))* | `connection.manage` | `POST` / `PATCH` / `DELETE /connections[/{id}]` |
| `connection.setCredentials` | `{ connectionId, ... }` (values in, references out) | `connection.manage` | `POST /connections/{id}/credentials` |
| `connection.startOAuth` | `{ type, origin, label?, labels?, config?, connectionId? }` (`connectionId` on a reconnect; `label`, `labels` and `config` only for a new connection, `validation` when given with `connectionId` *(amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323))*) -> `{ authorizationUrl }`; `invalid_state` when the plugin has no OAuth client credentials | `connection.manage` | `POST /oauth/start` |
| `connection.startDeviceFlow` | `{ type, label?, labels?, config?, connectionId? }` (`connectionId` on a reconnect; `label`, `labels` and `config` only for a new connection, `validation` when given with `connectionId` *(amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323))*) -> `{ setupId, userCode, verificationUri, interval, expiresAt }`; `invalid_state` when the provider refuses to start a device flow or cannot be reached | `connection.manage` | `POST /oauth/device/start` |
| `connection.pollDeviceFlow` | `{ setupId }` -> `pending` / `slow-down` / `unreachable` with the interval to wait, `done` with the Connection, or `expired` / `denied` / `failed` with a message. Every ending is a status, not an error | `connection.manage` | `POST /oauth/device/poll` |

*(Amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183).)* `connection.startOAuth` was built without a row here; it is added with the two device flow operations. Their semantics are in [./05-plugins.md](./05-plugins.md) section 10.1.

*(Amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323).)* Setup asks only for the credential or the sign-in. A new connection given no `label` is named after the account `validate` returns, and one given no `labels` has no topic ([./08-events-and-connections.md](./08-events-and-connections.md) section 8.1). A reconnect keeps the connection's label, topics and config, so a token flow started with `connectionId` refuses them, where it used to ignore them; `connection.update` changes them.

*(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* `connection.update` also takes `feedIntervals`, a map from feed name to seconds that replaces the whole map; `{}` returns every feed to its default. A feed the Connection type's event source does not declare, or a value below the feed's floor, is refused with `validation` at `feedIntervals.<feed>` ([./08-events-and-connections.md](./08-events-and-connections.md) section 8.1). `connection.delete` is refused with `invalid_state` while a workflow step names the Connection as a literal id, as it already was while a Resource or a trigger names it.

`connection.use` is a grant, not an operation: it is what a plugin-contributed action (`github/pr.merge`) requires when it names the Connection it acts as. ~~In v1 nothing a session token calls directly requires it (sessions cannot invoke plugin actions outside a run), so it is dormant until the Hercule MCP server or the agent-tools extension point lands.~~ *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* `run.start` requires it when the request sends a workflow (`source` or `definition`) with a step whose action acts through a Connection, whether the step's `connection` param is an id or a template; without it the request fails with `forbidden` and no run starts. ~~A stored workflow needs no `connection.use`, because the user authored its steps and a caller can only fill in the Connection inputs the user declared. Nothing else a session token calls directly requires it yet.~~

*(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The rule is: whoever chooses the Connection a step acts through needs `connection.use`. A session without it is refused with `forbidden`, and the message says what to ask the user for. The user and a run's own steps pass. The operations that check it:

- `event.emit`, for every event, because it accepts only a kind a plugin declares, and such an event starts the same workflows as one the plugin's event source sends through a Connection ([./08-events-and-connections.md](./08-events-and-connections.md) section 5.4). `event.enrich` is not checked.
- `workflow.create`, and `workflow.update` with a new `source` or `definition`, when a step acts through a Connection, whether its `connection` param is a literal id or an input. An `update` of `enabled` alone, and `workflow.validate`, are not checked ([./07-workflows.md](./07-workflows.md) section 1).
- `run.start` with `source` or `definition`, as above.
- `run.start` with `workflowId`, when the request gives a value for an input that a step's `connection` param reads. Leaving the input to its default needs no grant.
- `run.rerun` in `replay` mode, when the original run's workflow was sent with `run.start` and has a step that acts through a Connection. A re-stamp, and a replay of a stored workflow, are not checked ([./07-workflows.md](./07-workflows.md) section 7.1).

*(Amended 2026-10-05, [#89](https://github.com/theagenticage/hercule/issues/89).)* A `run.start` step chooses a Connection too, when it gives a value for a Connection input of the workflow it starts: the child run acts as `run:<id>` and passes every check, so the check has to happen on the parent. The `workflow.*` and `run.*` checks above count such a value as a `connection` param. When the step names the workflow by a template, every value it gives counts, because the controller cannot tell which inputs take a Connection ([./07-workflows.md](./07-workflows.md) section 8). One gap is accepted: a session may save a step that gives an id to an input that is plain text today, and if the user later turns that input into a Connection input, the saved value passes unchecked.

### runner, plugin, provider, controller (grant family `infra`)

Semantics: [./03-controller-and-runners.md](./03-controller-and-runners.md), [./05-plugins.md](./05-plugins.md), [./06-providers.md](./06-providers.md), [./15-packaging-and-operations.md](./15-packaging-and-operations.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `runner.query` / `runner.read` | `{ state?, label? }` / `{ runnerId }` (state, probed facts, capabilities) | `infra.read` | `GET /runners[/{id}]` |
| `runner.update` | `{ runnerId, name?, labels?, maxConcurrentSessions? }` | `infra.write` | `PATCH /runners/{id}` |
| `runner.drain` / `runner.retire` / `runner.upgrade` | `{ runnerId }`; `retire` takes `force?: boolean` for an unreachable runner | `infra.write` | `POST /runners/{id}/drain` etc. |
| `runner.probe` | `{ runnerId, instanceId }` -> capability snapshot | `infra.write` | `POST /runners/{id}/probe` |
| `runner.createJoinToken` | `{}` -> single-use join token (renamed from `mintJoinToken` 2026-09-01, [#44](https://github.com/theagenticage/hercule/issues/44): `create` over `mint`, consistently) | `infra.write` | `POST /runners/join-tokens` |
| `plugin.query` / `plugin.read` | `{}` / `{ pluginId }` (state, config, contributions) | `infra.read` | `GET /plugins[/{id}]` |
| `plugin.enable` / `plugin.disable` | `{ pluginId }` | `infra.write` | `POST /plugins/{id}/enable` etc. |
| `plugin.configure` | `{ pluginId, config }` (deactivate + reactivate) | `infra.write` | `PUT /plugins/{id}/config` |
| `plugin.retry` | `{ pluginId }` -> re-runs `activate()` once on an `errored` plugin; `validation` on any other state *(added 2026-09-06, [#63](https://github.com/theagenticage/hercule/issues/63))* | `infra.write` | `POST /plugins/{id}/retry` |
| `plugin.resetState` | `{ pluginId }` -> deactivate, wipe the plugin's KV, activate again if enabled ([./05](./05-plugins.md) sections 6 and 8) *(added 2026-09-06, [#63](https://github.com/theagenticage/hercule/issues/63))* | `infra.write` | `POST /plugins/{id}/reset-state` |
| `provider.query` / `provider.read` | provider instances and their capability snapshots | `infra.read` | `GET /providers[/{id}]` |
| `provider.create` / `update` / `delete` | instance config ([./06](./06-providers.md)) | `infra.write` | `POST` / `PATCH` / `DELETE /providers[/{id}]` |
| `provider.login` | `{ instanceId, runnerId }` -> `{ url }`, the vendor's authorize URL from that machine's own login child; `invalid_state` when the runner is offline or printed no URL *(added 2026-09-07, [#64](https://github.com/theagenticage/hercule/issues/64))*. *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* -> `{ url, userCode?, expiresAt? }`: a device-code login adds the one-time `userCode` the user types at `url`, and `expiresAt`, the ISO-8601 instant the code stops working, at most a day after the call (absent when the runner's build does not say). Such a login finishes by itself: the controller probes the instance when the runner reports the login ended, and announces `provider` / `updated` | `infra.write` | `POST /providers/{id}/login` |
| `provider.submitLoginCode` | `{ instanceId, runnerId, code }` -> the capability snapshot the finished login left behind; `validation` carrying the vendor's own words when the code is refused, and the login stays up for another paste *(added 2026-09-07, [#64](https://github.com/theagenticage/hercule/issues/64))* | `infra.write` | `POST /providers/{id}/login-code` |
| `runner.installHarness` | `{ runnerId, providerId }` -> the refreshed runner, its harness installed by the adapter and every instance on it probed again *(added 2026-09-07, [#64](https://github.com/theagenticage/hercule/issues/64))* | `infra.write` | `POST /runners/{id}/install-harness` |
| `controller.read` | `{}` -> identity, version, update availability, default runner. *(2026-09-04, [#57](https://github.com/theagenticage/hercule/issues/57): as built it returned identity and version only. Amended 2026-09-05, [#61](https://github.com/theagenticage/hercule/issues/61): it now also returns `defaultRunnerId`, nullable, written by `controller.update`. Update availability lands with the update-check ticket - it stays part of the operation's description, it is simply not there yet. Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313): it also returns `localRunnerId`, nullable: the runner this controller started on its own machine, read from that child on every call and stored nowhere, so it is null until the child has joined and on a controller that starts no local runner ([03 §3.4](./03-controller-and-runners.md)). `controller.update` does not accept it.)* | `infra.read` | `GET /controller` |
| `controller.update` | `{ defaultRunnerId? }` | `infra.write` | `PATCH /controller` |
| `controller.createPromotionToken` / `controller.export` / `controller.import` | promotion ([./15](./15-packaging-and-operations.md)); renamed from `mintPromotionToken` with `runner.createJoinToken` ([#44](https://github.com/theagenticage/hercule/issues/44)). *(Amended 2026-10-09, [#103](https://github.com/theagenticage/hercule/issues/103).)* `createPromotionToken`: `{}` -> `{ token, expiresAt }`, status 201: a single-use token valid for 15 minutes. Creating a token invalidates any earlier one not yet spent. Only the user may call it: a session is refused `forbidden` even when its profile holds the grant. The answer carries no address, because the controller does not know the address another machine reaches it at. The CLI (`hercule controller promotion-token create`) prints the `hercule promote --from <url> --token <t>` command to run on the new machine: `--from` is the URL the CLI reached the controller at, or the placeholder `<this-controller-url>` and a line asking the user to replace it, when that URL is loopback ([./03](./03-controller-and-runners.md) section 8.2). `export` and `import`, the bundle fallback ([./03](./03-controller-and-runners.md) section 8.4), are not built yet. | `infra.write` | `POST /controller/promotion-tokens`, `.../export`, `.../import` |

*(Amended 2026-09-06, [#63](https://github.com/theagenticage/hercule/issues/63).)* `plugin.retry` and `plugin.resetState` are the two plugin moves [./05](./05-plugins.md) section 8 describes and this catalogue had no rows for. Both are custom verbs on one entity, so they follow section 1.4's `POST /api/v1/<xs>/{id}/<verb>` shape, and `resetState`'s path is the verb kebab-cased (`reset-state`), which is what a multi-word verb spells here. Reads of a plugin need `infra.read`, every write `infra.write`; the actor is always `user`, since nothing but a person moves a plugin. Every plugin write appends its own audit row and publishes an invalidation on topic `plugin`.

### workspace

Semantics: [./03-controller-and-runners.md](./03-controller-and-runners.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `workspace.query` / `workspace.read` | `{ runnerId?, resourceId?, projectId?, kind?, status? }` / `{ workspaceId }` | `workspace.read` | `GET /workspaces[/{id}]` |
| `workspace.provision` | `{ resourceId, runnerId }` -> managed main workspace; conflicts with an established existing selection | `workspace.write` | `POST /workspaces` |
| `workspace.attach` | `{ resourceId, runnerId, path, remoteName? }` -> logical main workspace, ready only after runner validation; `remoteName` defaults to `origin`; user actor only | `workspace.write` | `POST /workspaces/attach` |
| `workspace.inspect` | `{ id }` -> Workspace after a fresh runner observation; offline is an unavailable error | `workspace.read` | `POST /workspaces/{id}/inspect` |
| `workspace.detach` | `{ id }` -> forget existing-main registration; never delete files; refuse active holders | `workspace.write` | `POST /workspaces/{id}/detach` |
| `workspace.dispose` | `{ id, discardChanges? }`; only known managed workspace files; user confirmation permits force; active holders refuse | `workspace.write` | `DELETE /workspaces/{id}` |

*(Amended 2026-10-07, [#459](https://github.com/theagenticage/hercule/issues/459), [ADR 0039](../adr/0039-workspaces-preserve-runner-local-git-state-and-human-work.md).)* The table records the accepted contract; operations ship with their implementation, never with success stubs. Each operation has its CLI row beside the owning Effect Schema operation table, including purpose, examples and every input field. `workspace.attach` persists external path intent for exactly one runner; no other spawn input accepts an external path. `workspace.inspect` is a controller daemon use case, while `workspace.read` remains a persisted read. Mutation services enforce permissions and stamp actors, and transport handlers remain one line.

`Workspace.ownership`, `retentionPolicy` and `observedAt`, and Checkout `headCommit`, `startingRevision` and `baseCommit` are owned by [spec 02](./02-domain-model.md). Unobserved facts are null. A manual workspace has no automatic deletion deadline; a deadline for an automatic workspace is eligibility for safe cleanup, never proof files were removed. The later lifecycle supersedes the managed-only, implicit primary branch-switch and lease-only rules in the historical amendments below. Thread main-workspace starts preserve the actual branch. Workflow primary policies that explicitly choose a branch retain that behavior. Ephemeral checkouts accept the `startingRevision` union of spec 03 section 6.8; deprecated `baseBranch` is an explicit remote choice and supplying both is validation failure.

Disposal reserves `disposing` before runner I/O and returns deletion success only after a successful outcome. Safe refusal leaves files available with its reason; a lost acknowledgement leaves durable intent for retry. Only a user may request force through `discardChanges: true`, and automatic cleanup cannot request it. Detachment tells the user about derived worktrees while preserving their source bindings and every attached file. Capability negotiation rejects unsupported new semantics visibly. Derived clients and OpenAPI are regenerated by their owning tools.

Workspaces otherwise appear as side effects of session and run placement; `lost` is set by runner retirement, never by an operation.

*(Amended 2026-09-27, [#263](https://github.com/theagenticage/hercule/issues/263); [ADR 0036](../adr/0036-a-workspace-is-kept-by-leases-its-holders-release.md).)* **A workspace says how long it is kept, and `workspace.dispose` names what still uses it.**

- **`Workspace.keptUntil`** (`Timestamp | null`) is when the sweep may delete the workspace: the latest kept-until time of its Workspace Leases, fixed when its last holder released it. A settings change does not move it. It is null for a primary, for a workspace that is gone, and while a session or a run still holds it. Example: a run that failed on 24 Sep leaves its workspace with `keptUntil` 8 Oct, fourteen days by default.
- **`Workspace.sessionIds`** are the sessions holding an active lease on it.
- **`run.cancel`'s `keepWorkspace`** picks the retention the run releases its lease with: `inspection`, kept for `workspace.inspectionTtlDays` from the cancel, or `none`.
- **`workspace.dispose`** refuses a workspace with an active lease with `invalid_state`, and the message names what to stop: `cancel run <id> first` for an unfinished run, `stop sessions <ids> first` for sessions that have not exited, and both when a run and sessions both hold it.
- **The setting `workspace.failedRunTtlDays` is renamed `workspace.inspectionTtlDays`.** Its default stays 14 days.

*(Amended 2026-09-16, [#72](https://github.com/theagenticage/hercule/issues/72).)* Three sentences the rows above only sketched.

- `workspace.query` filters by `projectId` as well: a project's workspaces are the ones holding a checkout of a repo filed under it, which is what the composer lists.
- `workspace.provision` takes `{resourceId, runnerId}` and nothing else. ~~It adopts an existing local checkout in place.~~ Adopt-in-place is not built ([./03-controller-and-runners.md](./03-controller-and-runners.md) section 6.4): the main workspace is always a Hercule-managed clone under that runner's storage directory.
- `session.spawn`'s `workspace` is one of four, and a caller writes exactly one of them: absent (the thread runs with no workspace, `workspaceId: null`); `{kind: "primary", resourceId, branch?}` (the repo's main workspace on the placing machine, made if it is not there yet, with `branch` the one the machine switches it to before the harness starts - a one-shot pick, never replayed when the thread is resumed); `{kind: "ephemeral", checkouts: [{resourceId, baseBranch?}]}` (a workspace of the thread's own, one worktree per repo on ~~`hercule/run-<last 8 of the session id>`~~ `hercule/thread-<last 8 of the session id>` *(amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257): renamed so a thread's branch never looks like a run's, which is `hercule/run-<runId>`)*, an empty list making a scratch workspace); `{kind: "existing", workspaceId}` (join one that stands - it must be `ready`, it pins the machine, and every repo in it must be filed under the `projectId` the thread carries).
- `session.spawn` takes `projectId`: the Project the thread is filed under. Every resource any of the above reaches has to be filed under it, whether the workspace is made or joined.

### agent, assistant, binding, conversation

Semantics: [./12-assistants.md](./12-assistants.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `agent.query` / `agent.read` | `agent.query` takes `{ permissionProfileId? }`: the Agents that spawn their sessions under one Permission Profile, which is what a refused `profile.delete` is about (*Amended 2026-09-20, [#76](https://github.com/theagenticage/hercule/issues/76)*) | `agent.read` | `GET /agents[/{id}]` |
| `agent.create` / `update` / `delete` | `name`, `systemPrompt`, `instanceId`, `permissionProfileId`, `accessMode?`, `model?`, `options?` (the model's own choices; the two are one `ModelSelection` on the record, and one flag each on the CLI, exactly as `session.spawn` spells them - *Amended 2026-09-19, [#76](https://github.com/theagenticage/hercule/issues/76)*), ~~`mcpServers?`~~ (deferred to [#222](https://github.com/theagenticage/hercule/issues/222); the Agent as shipped has no such field - *Amended 2026-09-19, [#76](https://github.com/theagenticage/hercule/issues/76)*), `disallowedTools?` ([./02-domain-model.md](./02-domain-model.md) Agent); assigning a permission profile is an `agent.update` and affects sessions spawned afterwards; `delete` is `invalid_state` while a non-exited session references the agent | `agent.write` | `POST` / `PATCH` / `DELETE /agents[/{id}]` |
| `assistant.query` / `assistant.read` | | `agent.read` | `GET /assistants[/{id}]` |
| `assistant.create` / `update` / `delete` | an agent plus `heartbeat { enabled, schedule, timezone?, prompt, target }`, `rotation { contextFraction, maxContextTokens, dailyAt, timezone? }`, `reply`, `accessMode` ([./12-assistants.md](./12-assistants.md) section 1). On `create` only `name` is required: every other field takes the default listed in [./12-assistants.md](./12-assistants.md) section 1, and `create` also creates the assistant's web conversation *(amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92))*. `delete` is the confirmed action that ~~deletes memory and bindings~~ ~~stops the assistant's sessions, then deletes the assistant with its conversations and their messages~~ deletes the assistant with its conversations and their messages in one transaction, then tells its live sessions to stop without waiting for them; it is never refused `invalid_state` *(amended 2026-09-26, [#92](https://github.com/theagenticage/hercule/issues/92))*; its sessions and their transcripts stay as history ([./12-assistants.md](./12-assistants.md) section 10) *(amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92))* | `agent.write` | `POST` / `PATCH` / `DELETE /assistants[/{id}]` |
| `binding.query` / `create` / `update` / `delete` | channel bindings of an assistant | `agent.read` / `agent.write` | `GET` / `POST /assistants/{id}/bindings`, `PATCH` / `DELETE /assistants/{id}/bindings/{bindingId}` |
| `conversation.query` / `conversation.read` | ~~`{ assistantId, ... }` (lineage of sessions)~~ `conversation.query` takes `{ assistantId? }`. A conversation is `{ id, assistantId, channel, containerKey, createdAt }`: its lineage of sessions is not stored on it, and is read with `session.query { conversationId }` *(amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92))* | `agent.read` | ~~`GET /assistants/{id}/conversations[/{conversationId}]`~~ `GET /conversations[/{id}]` *(amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92))* |
| `conversation.queryMessages` | the conversation's messages, in order: the owner's messages, the assistant's replies, and the notices saying ~~it could not answer~~ it was interrupted or can't be reached *(amended 2026-09-26, [#92](https://github.com/theagenticage/hercule/issues/92))* ([./12-assistants.md](./12-assistants.md) section 9) *(amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92))* | `agent.read` | `GET /conversations/{id}/messages` |
| `conversation.send` | `{ text }`: stores the owner's message and hands it to the assistant, which gives it to the conversation's current session or starts one; returns the stored message. *(amended 2026-09-26, [#92](https://github.com/theagenticage/hercule/issues/92)): the message is steered into a running turn, opens a turn on an idle session, resumes an exited one in place, or starts a new session; when no session can take it the message is kept with a notice that the assistant can't be reached, so the send is never refused `invalid_state`)*. Only the user sends: a session is refused `forbidden` even when its profile holds the grant ([./12-assistants.md](./12-assistants.md) section 2) *(amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92))* | `agent.write` | `POST /conversations/{id}/messages` |
| `conversation.rotate` | manual rotation ("start fresh"): distill, end the incarnation, successor on next wake ([./12-assistants.md](./12-assistants.md) section 5.2) | `agent.write` | ~~`POST /assistants/{id}/conversations/{conversationId}/rotate`~~ `POST /conversations/{id}/rotate`, like the other conversation routes; not built yet *(amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92))* |

### reminder (scheduled wakes)

Semantics: [./12-assistants.md](./12-assistants.md) section 8.3. A reminder is a one-shot Scheduled Wake delivered as input to the conversation that created it; the heartbeat (the recurring wake) is edited through `assistant.update`, not here. Grant family `subscription` - a reminder is "wake me later" on a clock instead of an event.

| Operation | Input | Grant | Route |
|---|---|---|---|
| `reminder.create` | `{ at: ISO datetime, text }` -> `{ reminderId }`; from a session token the conversation is the session's own, a user credential names `conversationId` | `subscription.write` | `POST /reminders` |
| `reminder.query` | `{ conversationId? }`; a session token lists its own conversation's | `subscription.read` | `GET /reminders` |
| `reminder.cancel` | `{ reminderId }` | `subscription.write` | `DELETE /reminders/{id}` |

CLI: `hercule reminder create --at 2026-09-03T09:00 "Remind Rogier to chase the Acme invoice"`, `hercule reminder query | cancel`.

### memory (assistant-scoped)

Section 6.4 specifies the operations. Grant family `memory` (`read`: `list`, `read`, `search`; `write`: `write`, `append`, `delete`). Routes: `GET /assistants/{id}/memory` (list), `GET .../memory/search?text=`, `GET` / `PUT` / `DELETE .../memory/{name}`, `POST .../memory/{name}/append`. `PUT` takes `{ body, gist?, confirmShrink? }`. `{id}` is `me` for a session token (section 6.4 pins the scope rule).

### permission, profile

Content: [./13-security.md](./13-security.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `permission.request` | `{ grant, reason, operation?: { op, input } }` -> `{ requestId, subscriptionId? }` | none (granted to every profile) | `POST /permissions/request` |
| `permission.decide` | `{ requestId, outcome: "session" \| "profile" \| "deny" }` | `permission.write` | `POST /permissions/requests/{id}/decide` |
| `profile.query` / `profile.read` | | `permission.read` | `GET /profiles[/{id}]` |
| `profile.create` / `update` / `delete` | `{ name, grants[] }`; the three shipped profiles can be edited, not deleted | `permission.write` | `POST` / `PATCH` / `DELETE /profiles[/{id}]` |

Permission Requests are Notifications; pending ones are listed with `notification.query { kind: "permission-request" }`, and the user's decision in the web app is `notification.act` over a bound `permission.decide`. Section 5 covers the request flow. *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85): `permission.decide` is not on the list of bindable operations yet; [#86](https://github.com/theagenticage/hercule/issues/86) adds it, and must settle how its "add to profile" answer, which edits a permission profile, gets past the rule that keeps the `permission` family off that list.)*

### secret, credential

Semantics: [./13-security.md](./13-security.md), [./15-packaging-and-operations.md](./15-packaging-and-operations.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `secret.query` | `{ owner? }` -> references only, never values | `secret.read` | `GET /secrets` |
| `secret.set` / `secret.delete` | `{ ownerKind, ownerId, name, value }` / `{ ownerKind, ownerId, name }` | `secret.write` | `PUT` / `DELETE /secrets/{ownerKind}/{ownerId}/{name}` |
| `apiKey.query` / `apiKey.create` / `apiKey.revoke` | user API keys; `create` takes `{ name }` and returns `{ id, name, token, createdAt }`, `token` present on create and never again | `credential.read` / `credential.write` | `GET` / `POST /api-keys`, `DELETE /api-keys/{id}` |
| `user.read` | `{}` -> `{ username }`, the name of the user the credential belongs to, so a client that keeps only a token can show who is signed in. User credentials only: a session token is refused 403 even when its profile holds the grant, because no agent needs the user's login name *(added 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275))* | `credential.read` | `GET /user` |
| `user.setPassword` | `{ current, next }` | `credential.write` | `POST /user/password` |
| `auth.login` | `{ username, password }` -> bearer token | none (pre-auth) | `POST /auth/login` |
| `auth.logout` | `{}` -> `{}`; revokes the **login bearer that was presented** and nothing else. An API key or a session token gets `validation`: keys are revoked with `apiKey.revoke`, session tokens die with their session (added 2026-09-04, [#57](https://github.com/theagenticage/hercule/issues/57)) | any authenticated caller | `POST /auth/logout` |
| `auth.wsTicket` | `{}` -> short-lived WebSocket ticket | any authenticated caller | `POST /auth/ws-ticket` |
| `setup.read` | `{}` -> `{ complete: boolean }`; unauthenticated, so the web app knows to route to `/setup` (resolved 2026-09-01, [#44](https://github.com/theagenticage/hercule/issues/44)) | none (pre-auth) | `GET /setup` |
| `setup.complete` | `{ username, password, timezone }` - the thin gate; every later onboarding step is an ordinary authenticated call ([./14](./14-web-app.md) §Onboarding, resolved 2026-09-01, [#45](https://github.com/theagenticage/hercule/issues/45)); requires the one-time setup token ([./15](./15-packaging-and-operations.md)); atomically sets the password and returns a logged-in bearer token. Before setup completes, these two ops and the static bundle are all that is reachable; everything else is 401 | none (setup token) | `POST /setup/complete` |

*(Amended 2026-09-04, [#57](https://github.com/theagenticage/hercule/issues/57).)* A secret's owner is a **pair** - `ownerKind` (`connection | plugin | runner | provider-instance | core`) and `ownerId` - so it is two path segments, not one; the earlier `/secrets/{owner}/{name}` could not carry both, and the AEAD's associated data is `<ownerKind>|<ownerId>|<name>` ([./13-security.md](./13-security.md) §2.1). **`ownerKind: core` is rejected with `validation`** on `secret.set` and `secret.delete`: core secrets are the controller's own key material (the Ed25519 signing key), and overwriting one would break controller identity and every runner's trust in it ([./13-security.md](./13-security.md) §1). *(Amended 2026-10-02, [#326](https://github.com/theagenticage/hercule/issues/326).)* **`ownerKind: connection` is rejected the same way.** New credentials for a Connection must belong to the account it already holds, and only the Connection operations check that ([./05-plugins.md](./05-plugins.md) section 10.1); a `secret.set` would skip the check and could move the Connection, with its triggers and Resources, to another account. A Connection's credentials are replaced with `connection.setCredentials` or a reconnect, and removed with `connection.delete`. Their references are still listed, as `core`'s are.

### settings

The user settings store: per-user preference and presentation state with a closed, schema-validated key set - `timezone`, `topics.order: string[]`, `notifications.muted: string[]` (`workflow:<id>` | `plugin:<id>` | `assistant:<id>`), `lastChecked.intake`, `lastChecked.checkin`, `lastChecked.notifications`, `onboarding.completedSteps: string[]` (the post-gate onboarding steps, [./14](./14-web-app.md) §Onboarding), `thread.instanceId`, `thread.model`, `thread.accessMode`, `thread.profileId` (the defaults for a new Thread, [./02-domain-model.md](./02-domain-model.md) Thread; [./14](./14-web-app.md) Settings > Threads), and `github.defaultConnectionId`, the user's default GitHub Connection or null for none: the account a session acts through when its workspace designates no Connection ([./13-security.md](./13-security.md) section 9.3; [./14](./14-web-app.md) Settings > Profile). A Connection that is not a GitHub Connection is refused `validation` *(amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92))*. *(Added 2026-09-04, [#58](https://github.com/theagenticage/hercule/issues/58).)* The store also holds `ui.threadRows`, the one display preference of the shell: `"meta"` (the shipped default) or `"plain"` ([./14](./14-web-app.md) Settings > Threads). Keyed by user id from day one so a later user concept is a `WHERE` clause. Not a domain entity ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) sections 4, 7.2, 8; [./12-assistants.md](./12-assistants.md) section 5.2).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `settings.read` | `{}` -> the settings object | `settings.read` | `GET /settings` |
| `settings.update` | a partial settings object; unknown keys rejected | `settings.write` | `PATCH /settings` |

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* The controller settings hold `run.nestingLimit`, a whole number from 1, default 5: how many runs deep a run that a `run.start` step starts may be ([./07](./07-workflows.md) section 8). It has no field in the web app yet; `hercule settings update --controller '{"run.nestingLimit": 8}'` sets it.

*(Amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92).)* The controller setting `session.idleUnloadMinutes` is a whole number of minutes from 1, default 15: how long an assistant's session may sit with no turn before its runner stops the process, to be resumed at the next message ([./12-assistants.md](./12-assistants.md) section 5.1). It has no field in the web app yet; `hercule settings update --controller '{"session.idleUnloadMinutes": 30}'` sets it. *(Amended 2026-10-05, [#83](https://github.com/theagenticage/hercule/issues/83).)* It does not apply to an agent step's session, whose idle unload is a fixed 5 seconds ([./07-workflows.md](./07-workflows.md) section 4.2).

### project, resource

Semantics: [./02-domain-model.md](./02-domain-model.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `project.query` / `read` / `create` / `update` / `delete` | `{ name, description? }` (`description: null` on update removes it); `delete` is soft ([./02-domain-model.md](./02-domain-model.md) Deletion rules) | `project.read` / `project.write` | `/projects[/{id}]` |
| `resource.query` / `read` / `create` / `update` / `delete` | kind, remote (repo resources are unique on the canonical remote: `conflict`), `connectionId`, setup command, `.workspaceinclude` convention, `projectIds[]`; `delete` is `invalid_state` while a workspace referencing it is not `deleted \| lost`. *(Amended 2026-10-02, [#313](https://github.com/theagenticage/hercule/issues/313).)* A repo's remote is an `https://` URL or git's `user@host:owner/repo`; an `https://` URL with a user name or password before its host is `validation`, because the remote is stored and shown as written, and git gets its credential from the resource's Connection | `resource.read` / `resource.write` | `/resources[/{id}]` |

## 3. Actor stamping

### 3.1 Actor values

Every mutation through the service layer is stamped with an actor in the append-only event log ([./04-state-store.md](./04-state-store.md)):

```
actor: "user" | "session:<sessionId>" | "run:<runId>" | "plugin:<pluginId>"
```

- `user`: an API key or the web app's login token. Full parity; no profile applies.
- `session:<id>`: a session token. Bounded by the agent's permission profile (section 5).
- `run:<id>`: an action step executing inside a run (`task.create` on a cron tick). **Ungated**: the workflow was authored by the user, and its action steps run with the user's parity. A plugin action's `ctx.api` mutations are also `run:<id>`, with the `stepId` carried in the audit entry ([ADR 0026](../adr/0026-workflow-actions-may-call-the-public-api-as-the-run.md)). *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* For a workflow sent with `run.start` the caller authored the steps, so `run.start` checks `connection.use` on the caller before the run starts (section 2); the run's steps are then ungated as for a stored workflow. *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The same check runs wherever a caller chooses a step's Connection: when a workflow is saved, when a Connection input is given a value, and when a sent workflow is replayed (section 2, `connection`). Agent steps are sessions and act as `session:<id>` under their own profile, which is what keeps a `worker` session from fanning out.
- `plugin:<id>`: a plugin calling the service layer in-process through the public-API client capability. **Ungated**: the user enabled the plugin and granted the capability ([./05-plugins.md](./05-plugins.md)).

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* Two more facts about the values:

- **`run:<id>` is built.** Every mutation a built-in action step makes is stamped `run:<runId>`, and no grant check refuses it. The step's id is not yet written to the audit entry; the step record shows what each step returned ([./07](./07-workflows.md) section 7.2). `ctx.api` for plugin actions is not built yet ([./05-plugins.md](./05-plugins.md) section 4.4). *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89): it is left to a follow-up ticket.)*
- **`system`** is a fifth value, which the contract already accepts. It stamps a change the controller made on nobody's behalf: enlisting a runner that presented a join token, and what that runner reports about itself afterwards. It is only a stamp, never a caller: no credential resolves to it, so no grant check ever sees it.

An envelope's `actor` is `Actor | null`, and `null` means no actor caused the row: an ingested or cron event, and **`auth.login.failed`**, which is stamped `null` rather than `user` because nobody has been authenticated at the moment it is written. *(Amended 2026-09-04, [#59](https://github.com/theagenticage/hercule/issues/59).)*

The event log is the audit log; there is no separate audit subsystem. Multi-user later widens the `user` value to a user id and never restructures the field. Security events and actor-stamped mutations keep 90-day retention ([./13-security.md](./13-security.md)).

The actor also appears wherever the domain records who did something: task provenance entries (`{ref?, eventId?, runId?, at, actor}`), the `actor` field of the event envelope (platform events such as `task.created` carry it there, never duplicated in the payload; [./08-events-and-connections.md](./08-events-and-connections.md)), permission requests, memory writes (a provenance line on writes distilled from tainted conversations).

The actor is derived from the credential or the in-process caller, never supplied by the caller: an API key resolves to `user`, a session token resolves to `session:<id>` (section 4), the run engine and the plugin host supply theirs.

### 3.2 Bound Notification actions

A decision Notification may bind an operation (for example "Start Bugfix" = ~~`workflow.run`~~ `run.start` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))* with workflow X and task Y; "Merge dev bumps" = `github/pr.merge` over three PRs; "Event-sourced" = `session.input` replying to the session that asked). Pinned by ticket 37 ([ADR 0022](../adr/0022-proposing-is-not-doing.md)): **proposing is not doing.** The producer - a session, a run's `notify` step, a plugin or the core - declares the operation, and it is not checked against the producer's permission profile. The operation executes through `notification.act` when the user decides, as actor `user` under full parity; the event log entry records the notification id, its producer and, for a channel click, the connection it came through. Two guardrails replace the profile check: ~~the `bindable` flag withholds the credential/secret/infra/permission families, `connection.manage` and bulk-destructive operations from non-core producers, and every operation's `describe(input)` line is rendered by the core on every answer~~ *(amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85))* an answer may run only an operation on the curated list of bindable operations, for every producer, the core included (section 2, `notification`), and the core renders each listed operation's `describe(input)` line on every answer. An answer may carry `operation: null` - decide and do nothing ("Dismiss" on an offer, "Neither" on an agent question). Record shape, execution, failure and channel-click rules: [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4. *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85): of the examples, `run.start` and `session.input` can be bound today; `github/pr.merge` cannot, because no plugin action is on the list yet.)* Only the user takes an answer; the audit entry is `notification.decided { notificationId, actionId, op, producer }`, and where the answer came from is the resolution's `origin`. *(Added 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85).)* *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85), security.)* "Not checked against the producer's permission profile" does not mean any producer may bind anything on the list. Because the click runs as the user, the producer's own identity limits what it may bind: `session.respond` only the core; `session.input` a session only to itself (never from an assistant's conversation), a run to any session. So a producer can propose work it may not do, but it cannot aim the user's click at another session. The rules and their reasons: [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4.

## 4. Credentials

Two credential kinds resolve to the same actor-stamped API. Both are opaque random tokens, hashed in the controller database, resolved by one indexed lookup. No JWTs, no OAuth machinery for Hercule's own auth. Details: [./13-security.md](./13-security.md).

### 4.1 Session tokens

- **Minting:** at session start the controller mints a session token whose subject is the Session row. The token carries no claims of its own; the session's permission profile is reached by resolution `token -> session -> profile`: the profile id was copied onto the Session at spawn ([./02-domain-model.md](./02-domain-model.md) rule 9), so a Thread (no agent) resolves the same way.
- **Injection:** the runner injects `HERCULE_API_URL`, `HERCULE_TOKEN` and `HERCULE_SESSION=1` into the provider process environment. Nothing is written to runner disk.
- **Lifetime:** the token dies with the session. It is revoked when the session ends. A rotated assistant conversation continues in a fresh session and therefore under a fresh token; the old session's subscriptions migrate to the successor ([./12-assistants.md](./12-assistants.md)). *(Amended 2026-09-12, [#162](https://github.com/theagenticage/hercule/issues/162).)* "Ends" is the process exiting: the token is revoked on every exit, and a resume mints a fresh one for the same session id ([./13-security.md](./13-security.md) section 5).
- **Latency constraint (hard rule):** resolving token to profile MUST NOT meaningfully add endpoint latency. One indexed lookup on the hashed token plus a cached or joined profile read satisfies it; a per-request chain of separate queries does not.
- **`HERCULE_SESSION=1`:** the marker that makes the CLI refuse file-held user credentials (section 6.2 and [./13-security.md](./13-security.md)). It defends against accidental fallback to the user's identity, not against a malicious local process; sessions are bare processes as the same OS user ([ADR 0003](../adr/0003-sessions-run-as-bare-processes.md)).

### 4.2 User API keys

Long-lived, opaque, revocable, minted in the web app or via `hercule login` (password in, token out, stored with mode 0600 in the CLI credential file; its location inside Hercule Home is **Open** in [./15-packaging-and-operations.md](./15-packaging-and-operations.md)). Always the user's identity; the user has unrestricted parity. The web app's bearer token comes from the same password login. Full auth model: [./13-security.md](./13-security.md).

## 5. Permission enforcement

Every Session carries a permission profile, copied from its Agent at spawn or from the `thread.profileId` setting for a Thread; its session token carries it. Enforcement happens in the service layer, so it binds HTTP callers and in-process session callers alike (run and plugin actors are ungated, section 3.1). Parity with the user is the ceiling, not the default.

Grant families and verbs, the operation-to-grant table's vocabulary, and the three shipped profiles (`assistant`, `worker`, `unrestricted`) are specified in [./13-security.md](./13-security.md) section 6; this document does not restate them. Section 2 names the grant beside every operation.

**Grants are unscoped in v1 (hard rule):** a grant on a family covers every entity in that family. `session.read` reads every session's transcript, including other assistants' conversations; "the sessions I spawned" is a filter (`actor: "me"`), not a boundary. Scoped grants are the post-v1 "finer grants inside a family" that [./13-security.md](./13-security.md) reserves room for. The sole v1 exception is `memory` (section 6.4): a session token's memory operations are pinned to that session's assistant.

**403 rule (hard rule):** a denied operation returns 403 and the response names the missing grant (section 1.5). The CLI surfaces that name verbatim so the agent can ask for exactly it.

**Escalation:** `permission.request { grant, reason, operation? }` is granted to every profile. It creates a Permission Request notification, and, when the caller is a session, registers a `{ kind: "request" }` subscription for that session as part of the same operation: nobody asks for a grant without wanting the answer, so the response carries `subscriptionId` and the CLI has nothing to teach. `operation` is optional and informational in v1: it lets the notification say "wants to run `connection.create` with {...}" instead of only naming a grant. The user decides `session` (overlay that dies with the session), `profile` (edit the agent's profile) or `deny`; the decision arrives as queued input and the agent retries the original call itself, so the actor stays `session:<id>`. A one-call outcome (`once`) is post-v1 (section 10). Escalation UX: [./13-security.md](./13-security.md) section 6.4.

## 6. The `hercule` CLI

### 6.1 One binary, ~~three~~ five roles

`hercule` is the single self-contained binary ([ADR 0018](../adr/0018-hercule-ships-as-one-self-contained-binary.md)). `hercule serve` runs the controller, `hercule runner` runs a runner, and every other verb is an API client. *(Amended 2026-10-09, [#103](https://github.com/theagenticage/hercule/issues/103).)* `hercule service` and `hercule promote` are roles of their own too, not API clients: the first acts on this machine's OS supervisor, the second writes this machine's Hercule Home ([./15-packaging-and-operations.md](./15-packaging-and-operations.md) section 2). Role subcommands (`serve`, `runner`, `runner join`, `service install`, `upgrade`, `login`, `promote`, export/import) are specified in [./15-packaging-and-operations.md](./15-packaging-and-operations.md). Mode isolation is CI-enforced: the runner entrypoint imports no controller packages.

The CLI never prompts interactively: onboarding lives wholly in the web app + API, and the runner join exchange is fully programmatic.

`hercule login` takes the password docker-style (resolved 2026-09-01, [#44](https://github.com/theagenticage/hercule/issues/44)): `--password-stdin` is the canonical scripted form; on a TTY with no flag it prompts with echo off, **one of two documented exceptions** to the never-prompts rule *(amended 2026-10-09, [#103](https://github.com/theagenticage/hercule/issues/103); the other is `hercule promote` without `--yes`)*. The rule's purpose is that automation and the future desktop installer never wedge on a hidden prompt - `--password-stdin` preserves programmatic drivability, and the desktop app never runs `hercule login`. A bare `--password` flag does not exist (it would leak into `ps` and shell history).

### 6.2 Credential resolution

The CLI resolves its credential in this order:

1. `HERCULE_TOKEN` from the environment (with `HERCULE_API_URL`).
2. The CLI credential file, `~/.hercule/credentials.json` (written by `hercule login`; [./15-packaging-and-operations.md](./15-packaging-and-operations.md)).

When `HERCULE_SESSION=1` is set, step 2 is skipped: the CLI refuses file credentials outright. This is what makes the ops CLI and hercule-as-a-tool the same binary: identical commands, different credential.

### 6.3 Hercule-as-a-tool

Inside a session the `hercule` CLI is the whole of hercule-as-a-tool in v1. It ships built-in (not a plugin contribution), is uniform across Claude Code, Codex and pi, and needs no per-adapter wiring. The runner makes the binary available to the session process and materializes the skill (below) into it.

*(Rewritten 2026-09-15, [#126](https://github.com/theagenticage/hercule/issues/126). Until then this section pinned "Command = operation id": `hercule <entity> <verb>` was `<entity>.<verb>` spelled exactly as the contract spells it, which produced `hercule apiKey query` and `hercule auth wsTicket` and left the agent-addressed help nowhere to live.)*

**The command tree is spelled for a terminal and written in the contract.** `packages/contract` holds, beside the operation table, one CLI table with a row per operation: the command's words, its purpose, its examples, and one entry per field with its flag name and one line of help; or `hidden: true` for an operation only programmatic clients call. The row type is keyed by operation id, so an operation without a row does not compile. The `hercule` CLI derives its whole tree, its argument parsing and its help from that table plus the operation's schemas; nothing per-operation lives in the CLI package. A test proves the tree and the visible operations are one-to-one.

What survives of the one-vocabulary rule (section 1.3, [ADR 0021](../adr/0021-one-operation-vocabulary-coarse-grants-explicit-routes.md)): the operation id names the endpoint, the contract key and the built-in workflow action; a 403 names the grant; `--json` prints the output schema verbatim; and every command's `--help` names its operation id, route and grant on one line, so an agent holding a workflow action id or a 403 can find the command, and the other way round.

Spelling rules:

- A command is `hercule <noun>... <verb>`, every word kebab-case. The first noun is the operation's entity in kebab-case, singular as the id is (`api-key`, `session`).
- Standard verbs: `query` is `list`; `read`, `create`, `update` and `delete` keep their names. `hercule task list`, `hercule task read <id>`.
- A custom verb is kebab-cased as a verb phrase: `hercule runner refresh-facts`, `hercule user set-password`, `hercule connection start-oauth`, `hercule connection start-device-flow`.
- A custom verb of the form `<action><Thing>`, where the things have ids and a listing of their own, becomes a nested noun with standard verbs: `runner.createJoinToken`, `runner.queryJoinTokens` and `runner.revokeJoinToken` are `hercule runner join-token create | list | revoke <id>`.
- An owned sub-resource that is its own operation entity keeps its own root noun: `hercule input list <session-id>`, `hercule transcript read <session-id>`.
- One spelling per command. No aliases, no second spelling; the operation id is not accepted as a command.
- A hidden operation has no command at all: not in the tree, not in help, not callable. `auth.login`, `auth.logout` and `auth.wsTicket` are hidden; `hercule login` is the human form of login.
- Path parameters are positional, in route order. A payload field may be positional when its row says so (`hercule permission request <grant>`, `hercule subscription create <target>`), after the path parameters. Every other field is a flag, kebab-case, named in the row; a repeatable flag is singular (`--label bug --label ui`).
- Ids: a full id, or a tail of eight or more characters where the row names the listing that resolves it (section 1.4). A positional whose row names no listing takes the full id, and its help says so.
- The CLI adds no default of its own. A common case that needs no flags gets there through the operation's own defaults, never through a value the CLI invents.

Rules the CLI follows on every command:

- **Agent-addressed help.** `--help` works at any position on every subcommand, `hercule runner --help` included. Three levels. `hercule --help` lists every visible noun with its verbs and one line, then the conventions that hold everywhere (ids, `--json`, stdin, paging, exit codes, what a 403 means). `hercule <noun> --help` lists the noun's verbs with one line and the grant each needs, and a flow line naming the usual order. `hercule <noun> <verb> --help` prints, in this fixed order: purpose (what it does and when to use it), usage, examples, arguments, flags, stdin, returns, errors, next, and the operation line (`operation <id> · <METHOD> <path> · grant <g>`). Purpose, examples, the line per field, the noun's summary and flow line, and optional per-error meanings are written in the table; usage, placeholders, allowed values, required or optional, the stdin note, paging, the returns fields, the error code list and the operation line are derived from the contract. Examples are stored as arguments plus stdin and are parsed by a test, so they cannot go stale; every command any help text names must exist, by test. Static help plus 403s that name the missing grant are the two teaching channels.
- **Output.** Human-readable by default; `--json` on every command emits the contract's output schema (or error envelope) verbatim. Teaching lines ("read the reply with ...") exist only in the human rendering.
- **Progressive disclosure.** The skill is a minimal skeleton pointing at the CLI's own help. It names no command beyond the three help forms, and the ticket that writes it carries a test that every command it names exists. The list of "commands an agent uses most" that this section used to carry is the root help, generated.
- **One content channel (hard rule).** A field the row marks `stdin` has no inline flag: a password, a secret's value, credentials, a task's or project's description, a session's prompt or input text, a config that is the whole payload. Required, it is read from stdin unasked: `echo "carry on" | hercule session input <id>`. Optional, it is read only when its `--<flag>-stdin` marker is given (`hercule task update <id> --description-stdin < notes.md`), so an empty pipe never blanks a field. The whole of stdin is the value, one trailing newline removed, which is what a heredoc produces. At most one stdin field per command, because a document has newlines and cannot share the stream; `hercule user set-password` is the one exception and reads two lines, current then next. At a terminal the CLI never blocks on a stdin field: it exits 2 and shows the piped form (the echo-off prompt of section 6.1 is `hercule login`'s exception). There is no inline content flag and no `--file` flag. [Assemble the v1 spec](https://github.com/theagenticage/hercule/issues/21) delegated the pick between stdin-only and `--file` to the spec; the spec picks stdin-only. Rationale: a model mixed `--content` with a heredoc in the memory experiment ([Prototype: assistant memory interface](https://github.com/theagenticage/hercule/issues/31)).
- **Never blocks.** No `--wait` on any command (section 8).
- **Pagination.** ~~`list` commands page with `--limit`, `--cursor` and `--sort`;~~ *(Amended 2026-10-03, [#300](https://github.com/theagenticage/hercule/issues/300).)* `list` commands page with `--limit`, `--cursor` and `--sort`, and `--sort` repeats, one flag per key in order; `--all` follows `nextCursor` to the end.

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* A workflow's source is the first document the CLI carries both ways, and five rules changed so that a file round-trips byte for byte:

- **stdin is strict UTF-8.** A byte that is not part of a UTF-8 character is refused with exit 2, and nothing is sent, because a replacement character would change the value before any operation sees it. A leading byte order mark is kept, because it is part of what was sent.
- **`\r\n` is a newline.** The one trailing newline removed from stdin may be `\r\n`, as a file saved on Windows ends, and `hercule user set-password` splits its two lines on `\r\n` too.
- **A read prints the document.** `hercule workflow read` prints the source as it is, not as key/value lines, and ends it with the line break the source uses (`\r\n` when the source's first line break is one). What a read prints can be edited and piped back into `hercule workflow update`. `--json` prints the whole record. `workflow create` and `workflow update` print the id, whether the workflow is on, and one line per warning, and not the source the caller has just sent.
- **A check that finds an error exits 1.** `hercule workflow validate` prints one line per error and per warning, each named by its place in the definition, or one line that says the source is valid. It exits 1 when there is an error, as a refused save does, so a script can stop on it; warnings alone exit 0.
- **A field row may be hidden.** A row can hide one field of a visible operation (`hidden: true`, with the reason in a comment), and the field is then not on the command line at all. `definition` is hidden on `workflow create`, `update` and `validate` (and `submit`, *amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79)*), because on the command line the source is the text and stdin carries it. On `create` and `validate` (and `submit`) the `source` row is marked `required`, so the command reads stdin unasked although the operation lets the field be absent. A row that names a field the operation does not take fails the tree test, hidden or not.

*(Amended 2026-10-08, [#465](https://github.com/theagenticage/hercule/issues/465).)* **`--image <path>` is the one flag that names a file.** `hercule session spawn`, `session input` and `session continue` take `--image <path>`, repeatable, in the order the agent should see the images. It is a CLI-side step, not a content flag: the CLI uploads each file with `attachment.create`, and puts the returned ids in the operation's `attachments` field. The image bytes are binary and there can be several, so they cannot share stdin with the prompt; the prompt text still comes from stdin as the content channel rule says. `hercule session input <id> --image a.png --image b.jpg < note.txt` sends the note with two images. With at least one `--image`, the prompt is optional: an empty stdin from a pipe or a file sends the images alone, and at a terminal the CLI does not wait for stdin and sends the images with empty text. Without `--image` the prompt is required as before. The CLI row marks the field as `{ upload: true, flag: "image" }`, so the CLI package still holds nothing per operation. Before it sends anything, the CLI checks every file without reading its bytes, and refuses more than 10 files, a missing file, a file that is not a PNG, JPEG, GIF or WebP by its name, or a file over 10 MiB; it uploads only after every id tail has resolved, and a refused upload names the file. `input update` takes no `--image`: its row keeps `attachments` hidden, so from the command line a queued input keeps the images it has. The attachment operations are hidden, so `--image` is the only way the CLI uploads an image. A desktop or web client gives an upload or an image download more time than other requests: the desktop app allows 120 seconds ([./17-desktop-app.md](./17-desktop-app.md) §Reaching the controller).

**Standing rule.** An operation added to the contract lands its CLI row in the same change: spelling, purpose, examples and a line per field, or `hidden: true` with the reason in a comment. The row type and the tree tests refuse a contract without it; no ticket ships an operation the CLI cannot explain.

**The skill.** One provider-agnostic skill source describes the CLI; each provider adapter materializes it in that provider's native instruction format ~~(Codex takes instructions only as `AGENTS.md` in the cwd, so a Codex session needs a cwd even when workspace-less)~~. *(Amended 2026-09-30: Codex takes it as `developerInstructions` since [#68](https://github.com/theagenticage/hercule/issues/68); a Codex session still gets a scratch cwd, because `thread/start` requires one.)* Materialization and provider-home isolation are specified in [./06-providers.md](./06-providers.md).

### 6.4 `hercule memory`

Assistant memory is reached only through these operations ([ADR 0020](../adr/0020-assistant-memory-is-reached-only-through-the-api.md)); nothing is materialized on runner disk and assistant sessions stay workspace-less. Memory tiers (`core` plus named topics), the two-line topic header, the size and count caps, injection at session start and rotation are specified in [./12-assistants.md](./12-assistants.md); the operations and their enforcement are specified here.

| Operation | Behaviour |
|---|---|
| `list` | Returns the index: per document, name, size and gist. This is the same index injected at session start. |
| `read <name>` | Returns the full body of `core` or one topic. |
| `search <words>` | SQLite FTS5 over `core` and every topic; returns per matching document `{ name, snippets[] }`. The API's substitute for `grep`. |
| `write <name> [--gist "..."] [--confirm-shrink]` | Replaces the whole body of `core` or a topic; creates the topic if absent. Content on stdin; `--gist` sets the topic's one-line gist (optional, unchanged when omitted, ignored for `core`). |
| `append <name>` | Appends content to an existing document. Content on stdin. Never touches the gist. |
| `delete <name>` | Removes a topic. `delete core` is refused (`core` is seeded and always injected; `write core` with an empty body clears it). |

Enforcement at the write seam (hard rules):

- A `write` or `append` whose resulting size exceeds the document's cap fails with `cap_exceeded`, naming the current size and the cap so the agent can consolidate. The over-cap write is a visible event, never a silent truncation.
- A `write` that would exceed the topic count cap fails with `cap_exceeded`, naming the topic count and its cap.
- **Shrink guard.** A `write` that would shrink a document of 1,000 or more characters by more than 50% fails with `shrink_rejected`, naming old and new sizes, unless the call carries `confirmShrink: true`. The error is the teaching channel ([./12-assistants.md](./12-assistants.md) section 6.4).
- Every write is actor-stamped (section 3). Writes from a tainted session (one that has been delivered third-party lines) get provenance metadata *on* the document, set by the core, rendered by `read` as a trailing `> provenance:` line ([./12-assistants.md](./12-assistants.md) section 6.7, [./13-security.md](./13-security.md) section 10).

**Scope (hard rule, the one scoped family in v1):** memory operations from a session token act on the memory of that session's assistant and on nothing else; `assistantId` (`/assistants/{id}/memory`) is honoured for user credentials only, and a session token naming another assistant gets 403 `forbidden`. A session under a profile without `memory` (the `worker` profile) reaches no memory at all. The user reaches every assistant's memory through the same operations; the web app's memory view is a client of them.

There is no header convention to validate: the gist is a field (`--gist`), the body is pure content ([./12-assistants.md](./12-assistants.md) section 6.2).

## 7. Session subscriptions

A session may hold Subscriptions directly, without a run. Two use cases justify it: mid-session artifacts (an agent opens PR #87 and subscribes to its CI) and assistants (long-lived, no run to hold claims).

- **Registration** is the ordinary `subscription.create` operation (section 2), invoked from the session as `hercule subscription create <target>`, where `<target>` is `<kind>:<id>` (`run:r_3`, `session:s_12`, `request:pr_7`) or a bare External Ref (`github:pr:owner/repo#87`, taken as `ref:`).
- **Matching** runs in the single persisted pipeline like every subscription ([./08-events-and-connections.md](./08-events-and-connections.md)).
- **Delivery** is queued input on a turn boundary: rendered text plus the structured payload. Never steering by default. The agent's next turn opens with the match.
- **Lifetime:** dies with its holder session, or with `subscription.cancel`. On assistant rotation the subscriptions migrate to the successor session. No timeouts.
- **No polling surface for matches** in v1: there is no "any news?" operation; the event wakes the session. Listing *registrations* (`subscription.query`) exists for cancellation and for the session view.

Platform-auto detection ("this session opened PR #87, subscribe it") is not specified; explicit registration is the primitive.

## 8. The no-blocking rule

Every endpoint returns fast. No operation waits for a run, session, approval or permission decision to finish. Consequences:

- Spawn-type operations (~~`workflow.run`, `workflow.submit`~~ `run.start` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))*, `session.spawn`) return a handle immediately, and the CLI's human rendering teaches the follow-up: `subscribe for updates: hercule subscription create run:r_3`. *(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* ~~Until run events land ([#81](https://github.com/theagenticage/hercule/issues/81)) nothing would ever match a subscription on a run, so the controller refuses the target `run:<id>`.~~ ~~`hercule workflow run` and `hercule workflow submit`~~ ~~`hercule run start` therefore teaches `see how far it got with hercule run read <id>`. The subscription hint returns with [#81](https://github.com/theagenticage/hercule/issues/81).~~ *(Amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81).)* Run events are emitted and the controller accepts the target `run:<id>` (section 2), so `hercule run start` and `hercule run rerun` print the subscription hint again.
- There is no `--wait` flag anywhere in the CLI.
- The canonical long-wait pattern for an agent is: start the thing, subscribe to it, end the turn. The matching event arrives as queued input and wakes the session.
- Permission escalation (section 5) subscribes the caller automatically; the assistant heartbeat is a Scheduled Wake delivering queued input ([./12-assistants.md](./12-assistants.md) section 8).

## 9. The ops CLI

The ops CLI is the same `hercule` binary under a user credential: `hercule login` writes the API key to the CLI credential file, after which every API verb runs as actor `user` with unrestricted parity. Commands are identical to what a session sees; only the credential and therefore the profile differ. Role subcommands are specified in [./15-packaging-and-operations.md](./15-packaging-and-operations.md); runner join in [./03-controller-and-runners.md](./03-controller-and-runners.md).

## 10. Post-v1

- **Hercule MCP server** - the public API exposed to sessions as typed MCP tools (t3-code-style self-injection). High on the revisit list. V1 keeps the `SessionSpec.mcpServers` passthrough ([./06-providers.md](./06-providers.md)) so it lands without redesign; the operation catalogue maps one-to-one onto tools.
- **Scoped grants** ("the sessions you spawned", "this project's tasks") - finer grants inside a family; v1 grants are unscoped except `memory`.
- **One-call permission outcome (`once`)** - a fourth decision on a Permission Request that carries an `operation`: an overlay row on the session with `remainingUses: 1`, consumed by the first successful call of the named operation, so "may I do X once?" is answerable without a session-wide grant. `permission.request` already carries the `operation` field this needs. Its CLI sugar (`hercule <failed command> --request "<reason>"`, packing the failed call into the request) lands with it.
- **Bulk operations** (delete-many, cancel-all) - none exist in v1; when they do, they are tagged in the contract and withheld from every profile but `unrestricted` by default, per [./13-security.md](./13-security.md).
- **Offset pagination and totals** - bolted on beside cursors if usage shows a real need for random access.
- **CEL subscription targets** - a fifth `SubscriptionTarget` kind carrying a filter over `event`, if the four shorthand kinds prove short.
- **Read-only memory materialization on runners** (memory as files for native grep, writes still via API) - a pure read convenience addable without touching the write path.
- **Memory version history** - ruled post-v1; the retrofit is additive (history table beside the live document). V1 ships the shrink guard on the write seam instead, and every rewrite is a visible actor-stamped event.
- **Platform-auto subscription detection** - the controller subscribing a session to artifacts it created; explicit registration stays the primitive.
- **Multi-user** - widens the actor field to a user id; no restructuring.
- **Per-agent git identity** - a policy addition on unchanged plumbing ([./13-security.md](./13-security.md)).

## Sources

Tickets:

- [Public API operation catalogue: naming, route style, grant families](https://github.com/theagenticage/hercule/issues/38)
- [Agent-operates-system surface](https://github.com/theagenticage/hercule/issues/16)
- [Security & secrets model](https://github.com/theagenticage/hercule/issues/18)
- [Prototype: assistant memory interface](https://github.com/theagenticage/hercule/issues/31)
- [Assemble the v1 spec](https://github.com/theagenticage/hercule/issues/21) (handed-over constraints from #30 and #31)
- [Controller packaging & install story](https://github.com/theagenticage/hercule/issues/24)
- [Web app architecture: observability-first, desktop-shell-ready](https://github.com/theagenticage/hercule/issues/19)
- [Assistant design: memory, identity, channel binding](https://github.com/theagenticage/hercule/issues/17)
- [Event & trigger ingress design](https://github.com/theagenticage/hercule/issues/14)
- [Triage engine & user-set bounds](https://github.com/theagenticage/hercule/issues/15)
- [Task model: shape, status axis, lifecycle, provenance](https://github.com/theagenticage/hercule/issues/29)
- [Prototype: the Intake view](https://github.com/theagenticage/hercule/issues/30)
- [Plugin architecture: API shape, loading, dogfooding](https://github.com/theagenticage/hercule/issues/11)
- [Controller/runner architecture: registration, placement, scheduling](https://github.com/theagenticage/hercule/issues/7)
- [Controller promotion & portability](https://github.com/theagenticage/hercule/issues/10)
- [Workflow model: recipes, triggers, human gates](https://github.com/theagenticage/hercule/issues/13)
- [Provider adapter interface](https://github.com/theagenticage/hercule/issues/12)
- [Revisit Effect for the backend (#53)](https://github.com/theagenticage/hercule/issues/53) (Effect, HttpApi as the contract, handler-free operations, request lifetime, neutral validation issues)

ADRs:

- [ADR 0031 - The backend is written on Effect](../adr/0031-the-backend-is-written-on-effect.md)

- [ADR 0021 - One operation vocabulary, coarse grants, explicit routes](../adr/0021-one-operation-vocabulary-coarse-grants-explicit-routes.md)
- [ADR 0013 - Agents operate Hercule through the public API, behind one contract with two transports](../adr/0013-agents-operate-hercule-through-the-public-api.md)
- [ADR 0020 - Assistant memory is reached only through the API](../adr/0020-assistant-memory-is-reached-only-through-the-api.md)
- [ADR 0017 - The web app is a static pure client of the public API](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)
- [ADR 0018 - Hercule ships as one self-contained binary](../adr/0018-hercule-ships-as-one-self-contained-binary.md)
- [ADR 0003 - Sessions run as bare processes](../adr/0003-sessions-run-as-bare-processes.md)
