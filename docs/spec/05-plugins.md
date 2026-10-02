# Plugins

Hercule has one plugin concept. A plugin is a container that requests plugin capabilities in a coarse manifest and registers contributions, in code, into four fixed extension points: provider, channel, event source, workflow action. Loading is two-phase: a pure `register()` builds a persisted contribution catalog for every installed plugin, and `activate()` starts real machinery only for enabled plugins. Plugins program against a capability-sliced host API and never touch controller internals; their durable state is a namespaced KV and a scoped secrets service inside the controller database. In v1 every plugin is compiled into the controller and runs in-process; runner-side provider execution is built-in code written plugin-shaped. Channels, event sources, providers and their workflow actions are all built as plugins in v1 (dogfooding), so an internal plugin and a future third-party plugin differ only in trust, not in kind. Rationale: [ADR 0006](../adr/0006-plugins-request-capabilities-and-register-contributions-in-code.md).

## 1. The plugin concept

- There are no typed plugin kinds ("channel plugin", "provider plugin"). A plugin is a container; what it *is* follows from what it contributes.
- One plugin may contribute several things that share one configuration and one set of credentials. The `github` plugin contributes an event source and workflow actions; the `gmail` plugin likewise.
- **Plugin capabilities** are what a plugin may *call*: named slices of the host API requested in the manifest and granted at load (section 5). **Contributions** are what a plugin *provides*: named things registered into extension points through the granted capability APIs (section 4). The manifest lists capabilities, never contributions.
- The v1 extension points are fixed at four: **provider**, **channel**, **event source**, **workflow action**. Plugins cannot define new extension points. The notification sink is not a fifth point: it is an optional facet of a channel contribution (section 11).
- A catalog contribution is identified by its **qualified id**, `<pluginId>/<word>`: the plugin declares the bare word, the host mints the qualified form at registration, and that is the identity everywhere downstream ([ADR 0034](../adr/0034-a-catalog-contribution-is-identified-by-its-qualified-id.md)). It holds for every extension point - connection types (`github/github`), workflow actions (`github/pr.merge`), channel contributions (`discord/discord`), provider definitions - so the dotted plugin prefix the tickets use (`github.merge`) is retired. The word may contain dots (`pr.merge`) but never a `/`. Built-in core actions are operations and keep the operation id (`task.create`, [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 1); event kinds are dotted, with a namespace before the first dot, not by this rule (`github.issue.opened`); the namespace is not always the event's source (`task.created` has the source `platform`). A workflow step names an action contribution by id; an assistant binding names a channel contribution by id.
- Everything a plugin defines that names things outside Hercule is namespaced by the plugin: connection types (declared `gmail`, `github`; identified `gmail/gmail`, `github/github`) and External Ref canonicalization (`github:issue:owner/repo#42`) are owned by the defining plugin ([ADR 0010](../adr/0010-external-accounts-are-core-owned-connections.md); Task provenance in [./09-tasks.md](./09-tasks.md)).

## 2. Manifest

The manifest is deliberately coarse. It carries exactly four things:

| Part | Content |
|---|---|
| Identity | plugin id (stable, used as the namespace for KV, secrets, and the qualified ids of connection types and contributions), display name |
| `hostApi` | one integer naming the core host contract the plugin was built against; checked at load |
| Plugin capabilities | the list of capability names the plugin requests, scope-style ("the channels API", "the notifications API") |
| Config schema | an Effect Schema for the plugin's own configuration, persisted as the JSON Schema derived from it; the web app generates the plugin's settings form from that ([./14-web-app.md](./14-web-app.md)) |

```ts
interface PluginManifest {
  id: string                 // "github", "gmail", "discord", "slack", "claude-code", "codex", "pi"
  displayName: string
  hostApi: number            // core host contract version integer
  capabilities: string[]     // requested plugin capabilities, e.g. ["event-sources", "workflow-actions", "connections", "events", "notifications", "secrets", "kv"]
  configSchema: Schema       // plugin-level configuration, in Effect Schema
}
```

*(Amended 2026-09-06, [#63](https://github.com/theagenticage/hercule/issues/63).)* `configSchema` is an **Effect Schema**, not a JSON Schema, which is what section 5's "authored in Effect Schema, persisted as JSON Schema" always said; this snippet was the stale spelling. The host derives the JSON Schema from it and persists that, and it decodes the stored config against the live schema before handing it to `activate()` - neither is possible from JSON alone. It is the one thing in the manifest that is not plain data, which is why the manifest is static data shipped with the package rather than a serializable record. The derivation refuses shapes the generated form cannot render: the supported set is a flat struct of string, number, integer, boolean, enum and array-of-string properties, and a plugin whose schema goes beyond it is refused at load with the reason shown in Settings > Plugins.

Rules:

- No contribution appears in the manifest. A VS Code-style declarative contribution list was rejected ([ADR 0006](../adr/0006-plugins-request-capabilities-and-register-contributions-in-code.md)).
- The manifest is static data shipped with the plugin package; the controller reads it before running any plugin code.
- The tickets pin the four parts and the name `hostApi`; the other field names above are this spec's spelling and MUST be used consistently.

## 3. Loading: `register()` and `activate()`

### Packaging and registry

- Each plugin is an npm workspace package in the monorepo at `plugins/<name>` with its own `package.json` (repo layout in [./14-web-app.md](./14-web-app.md) and [./15-packaging-and-operations.md](./15-packaging-and-operations.md)).
- The controller loads plugins from **one explicit static registry file** that imports each plugin package. There is no discovery, no dynamic loading, and no install step in v1: installed means compiled into the controller binary. Extracting a plugin later is moving a folder.
- The runner entrypoint imports no plugin host and no plugin package (CI-enforced mode isolation, [./15-packaging-and-operations.md](./15-packaging-and-operations.md)).

### Two hooks

Every plugin exports a manifest and two hooks.

```ts
interface Plugin {
  manifest: PluginManifest
  register(host: RegistrationHost): Effect<void>   // pure: declares contributions only
  activate(host: ActivationHost): Effect<Deactivate>    // starts machinery; returns its own teardown
}
type Deactivate = Effect<void>
```

*(Amended 2026-09-06, [#63](https://github.com/theagenticage/hercule/issues/63).)* **`register` returns an `Effect` like every other hook**, as section 5's "every hook and capability method returns an `Effect`" requires; the `void` above was the stale spelling. Pure still means what it says here - no I/O, no timers, no config, no state - and the Effect is what carries a registration's typed failure, so a plugin that hands the host something the catalog will not take fails its own registration instead of taking the boot down with it. Both hooks fail with the plugin's own `PluginError`, and the capability methods a plugin calls from inside them are Effects too.

`register()`:

- Is pure and cheap: no I/O, no timers, no network, no reads of plugin config or state. It only declares contributions by calling the registration surface of the capabilities the plugin was granted (`host.channels.register(...)`, `host.workflowActions.register(...)`, `host.providers.register(definition)`, `host.eventSources.register(...)`, `host.connections.registerType(...)`).
- Runs at every controller boot for **every installed plugin, enabled or not**. Its output is the **contribution catalog**, persisted in the controller database.
- Because it runs without config and regardless of enabled state, a contribution's identity and schemas MUST NOT depend on plugin configuration.

`activate()`:

- Runs only for enabled plugins, after the whole catalog exists. It receives the decoded plugin config and the runtime surfaces of the granted capabilities (emit events, emit notifications, read connections, KV, secrets, the public-API client if requested).
- Starts real machinery: opens channel connections, starts one ingest loop per connection for each event source, and so on.
- Returns a deactivation function that stops everything it started. Deactivate-then-activate is the only reconfiguration protocol (section 8).

### The catalog is the source of truth

Consumers of contributions read the persisted catalog, never the live plugin object:

- Workflow validation resolves action ids against the catalog ([./07-workflows.md](./07-workflows.md)).
- UI pickers (action steps, channel bindings, provider selection, connection types) list from the catalog.
- "What does this disabled plugin offer" is answered from the catalog; the catalog records for each contribution which plugin owns it and whether that plugin is currently enabled.

Built-in contributions live in the **same catalog**. The five built-in workflow actions (~~`workflow.run`~~ `run.start`, `notification.create`, `task.create`, `task.update`, `task.query`; and `wait`, the one that is not an operation *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))*) are registered into the workflow-action extension point at boot, owned by `core`, ids unprefixed and equal to their operation ids ([./07-workflows.md](./07-workflows.md) section 8). Validation and pickers read one list; the catalog's owner column distinguishes core from plugin, and core contributions are never disabled.

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* Three built-in actions are registered now: `task.create`, `task.update` and `task.query` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79): and `workflow.run`, which joined with its operation)*. ~~`workflow.run` and `notification.create` join in the tickets that add their operations ([#79](https://github.com/theagenticage/hercule/issues/79), [#84](https://github.com/theagenticage/hercule/issues/84)), because a built-in action is its operation and cannot exist before it.~~ `notification.create` joins in the ticket that adds its operation ([#84](https://github.com/theagenticage/hercule/issues/84)), because a built-in action is its operation and cannot exist before it. *(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* `workflow.run` is now `run.start`, the operation that replaced `workflow.run` and `workflow.submit`, and `wait` joined as a fifth registered action: it pauses a run and has no operation ([./07-workflows.md](./07-workflows.md) section 8). Each is a catalog row owned by `core`, beside the plugins' rows, with the operation's contract input as its input schema ([./07-workflows.md](./07-workflows.md) section 8 names the two that differ). **The plugin id `core` is reserved**: the controller refuses to boot with a plugin of that id in the registry, because a plugin row with that id would decide whether the built-in contributions are enabled.

### Where plugins run

- In-process, **controller-only**, in v1. There is no plugin host on runners.
- Runner-side provider execution (spawning harness CLIs, speaking the Agent SDK, app-server and pi SDK protocols) is **built-in runner code written plugin-shaped**: one narrow `ProviderAdapter` per provider, no cross-provider leakage, keyed by `providerId` to the `ProviderDefinition` the plugin registered on the controller ([./06-providers.md](./06-providers.md)). It is lifted into the plugins post-v1 once three real providers have taught the hooks. *(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257): workspace actions, such as `git.commit`, are built-in runner code written plugin-shaped in the same way, [ADR 0035](../adr/0035-an-action-declares-where-it-runs.md).)*
- The host API is shaped for later isolation and third-party loading: dependencies are handed in through the host, never imported from the controller; nothing crosses the host API that cannot be serialized (no live DB handles, no controller service objects, no functions in either direction other than the hooks themselves). A plugin that follows these rules runs unchanged out-of-process later.

## 4. Extension points and contribution interfaces

For each extension point this section states what crosses the plugin boundary. Behaviour lives in the neighbour documents.

### 4.1 Provider

The contribution is the act of registering a `ProviderDefinition`: the provider's static self-description (identity, `supportsMultipleInstances`, per-instance `configSchema`, `defaultConfig`, and the `DeclaredCapabilities` block of static facts; `defaultConfig` is a plain JSON value rather than a function, 2026-09-06, [#63](https://github.com/theagenticage/hercule/issues/63)). The interface, including `DeclaredCapabilities`, is pinned in [./06-providers.md](./06-providers.md) section 2 and is not copied here.

- A provider instance is definition plus decoded per-instance config; the `instanceId`, not the provider id, is the routing key. What the instance config holds and where paths are resolved is stated in [./06-providers.md](./06-providers.md) section 2.1, including its Conflict line on runner paths versus the no-paths rule of [./04-state-store.md](./04-state-store.md).
- The runner-side `ProviderAdapter` (probe plus five session methods plus `listSessions`, one normalized event stream) is built-in in v1 and is selected by `providerId`. Capability snapshots, access-mode fallback, the event taxonomy and session specs are all in [./06-providers.md](./06-providers.md).
- A provider plugin needs no host services beyond registration in v1: authentication is the harness's own login on the runner. Secret-valued instance config entries are not plugin-owned secrets (section 7); their owner kind in the secrets table is Open in [./06-providers.md](./06-providers.md).

### 4.2 Channel

A channel contribution makes one chat platform reachable. The TypeScript interface (`ChannelContribution`, `ChannelHost`, `ChannelHandle`, the inbound and outbound message shapes, the sink facet) is pinned in [./12-assistants.md](./12-assistants.md) section 11.1; the obligations at the boundary:

- **Identity**: the contribution's qualified id (`discord/discord`), the connection type it services (a Discord bot-token connection; a Slack connection holding a bot token and an app-level token), and its **scope model** - the container levels, outermost first, for group containers and DMs (Discord `guild > channel > thread` / `user`; Slack `channel > thread` / `user`). The scope model is catalog data: the binding editor and the core's binding matcher read it, so bindings validate while the plugin is disabled.
- **Inbound**: for each live connection, deliver every observed message to the core through `host.message()` with its container key (`{ kind, path }` of platform ids), the platform sender identity (plugin-formatted identity key, display name, bot and self flags), the text normalized to markdown, attachment links, and the mention facts it can see (explicit platform mention, reply-to-self). The core, not the plugin, resolves bindings, evaluates wake rules and roles, stores conversation messages and decides what is context and what is instruction ([./12-assistants.md](./12-assistants.md) section 4). Inbound chat messages are not pipeline Events ([ADR 0023](../adr/0023-chat-messages-are-conversation-input-not-events.md)).
- **Outbound**: `send` a markdown message into a named container on the core's request, converting markup and splitting at the platform limit; `activity` renders a working indicator (Discord typing, Slack reaction). Outbound sends leave the core through outbox rows with retry ([./04-state-store.md](./04-state-store.md)).
- **Conversation container**: the plugin defines how its platform's containers map to Hercule Conversations (Discord channel, thread or DM; Slack thread, DM or group DM - a top-level Slack mention opens a thread). One container = one Conversation, never merged ([ADR 0014](../adr/0014-assistants-remember-through-distilled-memory-not-merged-sessions.md)).
- **Notification sink (optional)**: deliver a Notification rendered by the core to a container on a connection, render its bound actions as native buttons, report clicks through `host.click()` and edit the message on `resolved()`. See section 11 and [./12-assistants.md](./12-assistants.md) section 11.6.

### 4.3 Event source

An event-source contribution ingests external facts ([ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)). The interface is pinned here; pipeline behaviour, kind rosters and cadence numbers are owned by [./08-events-and-connections.md](./08-events-and-connections.md).

```ts
interface EventSourceContribution {
  id: string                                   // the bare word "github", "gmail"; identified as "github/github"
  connectionType: string                       // the qualified id of the Connection type it ingests for
  kinds: Record<string, KindDeclaration>       // "github.issue.opened" -> payload schema + description
  feeds?: Record<string, FeedDeclaration>      // named poll feeds; absent for purely push-driven sources
  connectionConfigSchema?: Schema              // per-Connection config (the GitHub watch list)
  open(connection: ConnectionRef, ctx: IngestContext): Effect<IngestHandle>
}

interface KindDeclaration { schema: Schema; description: string }
interface FeedDeclaration { defaultIntervalSeconds: number; minIntervalSeconds?: number }

// What the core hands the ingest loop.
interface IngestContext {
  emit(e: EmitEvent): Effect<{ eventId: string }>    // the `events` capability; connection-stamped by the host
  state: KeyValueStore                         // Connection-scoped KV view (section 6): cursors, watch-list diffs
  status(s: { state: "connected" | "degraded" | "disconnected"; detail?: string }): void
}

// What the core calls on a live ingest loop.
interface IngestHandle {
  poll?(feed: string): Effect<{ nextAfterSeconds?: number } | void>
  close(): Effect<void>
}
```

Division of labour in one line: **core clock, plugin numbers.**

- The core drives the lifecycle exactly as it does for channels: `open()` once per `connected` Connection of the type after `activate()`, `close()` on disable, deactivate, Connection removal or status change. The core owns the timers - one per (Connection, feed), fired at the per-Connection interval, paused during controller promotion, backed off on errors (section 8.1) - and reports health uniformly.
- The plugin owns the cadence *numbers*: each feed declares its `defaultIntervalSeconds` (and optionally a `minIntervalSeconds` floor), and `poll()` may return `nextAfterSeconds` as a per-tick floor derived from what the wire said (`X-Poll-Interval`, `Retry-After`, quota math); the core never fires sooner. The user may override the interval per Connection, per feed, clamped to the plugin's floor.
- **Push sources declare no feeds**: a source holding a persistent connection (a websocket, post-v1 webhook delivery) opens it inside `open()`, emits whenever the wire says so, reports `status()`, and never implements `poll`. The core restarts a dead handle with backoff. Poll and push are one contribution shape (ADR 0009's push-agnostic boundary); the Discord channel plugin's gateway socket already proves the always-on pattern in v1.
- **Kind names are prefixed** with the plugin id (`github.`), enforced at `register()`. Kinds and their payload schemas are catalog data, so ~~trigger filters and UI validate against them~~ the UI can show them, and old events still render, while the plugin is disabled. *(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* A trigger cannot name a kind of a plugin that is disabled or did not start: its source ingests nothing, so the trigger could never match, and validation refuses it. A plugin may not declare a kind the core declares ([./08-events-and-connections.md](./08-events-and-connections.md) section 2), because a trigger names a kind by its name alone; the registration fails.
- **Emit is the whole output**: the plugin supplies `kind`, `dedupKey`, `occurredAt`, `payload`, `refs` (canonicalized by this plugin: `github:issue:owner/repo#42`), `url`, `system` and `raw` per the envelope in [./08-events-and-connections.md](./08-events-and-connections.md); the host stamps `connectionId`. The core persists, deduplicates, matches and dispatches; a plugin never sees triggers, subscriptions or dispatch.
- **Baseline at now**: a newly established connection emits no history.

### 4.4 Workflow action

A workflow action is what an action step invokes ([ADR 0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md); step semantics in [./07-workflows.md](./07-workflows.md)).

```ts
interface WorkflowActionContribution {
  id: string                                   // the bare word "<entity>.<verb>", e.g. "pr.merge"; identified as "github/pr.merge"
  displayName: string
  description: string                          // shown in pickers; raw material for a bound action's describe line
  input: Schema
  output: Schema                               // what edge conditions route on: steps.<id>.output.*
  connection?: { type: string }                // this action acts through one Connection of this type
  execute(input: unknown, ctx: ActionContext): Effect<unknown>
}

interface ActionContext {
  connection?: { id: string; credentials: unknown; config: unknown }   // decoded; present iff declared
  run: { runId: string; stepId: string }       // where this execution sits
  api: PublicApiClient                         // stamped run:<runId>, stepId carried in the audit entry (ADR 0026)
  signal: AbortSignal                          // fires when the run is cancelled
}
```

Rules at the boundary:

- **Failure is a throw.** An action throws `ActionError { code, message, detail? }`; anything else thrown is wrapped as `code: "unexpected"`. The step record stores `{code, message}` and the run fails (`step-failed`, [./07-workflows.md](./07-workflows.md)). No retries, and actions never redirect the graph ([ADR 0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md)).
- **Connection is resolved by the core.** The step's `params` carry the Connection id, usually mapped from the triggering event's connection stamp so reply-as-the-triggering-account needs no special machinery ([ADR 0010](../adr/0010-external-accounts-are-core-owned-connections.md)); the core validates its type against the declaration and hands `execute` the decoded credential. The plugin never lists or picks Connections.
- **Actions may call the host** through `ctx.api`, a public-API client whose mutations are stamped `run:<runId>` with the `stepId` in the audit entry, on the same ungated parity footing as built-in actions ([ADR 0026](../adr/0026-workflow-actions-may-call-the-public-api-as-the-run.md); [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 3.1). Every `ctx.api` mutation is also summarised on the step record (op + entity id), so the run view reports what a step did beyond its declared output.
- **No event emission from `execute()`.** An action wanting to inject a signal calls the `event.emit` operation explicitly, which stamps `source: "manual"` and the actor; the `events` capability's emit belongs to ingest loops only.
- **No blocking waits**: an action that would wait for something external is instead expressed as a subscription-holding run, not an action that sleeps ([./07-workflows.md](./07-workflows.md)). This generalises ticket 16's no-blocking rule, stated for API endpoints, to action contributions.
- **Single-purpose is the shipped convention, not a mechanism.** The v1 rosters below each do one external thing and return output; routing decisions belong in the graph. `ctx.api` is the escape hatch for deterministic logic (fan-out bookkeeping over a list) that would otherwise demand a pointless agent step; routing written into `execute()` is the smell the review bar catches.

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* **Registration is built; ~~execution is not~~** *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79): execution is built too, below)*. A plugin that requests `workflow-actions` registers an action with `host.workflowActions.register(...)`. The host qualifies the word, and refuses a word with a `/`, an empty or overlong description, an action registered twice, and an input that is not a struct, because a step writes its params as named fields. It persists the catalog row with the JSON Schema of the input and the output, which `workflowAction.query` answers. Validation decodes a literal param against the live input schema that the boot keeps in memory, as an emit is read against a kind's live payload schema. ~~`execute` is typed and not called: runs do not execute action steps yet ([#79](https://github.com/theagenticage/hercule/issues/79)). So `ActionContext` carries `connection?` and `run` only, and `api` and `signal` join it with the run engine;~~ `ActionError` is `{ code, message }`. A step can name the actions of a plugin that is enabled and started; the actions of any other plugin stay in the catalog, and validation refuses them ([./07-workflows.md](./07-workflows.md) section 1).

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* **Execution is built.** The run engine calls a plugin action's `execute(input, ctx)` as a step of a run:

- `input` is the step's `params`, with their templates rendered and then decoded against the action's input schema ([./07-workflows.md](./07-workflows.md) section 5). A decode failure fails the step with the code `validation`, and `execute` is not called.
- `ctx` carries `run` (`{ runId, stepId }`) and `signal`, an `AbortSignal` that aborts when the run is cancelled.
- `api` is not shipped, not even as a stub that fails. It joins with the first plugin action that needs it.
- `connection` is never set yet. A run is refused at start while it has a step that calls a plugin action which declares a Connection ([./07-workflows.md](./07-workflows.md) section 7.1). The first plugin action that needs a Connection decides which param names it, and how the core checks and resolves it.
- The step record stores `{ code, message }` from an `ActionError`. Any other failure is stored as the code `unexpected`, and the controller's log holds the details. Either way the run fails with `step-failed`.
- What `execute` returns is encoded with the action's `output` schema before it becomes the step's output. A value the schema refuses fails the step with the code `unexpected`, because later steps read the output and must not route on a value of the wrong shape.
- `execute` is called after the step record is `running` and has committed, outside any transaction, because it reaches outside the database. A step record found `running` when the controller starts fails with the code `interrupted`: the action may or may not have taken effect, and runs never retry one ([./07-workflows.md](./07-workflows.md) section 7.2).

The v1 rosters (the words follow the entity-verb shape of the operation vocabulary in [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md); the Intake prototype's `github.merge` is spelled `github/pr.merge`):

| Plugin | Actions |
|---|---|
| `github` | `github/issue.read`, `github/issue.comment`, `github/issue.update` (labels, assignees, state); `github/pr.read`, `github/pr.comment`, `github/pr.review` (approve / request-changes / comment), `github/pr.update` (labels, reviewers, draft/ready, base), `github/pr.merge` (method, delete-branch), `github/pr.create` (from an already-pushed branch) |
| `gmail` | `gmail/message.read` (full body, parsed text + html), `gmail/thread.read`, `gmail/message.search` (Gmail query syntax, headers only), `gmail/message.send`, `gmail/message.reply` (in-thread), `gmail/message.modify` (add/remove labels: archive, mark read, star) |

~~Anything git (clone, push, branch) is not an action: it happens in the run's workspace.~~ *(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257); [ADR 0035](../adr/0035-an-action-declares-where-it-runs.md): git is a built-in workspace action, below.)* Gmail bodies stay out of ingest and are fetched on demand through `gmail/message.read` / `gmail/thread.read` ([./08-events-and-connections.md](./08-events-and-connections.md) section 5.2).

*(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257); [ADR 0035](../adr/0035-an-action-declares-where-it-runs.md).)* **Git is a built-in workspace action, implemented in the runner.**

- Every action in the catalog says where it runs, `runsIn: "controller" | "workspace"` ([./07-workflows.md](./07-workflows.md) section 8). A workspace action runs on the run's runner, in the run's workspace.
- The git actions are workspace actions: `git.commit` now, `git.push` with [#259](https://github.com/theagenticage/hercule/issues/259). They are core actions, unprefixed. Their code is built into the runner, written plugin-shaped, the way provider adapters are (section 3, "Where plugins run"). The controller holds only their catalog entries.
- **Plugins cannot contribute workspace actions in v1.** Plugins run only on the controller ([ADR 0006](../adr/0006-plugins-request-capabilities-and-register-contributions-in-code.md)), and a workspace action runs on a runner. So there is no contribution shape for one: `WorkflowActionContribution` has no `runsIn` field, and every action a plugin registers runs on the controller.
- Cloning a checkout and naming its branch are still not actions: they happen when the run's workspace is provisioned ([./07-workflows.md](./07-workflows.md) section 4.4).

## 5. Host API and plugin capabilities

The host API is the only surface a plugin programs against. It is **capability-sliced**: at load the controller grants each plugin exactly the capabilities its manifest requests, as service objects handed to the hooks. A plugin that did not request `notifications` has no way to emit one. A plugin never receives repositories, the database, the matcher, or any other controller internal.

V1 plugin capabilities:

| Capability | Phase | Grants |
|---|---|---|
| `providers` | register | register a `ProviderDefinition` |
| `channels` | register + activate | register a channel contribution (scope model included); at runtime deliver inbound messages and clicks, report connection status, and receive outbound send, activity and notification-delivery requests ([./12-assistants.md](./12-assistants.md) section 11.1) |
| `event-sources` | register + activate | register an event-source contribution (kinds + schemas, per-connection config schema) |
| `workflow-actions` | register | register workflow actions |
| `connections` | register + activate | declare the connection types the plugin services and their setup flow; at runtime list the plugin's own connections, read their decoded credentials and per-connection config, report connection status |
| `events` | activate | emit events into the pipeline ([ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)) |
| `notifications` | activate | emit a Notification, withdraw one of its own ([ADR 0012](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)) |
| `resources` | activate | read Resources (repos, mailboxes) relevant to the plugin's connection types, e.g. to seed a watch list |
| `secrets` | activate | plugin-scoped secrets service (section 7) |
| `kv` | activate | plugin-scoped state (section 6) |
| `public-api` | activate | a client for the public API (below) |

Rules:

- `channels` and `notifications` are the capability names pinned by the tickets; the remaining spellings are this spec's and MUST be used consistently. The `events` capability has one method, `emit`; "`events.emit`" in [./08-events-and-connections.md](./08-events-and-connections.md) names that method, not a separate capability. The *set* of services is pinned: contribution registration per extension point, events emit, notifications emit, connections, resources read, secrets, KV, public-API client.
- A capability's registration surface is what `register()` receives; its runtime surface is what `activate()` receives. `register()` never sees a runtime surface.
- *(Added 2026-09-06, [#63](https://github.com/theagenticage/hercule/issues/63).)* **~~Three~~ Six of the eleven exist so far**: `providers`, `kv` and `secrets` ([#63](https://github.com/theagenticage/hercule/issues/63)), `connections` ([#71](https://github.com/theagenticage/hercule/issues/71)), `event-sources` ([#77](https://github.com/theagenticage/hercule/issues/77)) and `workflow-actions` ([#78](https://github.com/theagenticage/hercule/issues/78), registration only). *(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78): the count was not updated when `connections` and `event-sources` shipped.)* All eleven names are valid in a manifest, so a manifest never has to be rewritten as the rest arrive, but a plugin requesting one that is not implemented is refused at load with that capability named, on the same footing as a `hostApi` mismatch (section 8). Nothing is granted silently and nothing is granted empty.
- Everything crossing a capability API is plain serializable data.
- **Interfaces are Effect-typed natively** ([ADR 0031](../adr/0031-the-backend-is-written-on-effect.md)): every hook and capability method returns an `Effect` (typed failures; deactivation interrupts whatever `activate()` started) and anything stream-shaped is a `Stream`. V1 plugins are in-process built-ins, so there is no promise-shaped facade; one can be added post-v1 if third-party loading wants it.
- **Schemas are authored in Effect Schema, persisted as JSON Schema.** Every schema crossing the host API (manifest `configSchema`, event payload kinds, action input/output, per-Connection config, credential fields) is written as an Effect Schema in plugin code; the catalog persists the JSON Schema Effect derives from it, which is what workflow validation and the web app's generated forms consume.
- Plugin capabilities are not user permissions. They are granted by the manifest at load, not by the user; the user's control over a plugin is the enabled flag and its config (section 8). This is the honest v1 position for compiled-in plugins; a review step for third-party manifests is a post-v1 concern.

### The public-API client

A plugin that needs to act on the wider system (create a Task, start a Run, query Sessions) requests `public-api` and receives a client that calls the **same service layer** as HTTP, bound to the same shared contract package ([ADR 0013](../adr/0013-agents-operate-hercule-through-the-public-api.md); [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)). Parity holds: nothing is reachable in-process that is not reachable over HTTP. Plugins do not get a wider surface than any other API consumer.

Plugin-originated mutations are stamped `plugin:<pluginId>` and are ungated: the user enabled the plugin and granted the capability ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 3.1).

## 6. Plugin state: namespaced KV

- Every plugin gets a key-value store namespaced by plugin id, values as JSON, stored as rows in the one controller SQLite database ([ADR 0004](../adr/0004-controller-state-lives-in-one-sqlite-database.md); [./04-state-store.md](./04-state-store.md)).
- This is the only durable state a plugin has. Plugins keep nothing on disk: no files under Hercule Home, no caches outside the database. Consequences: plugin state is inside the Data Root, moves with promotion ([ADR 0005](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)), and is covered by the daily backup.
- Typical contents: polling cursors per connection (GitHub `since` markers, Gmail `historyId`), last-seen markers, small caches. Secrets do not go in KV (section 7).
- KV has two views over the same table. `activate()` receives the **plugin-scoped** store: global, connection-agnostic state (a repo metadata cache, a sender-rule override map). Ingest and channel handles additionally receive a **Connection-scoped** view (`ctx.state`), keys physically `<pluginId>/<connectionId>/...`: cursors and per-connection markers live there, so the core can wipe exactly that slice when the Connection is deleted or re-baselined, without knowing the plugin's key conventions.

KV is **retained on disable**: disable is a toggle, and re-enabling resumes cursors. It is wiped only by an explicit **Reset plugin state** in Settings > Plugins (which also re-baselines every Connection of the plugin) or, per slice, by deleting a Connection.

## 7. Plugin secrets

- The host API includes a **plugin-scoped secrets service**: `get`, `set`, `delete`, `list` (names only) over secret values owned by the plugin.
- Storage is the one owner-scoped secrets table in the controller database with owner kind `plugin` and owner id = plugin id; each value encrypted per-value under the keychain-held master key ([ADR 0015](../adr/0015-secrets-are-encrypted-per-value-under-a-keychain-held-master-key.md); [./13-security.md](./13-security.md)). The plugin secrets service is a scoped view over that table: a plugin can only reach its own owner scope.
- A plugin receives plaintext only through the service at runtime, in memory. Secret values never appear in the event log, in API responses, in KV, or in Notifications; references only.
- Plugin secrets are packable at export, so promotion carries them like every other secret.
- **Connection credentials are not plugin secrets.** They are owned by the Connection (owner kind `connection`) and reached through the `connections` capability, which hands the plugin the decoded credential for a connection it services. Plugin-owned secrets are for values that are the plugin's own and not tied to one Connection.

A BYO OAuth client lives at the **plugin level**: client id in plugin config, client secret as a plugin-owned secret; one client serves every Connection of the type (work and personal Gmail connect through the same GCP app, pasted once), as the setup recipe in [./08-events-and-connections.md](./08-events-and-connections.md) section 9.2 writes. Known v1 limitation, accepted: mixing accounts that demand different clients (a Workspace that only trusts an Internal app, plus a personal account) is impossible; the fix is the additive per-Connection client override (Post-v1).

## 8. Configuration and lifecycle

Three levels of configuration exist and MUST not be confused:

| Level | Schema from | Stored | Example |
|---|---|---|---|
| Plugin config | manifest `configSchema` | controller state, one per plugin | Gmail plugin: BYO OAuth client id (or per-Connection; Open in section 7) |
| Per-connection config | event-source contribution's per-connection schema | controller state, one per Connection | GitHub: watched-repo list for this account |
| Provider-instance config | `ProviderDefinition.configSchema` | one per provider instance; logical settings on the controller, path resolution per [./06-providers.md](./06-providers.md) section 2.1 and its Conflict line | Claude Code instance: isolated provider home |

Lifecycle rules:

- **Installed = compiled in.** The set of installed plugins is fixed by the binary. Settings > Plugins lists them ([./14-web-app.md](./14-web-app.md)); management operations sit under the `infra` grant family ([./13-security.md](./13-security.md)).
- **`hostApi` check at load.** A plugin whose `hostApi` does not match the controller's is not loaded; `register()` is not run for it, so it contributes nothing. The controller surfaces the mismatch in Settings > Plugins. Since v1 plugins are compiled in, a mismatch is a build error in practice.
- **Enabled/disabled flag** per plugin in controller state. Disabling runs the plugin's deactivate function and removes the validity of every one of its contributions everywhere: workflows referencing its actions fail validation loudly, channel bindings on its channels stop resolving, its event sources stop ingesting, its provider instances cannot start sessions. The contributions stay in the catalog, marked as from a disabled plugin, so the UI can say what is missing.
- **Config change or toggle = deactivate + reactivate.** There is no hot-reconfigure protocol; a plugin never observes a config change while running. Config writes are validated against the manifest schema before the restart.
- **Connections survive toggles.** A Connection is a core record; disabling its plugin stops ingest and outbound use but deletes nothing.

Failure handling:

- **`activate()` throws**: the plugin enters an **`errored`** state (beside enabled, disabled and the `hostApi` mismatch) with the error shown in Settings > Plugins, and one `core.plugin-error` Notification is emitted. There is no automatic retry loop - a broken plugin retrying every 30 seconds is noise; it is retried at the next controller boot or by the user's Retry button. Transient per-Connection trouble is the ingest loop's business (section 8.1), not this state's.
- **Deactivate fails**: logged, the plugin is marked `errored`, its contributions are treated as disabled, and Settings says a controller restart clears the leftover machinery.

*(Amended 2026-09-06, [#63](https://github.com/theagenticage/hercule/issues/63).)* **Retry and Reset plugin state are operations**, not screen-local behaviour: `plugin.retry` and `plugin.resetState` in the catalogue ([./11](./11-public-api-and-agent-surface.md) section 2), under `infra.write` like the other plugin writes. Retry re-runs `activate()` once and is refused with `validation` on a plugin that is not `errored`, so the button is never a second spelling of Enable. Reset is deactivate, wipe the plugin's KV rows, activate again when the plugin is enabled; it is allowed while `inactive` and while `errored` too, since leftover state is one of the things an errored plugin may be stuck on. Both are reachable from every client, not only from Settings, which is what makes them recoverable when the screen is what is broken.

*(Amended 2026-09-06, [#63](https://github.com/theagenticage/hercule/issues/63).)* Two states join the `hostApi` mismatch as **load-time refusals**, on the same footing: a manifest naming a capability the host has not implemented yet, and a `configSchema` the generated form cannot render. A refused plugin is listed with its reason, `register()` is never run for it, it contributes nothing, and every write on it is refused with `validation`. Nothing is substituted silently. Until a notifications domain exists, the `core.plugin-error` Notification above is an audit row (`plugin.errored`, carrying the plugin id, the phase and the message); the notifications ticket routes from it.

### 8.1 Ingest-loop failures

`open()` or `poll()` throwing is the common failure (network blip, rate limit). The core retries with exponential backoff (base = the feed's interval, cap 15 minutes); after 5 consecutive failures the Connection goes `error` with one Notification. A success resets the counter and recovers `connected` without user action. A plugin throws a typed `AuthError` to send the Connection straight to `needs-reauth`, no retries.

## 9. Versioning

- One `hostApi` integer names the core host contract (hook signatures, manifest shape, catalog semantics). It is checked at load and is the only version number in the plugin system.
- **Capability APIs evolve additively.** New optional fields, new methods, new event kinds and new contribution facets are added without renaming.
- **A breaking change mints a new capability name** (`channels.v2`). The old name keeps working until it is retired; a plugin requests whichever it was built against. There is no per-capability version matrix and no version field on a capability. Load-time compatibility is one integer check plus name lookup.
- Contribution schemas (event kinds, action input/output schemas) follow the same rule inside a plugin: add, do not rename; a breaking change is a new contribution id. This extends ticket 11's rule, pinned for capability APIs, to contributions; it is the spec's extension.

## 10. Connections and plugin-defined connection types

Connections are core-owned; plugins define types and drive setup. The full Connection model, credential kinds, setup flows and the labels/topic rule are in [./08-events-and-connections.md](./08-events-and-connections.md). The plugin-side facts ([ADR 0010](../adr/0010-external-accounts-are-core-owned-connections.md)):

- A plugin **declares the connection types it services** through the `connections` capability. The plugin declares a bare word; the host mints the qualified id `<pluginId>/<word>` and that is the type everywhere downstream, so two plugins may declare the same word and both load ([ADR 0034](../adr/0034-a-catalog-contribution-is-identified-by-its-qualified-id.md)). Two plugins wanting the same external service each define their own type and the user authenticates twice. Deduping on OAuth identity is post-v1.
- The plugin **drives the flow that establishes a connection**: paste-a-token (GitHub PAT, Slack and Discord bot tokens), ~~or~~ a BYO-OAuth-client redirect flow to the controller's own origin (Google), or a device flow through an OAuth App whose public client id the plugin ships (GitHub) *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*. A type may offer more than one, and the user picks one per connection (section 10.1). Policy is pinned in [./13-security.md](./13-security.md): BYO OAuth client where the provider demands ~~one~~ a client secret, no Hercule-hosted relay, no shipped client secret, paste-a-token as the universal fallback. The controller displays the exact redirect URI derived from the origin the user's browser is using.
- The **core owns** storage, listing, status, the single connected-accounts UI, and the credential secrets. The plugin reads a connection's decoded credentials and per-connection config through the `connections` capability and reports status (for example "token expiring") back through it.
- **Ingest is per connection**: one loop per enabled connection, every event stamped with its `connectionId`. Triggers select connections explicitly; outbound actions name their connection.
- A Resource may reference the Connection used to reach it; the `resources` capability exposes that link to the plugin.

### 10.1 The setup-flow contribution

A connection type is declared in `register()` with its setup flow as **catalog data**: a list of steps from a small fixed set, rendered entirely by the core (no UI extension point exists), so the Connections screen can show what setting a type up takes before the plugin is even enabled.

```ts
interface ConnectionTypeContribution {
  type: string                                 // the bare word: "github", "gmail", "discord", "slack"; the host qualifies it to `<pluginId>/<word>`. No `/` in the word
  displayName: string
  setup: SetupStep[]
  validate(credentials: Record<string, string>): Effect<{ displayName: string; detail?: string }, ConnectionValidationFailed, HttpClient>  // the pasted fields, or { accessToken } from a redirect or device flow
  oauth?: OAuthDeclaration                     // required iff an oauth step appears
  device?: DeviceDeclaration                   // required iff a device step appears
}

type SetupStep =
  | { kind: "checklist"; markdown: string }    // platform-side prep: Discord intents + invite URL; Slack Socket Mode + scopes; the Google recipe
  | { kind: "credentials"; fields: CredentialField[] }   // one or more secret fields (Slack: bot token + app-level token)
  | { kind: "oauth" }                          // run the core OAuth2 client against `oauth`
  | { kind: "device" }                         // run the core device flow client against `device`
  | { kind: "pairing" }                        // core-owned: DM the bot a one-time code ([./12-assistants.md](./12-assistants.md) section 4.1); channels only

interface OAuthDeclaration {
  authorizationUrl: string
  tokenUrl: string
  scopes: string[]
  extraParams?: Record<string, string>         // Google: { access_type: "offline", prompt: "consent" }
}

interface DeviceDeclaration {
  clientId: string                             // public: a device flow needs no client secret, so the plugin ships the id
  deviceCodeUrl: string
  tokenUrl: string
  scopes: string[]
}
```

*(Amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183).)* The `device` step and its `DeviceDeclaration` are new. The bullets from "Which flows a type offers" to "Token endpoint errors" below describe them, and the rules for a type that offers more than one flow.

- **The core runs the OAuth dance.** One generic authorization-code client (PKCE, token exchange, refresh) lives in the core, parameterised by the plugin's `OAuthDeclaration`; the plugin writes no OAuth code and never touches the client secret. The device flow client (RFC 8628) sits beside it, parameterised by the plugin's `DeviceDeclaration`. It stores its tokens in the same `oauth.tokens` secret, but it has no refresh: refresh uses only the type's `OAuthDeclaration`, so a connection set up by a device flow is never refreshed *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*. Refreshed access tokens are what `ctx.connection.credentials` hands the plugin at poll or execute time; a refresh failure sets `needs-reauth` uniformly.
- **Callback routing**: the core mints an opaque `state` referencing a pending-setup row `{type, connectionId?, expiresAt}` (the qualified type names its plugin) and serves `/oauth/callback` itself; the row, not the plugin, is what the callback resolves. The plugin is never routed a request. The row also carries the connection the flow will write: `label`, `labels` and `config` on the same terms as the device flow's row below *(amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323))*.
- **Which flows a type offers.** *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))* Three steps each obtain the credential in their own way: `credentials` (the user pastes it), `oauth` (a redirect flow) and `device` (a device flow). A type declares the steps it offers; when it declares more than one, the user picks one for each connection. GitHub declares `device` and `credentials`. Registration refuses a type when:
  - it has an `oauth` or `device` step without the matching declaration, because the flow would have nowhere to go;
  - it has a declaration with no step for it, because nothing could ever use it;
  - it has both an `oauth` and a `device` step, because refresh uses the `oauth` declaration's client for every `oauth.tokens` secret, including one the device flow's client issued;
  - it declares a credential field named `oauth.tokens`, because the core would read the pasted value as a token set.
- **The flow belongs to the connection, not its type.** *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))* The core reads it from the secrets the connection holds. A connection set up by a redirect flow or a device flow holds the `oauth.tokens` secret, and `credentials()` hands the plugin `{ accessToken }`. A connection set up by paste holds the declared credential fields, and `credentials()` hands the plugin those fields. `validate` receives the same shape, so a type that offers both reads whichever it was given. A reconnect offers the same choice as a first setup, and replaces whichever secrets the connection held. It keeps the connection's label, topics and config *(amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323))*. A refresh calls the provider outside any transaction, so it stores its new tokens, or marks the connection `needs-reauth`, only if the connection still holds the token set it started from; a refresh that a reconnect overtook changes nothing and fails, and the plugin asks again.
- **The device flow.** *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))* `connection.startDeviceFlow` asks the provider for a device code and writes a pending device setup row: `{setupId, type, connectionId?, label?, labels?, config?, deviceCode, interval, nextPollAt, expiresAt}`. *(Amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323).)* A row for a new connection holds `labels` and `config`, and `label` only when the user gave one; with no `label`, the connection is named after the account. A row for a reconnect holds the `connectionId` and none of the three, because a reconnect keeps the connection's label, topics and config. It returns the setup id, the user code, the verification page, the interval and the expiry. Unlike the redirect flow, whose `state` is the row's identity because the provider sends it back, the device flow's handle is an opaque `setupId` the controller mints: the device code never leaves the controller, because anyone holding it could collect the token once the user approves. Expired rows are deleted on the next start, as pending-setup rows are. The provider's `expires_in` is capped at 30 minutes, so an unusual answer from the provider cannot keep a row alive for long. Its `interval` is ~~capped at 60 seconds~~ never shortened, because RFC 8628 §3.5 forbids polling sooner than the provider asks *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*. A flow whose first poll would come after its expiry is refused at start, so no setup screen waits longer than the capped expiry. Polling follows these rules:
  - **The client drives it, the controller paces it.** There is no controller-side timer. The web app (or `hercule connection poll-device-flow`) calls `connection.pollDeviceFlow` while the setup screen is open. A poll before `nextPollAt` answers `pending` without calling the provider. A poll that does call the provider first moves `nextPollAt` one interval forward. So the provider is asked at most once per interval, even when several clients poll the same setup.
  - **An approval is used once.** When the provider issues the token, the poll deletes the row before it does anything else, so only one poll can turn a setup into a connection. Every outcome that ends the flow deletes the row, and a poll on an unknown, deleted or expired row answers `expired`.
  - **`validate` is retried.** After the row is deleted, the plugin's `validate` checks the token. A failure is retried, up to 3 attempts with a short backoff, because the provider will not issue the token a second time. If the last attempt fails too, the poll answers `failed` with a message that tells the user to start again for a new code.
  - **The outcomes** are `pending`, `slow-down` (the provider asked for slower polling; the answer carries the new interval: at least five seconds longer, as RFC 8628 §3.5 requires, or longer still when the provider names one. When the next poll would come after the expiry, the poll answers `failed` instead), `unreachable` (the provider could not be reached this time; the flow stays open), `done` (with the connection), `expired`, `denied` (the user declined at the provider) and `failed` (the provider refused the flow for another reason, such as a bad client id or device flow being disabled on its app, or `validate` still failed after its retries). The last four end the flow.
  - **On `done`** the token set is stored under `oauth.tokens`, as a redirect flow stores it. It is never refreshed: a type with a `device` step has no `OAuthDeclaration`, and refresh needs one. A GitHub OAuth App token never expires and comes with no refresh token, so it needs no refresh. When the provider stops accepting the token, the plugin reports `needs-reauth` (section 8.1), and the user signs in again.
- **Token endpoint errors.** *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))* Some providers, GitHub among them, answer a token request they refuse with HTTP 200 and an `error` field in the body. A body with an `error` field is never a success, whatever the status. What it means depends on the request:
  - In a code exchange or a refresh, any `error` is a refusal. A refused refresh sets `needs-reauth`, never the retried `error` state, because waiting will not fix it.
  - In a device flow poll, the RFC 8628 codes are the poll's outcomes: `authorization_pending` is `pending`, `slow_down` is `slow-down`, `expired_token` is `expired` and `access_denied` is `denied`. Any other code is `failed`. An HTTP 403 or 429 with no `error` field is `unreachable`, not a refusal: it is how a provider such as GitHub rate limits, and waiting fixes it.
