# Public API and agent surface

Hydra has one public API. The web app, the `hydra` CLI, agents inside sessions, built-in workflow actions and plugins all operate the system through the same set of operations, defined once in a framework-free service layer and described once in a shared contract package of Effect Schema declarations. HTTP routes are derived from that contract and call the service layer; the `hydra` CLI is a thin client over HTTP. Agents reach the API with a per-session token that carries their agent's permission profile; the user reaches it with an API key. Every mutation is stamped with its actor in the event log. No endpoint blocks: long waits are expressed as subscriptions whose matches arrive as queued input. This document pins the contract structure, the operation vocabulary, the transports and route style, the error envelope, the operation catalogue, the credential and attribution rules, the `hydra` CLI (including `hydra memory`), session subscriptions and the no-blocking rule. Rationale lives in [ADR 0013](../adr/0013-agents-operate-hydra-through-the-public-api.md), [ADR 0020](../adr/0020-assistant-memory-is-reached-only-through-the-api.md), [ADR 0021](../adr/0021-one-operation-vocabulary-coarse-grants-explicit-routes.md) and [ADR 0031](../adr/0031-the-backend-is-written-on-effect.md).

## 1. Contract structure

### 1.1 Service layer

A framework-free TypeScript service layer defines every operation: each operation is a method on an Effect service (`Sessions.spawn(input)`), the backend being written on Effect ([ADR 0031](../adr/0031-the-backend-is-written-on-effect.md)). "Framework-free" means: **no operation logic in any transport handler.** An HttpApi handler is a one-line call into the service method, and an RPC handler would be the same one line, so an operation can later be exposed over the WebSocket by adding one handler line, never by moving logic. Every consumer goes through it:

| Consumer | How it calls |
|---|---|
| HTTP routes | derived from the contract's HttpApi declaration (input validated and output encoded by the derived route); one-line call into the service method |
| `hydra` CLI (agent and ops) | over HTTP |
| Web app | over HTTP (plus one WebSocket for live topics, see [./14-web-app.md](./14-web-app.md)) |
| Built-in workflow actions (`workflow.run`, `notification.create`, `task.create`, `task.update`, `task.query`) | in-process, same service layer |
| Plugins holding the public-API client capability | in-process, same service layer ([./05-plugins.md](./05-plugins.md)) |

Permission enforcement (section 5) and actor stamping (section 3) sit inside the service layer, so they bind every consumer identically.

**Request lifetime.** Each HTTP request or RPC call runs as one fiber. The transport handler resolves the credential and provides the current actor and a tracing span as request-scoped context, which service methods read (`CurrentActor`), never a context parameter threaded through signatures. A client disconnect interrupts the fiber, and an open transaction rolls back with it ([./04-state-store.md](./04-state-store.md)). Every service operation and repository call carries a span from day one; v1 exports spans nowhere beyond the log line, and an OpenTelemetry exporter is a later layer swap ([ADR 0031](../adr/0031-the-backend-is-written-on-effect.md)).

**Parity guarantee (hard rule):** nothing is reachable in-process that is not reachable over HTTP. A service operation without an HTTP route is a defect. The WebSocket carries live-topic subscriptions only; every query and mutation stays on HTTP ([ADR 0017](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)).

### 1.2 Contract package

`packages/contract` holds, per operation: its id, an Effect Schema input schema, an Effect Schema output schema, its error schemas, the grant it requires (section 5), and its HTTP route (section 1.4), all as one Effect HttpApi declaration. It is the pinned, expensive-to-retrofit asset. Consumers of the package: server-side validation, the `hydra` CLI, the web app (`client-core`, [./14-web-app.md](./14-web-app.md)), the plugin public-API client, and the workflow editor's schema-driven autocomplete.

From that declaration the server routes, request validation, the OpenAPI document and the typed client are derived ([ADR 0031](../adr/0031-the-backend-is-written-on-effect.md)); the route table of section 1.4 is what the declaration follows. The `hydra` CLI and `client-core` use the derived client. The same package holds the Effect RPC group for the WebSocket's live topics ([./14-web-app.md](./14-web-app.md)); every query and mutation stays on HttpApi (section 1.1). The deferral of RPC-framework adoption in [ADR 0013](../adr/0013-agents-operate-hydra-through-the-public-api.md) is withdrawn by its 2026-09-02 amendment.

### 1.3 Operation vocabulary

One identifier names an operation on every surface ([ADR 0021](../adr/0021-one-operation-vocabulary-coarse-grants-explicit-routes.md)):

- **Operation id** = `<entity>.<verb>`, entity singular: `task.create`, `session.spawn`, `workflow.submit`, `runner.drain`. Every entity is its own operation family.
- **Built-in workflow action id** = the operation id, unchanged. The built-in actions *are* the operations ([./07-workflows.md](./07-workflows.md) section 8).
- **CLI** = the id split on the dot: `hydra task create`, `hydra session spawn`, `hydra runner drain`. No aliases, no second spelling.
- **Grant** = `<family>.<verb>` in the coarse grant vocabulary of [./13-security.md](./13-security.md) section 6.1. Grant families are *not* one-to-one with operation families: `infra.write` covers `runner.*`, `plugin.*`, `provider.*` and `controller.*`. The operation-to-grant mapping is an explicit table in the contract package; a 403 and the CLI's `--help` both name the grant, so an agent never has to guess it.

Standard verbs, used with the same meaning on every entity that has them:

| Verb | Meaning |
|---|---|
| `query` | the one list operation of an entity: filters (including `text` where full-text search exists) plus pagination; no filters lists everything; returns `items: <Entity>[]`. There is no `list` and no `search` anywhere in the catalogue. |
| `read` | one entity by id |
| `create` / `update` / `delete` | the obvious; `update` is a partial patch |
| custom verbs | `spawn`, `steer`, `run`, `submit`, `emit`, `cancel`, `rerun`, `drain`, ...: named per entity in section 2 |

**Rule:** `<entity>.query` returns `<Entity>[]`. Something that returns another type is another entity's operation (transcript passages are `transcript.query`, not `session.query { text }`).

