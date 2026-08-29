# Public API and agent surface

Hydra has one public API. The web app, the `hydra` CLI, agents inside sessions, built-in workflow actions and plugins all operate the system through the same set of operations, defined once in a framework-free service layer and described once in a shared Zod contract package. HTTP is a thin proxy over that layer; the `hydra` CLI is a thin client over HTTP. Agents reach the API with a per-session token that carries their agent's permission profile; the user reaches it with an API key. Every mutation is stamped with its actor in the event log. No endpoint blocks: long waits are expressed as subscriptions whose matches arrive as queued input. This document pins the contract structure, the transports, the operation inventory at family level, the credential and attribution rules, the `hydra` CLI (including `hydra memory`), session subscriptions and the no-blocking rule. Rationale lives in [ADR 0013](../adr/0013-agents-operate-hydra-through-the-public-api.md) and [ADR 0020](../adr/0020-assistant-memory-is-reached-only-through-the-api.md).

## 1. Contract structure

### 1.1 Service layer

A framework-free TypeScript service layer defines every operation. "Framework-free" means: plain functions/classes with no dependency on an HTTP or RPC framework. Every consumer goes through it:

| Consumer | How it calls |
|---|---|
| HTTP routes | proxy: validate input schema, call service, serialize output schema |
| `hydra` CLI (agent and ops) | over HTTP |
| Web app | over HTTP (plus one WebSocket for live topics, see [./14-web-app.md](./14-web-app.md)) |
| Built-in workflow actions (`workflow.run`, `notify`, `task.create`, `task.update`, `task.query`) | in-process, same service layer |
| Plugins holding the public-API client capability | in-process, same service layer ([./05-plugins.md](./05-plugins.md)) |

Permission enforcement (section 5) and actor stamping (section 3) sit inside the service layer, so they bind every consumer identically.

**Parity guarantee (hard rule):** nothing is reachable in-process that is not reachable over HTTP. A service operation without an HTTP route is a defect. The WebSocket carries live-topic subscriptions only; every query and mutation stays on HTTP ([ADR 0017](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)).

### 1.2 Contract package

`packages/contract` holds a Zod input schema and output schema per operation. It is the pinned, expensive-to-retrofit asset. Consumers of the package: server-side validation, the `hydra` CLI, the web app (`client-core`, [./14-web-app.md](./14-web-app.md)), the plugin public-API client, and the workflow editor's schema-driven autocomplete.

OpenAPI is generated from the schemas with zod-openapi-style tooling. No framework derives routes; HTTP routes are hand-written proxies.

RPC-framework adoption (tRPC, oRPC, Effect RPC) is deliberately deferred post-v1 ([ADR 0013](../adr/0013-agents-operate-hydra-through-the-public-api.md)).

**Open:** the HTTP route style (resource paths with methods vs one RPC-style path per operation) and the error envelope shape beyond the 403 rule in section 5 are not pinned. The contract package's schemas are the source of truth either way.

**Open:** operation naming. Sources use three styles for the same nouns: grant families are plural (`tasks`, `sessions`), built-in action ids are singular dotted (`task.create`, `workflow.run`), CLI nouns are singular (`hydra task search`), and two ops are named in profile text as `sessions.spawn` / `workflows.run`. One canonical operation-id convention must be chosen and mapped onto all three surfaces.

### 1.3 Transports

Two transports, one contract:

1. **HTTP** on the controller's origin. Bearer authentication (`Authorization` header) with either credential kind (section 4). Plain HTTP on LAN/tailnet by default ([./13-security.md](./13-security.md)).
2. **The `hydra` CLI** (section 6): the same binary in every role, speaking HTTP to `HYDRA_API_URL`.

The web app additionally holds one WebSocket for live topics (subscriptions only), connected with a short-lived single-purpose ticket fetched over HTTP; bearer auth, no cookies. Details in [./14-web-app.md](./14-web-app.md).

A Hydra MCP server is not a v1 transport (section 10).

## 2. Operation inventory

The inventory is listed at family level. Families match the grant families of the permission model ([./13-security.md](./13-security.md)) where one exists. "Pinned" means a ticket named the operation; entity semantics belong to the linked document. Items marked **Open:** are operations an implementer clearly needs that no ticket pinned.