- **A pending setup is not a Connection.** The Connection record exists once `validate()` has passed; `validate` names the account (`displayName`: the GitHub login, the Gmail address) for the Connections screen. *(Amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323).)* A new connection given no label is named after the account when its record is written, after `validate`: its label is the `displayName`, or the type's own `displayName` (such as "GitHub") when the account name is empty or only whitespace, cut to at most 128 UTF-16 code units without splitting a character. A reconnect stores the new `displayName` and keeps the label. The status enum stays `connected | needs-reauth | error | disabled` ([./08-events-and-connections.md](./08-events-and-connections.md) section 8.1).
- **Reconnect reuses the Connection id**, so triggers and Resources stay attached ([./08-events-and-connections.md](./08-events-and-connections.md) section 8.4).

## 11. Notifications from plugins

Rationale and the full Notification model: [ADR 0012](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md), [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md). At the plugin boundary:

- **Producing.** A plugin with the `notifications` capability emits a Notification (for example Gmail warning that its OAuth token is expiring). It becomes one persisted core-owned Notification record like every other producer's. The plugin decides nothing about delivery. The same capability offers `withdraw(notificationId, reason)` for a decision the plugin raised whose question has stopped existing ("token refreshed"); it works only on the plugin's own notifications, and it is the only mutation a producer has - records are otherwise immutable ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.7).
- **Delivering.** Delivery is core-push, never plugin-claim. The core router alone decides fan-out. A **sink** is a channel contribution that optionally implements notification delivery; it rides the channel extension point, so the fixed set of four stays intact. The web app's notification center always records the notification regardless of sinks.
- **User control.** The user toggles delivery per channel connection. V1 routing policy is deliver-to-all-enabled. **Producer-side muting** (silence a chatty plugin's notifications) is a separate control from sink-side toggles.
- **Sink contract grows additively.** V1 sinks implement `deliver` (returning a delivery ref) and `resolved` (edit the delivered message when the decision is taken anywhere), and report clicks to the core, which authenticates and executes them ([./12-assistants.md](./12-assistants.md) section 11.6). Post-v1 fields (device class, presence, receipts) are optional; a sink that reports nothing is treated as always available. Presence-aware routing lands as a router upgrade touching no plugin.
- **No second path.** A plugin MUST NOT deliver a user-facing notification by any route other than the `notifications` capability, even when it has a channel connection in hand. Assistants speaking unprompted in a conversation are not notifications; the no-double-fire rule and its router mechanism are in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.5.

## 12. V1 inventory

### Built-in plugins

| Plugin | Contributions | Connection types | Notes |
|---|---|---|---|
| `github` | event source (watched-repo polling: issue and PR lifecycle, notifications); workflow actions | `github/github` (~~PAT paste; BYO OAuth app + device flow optional~~ device flow through Hercule's own OAuth App, PAT paste as the fallback *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*) | per-connection watch list seeded from repo Resources; git credentials for runners derive from these Connections ([ADR 0016](../adr/0016-git-credentials-derive-from-connections.md)) |
| `gmail` | event source (`history.list` polling: headers, subject, snippet, ids); workflow actions (body fetch on demand) | `gmail/gmail` (BYO Google OAuth client, redirect flow) | emits `system` enrichment where a sender rule recognises the originating system |
| `discord` | channel (+ notification sink) | `discord/discord` (bot token paste) | conversation container = channel or DM |
| `slack` | channel (+ notification sink) | `slack/slack` (bot token paste) | conversation container = thread |
| `claude-code` | provider definition | none | adapter built into the runner |
| `codex` | provider definition | none | adapter built into the runner |
| `pi` | provider definition | none | adapter built into the runner; child process per session |

Behaviour per plugin: providers in [./06-providers.md](./06-providers.md), event sources and connections in [./08-events-and-connections.md](./08-events-and-connections.md), channels in [./12-assistants.md](./12-assistants.md).

### Core emitters and built-ins that are not plugins

- **Cron**: a core scheduler emitting `cron.tick` into the pipeline; schedules live in workflow start triggers.
- **Manual**: direct run creation and the synthetic-event API.
- **Platform events**: `run.completed`, `run.failed`, `run.cancelled`, `task.created`, `task.updated`, emitted by the controller.
- **Built-in workflow actions**: ~~`workflow.run`~~ `run.start` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))*, ~~`notify`~~ `notification.create`, `task.create`, `task.update`, `task.query`; the first two join with their operations (section 3; *amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79): `workflow.run` has joined, `notification.create` joins with [#84](https://github.com/theagenticage/hercule/issues/84)*). *(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78): the core declares `run.cancelled` beside the other platform kinds, and `notify` is spelled as its operation.)*
- **Hercule-as-a-tool**: the runner-shipped `hercule` CLI plus skill files the runner materializes into sessions; not a plugin contribution ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)).
- **Notification center**: the web app's always-on notification sink, part of the web app, not a channel plugin.