**Named exception:** `memory` keeps the verbs `list`, `read`, `search`, `write`, `append`, `delete` pinned by [ADR 0020](../adr/0020-assistant-memory-is-reached-only-through-the-api.md) and tested with real agents in [Prototype: assistant memory interface](https://github.com/rogierpennink/hydra/issues/31). `list` returns the index and `search` returns matches, so they could not be one `query` under the rule above anyway.

### 1.4 Transports and route style

Two transports, one contract:

1. **HTTP** on the controller's origin. Bearer authentication (`Authorization` header) with either credential kind (section 4). Plain HTTP on LAN/tailnet by default ([./13-security.md](./13-security.md)).
2. **The `hydra` CLI** (section 6): the same binary in every role, speaking HTTP to `HYDRA_API_URL`.

The web app additionally holds one WebSocket for live topics (subscriptions only), connected with a short-lived single-purpose ticket fetched over HTTP; bearer auth, no cookies. Details in [./14-web-app.md](./14-web-app.md).

A Hydra MCP server is not a v1 transport (section 10).

**Ids on the wire** are canonical lowercase UUIDv7 strings, except event ids, which are integers ([./04-state-store.md](./04-state-store.md)). The CLI accepts a full id or an unambiguous tail of eight or more characters for any `<id>` argument (`conflict` if ambiguous) and prints tails in human output; `--json` always prints full ids. *(Amended 2026-09-04, [#57](https://github.com/rogierpennink/hydra/issues/57).)* **Tail resolution is a CLI-side behaviour**: the CLI resolves a tail through the entity's `query` operation and reports `conflict` itself when more than one id matches. The wire carries canonical ids only - no `{id}` path parameter and no input schema accepts a tail - so a tail costs an extra round trip and needs the entity's read grant.

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

Path nouns are plural (`/tasks`) although operation ids are singular; that is the one place the two spellings differ. Query strings repeat the key for list-valued filters (`label=a&label=b`); the derived client serializes from the operation's input schema, so neither the CLI nor the web app hand-builds URLs. `me` is accepted wherever an id names the caller's own session or assistant (`/api/v1/assistants/me/memory`): a session token resolves it, a user credential gets 400 `validation`.

### 1.5 Success and error shapes

**Success** bodies are the operation's output schema, bare: no `{ data: ... }` wrapper.

**Errors** use one envelope; the HTTP status is derived from the code:

```json
{ "error": { "code": "forbidden", "message": "missing grant session.spawn", "details": { "grant": "session.spawn" } } }
```

- `code` is a closed enum in the contract, extended additively: `unauthenticated` (401), `forbidden` (403), `validation` (400), `not_found` (404), `conflict` (409), `invalid_state` (409), `cap_exceeded` (422), `internal` (500).
- `details` is typed per code: `forbidden` carries `{ grant }`; `cap_exceeded` carries `{ size, cap }` or `{ count, cap }`; `validation` carries `{ issues: { path: string[]; message: string }[] }`, mapped from the schema library's parse issues; the wire contract names no schema library.
- `message` is for people and is never parsed.
- **One response is not in the envelope.** A request body larger than the controller's cap is answered `413` by the transport, bare, before any of the body is read. Reading it to answer in the envelope is the cost the cap exists to avoid.
- **One error per response.** The service layer runs its checks in a fixed order and the first failing check is the response: `unauthenticated`, then the static grant check (`forbidden`, before any entity is touched), then `validation`, then `not_found`, then entity-dependent `forbidden` (the `memory` scope rule, section 6.4), then business rules (`conflict`, `invalid_state`, `cap_exceeded`), then `internal`. A caller lacking a grant learns that before learning whether the entity exists. `validation` is the one code that reports everything wrong at once, so a caller fixes every field in one retry.

  *(Amended 2026-09-04, [#57](https://github.com/rogierpennink/hydra/issues/57).)* On HTTP the derived route decodes and validates the payload before it ever reaches a handler, so the fixed order only holds if the grant check runs earlier: **the static grant check is performed by transport middleware, before payload decoding**. The contract's operation-to-grant table (section 1.3) is therefore load-bearing at request time, not documentation. Service methods keep the same check inside the method, for in-process callers (built-in workflow actions, plugins) that reach no transport; a caller over HTTP is simply checked twice, identically.

The `hydra` CLI prints `message` (and, for `forbidden`, the grant on its own line); `--json` prints the envelope verbatim.

### 1.6 Pagination and sorting

Every `query` operation takes `{ limit?, cursor?, sort? }` and returns `{ items, nextCursor? }`. Cursors are opaque strings; the default `limit` is 50 and the hard maximum 500. `sort` is `{ field, direction }` over an enum of allowed fields declared per operation. Inside the cursor the controller uses keyset pagination for stable sorts and an offset for relevance-sorted full-text results; callers never see the difference. There are no page numbers and no total counts in v1: the web app pages forward ("load more"), and jumping to a range is done with filters (`run.query { since, until }`), not pagination.

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

`task.query` sorts over `updatedAt | createdAt | priority | status`, default `updatedAt desc`, keyset. With `text` the order is relevance and the walk pages by offset; `text` together with an explicit `sort` is `validation` naming both ([./09-tasks.md](./09-tasks.md) Search). `task.update` never takes a whole `labels` array: labels move one at a time through `addLabels` and `removeLabels`, so a concurrent edit by the user and a triage agent cannot clobber each other.

### workflow, trigger, run

Semantics: [./07-workflows.md](./07-workflows.md); breaker semantics in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `workflow.query` | `{ enabled?, text? }` -> `{ items: { id, name, description, enabled, updatedAt }[] }` (parse-time denormalized columns) | `workflow.read` | `GET /workflows` |
| `workflow.read` | `{ workflowId }` -> `{ id, enabled, source, createdAt, updatedAt }`; `source` is the stored YAML text, and no parsed object is returned - clients parse it themselves with the contract schema ([./07](./07-workflows.md) section 1; resolved 2026-09-01, [#45](https://github.com/rogierpennink/hydra/issues/45)) | `workflow.read` | `GET /workflows/{id}` |
| `workflow.create` / `update` / `delete` | `{ source: string }` (YAML) or `{ definition: object }` (rendered to canonical YAML by the controller; the object form is the agents' convenience); `enabled` is a separate field on update ([./07](./07-workflows.md) section 1) | `workflow.write` | `POST` / `PATCH` / `DELETE /workflows[/{id}]` |
| `workflow.run` | `{ workflowId, inputs }` -> `{ runId }` | `workflow.run` | `POST /workflows/{id}/run` |
| `workflow.submit` | `{ source | definition, inputs }` -> `{ runId }` (same input union as `workflow.create`) | `workflow.submit` | `POST /workflows/submit` |
| `trigger.query` | `{ workflowId?, kind?, status? }` | `workflow.read` | `GET /triggers` |
| `trigger.read` | `{ triggerId }` (includes the held-event count) | `workflow.read` | `GET /triggers/{id}` |
| `trigger.pause` | `{ triggerId }` | `workflow.write` | `POST /triggers/{id}/pause` |
| `trigger.resume` | `{ triggerId, discardHeld?: boolean }` | `workflow.write` | `POST /triggers/{id}/resume` |
| `run.query` | `{ workflowId?, status?, since?, until?, actor? }` | `run.read` | `GET /runs` |
| `run.read` | `{ runId }` (frozen plan, inputs, trigger event, step records, failure reason, final output, live subscriptions) | `run.read` | `GET /runs/{id}` |
| `run.cancel` | `{ runId }` | `run.write` | `POST /runs/{id}/cancel` |
| `run.rerun` | `{ runId, mode?: "re-stamp" \| "replay" }` -> `{ runId }` | `workflow.run` | `POST /runs/{id}/rerun` |

`workflow.submit` starts a run from a workflow definition that is not stored: the same `Workflow` shape minus `id` and timestamps, validated exactly as a stored one. `workflow.run` loads the stored definition and takes the same internal path. The outside world, agents included, only ever writes *workflows*; the frozen execution plan on a run is internal vocabulary. A run's held events are read with `event.query { triggerId }`.

### session, input, transcript

Semantics: [./06-providers.md](./06-providers.md), [./12-assistants.md](./12-assistants.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `session.query` | `{ status?, agentId?, thread?, assistantId?, runnerId?, runId?, actor?, since?, until? }` (`thread: true` = sessions with no agent) | `session.read` | `GET /sessions` |
| `session.read` | `{ sessionId }` (the record: status, agent, runner, workspace, usage) | `session.read` | `GET /sessions/{id}` |
| `session.spawn` | `{ agentId?, prompt, instanceId?, model?, accessMode?, workspace? }` -> `{ sessionId }`; without `agentId` the session is a Thread built from the `thread.*` settings plus the overrides given, allowed for actor `user` only (`forbidden` otherwise; [./02-domain-model.md](./02-domain-model.md) Thread) | `session.spawn` | `POST /sessions` |
| `session.continue` | `{ sessionId, mode: "resume" \| "fork", prompt }` -> `{ sessionId }` | `session.spawn` | `POST /sessions/{id}/continue` |
| `session.input` | `{ sessionId, content }` -> `{ inputId, result: "opened" \| "steered" }` | `session.steer` | `POST /sessions/{id}/input` |
| `session.interrupt` / `session.stop` | `{ sessionId }` | `session.steer` | `POST /sessions/{id}/interrupt` / `.../stop` |
| `session.respond` | `{ sessionId, requestId, decision: "allow" \| "allow_always" \| "deny" \| "cancel" }` | `session.steer` | `POST /sessions/{id}/respond` |
| `input.query` | `{ sessionId }` (the controller-owned queue) | `session.read` | `GET /sessions/{id}/inputs` |
| `input.update` / `input.cancel` | `{ inputId, content }` / `{ inputId }` | `session.steer` | `PATCH` / `DELETE /sessions/{id}/inputs/{inputId}` |
| `transcript.read` | `{ sessionId, cursor? }` -> the normalized transcript | `session.read` | `GET /sessions/{id}/transcript` |
| `transcript.query` | `{ text, sessionId?, agentId?, assistantId?, actor?, since?, until? }` -> `items: Passage[]` | `session.read` | `GET /transcripts` |

```ts
interface Passage { sessionId: string; turnId: string; at: string; excerpt: string }
```

`transcript.query` is full-text search over normalized transcripts and is the transcript-recall operation of [./12-assistants.md](./12-assistants.md): an assistant recalls its own conversations with `assistantId: "me"`, and any agent granted `session.read` searches any session (a learning workflow reading past sessions uses the same operation). `actor: "me"` on `session.query` and `transcript.query` is the shortcut for "sessions this session spawned"; it is a filter on the actor stamp, not a permission.

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

The controller expands a target into the pipeline's matching condition and stores both, so the web app shows "waiting on run r_3" without parsing anything. A session token with no `holder` lists its own subscriptions; a user credential must name a holder. `subscription.cancel` accepts session-held subscriptions only; a run-held one (instantiated from a signal trigger) ends with its run, and cancelling it directly is 409 `invalid_state`. No free-form CEL target in v1: the four kinds already compose into everything the tickets asked for, and CEL is the escape hatch if dogfooding proves them short.

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

Two per-operation facts in the contract's operation table serve bound actions ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4): a **`bindable`** flag, default true, `false` for the `credential`, `secret`, `infra` and `permission` families, `connection.manage` and bulk-destructive-tagged operations (the core may still bind those; other producers may not), and a **`describe(input) -> string`** renderer, the core-rendered line shown on every bound action so the click is informed.

### event

Pipeline: [./08-events-and-connections.md](./08-events-and-connections.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `event.query` | `{ connectionId?, kind?, since?, until? }` | `event.read` | `GET /events` |
| `event.read` | `{ eventId }` | `event.read` | `GET /events/{id}` |
| `event.emit` | `{ kind, payload, connectionId? }` -> `{ eventId }` (the `manual` source) | `event.emit` | `POST /events/emit` |
| `event.enrich` | `{ eventId, system?, url?, refs? }`; `system`/`url` overwrite, `refs` append-only; re-matches the event idempotently ([./08-events-and-connections.md](./08-events-and-connections.md) section 4.2) | `event.emit` | `POST /events/{id}/enrich` |

*(Amended 2026-09-04, [#59](https://github.com/rogierpennink/hydra/issues/59).)* `event.query` ships with `connectionId`, `kind`, `since` and `until`. The `triggerId` and `runId` filters (joined to effect rows; `triggerId` lists a paused trigger's held events) are added by the workflows ticket, which completes this operation rather than changing it: triggers, runs and held events do not exist yet, and a filter that always answers empty is a silent substitution.

`since` and `until` bound **`receivedAt`**, when the log took the event, not `occurredAt`, when the source says it happened. Arrival is the log's own axis and the one its ids run with, so a window and the order a page comes back in never disagree; an emitter's claim about when something happened is neither.

`event.query` returns **both populations** behind the one `event.read` grant: pipeline events and audit entries come back from one call, told apart only by `kind`. There is no population filter, because reading failed logins beside the events that caused work is what the log is opened for; any holder of `event.read` therefore reads every security entry. The log is walked by `id` only, default `id desc`, keyset. Event ids are integers on the wire (section 1.4).

### connection

Semantics: [./08-events-and-connections.md](./08-events-and-connections.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `connection.query` / `connection.read` | `{ type?, status? }` / `{ connectionId }` (status, labels, credential *references*) | `connection.read` | `GET /connections[/{id}]` |
| `connection.create` / `update` / `delete` | record fields incl. labels and default topic | `connection.manage` | `POST` / `PATCH` / `DELETE /connections[/{id}]` |
| `connection.setCredentials` | `{ connectionId, ... }` (values in, references out) | `connection.manage` | `POST /connections/{id}/credentials` |

`connection.use` is a grant, not an operation: it is what a plugin-contributed action (`github.merge`) requires when it names the Connection it acts as. In v1 nothing a session token calls directly requires it (sessions cannot invoke plugin actions outside a run), so it is dormant until the Hydra MCP server or the agent-tools extension point lands.

### runner, plugin, provider, controller (grant family `infra`)

Semantics: [./03-controller-and-runners.md](./03-controller-and-runners.md), [./05-plugins.md](./05-plugins.md), [./06-providers.md](./06-providers.md), [./15-packaging-and-operations.md](./15-packaging-and-operations.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `runner.query` / `runner.read` | `{ state?, label? }` / `{ runnerId }` (state, probed facts, capabilities) | `infra.read` | `GET /runners[/{id}]` |
| `runner.update` | `{ runnerId, name?, labels?, maxConcurrentSessions? }` | `infra.write` | `PATCH /runners/{id}` |
| `runner.drain` / `runner.retire` / `runner.upgrade` | `{ runnerId }`; `retire` takes `force?: boolean` for an unreachable runner | `infra.write` | `POST /runners/{id}/drain` etc. |
| `runner.probe` | `{ runnerId, instanceId }` -> capability snapshot | `infra.write` | `POST /runners/{id}/probe` |
| `runner.createJoinToken` | `{}` -> single-use join token (renamed from `mintJoinToken` 2026-09-01, [#44](https://github.com/rogierpennink/hydra/issues/44): `create` over `mint`, consistently) | `infra.write` | `POST /runners/join-tokens` |
| `plugin.query` / `plugin.read` | `{}` / `{ pluginId }` (state, config, contributions) | `infra.read` | `GET /plugins[/{id}]` |
| `plugin.enable` / `plugin.disable` | `{ pluginId }` | `infra.write` | `POST /plugins/{id}/enable` etc. |
| `plugin.configure` | `{ pluginId, config }` (deactivate + reactivate) | `infra.write` | `PUT /plugins/{id}/config` |
| `provider.query` / `provider.read` | provider instances and their capability snapshots | `infra.read` | `GET /providers[/{id}]` |
| `provider.create` / `update` / `delete` | instance config ([./06](./06-providers.md)) | `infra.write` | `POST` / `PATCH` / `DELETE /providers[/{id}]` |
| `controller.read` | `{}` -> identity, version, update availability, default runner. *(2026-09-04, [#57](https://github.com/rogierpennink/hydra/issues/57): as built it returns identity and version only. Update availability and the default runner land with the update-check and runner tickets - they stay part of the operation's description, they are simply not there yet.)* | `infra.read` | `GET /controller` |
| `controller.update` | `{ defaultRunnerId? }` | `infra.write` | `PATCH /controller` |
| `controller.createPromotionToken` / `controller.export` / `controller.import` | promotion ([./15](./15-packaging-and-operations.md)); renamed from `mintPromotionToken` with `runner.createJoinToken` ([#44](https://github.com/rogierpennink/hydra/issues/44)) | `infra.write` | `POST /controller/promotion-tokens`, `.../export`, `.../import` |

### workspace

Semantics: [./03-controller-and-runners.md](./03-controller-and-runners.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `workspace.query` / `workspace.read` | `{ runnerId?, resourceId?, kind?, status? }` / `{ workspaceId }` | `workspace.read` | `GET /workspaces[/{id}]` |
| `workspace.provision` | `{ resourceId, runnerId }` -> a primary workspace (adopts an existing local checkout in place) | `workspace.write` | `POST /workspaces` |
| `workspace.dispose` | `{ workspaceId }` (an ephemeral, including the kept workspace of a failed run; a primary is never torn down by Hydra: 409 `invalid_state`) | `workspace.write` | `DELETE /workspaces/{id}` |

Workspaces otherwise appear as side effects of session and run placement; `lost` is set by runner retirement, never by an operation.

### agent, assistant, binding, conversation

Semantics: [./12-assistants.md](./12-assistants.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `agent.query` / `agent.read` | | `agent.read` | `GET /agents[/{id}]` |
| `agent.create` / `update` / `delete` | `name`, `systemPrompt`, `instanceId`, `permissionProfileId`, `accessMode?`, `model?`, `mcpServers?`, `disallowedTools?` ([./02-domain-model.md](./02-domain-model.md) Agent); assigning a permission profile is an `agent.update` and affects sessions spawned afterwards; `delete` is `invalid_state` while a non-exited session references the agent | `agent.write` | `POST` / `PATCH` / `DELETE /agents[/{id}]` |
| `assistant.query` / `assistant.read` | | `agent.read` | `GET /assistants[/{id}]` |
| `assistant.create` / `update` / `delete` | an agent plus `heartbeat { enabled, schedule, timezone?, prompt, target }`, `rotation { contextFraction, maxContextTokens, dailyAt, timezone? }`, `reply`, `accessMode` ([./12-assistants.md](./12-assistants.md) section 1); `delete` is the confirmed action that deletes memory and bindings | `agent.write` | `POST` / `PATCH` / `DELETE /assistants[/{id}]` |
| `binding.query` / `create` / `update` / `delete` | channel bindings of an assistant | `agent.read` / `agent.write` | `GET` / `POST /assistants/{id}/bindings`, `PATCH` / `DELETE /assistants/{id}/bindings/{bindingId}` |
| `conversation.query` / `conversation.read` | `{ assistantId, ... }` (lineage of sessions) | `agent.read` | `GET /assistants/{id}/conversations[/{conversationId}]` |
| `conversation.rotate` | manual rotation ("start fresh"): distill, end the incarnation, successor on next wake ([./12-assistants.md](./12-assistants.md) section 5.2) | `agent.write` | `POST /assistants/{id}/conversations/{conversationId}/rotate` |

### reminder (scheduled wakes)

Semantics: [./12-assistants.md](./12-assistants.md) section 8.3. A reminder is a one-shot Scheduled Wake delivered as input to the conversation that created it; the heartbeat (the recurring wake) is edited through `assistant.update`, not here. Grant family `subscription` - a reminder is "wake me later" on a clock instead of an event.

| Operation | Input | Grant | Route |
|---|---|---|---|
| `reminder.create` | `{ at: ISO datetime, text }` -> `{ reminderId }`; from a session token the conversation is the session's own, a user credential names `conversationId` | `subscription.write` | `POST /reminders` |
| `reminder.query` | `{ conversationId? }`; a session token lists its own conversation's | `subscription.read` | `GET /reminders` |
| `reminder.cancel` | `{ reminderId }` | `subscription.write` | `DELETE /reminders/{id}` |

CLI: `hydra reminder create --at 2026-09-03T09:00 "Remind Rogier to chase the Acme invoice"`, `hydra reminder query | cancel`.

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

Permission Requests are Notifications; pending ones are listed with `notification.query { kind: "permission-request" }`, and the user's decision in the web app is `notification.act` over a bound `permission.decide`. Section 5 covers the request flow.

### secret, credential

Semantics: [./13-security.md](./13-security.md), [./15-packaging-and-operations.md](./15-packaging-and-operations.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `secret.query` | `{ owner? }` -> references only, never values | `secret.read` | `GET /secrets` |
| `secret.set` / `secret.delete` | `{ ownerKind, ownerId, name, value }` / `{ ownerKind, ownerId, name }` | `secret.write` | `PUT` / `DELETE /secrets/{ownerKind}/{ownerId}/{name}` |
| `apiKey.query` / `apiKey.create` / `apiKey.revoke` | user API keys; `create` takes `{ name }` and returns `{ id, name, token, createdAt }`, `token` present on create and never again | `credential.read` / `credential.write` | `GET` / `POST /api-keys`, `DELETE /api-keys/{id}` |
| `user.setPassword` | `{ current, next }` | `credential.write` | `POST /user/password` |
| `auth.login` | `{ username, password }` -> bearer token | none (pre-auth) | `POST /auth/login` |
| `auth.logout` | `{}` -> `{}`; revokes the **login bearer that was presented** and nothing else. An API key or a session token gets `validation`: keys are revoked with `apiKey.revoke`, session tokens die with their session (added 2026-09-04, [#57](https://github.com/rogierpennink/hydra/issues/57)) | any authenticated caller | `POST /auth/logout` |
| `auth.wsTicket` | `{}` -> short-lived WebSocket ticket | any authenticated caller | `POST /auth/ws-ticket` |
| `setup.read` | `{}` -> `{ complete: boolean }`; unauthenticated, so the web app knows to route to `/setup` (resolved 2026-09-01, [#44](https://github.com/rogierpennink/hydra/issues/44)) | none (pre-auth) | `GET /setup` |
| `setup.complete` | `{ username, password, timezone }` - the thin gate; every later onboarding step is an ordinary authenticated call ([./14](./14-web-app.md) §Onboarding, resolved 2026-09-01, [#45](https://github.com/rogierpennink/hydra/issues/45)); requires the one-time setup token ([./15](./15-packaging-and-operations.md)); atomically sets the password and returns a logged-in bearer token. Before setup completes, these two ops and the static bundle are all that is reachable; everything else is 401 | none (setup token) | `POST /setup/complete` |

*(Amended 2026-09-04, [#57](https://github.com/rogierpennink/hydra/issues/57).)* A secret's owner is a **pair** - `ownerKind` (`connection | plugin | runner | provider-instance | core`) and `ownerId` - so it is two path segments, not one; the earlier `/secrets/{owner}/{name}` could not carry both, and the AEAD's associated data is `<ownerKind>|<ownerId>|<name>` ([./13-security.md](./13-security.md) §2.1). **`ownerKind: core` is rejected with `validation`** on `secret.set` and `secret.delete`: core secrets are the controller's own key material (the Ed25519 signing key), and overwriting one would break controller identity and every runner's trust in it ([./13-security.md](./13-security.md) §1).

### settings

The user settings store: per-user preference and presentation state with a closed, schema-validated key set - `timezone`, `topics.order: string[]`, `notifications.muted: string[]` (`workflow:<id>` | `plugin:<id>` | `assistant:<id>`), `lastChecked.intake`, `lastChecked.checkin`, `lastChecked.notifications`, `onboarding.completedSteps: string[]` (the post-gate onboarding steps, [./14](./14-web-app.md) §Onboarding), `thread.instanceId`, `thread.model`, `thread.accessMode`, `thread.profileId` (the defaults for a new Thread, [./02-domain-model.md](./02-domain-model.md) Thread; [./14](./14-web-app.md) Settings > Threads). *(Added 2026-09-04, [#58](https://github.com/rogierpennink/hydra/issues/58).)* The store also holds `ui.threadRows`, the one display preference of the shell: `"meta"` (the shipped default) or `"plain"` ([./14](./14-web-app.md) Settings > Threads). Keyed by user id from day one so a later user concept is a `WHERE` clause. Not a domain entity ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) sections 4, 7.2, 8; [./12-assistants.md](./12-assistants.md) section 5.2).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `settings.read` | `{}` -> the settings object | `settings.read` | `GET /settings` |
| `settings.update` | a partial settings object; unknown keys rejected | `settings.write` | `PATCH /settings` |

### project, resource

Semantics: [./02-domain-model.md](./02-domain-model.md).

| Operation | Input | Grant | Route |
|---|---|---|---|
| `project.query` / `read` / `create` / `update` / `delete` | `{ name, description? }` (`description: null` on update removes it); `delete` is soft ([./02-domain-model.md](./02-domain-model.md) Deletion rules) | `project.read` / `project.write` | `/projects[/{id}]` |
| `resource.query` / `read` / `create` / `update` / `delete` | kind, remote (repo resources are unique on the canonical remote: `conflict`), `connectionId`, setup command, `.workspaceinclude` convention, `projectIds[]`; `delete` is `invalid_state` while a workspace referencing it is not `deleted \| lost` | `resource.read` / `resource.write` | `/resources[/{id}]` |

## 3. Actor stamping

### 3.1 Actor values

Every mutation through the service layer is stamped with an actor in the append-only event log ([./04-state-store.md](./04-state-store.md)):

```
actor: "user" | "session:<sessionId>" | "run:<runId>" | "plugin:<pluginId>"
```

- `user`: an API key or the web app's login token. Full parity; no profile applies.
- `session:<id>`: a session token. Bounded by the agent's permission profile (section 5).
- `run:<id>`: an action step executing inside a run (`task.create` on a cron tick). **Ungated**: the workflow was authored by the user, and its action steps run with the user's parity. A plugin action's `ctx.api` mutations are also `run:<id>`, with the `stepId` carried in the audit entry ([ADR 0026](../adr/0026-workflow-actions-may-call-the-public-api-as-the-run.md)). Agent steps are sessions and act as `session:<id>` under their own profile, which is what keeps a `worker` session from fanning out.
- `plugin:<id>`: a plugin calling the service layer in-process through the public-API client capability. **Ungated**: the user enabled the plugin and granted the capability ([./05-plugins.md](./05-plugins.md)).

An envelope's `actor` is `Actor | null`, and `null` means no actor caused the row: an ingested or cron event, and **`auth.login.failed`**, which is stamped `null` rather than `user` because nobody has been authenticated at the moment it is written. *(Amended 2026-09-04, [#59](https://github.com/rogierpennink/hydra/issues/59).)*

The event log is the audit log; there is no separate audit subsystem. Multi-user later widens the `user` value to a user id and never restructures the field. Security events and actor-stamped mutations keep 90-day retention ([./13-security.md](./13-security.md)).

The actor also appears wherever the domain records who did something: task provenance entries (`{ref?, eventId?, runId?, at, actor}`), the `actor` field of the event envelope (platform events such as `task.created` carry it there, never duplicated in the payload; [./08-events-and-connections.md](./08-events-and-connections.md)), permission requests, memory writes (a provenance line on writes distilled from tainted conversations).

The actor is derived from the credential or the in-process caller, never supplied by the caller: an API key resolves to `user`, a session token resolves to `session:<id>` (section 4), the run engine and the plugin host supply theirs.

### 3.2 Bound Notification actions

A decision Notification may bind an operation (for example "Start Bugfix" = `workflow.run` with workflow X and task Y; "Merge dev bumps" = `github.merge` over three PRs; "Event-sourced" = `session.input` replying to the session that asked). Pinned by ticket 37 ([ADR 0022](../adr/0022-proposing-is-not-doing.md)): **proposing is not doing.** The producer - a session, a run's `notify` step, a plugin or the core - declares the operation, and it is not checked against the producer's permission profile. The operation executes through `notification.act` when the user decides, as actor `user` under full parity; the event log entry records the notification id, its producer and, for a channel click, the connection it came through. Two guardrails replace the profile check: the `bindable` flag withholds the credential/secret/infra/permission families, `connection.manage` and bulk-destructive operations from non-core producers, and every operation's `describe(input)` line is rendered by the core on every answer. An answer may carry `operation: null` - decide and do nothing ("Dismiss" on an offer, "Neither" on an agent question). Record shape, execution, failure and channel-click rules: [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4.

## 4. Credentials

Two credential kinds resolve to the same actor-stamped API. Both are opaque random tokens, hashed in the controller database, resolved by one indexed lookup. No JWTs, no OAuth machinery for Hydra's own auth. Details: [./13-security.md](./13-security.md).

### 4.1 Session tokens

- **Minting:** at session start the controller mints a session token whose subject is the Session row. The token carries no claims of its own; the session's permission profile is reached by resolution `token -> session -> profile`: the profile id was copied onto the Session at spawn ([./02-domain-model.md](./02-domain-model.md) rule 9), so a Thread (no agent) resolves the same way.
- **Injection:** the runner injects `HYDRA_API_URL`, `HYDRA_TOKEN` and `HYDRA_SESSION=1` into the provider process environment. Nothing is written to runner disk.
- **Lifetime:** the token dies with the session. It is revoked when the session ends. A rotated assistant conversation continues in a fresh session and therefore under a fresh token; the old session's subscriptions migrate to the successor ([./12-assistants.md](./12-assistants.md)).
- **Latency constraint (hard rule):** resolving token to profile MUST NOT meaningfully add endpoint latency. One indexed lookup on the hashed token plus a cached or joined profile read satisfies it; a per-request chain of separate queries does not.
- **`HYDRA_SESSION=1`:** the marker that makes the CLI refuse file-held user credentials (section 6.2 and [./13-security.md](./13-security.md)). It defends against accidental fallback to the user's identity, not against a malicious local process; sessions are bare processes as the same OS user ([ADR 0003](../adr/0003-sessions-run-as-bare-processes.md)).

### 4.2 User API keys

Long-lived, opaque, revocable, minted in the web app or via `hydra login` (password in, token out, stored with mode 0600 in the CLI credential file; its location inside Hydra Home is **Open** in [./15-packaging-and-operations.md](./15-packaging-and-operations.md)). Always the user's identity; the user has unrestricted parity. The web app's bearer token comes from the same password login. Full auth model: [./13-security.md](./13-security.md).

## 5. Permission enforcement

Every Session carries a permission profile, copied from its Agent at spawn or from the `thread.profileId` setting for a Thread; its session token carries it. Enforcement happens in the service layer, so it binds HTTP callers and in-process session callers alike (run and plugin actors are ungated, section 3.1). Parity with the user is the ceiling, not the default.

Grant families and verbs, the operation-to-grant table's vocabulary, and the three shipped profiles (`assistant`, `worker`, `unrestricted`) are specified in [./13-security.md](./13-security.md) section 6; this document does not restate them. Section 2 names the grant beside every operation.

**Grants are unscoped in v1 (hard rule):** a grant on a family covers every entity in that family. `session.read` reads every session's transcript, including other assistants' conversations; "the sessions I spawned" is a filter (`actor: "me"`), not a boundary. Scoped grants are the post-v1 "finer grants inside a family" that [./13-security.md](./13-security.md) reserves room for. The sole v1 exception is `memory` (section 6.4): a session token's memory operations are pinned to that session's assistant.

**403 rule (hard rule):** a denied operation returns 403 and the response names the missing grant (section 1.5). The CLI surfaces that name verbatim so the agent can ask for exactly it.

**Escalation:** `permission.request { grant, reason, operation? }` is granted to every profile. It creates a Permission Request notification, and, when the caller is a session, registers a `{ kind: "request" }` subscription for that session as part of the same operation: nobody asks for a grant without wanting the answer, so the response carries `subscriptionId` and the CLI has nothing to teach. `operation` is optional and informational in v1: it lets the notification say "wants to run `connection.create` with {...}" instead of only naming a grant. The user decides `session` (overlay that dies with the session), `profile` (edit the agent's profile) or `deny`; the decision arrives as queued input and the agent retries the original call itself, so the actor stays `session:<id>`. A one-call outcome (`once`) is post-v1 (section 10). Escalation UX: [./13-security.md](./13-security.md) section 6.4.

## 6. The `hydra` CLI

### 6.1 One binary, three roles

`hydra` is the single self-contained binary ([ADR 0018](../adr/0018-hydra-ships-as-one-self-contained-binary.md)). `hydra serve` runs the controller, `hydra runner` runs a runner, and every other verb is an API client. Role subcommands (`serve`, `runner`, `runner join`, `service install`, `upgrade`, `login`, `promote`, export/import) are specified in [./15-packaging-and-operations.md](./15-packaging-and-operations.md). Mode isolation is CI-enforced: the runner entrypoint imports no controller packages.

The CLI never prompts interactively: onboarding lives wholly in the web app + API, and the runner join exchange is fully programmatic.

`hydra login` takes the password docker-style (resolved 2026-09-01, [#44](https://github.com/rogierpennink/hydra/issues/44)): `--password-stdin` is the canonical scripted form; on a TTY with no flag it prompts with echo off, **the one documented exception** to the never-prompts rule. The rule's purpose is that automation and the future desktop installer never wedge on a hidden prompt - `--password-stdin` preserves programmatic drivability, and the desktop app never runs `hydra login`. A bare `--password` flag does not exist (it would leak into `ps` and shell history).

### 6.2 Credential resolution

The CLI resolves its credential in this order:

1. `HYDRA_TOKEN` from the environment (with `HYDRA_API_URL`).
2. The CLI credential file, `~/.hydra/credentials.json` (written by `hydra login`; [./15-packaging-and-operations.md](./15-packaging-and-operations.md)).

When `HYDRA_SESSION=1` is set, step 2 is skipped: the CLI refuses file credentials outright. This is what makes the ops CLI and hydra-as-a-tool the same binary: identical commands, different credential.

### 6.3 Hydra-as-a-tool

Inside a session the `hydra` CLI is the whole of hydra-as-a-tool in v1. It ships built-in (not a plugin contribution), is uniform across Claude Code, Codex and pi, and needs no per-adapter wiring. The runner makes the binary available to the session process and materializes the skill (below) into it.

Rules the CLI follows on every subcommand:

- **Command = operation id.** `hydra <entity> <verb>` is `<entity>.<verb>` (section 1.3); `--help` on a command names the grant it requires. Filters and fields are flags (`--label bug --label ui --text crash`); ids are positional.
- **Agent-addressed help.** `--help` works at any position on every subcommand. Help text is written for an agent reading it mid-task, pi-style: what the command does, its arguments, what to do next. Static help plus 403s that name the missing grant are the two teaching channels.
- **Output.** Human-readable by default; `--json` on every command emits the contract's output schema (or error envelope) verbatim. Teaching lines ("subscribe with ...") exist only in the human rendering.
- **Progressive disclosure.** The skill is a minimal skeleton pointing at the CLI's own help; the CLI self-documents deeper levels.
- **One content channel (hard rule).** Where a command takes document content (`memory write`, `memory append`, task descriptions), content arrives on stdin and nowhere else. There is no inline content flag and no `--file` flag. [Assemble the v1 spec](https://github.com/rogierpennink/hydra/issues/21) delegated the pick between stdin-only and `--file` to the spec; the spec picks stdin-only. Rationale: a model mixed `--content` with a heredoc in the memory experiment ([Prototype: assistant memory interface](https://github.com/rogierpennink/hydra/issues/31)).
- **Never blocks.** No `--wait` on any command (section 8).
- **Pagination.** `query` commands page with `--limit` and `--cursor`; `--all` follows `nextCursor` to the end.

**The skill.** One provider-agnostic skill source describes the CLI; each provider adapter materializes it in that provider's native instruction format (Codex takes instructions only as `AGENTS.md` in the cwd, so a Codex session needs a cwd even when workspace-less). Materialization and provider-home isolation are specified in [./06-providers.md](./06-providers.md).

**Commands an agent uses most** (the full set is section 2):

- `hydra task query | read | create | update | delete`
- `hydra workflow run <id> | submit` (definition on stdin), `hydra run read | cancel`
- `hydra session spawn | input | read`, `hydra transcript query --text "..." [--assistant me]`
- `hydra subscription create <target>` (section 7), `hydra subscription query | cancel`
- `hydra notification create`
- `hydra memory list | read | search | write | append | delete` (section 6.4)
- `hydra permission request <grant> --reason "..."`

### 6.4 `hydra memory`

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

- **Registration** is the ordinary `subscription.create` operation (section 2), invoked from the session as `hydra subscription create <target>`, where `<target>` is `<kind>:<id>` (`run:r_3`, `session:s_12`, `request:pr_7`) or a bare External Ref (`github:pr:owner/repo#87`, taken as `ref:`).
- **Matching** runs in the single persisted pipeline like every subscription ([./08-events-and-connections.md](./08-events-and-connections.md)).
- **Delivery** is queued input on a turn boundary: rendered text plus the structured payload. Never steering by default. The agent's next turn opens with the match.
- **Lifetime:** dies with its holder session, or with `subscription.cancel`. On assistant rotation the subscriptions migrate to the successor session. No timeouts.
- **No polling surface for matches** in v1: there is no "any news?" operation; the event wakes the session. Listing *registrations* (`subscription.query`) exists for cancellation and for the session view.

Platform-auto detection ("this session opened PR #87, subscribe it") is not specified; explicit registration is the primitive.

## 8. The no-blocking rule

Every endpoint returns fast. No operation waits for a run, session, approval or permission decision to finish. Consequences:

- Spawn-type operations (`workflow.run`, `workflow.submit`, `session.spawn`) return a handle immediately, and the CLI's human rendering teaches the follow-up: `subscribe for updates: hydra subscription create run:r_3`.
- There is no `--wait` flag anywhere in the CLI.
- The canonical long-wait pattern for an agent is: start the thing, subscribe to it, end the turn. The matching event arrives as queued input and wakes the session.
- Permission escalation (section 5) subscribes the caller automatically; the assistant heartbeat is a cron trigger delivering queued input ([./12-assistants.md](./12-assistants.md)).

## 9. The ops CLI

The ops CLI is the same `hydra` binary under a user credential: `hydra login` writes the API key to the CLI credential file, after which every API verb runs as actor `user` with unrestricted parity. Commands are identical to what a session sees; only the credential and therefore the profile differ. Role subcommands are specified in [./15-packaging-and-operations.md](./15-packaging-and-operations.md); runner join in [./03-controller-and-runners.md](./03-controller-and-runners.md).

## 10. Post-v1

- **Hydra MCP server** - the public API exposed to sessions as typed MCP tools (t3-code-style self-injection). High on the revisit list. V1 keeps the `SessionSpec.mcpServers` passthrough ([./06-providers.md](./06-providers.md)) so it lands without redesign; the operation catalogue maps one-to-one onto tools.
- **Scoped grants** ("the sessions you spawned", "this project's tasks") - finer grants inside a family; v1 grants are unscoped except `memory`.
- **One-call permission outcome (`once`)** - a fourth decision on a Permission Request that carries an `operation`: an overlay row on the session with `remainingUses: 1`, consumed by the first successful call of the named operation, so "may I do X once?" is answerable without a session-wide grant. `permission.request` already carries the `operation` field this needs. Its CLI sugar (`hydra <failed command> --request "<reason>"`, packing the failed call into the request) lands with it.
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

- [Public API operation catalogue: naming, route style, grant families](https://github.com/rogierpennink/hydra/issues/38)
- [Agent-operates-system surface](https://github.com/rogierpennink/hydra/issues/16)
- [Security & secrets model](https://github.com/rogierpennink/hydra/issues/18)
- [Prototype: assistant memory interface](https://github.com/rogierpennink/hydra/issues/31)
- [Assemble the v1 spec](https://github.com/rogierpennink/hydra/issues/21) (handed-over constraints from #30 and #31)
- [Controller packaging & install story](https://github.com/rogierpennink/hydra/issues/24)
- [Web app architecture: observability-first, desktop-shell-ready](https://github.com/rogierpennink/hydra/issues/19)
- [Assistant design: memory, identity, channel binding](https://github.com/rogierpennink/hydra/issues/17)
- [Event & trigger ingress design](https://github.com/rogierpennink/hydra/issues/14)
- [Triage engine & user-set bounds](https://github.com/rogierpennink/hydra/issues/15)
- [Task model: shape, status axis, lifecycle, provenance](https://github.com/rogierpennink/hydra/issues/29)
- [Prototype: the Intake view](https://github.com/rogierpennink/hydra/issues/30)
- [Plugin architecture: API shape, loading, dogfooding](https://github.com/rogierpennink/hydra/issues/11)
- [Controller/runner architecture: registration, placement, scheduling](https://github.com/rogierpennink/hydra/issues/7)
- [Controller promotion & portability](https://github.com/rogierpennink/hydra/issues/10)
- [Workflow model: recipes, triggers, human gates](https://github.com/rogierpennink/hydra/issues/13)
- [Provider adapter interface](https://github.com/rogierpennink/hydra/issues/12)
- [Revisit Effect for the backend (#53)](https://github.com/rogierpennink/hydra/issues/53) (Effect, HttpApi as the contract, handler-free operations, request lifetime, neutral validation issues)

ADRs:

- [ADR 0031 - The backend is written on Effect](../adr/0031-the-backend-is-written-on-effect.md)

- [ADR 0021 - One operation vocabulary, coarse grants, explicit routes](../adr/0021-one-operation-vocabulary-coarse-grants-explicit-routes.md)
- [ADR 0013 - Agents operate Hydra through the public API, behind one contract with two transports](../adr/0013-agents-operate-hydra-through-the-public-api.md)
- [ADR 0020 - Assistant memory is reached only through the API](../adr/0020-assistant-memory-is-reached-only-through-the-api.md)
- [ADR 0017 - The web app is a static pure client of the public API](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)
- [ADR 0018 - Hydra ships as one self-contained binary](../adr/0018-hydra-ships-as-one-self-contained-binary.md)
- [ADR 0003 - Sessions run as bare processes](../adr/0003-sessions-run-as-bare-processes.md)