### tasks

Pinned: `search` (SQLite FTS over title + description, combined with structured filters over refs, labels, status, project), `read`, `create`, `update` (any field including status, priority, labels; provenance is append-only), `delete` (hard delete is allowed by the Task model; which grant verb covers it is settled in [./13-security.md](./13-security.md), the `worker` profile has read/create/update only). The built-in `task.query` action is exact-identity matching over refs/labels/status/project and is the structured-filter subset of `search`, reachable over HTTP by the parity rule. Semantics: [./09-tasks.md](./09-tasks.md).

### runs

Pinned: create a run directly (manual run of a workflow, supplying declared inputs, no event), read the run record (frozen plan, inputs, trigger event, per-step records, failure reason, stored triage verdict), re-run (mode `replay` or `re-stamp`, default `re-stamp`), cancel (a forever-waiting run is visible and cancelable). Semantics: [./07-workflows.md](./07-workflows.md).

### workflows

Pinned: create/read/update/delete workflow definitions (declarative data; editing never affects in-flight runs), `workflows.run` (start a run, the same operation the built-in `workflow.run` action calls), trigger pause/resume for a tripped spawn bound (resume optionally discards the held backlog), list the held events of a paused trigger. Semantics: [./07-workflows.md](./07-workflows.md), breaker semantics in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md).

### sessions