All of these travel the same pipeline and the same catalog-facing surfaces as their plugin counterparts; being core changes only where the code lives and that they need no capability grant.

## Post-v1

- **UI-contribution extension point** (plugins shipping web/desktop/mobile UI): deferred; design not ready and it would span three surfaces. V1 keeps: plugin settings forms generated from config schemas, so plugins already have a UI presence without code.
- **Agent-tools extension point** (plugin-contributed MCP servers and skills for sessions): deferred, no v1 consumer. V1 keeps: `SessionSpec.mcpServers` passthrough ([./06-providers.md](./06-providers.md)), so the point lands without redesign. First identified consumer: mid-session mailbox queries (v1 covers it with Gmail action steps plus MCP passthrough).
- **Runner-side plugin loading**: deferred until three providers have taught the hooks. V1 keeps: adapters written one-per-provider behind the `ProviderAdapter` interface with no cross-provider leakage.
- **Dynamic third-party loading and discovery**: deferred. V1 keeps: dependencies handed in, serializable host API, single static registry file.
- **Webhook ingress core service** (a capability plugins request; unlocks GitHub push and Actions triggers): post-v1, strongly desired. V1 keeps: push-agnostic event-source boundary.
- **Gmail Pub/Sub pull**: post-v1 latency upgrade behind the same boundary.
- **Presence-aware notification routing**: post-v1 router upgrade; V1 keeps: additive sink contract.
- **Connection dedupe on OAuth identity** across qualified types: later nicety.
- **Per-Connection OAuth client override**: the additive fix for mixed-client account sets (section 7); v1 ships one BYO client per plugin.
- **Manifest review / trust gating** for third-party plugins: with dynamic loading.