Pinned: `sessions.spawn` (start a session: agent, prompt, provider instance, model selection, access mode, workspace spec or none), send input (opens a turn on an idle session, steers a busy one; result reports `opened | steered`), queued input edit/cancel (controller-owned queue), interrupt, stop, respond to an approval request (`allow | allow_always | deny | cancel`), read the normalized transcript, list sessions, continue a session (`resume | fork`). Assistants additionally recall their own past conversations through FTS over their own transcripts (pinned by [Assistant design](https://github.com/rogierpennink/hydra/issues/17)). Session semantics: [./06-providers.md](./06-providers.md), [./12-assistants.md](./12-assistants.md).

**Open:** whether transcript recall is a `sessions` search operation with an assistant-scoped filter or a separate assistant-family operation.

### subscriptions

Pinned: register a session-held subscription (section 7). Runs' subscriptions are instantiated by the controller from signal triggers and have no API surface.

**Open:** list and cancel for session-held subscriptions, and the shape of the registration input (the one pinned example is the target form `run:1234`; whether external refs, event kinds, or CEL correlation expressions are accepted is not pinned).

### notifications

Pinned: create (`notify`, the built-in action and the op behind it), list/read (the in-app center and the check-in needs-you list are the same record stream), `notifications.act` (decide a decision notification; a decision may carry a bound operation, see section 3.2). Record and router: [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md).

### events

Pinned: emit a synthetic event that flows the persisted pipeline (the `manual` source; used to test triggers and for agents to poke subscriptions), read the event log filtered by connection joined to its effect rows (the Intake per-connection events view, verdict-stamped, held events included). Pipeline: [./08-events-and-connections.md](./08-events-and-connections.md).

### connections

Two grants: `connections.manage` (create, edit, delete, set credentials, set labels including the default topic, read status) and `connections.use` (act via a connection: plugin-contributed actions such as `github.merge` name the connection they act as). Semantics: [./08-events-and-connections.md](./08-events-and-connections.md).

### runners (grant family `infra`)

Pinned: mint a single-use join token, list runners with state and capabilities, set user labels, override `maxConcurrentSessions`, drain, retire, force-retire an unreachable runner (explicit confirmation), trigger a remote runner upgrade over the runner WebSocket, on-demand capability probe of a runner for a provider instance. Semantics: [./03-controller-and-runners.md](./03-controller-and-runners.md), [./06-providers.md](./06-providers.md).

### workspaces

No ticket pinned workspace operations. Workspaces are provisioned as a side effect of session and run placement.

**Open:** which direct workspace operations exist (list, read, provision a primary workspace, delete/teardown, mark lost) and which grant family covers them (the assistant profile "denies workspaces", which implies a grant exists).

### agents and assistants

Pinned: create/read/update/delete agents (prompt, provider, capabilities, permission profile), create/read/update/delete assistants (an agent plus channel bindings plus memory), manage channel bindings, edit the heartbeat standing prompt and enable state, delete an assistant (confirmed action; memory dies with it). Semantics: [./12-assistants.md](./12-assistants.md).

**Open:** the grant family for agent and assistant management (not among the ten named families).

### memory (assistant-scoped)

Pinned: `list`, `read`, `search`, `write`, `append`, `delete`. Section 6.4 specifies them. The web app edits the same documents through the same operations.

Grant: the provisional `memory` family, see [./13-security.md](./13-security.md) (ticket 18 names ten families without it; ADR 0020 makes memory an API surface: an assistant session writes its own memory, a session under the `worker` profile never reaches it, the user reaches every assistant's memory).

**Open:** the `memory` grant family is provisional; its verbs and its place in the shipped profiles are settled in [./13-security.md](./13-security.md).

### permissions

Pinned: `permissions.request` (granted to every profile; creates a Permission Request notification), decide a request (`this session only` or `add to profile`), create/read/update/delete permission profiles, assign a profile to an agent. Content: [./13-security.md](./13-security.md).

### admin

Pinned: plugin enable/disable and config (config forms generated from manifest schemas; change = deactivate + reactivate), secrets (owner-scoped, references only in responses, grant `secrets`), user credentials (login, API key mint/revoke, WebSocket ticket, grant `credentials`), first-run setup (the one-time setup URL drives onboarding wholly through web app + API), promotion (mint promotion token, export/import bundle), update notifications, provider instances and their capability snapshots. Semantics: [./05-plugins.md](./05-plugins.md), [./13-security.md](./13-security.md), [./15-packaging-and-operations.md](./15-packaging-and-operations.md).

### projects and resources

No ticket pinned operations for Project or Resource management (create, link resources and their Connection, per-resource setup command, `.workspaceinclude`).

**Open:** the project/resource operation set and its grant family.

## 3. Actor stamping

### 3.1 Actor values

Every mutation through the service layer is stamped with an actor in the append-only event log ([./04-state-store.md](./04-state-store.md)):

```
actor: "user" | "session:<sessionId>"
```

The event log is the audit log; there is no separate audit subsystem. Multi-user later widens the actor field (a user id instead of the constant `user`) and never restructures it. Security events and actor-stamped mutations keep 90-day retention ([./13-security.md](./13-security.md)).

The actor also appears wherever the domain records who did something: task provenance entries (`{ref?, eventId?, runId?, at, actor}`), the `actor` field of the event envelope (platform events such as `task.created` carry it there, never duplicated in the payload; [./08-events-and-connections.md](./08-events-and-connections.md)), permission requests, memory writes (a provenance line on writes distilled from tainted conversations).

The actor is derived from the credential, never supplied by the caller: an API key resolves to `user`, a session token resolves to `session:<id>` (section 4).

**Open:** (owned here) the actor value for mutations made in-process by workflow action steps (`task.create` on a cron tick, with no session and no user present) and by plugins holding the public-API client, and which grants bound them. The two-value set above does not cover them; the run id is the obvious candidate but nothing pins it. Widening the enum is allowed, restructuring is not.

### 3.2 Bound Notification actions

A decision Notification may bind an operation (for example "Start Bugfix" = `workflows.run` with workflow X and task Y; "Merge dev bumps" = `github.merge` over three PRs). The operation executes through `notifications.act` when the user decides, so the actor is `user`. The operation was authored by an agent. Declaration, validation and execution of bound actions are the spec's consolidated proposal in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md), not a pinned decision.

**Open:** authorisation of agent-authored bound operations: whether the bound operation must have been within the authoring session's permission profile at authoring time, or only within the user's (unrestricted) parity at click time. The Intake handoff to [Assemble the v1 spec](https://github.com/rogierpennink/hydra/issues/21) names this as needing an answer.

## 4. Credentials

Two credential kinds resolve to the same actor-stamped API. Both are opaque random tokens, hashed in the controller database, resolved by one indexed lookup. No JWTs, no OAuth machinery for Hydra's own auth. Details: [./13-security.md](./13-security.md).

### 4.1 Session tokens

- **Minting:** at session start the controller mints a session token whose subject is the Session row. The token carries no claims of its own; the agent's permission profile is reached by resolution `token -> session -> agent -> profile`.
- **Injection:** the runner injects `HYDRA_API_URL`, `HYDRA_TOKEN` and `HYDRA_SESSION=1` into the provider process environment. Nothing is written to runner disk.
- **Lifetime:** the token dies with the session. It is revoked when the session ends. A rotated assistant conversation continues in a fresh session and therefore under a fresh token; the old session's subscriptions migrate to the successor ([./12-assistants.md](./12-assistants.md)).
- **Latency constraint (hard rule):** resolving token to profile MUST NOT meaningfully add endpoint latency. One indexed lookup on the hashed token plus a cached or joined profile read satisfies it; a per-request chain of separate queries does not.
- **`HYDRA_SESSION=1`:** the marker that makes the CLI refuse file-held user credentials (section 6.2 and [./13-security.md](./13-security.md)). It defends against accidental fallback to the user's identity, not against a malicious local process; sessions are bare processes as the same OS user ([ADR 0003](../adr/0003-sessions-run-as-bare-processes.md)).

### 4.2 User API keys

Long-lived, opaque, revocable, minted in the web app or via `hydra login` (password in, token out, stored with mode 0600 in the CLI credential file; its location inside Hydra Home is **Open** in [./15-packaging-and-operations.md](./15-packaging-and-operations.md)). Always the user's identity; the user has unrestricted parity. The web app's bearer token comes from the same password login. Full auth model: [./13-security.md](./13-security.md).

## 5. Permission enforcement

Every agent carries a permission profile; its session tokens inherit it. Enforcement happens in the service layer, so it binds HTTP callers and in-process callers alike. Parity with the user is the ceiling, not the default.

Grant families (verbs per family are read/write/run-style): the ten pinned by ticket 18 (`tasks`, `workflows`, `sessions`, `notifications`, `subscriptions`, `connections.use`, `connections.manage`, `infra`, `secrets`, `credentials`) plus the provisional `memory` family. Finer grants may land inside a family later without breaking existing profiles. The family table, verbs, and the three shipped profiles (`assistant`, `worker`, `unrestricted`) are specified in [./13-security.md](./13-security.md); this document does not restate them.

**403 rule (hard rule):** a denied operation returns 403 and the response names the missing grant. The CLI surfaces that name verbatim so the agent can ask for exactly it.

**Escalation:** `permissions.request <grant>` is granted to every profile. It creates a Permission Request notification. The user approves for this session only or bakes the grant into the profile. The agent learns the outcome through a subscription and retries; the request never blocks. Escalation UX: [./13-security.md](./13-security.md).

**Open:** whether `permissions.request` responses teach the follow-up subscription the way spawn-type operations do (section 8), and what the subscription target for a permission request is.

## 6. The `hydra` CLI

### 6.1 One binary, three roles

`hydra` is the single self-contained binary ([ADR 0018](../adr/0018-hydra-ships-as-one-self-contained-binary.md)). `hydra serve` runs the controller, `hydra runner` runs a runner, and every other verb is an API client. Role subcommands (`serve`, `runner`, `runner join`, `service install`, `upgrade`, `login`, `promote`, export/import) are specified in [./15-packaging-and-operations.md](./15-packaging-and-operations.md). Mode isolation is CI-enforced: the runner entrypoint imports no controller packages.

The CLI never prompts interactively: onboarding lives wholly in the web app + API, and the runner join exchange is fully programmatic.

**Open:** how `hydra login` receives the password under the never-prompts rule (flag, stdin, or an explicit exception for this one command).

### 6.2 Credential resolution

The CLI resolves its credential in this order:

1. `HYDRA_TOKEN` from the environment (with `HYDRA_API_URL`).
2. The CLI credential file (written by `hydra login`; location **Open** in [./15-packaging-and-operations.md](./15-packaging-and-operations.md)).

When `HYDRA_SESSION=1` is set, step 2 is skipped: the CLI refuses file credentials outright. This is what makes the ops CLI and hydra-as-a-tool the same binary: identical commands, different credential.

### 6.3 Hydra-as-a-tool

Inside a session the `hydra` CLI is the whole of hydra-as-a-tool in v1. It ships built-in (not a plugin contribution), is uniform across Claude Code, Codex and pi, and needs no per-adapter wiring. The runner makes the binary available to the session process and materializes the skill (below) into it.

Rules the CLI follows on every subcommand:

- **Agent-addressed help.** `--help` works at any position on every subcommand. Help text is written for an agent reading it mid-task, pi-style: what the command does, its arguments, what to do next. Static help plus 403s that name the missing grant are the two teaching channels.
- **Output.** Human-readable by default; `--json` on every command emits the contract's output schema.
- **Progressive disclosure.** The skill is a minimal skeleton pointing at the CLI's own help; the CLI self-documents deeper levels.
- **One content channel (hard rule).** Where a command takes document content (`memory write`, `memory append`, task descriptions), content arrives on stdin and nowhere else. There is no inline content flag and no `--file` flag. [Assemble the v1 spec](https://github.com/rogierpennink/hydra/issues/21) delegated the pick between stdin-only and `--file` to the spec; the spec picks stdin-only. Rationale: a model mixed `--content` with a heredoc in the memory experiment ([Prototype: assistant memory interface](https://github.com/rogierpennink/hydra/issues/31)).
- **Never blocks.** No `--wait` on any command (section 8).

**The skill.** One provider-agnostic skill source describes the CLI; each provider adapter materializes it in that provider's native instruction format (Codex takes instructions only as `AGENTS.md` in the cwd, so a Codex session needs a cwd even when workspace-less). Materialization and provider-home isolation are specified in [./06-providers.md](./06-providers.md).

**Pinned command families** (the verbs the tickets named; the full set follows the inventory in section 2):

- `hydra task search | read | create | update`
- `hydra events subscribe <target>` (section 7)
- `hydra memory list | read | search | write | append | delete` (section 6.4)
- `hydra permissions request <grant>`

### 6.4 `hydra memory`

Assistant memory is reached only through these operations ([ADR 0020](../adr/0020-assistant-memory-is-reached-only-through-the-api.md)); nothing is materialized on runner disk and assistant sessions stay workspace-less. Memory tiers (`core` plus named topics), the two-line topic header, the size and count caps, injection at session start and rotation are specified in [./12-assistants.md](./12-assistants.md); the operations and their enforcement are specified here.

| Operation | Behaviour |
|---|---|
| `list` | Returns the index: per document, name, size and gist. This is the same index injected at session start. |
| `read <name>` | Returns the full body of `core` or one topic. |
| `search <words>` | Searches across the assistant's memory documents and returns matches. The API's substitute for `grep`. |
| `write <name>` | Replaces the whole body of `core` or a topic; creates the topic if absent. Content on stdin. |
| `append <name>` | Appends content to an existing document. Content on stdin. |
| `delete <name>` | Removes a topic. |

Enforcement at the write seam (hard rules):

- A `write` or `append` whose resulting size exceeds the document's cap fails. The error names the current size and the cap so the agent can consolidate. The over-cap write is a visible event, never a silent truncation.
- A `write` that would exceed the topic count cap fails, naming the topic count and its cap.
- Every write is actor-stamped (section 3). Writes distilled from tainted conversation content carry a one-line provenance marker inside the document ([./13-security.md](./13-security.md)).

Scope: operations act on the memory of the assistant whose session holds the token. The user reaches every assistant's memory through the same operations by naming the assistant (the parameter is the spec's naming, not pinned); the web app's memory view is a client of them.

**Open:** whether `delete core` is refused (core is seeded and always injected; the tickets say nothing about deleting it).

**Open:** whether `write` validates the two-line topic header (`# name`, `> gist`) and rejects a nonconforming body, or accepts any body and derives the gist leniently.

**Open:** the matching semantics of `memory search` (SQLite FTS like task search, or substring) and whether it searches `core` as well as topics.

**Open:** whether v1 applies a shrink guard on `write` (reject a write that shrinks a document by more than N% unless confirmed). [Prototype: assistant memory interface](https://github.com/rogierpennink/hydra/issues/31) recorded it as the cheaper v1-shaped alternative to version history after a cap rejection led a model to drop fifteen unique decisions in one rewrite; it was put on the record, not adopted.

## 7. Session subscriptions

A session may hold Subscriptions directly, without a run. Two use cases justify it: mid-session artifacts (an agent opens PR #87 and subscribes to its CI) and assistants (long-lived, no run to hold claims).

- **Registration** is an ordinary API operation, invoked from the session via `hydra events subscribe <target>` (pinned example: `hydra events subscribe run:1234`).
- **Matching** runs in the single persisted pipeline like every subscription ([./08-events-and-connections.md](./08-events-and-connections.md)).
- **Delivery** is queued input on a turn boundary: rendered text plus the structured payload. Never steering by default. The agent's next turn opens with the match.
- **Lifetime:** dies with its holder session. On assistant rotation the subscriptions migrate to the successor session. No timeouts.
- **No polling surface** in v1: there is no "check my subscriptions" operation. The event wakes the session.

Platform-auto detection ("this session opened PR #87, subscribe it") is not specified; explicit registration is the primitive.

**Open:** see the subscriptions row in section 2 for the unpinned target vocabulary and list/cancel operations.

## 8. The no-blocking rule

Every endpoint returns fast. No operation waits for a run, session, approval or permission decision to finish. Consequences:

- Spawn-type operations (`workflows.run`, `sessions.spawn`) return a handle immediately, and the response text teaches the follow-up: `subscribe for updates: hydra events subscribe run:1234`.
- There is no `--wait` flag anywhere in the CLI.
- The canonical long-wait pattern for an agent is: start the thing, subscribe to it, end the turn. The matching event arrives as queued input and wakes the session.
- The same pattern covers permission escalation (section 5) and the assistant heartbeat (a cron trigger delivering queued input, [./12-assistants.md](./12-assistants.md)).

## 9. The ops CLI

The ops CLI is the same `hydra` binary under a user credential: `hydra login` writes the API key to the CLI credential file, after which every API verb runs as actor `user` with unrestricted parity. Commands are identical to what a session sees; only the credential and therefore the profile differ. Role subcommands are specified in [./15-packaging-and-operations.md](./15-packaging-and-operations.md); runner join in [./03-controller-and-runners.md](./03-controller-and-runners.md).

## Post-v1

- **Hydra MCP server** - the public API exposed to sessions as typed MCP tools (t3-code-style self-injection). High on the revisit list. V1 keeps the `SessionSpec.mcpServers` passthrough ([./06-providers.md](./06-providers.md)) so it lands without redesign.
- **RPC-framework adoption** (tRPC, oRPC, Effect RPC) - deriving routes and clients from the contract. V1 keeps the contract package as the pinned asset so derivation can be added later with evidence.
- **Read-only memory materialization on runners** (memory as files for native grep, writes still via API) - a pure read convenience addable without touching the write path.
- **Memory version history** - ruled post-v1; the retrofit is additive (history table beside the live document). The write seam already makes every rewrite a visible actor-stamped event.
- **Platform-auto subscription detection** - the controller subscribing a session to artifacts it created; explicit registration stays the primitive.
- **Multi-user** - widens the actor field to a user id; no restructuring.
- **Per-agent git identity** - a policy addition on unchanged plumbing ([./13-security.md](./13-security.md)).

## Sources

Tickets:

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

ADRs:

- [ADR 0013 - Agents operate Hydra through the public API, behind one contract with two transports](../adr/0013-agents-operate-hydra-through-the-public-api.md)
- [ADR 0020 - Assistant memory is reached only through the API](../adr/0020-assistant-memory-is-reached-only-through-the-api.md)
- [ADR 0017 - The web app is a static pure client of the public API](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)
- [ADR 0018 - Hydra ships as one self-contained binary](../adr/0018-hydra-ships-as-one-self-contained-binary.md)
- [ADR 0003 - Sessions run as bare processes](../adr/0003-sessions-run-as-bare-processes.md)