## Sources

Tickets:

- Plugin architecture: API shape, loading, dogfooding - https://github.com/theagenticage/hercule/issues/11
- Provider adapter interface - https://github.com/theagenticage/hercule/issues/12
- Workflow model: recipes, triggers, human gates - https://github.com/theagenticage/hercule/issues/13
- Event & trigger ingress design - https://github.com/theagenticage/hercule/issues/14
- Triage engine & user-set bounds - https://github.com/theagenticage/hercule/issues/15
- Agent-operates-system surface - https://github.com/theagenticage/hercule/issues/16
- Assistant design: memory, identity, channel binding - https://github.com/theagenticage/hercule/issues/17
- Security & secrets model - https://github.com/theagenticage/hercule/issues/18
- Web app architecture - https://github.com/theagenticage/hercule/issues/19
- Assemble the v1 spec (Intake handoffs: `system` field, labelable Connections) - https://github.com/theagenticage/hercule/issues/21
- Controller packaging & install story - https://github.com/theagenticage/hercule/issues/24
- Research: smoothest Connection-setup path - https://github.com/theagenticage/hercule/issues/32
- Plugin contribution interfaces and v1 event kinds - https://github.com/theagenticage/hercule/issues/41

ADRs:

- [ADR 0006 - Plugins request capability scopes in a manifest and register contributions in code](../adr/0006-plugins-request-capabilities-and-register-contributions-in-code.md)
- [ADR 0007 - Provider adapter is a thin interface behind a normalized event stream](../adr/0007-provider-adapter-is-a-thin-interface-behind-a-normalized-event-stream.md)
- [ADR 0009 - All events flow through one persisted pipeline](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)
- [ADR 0010 - External accounts are core-owned Connections](../adr/0010-external-accounts-are-core-owned-connections.md)
- [ADR 0012 - Notifications are core-routed; sinks are dumb](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)
- [ADR 0013 - Agents operate Hercule through the public API](../adr/0013-agents-operate-hercule-through-the-public-api.md)
- [ADR 0015 - Secrets are encrypted per-value under a keychain-held master key](../adr/0015-secrets-are-encrypted-per-value-under-a-keychain-held-master-key.md)
- [ADR 0016 - Git credentials derive from Connections](../adr/0016-git-credentials-derive-from-connections.md)
- [ADR 0026 - Workflow actions may call the public API as the run](../adr/0026-workflow-actions-may-call-the-public-api-as-the-run.md)
- [ADR 0031 - The backend is written on Effect](../adr/0031-the-backend-is-written-on-effect.md)
- [ADR 0034 - A catalog contribution is identified by its qualified id](../adr/0034-a-catalog-contribution-is-identified-by-its-qualified-id.md)
- [ADR 0035 - An action declares where it runs](../adr/0035-an-action-declares-where-it-runs.md)
