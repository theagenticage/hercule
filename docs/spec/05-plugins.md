# Plugins

Hydra has one plugin concept. A plugin is a container that requests plugin capabilities in a coarse manifest and registers contributions, in code, into four fixed extension points: provider, channel, event source, workflow action. Loading is two-phase: a pure `register()` builds a persisted contribution catalog for every installed plugin, and `activate()` starts real machinery only for enabled plugins. Plugins program against a capability-sliced host API and never touch controller internals; their durable state is a namespaced KV and a scoped secrets service inside the controller database. In v1 every plugin is compiled into the controller and runs in-process; runner-side provider execution is built-in code written plugin-shaped. Channels, event sources, providers and their workflow actions are all built as plugins in v1 (dogfooding), so an internal plugin and a future third-party plugin differ only in trust, not in kind. Rationale: [ADR 0006](../adr/0006-plugins-request-capabilities-and-register-contributions-in-code.md).

## 1. The plugin concept

- There are no typed plugin kinds ("channel plugin", "provider plugin"). A plugin is a container; what it *is* follows from what it contributes.
- One plugin may contribute several things that share one configuration and one set of credentials. The `github` plugin contributes an event source and workflow actions; the `gmail` plugin likewise.
- **Plugin capabilities** are what a plugin may *call*: named slices of the host API requested in the manifest and granted at load (section 5). **Contributions** are what a plugin *provides*: named things registered into extension points through the granted capability APIs (section 4). The manifest lists capabilities, never contributions.
- The v1 extension points are fixed at four: **provider**, **channel**, **event source**, **workflow action**. Plugins cannot define new extension points. The notification sink is not a fifth point: it is an optional facet of a channel contribution (section 11).
- Contribution ids are globally unique and qualified by the owning plugin. The tickets use dotted ids (`github.merge`); built-in core actions use the same form without a plugin prefix (`task.create`). A workflow step names an action contribution by id; an assistant binding names a channel contribution by id.
- Everything a plugin defines that names things outside Hydra is namespaced by the plugin: connection types (`gmail`, `github`) and External Ref canonicalization (`github:issue:owner/repo#42`) are owned by the defining plugin ([ADR 0010](../adr/0010-external-accounts-are-core-owned-connections.md); Task provenance in [./09-tasks.md](./09-tasks.md)).

## 2. Manifest

The manifest is deliberately coarse. It carries exactly four things:

| Part | Content |
|---|---|
| Identity | plugin id (stable, used as the namespace for KV, secrets, connection types, contribution ids), display name |
| `hostApi` | one integer naming the core host contract the plugin was built against; checked at load |
| Plugin capabilities | the list of capability names the plugin requests, scope-style ("the channels API", "the notifications API") |
| Config schema | typed JSON schema for the plugin's own configuration; the web app generates the plugin's settings form from it ([./14-web-app.md](./14-web-app.md)) |

```ts
interface PluginManifest {
  id: string                 // "github", "gmail", "discord", "slack", "claude-code", "codex", "pi"
  displayName: string
  hostApi: number            // core host contract version integer
  capabilities: string[]     // requested plugin capabilities, e.g. ["event-sources", "workflow-actions", "connections", "events", "notifications", "secrets", "kv"]
  configSchema: JsonSchema   // plugin-level configuration
}
```

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
  register(host: RegistrationHost): void          // pure: declares contributions only
  activate(host: ActivationHost): Promise<Deactivate>   // starts machinery; returns its own teardown
}
type Deactivate = () => Promise<void>
```

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

**Open:** whether the core's built-in workflow actions (`workflow.run`, `notify`, `task.create`, `task.update`, `task.query`) are entered into the same contribution catalog under a core namespace so validation and pickers read one list, or kept in a separate core registry. The tickets call them built-in and distinguish them from plugin contributions but do not say where they are listed.

### Where plugins run

- In-process, **controller-only**, in v1. There is no plugin host on runners.
- Runner-side provider execution (spawning harness CLIs, speaking the Agent SDK, app-server and pi SDK protocols) is **built-in runner code written plugin-shaped**: one narrow `ProviderAdapter` per provider, no cross-provider leakage, keyed by `providerId` to the `ProviderDefinition` the plugin registered on the controller ([./06-providers.md](./06-providers.md)). It is lifted into the plugins post-v1 once three real providers have taught the hooks.
- The host API is shaped for later isolation and third-party loading: dependencies are handed in through the host, never imported from the controller; nothing crosses the host API that cannot be serialized (no live DB handles, no controller service objects, no functions in either direction other than the hooks themselves). A plugin that follows these rules runs unchanged out-of-process later.

## 4. Extension points and contribution interfaces

For each extension point this section states what crosses the plugin boundary. Behaviour lives in the neighbour documents.

### 4.1 Provider

The contribution is the act of registering a `ProviderDefinition`: the provider's static self-description (identity, `supportsMultipleInstances`, per-instance `configSchema`, `defaultConfig()`, and the `DeclaredCapabilities` block of static facts). The interface, including `DeclaredCapabilities`, is pinned in [./06-providers.md](./06-providers.md) section 2 and is not copied here.

- A provider instance is definition plus decoded per-instance config; the `instanceId`, not the provider id, is the routing key. What the instance config holds and where paths are resolved is stated in [./06-providers.md](./06-providers.md) section 2.1, including its Conflict line on runner paths versus the no-paths rule of [./04-state-store.md](./04-state-store.md).
- The runner-side `ProviderAdapter` (probe plus five session methods plus `listSessions`, one normalized event stream) is built-in in v1 and is selected by `providerId`. Capability snapshots, access-mode fallback, the event taxonomy and session specs are all in [./06-providers.md](./06-providers.md).
- A provider plugin needs no host services beyond registration in v1: authentication is the harness's own login on the runner. Secret-valued instance config entries are not plugin-owned secrets (section 7); their owner kind in the secrets table is Open in [./06-providers.md](./06-providers.md).

### 4.2 Channel

A channel contribution makes one chat platform reachable. The TypeScript interface (`ChannelContribution`, `ChannelHost`, `ChannelHandle`, the inbound and outbound message shapes, the sink facet) is pinned in [./12-assistants.md](./12-assistants.md) section 11.1; the obligations at the boundary:

- **Identity**: contribution id, the connection type it services (a Discord bot-token connection; a Slack connection holding a bot token and an app-level token), and its **scope model** - the container levels, outermost first, for group containers and DMs (Discord `guild > channel > thread` / `user`; Slack `channel > thread` / `user`). The scope model is catalog data: the binding editor and the core's binding matcher read it, so bindings validate while the plugin is disabled.
- **Inbound**: for each live connection, deliver every observed message to the core through `host.message()` with its container key (`{ kind, path }` of platform ids), the platform sender identity (plugin-formatted identity key, display name, bot and self flags), the text normalized to markdown, attachment links, and the mention facts it can see (explicit platform mention, reply-to-self). The core, not the plugin, resolves bindings, evaluates wake rules and roles, stores conversation messages and decides what is context and what is instruction ([./12-assistants.md](./12-assistants.md) section 4). Inbound chat messages are not pipeline Events ([ADR 0023](../adr/0023-chat-messages-are-conversation-input-not-events.md)).
- **Outbound**: `send` a markdown message into a named container on the core's request, converting markup and splitting at the platform limit; `activity` renders a working indicator (Discord typing, Slack reaction). Outbound sends leave the core through outbox rows with retry ([./04-state-store.md](./04-state-store.md)).
- **Conversation container**: the plugin defines how its platform's containers map to Hydra Conversations (Discord channel, thread or DM; Slack thread, DM or group DM - a top-level Slack mention opens a thread). One container = one Conversation, never merged ([ADR 0014](../adr/0014-assistants-remember-through-distilled-memory-not-merged-sessions.md)).
- **Notification sink (optional)**: deliver a Notification rendered by the core to a container on a connection, render its bound actions as native buttons, report clicks through `host.click()` and edit the message on `resolved()`. See section 11 and [./12-assistants.md](./12-assistants.md) section 11.6.

### 4.3 Event source

An event-source contribution ingests external facts. Obligations at the boundary ([ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)):

- **Identity**: contribution id, the connection type(s) it ingests for, and the event kinds it emits with a declared payload schema per kind. Kinds and schemas are part of the catalog so trigger filters and UI can be validated against them.
- **Ingest**: on activation, run **one ingest loop per enabled connection** of its type. Emit every event through the `events` capability with: `connectionId`, `kind`, a plugin-supplied `dedupKey`, `occurredAt`, the normalized `payload`, `refs` (the External Refs the event is about, canonicalized by this plugin: `github:issue:owner/repo#42`, `gmail:thread:<id>`), `url` (where a human opens it in its system, or null), `system` (the system the event is about; defaults to the source's own system, writable after ingest for enrichment), and the `raw` vendor payload as passthrough. Field names and the full envelope are pinned in [./08-events-and-connections.md](./08-events-and-connections.md).
- **Only emit.** The core persists, deduplicates, matches, and dispatches. A plugin never sees triggers, subscriptions, or dispatch.
- **Baseline at now**: a newly established connection emits no history.
- **Push-agnostic**: the interface does not care whether the plugin polled or was pushed. V1 sources poll; post-v1 webhook and Pub/Sub ingress change the plugin's internals, not the boundary.
- **Per-connection plugin config**: an event source may declare a per-connection config schema (the GitHub watched-repo list, seeded from repo Resources via the `resources` capability and user-editable). Ingest cadence and the polling designs for GitHub and Gmail are in [./08-events-and-connections.md](./08-events-and-connections.md).

### 4.4 Workflow action

A workflow action is what an action step invokes ([ADR 0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md); step semantics in [./07-workflows.md](./07-workflows.md)). Obligations at the boundary:

- **Identity and schemas**: contribution id, display name, typed input schema, typed output schema. The output schema is what edge conditions route on (`steps.<id>.output.*`), so it is part of the catalog and validated at workflow save time.
- **Connection**: an action that acts on an external service names the Connection it acts as, as an ordinary input. Workflow inputs can map it from the triggering event's connection stamp, so reply-as-the-triggering-account needs no special machinery ([ADR 0010](../adr/0010-external-accounts-are-core-owned-connections.md)).
- **Execution**: `execute(input, ctx)` runs on the controller, in-process, and returns the output or throws. Actions never redirect the graph; a thrown error fails the step and the run.
- **No blocking waits**: an action that would wait for something external is instead expressed as a subscription-holding run, not an action that sleeps ([./07-workflows.md](./07-workflows.md)). This generalises ticket 16's no-blocking rule, which is stated for API endpoints, to action contributions.

**Open:** the TypeScript signatures of the event-source and workflow-action contribution interfaces are not pinned by any ticket; the obligations above are the pinned contract ([Plugin contribution interfaces](https://github.com/rogierpennink/hydra/issues/41)). The provider contribution (`ProviderDefinition`, [./06-providers.md](./06-providers.md)) and the channel contribution ([./12-assistants.md](./12-assistants.md) section 11.1) are pinned.

**Open:** the per-plugin v1 workflow-action roster (which `github.*` and `gmail.*` actions ship) is not pinned. Pinned facts: Gmail bodies are fetched on demand through Gmail actions; the Intake prototype used `github.merge` as an example of an agent-authored bound action.

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
| `notifications` | activate | emit a Notification ([ADR 0012](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)) |
| `resources` | activate | read Resources (repos, mailboxes) relevant to the plugin's connection types, e.g. to seed a watch list |
| `secrets` | activate | plugin-scoped secrets service (section 7) |
| `kv` | activate | plugin-scoped state (section 6) |
| `public-api` | activate | a client for the public API (below) |

Rules:

- `channels` and `notifications` are the capability names pinned by the tickets; the remaining spellings are this spec's and MUST be used consistently. The `events` capability has one method, `emit`; "`events.emit`" in [./08-events-and-connections.md](./08-events-and-connections.md) names that method, not a separate capability. The *set* of services is pinned: contribution registration per extension point, events emit, notifications emit, connections, resources read, secrets, KV, public-API client.
- A capability's registration surface is what `register()` receives; its runtime surface is what `activate()` receives. `register()` never sees a runtime surface.
- Everything crossing a capability API is plain serializable data.
- Plugin capabilities are not user permissions. They are granted by the manifest at load, not by the user; the user's control over a plugin is the enabled flag and its config (section 8). This is the honest v1 position for compiled-in plugins; a review step for third-party manifests is a post-v1 concern.

### The public-API client

A plugin that needs to act on the wider system (create a Task, start a Run, query Sessions) requests `public-api` and receives a client that calls the **same service layer** as HTTP, bound to the same shared Zod contract ([ADR 0013](../adr/0013-agents-operate-hydra-through-the-public-api.md); [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)). Parity holds: nothing is reachable in-process that is not reachable over HTTP. Plugins do not get a wider surface than any other API consumer.

Plugin-originated mutations are stamped `plugin:<pluginId>` and are ungated: the user enabled the plugin and granted the capability ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 3.1).

## 6. Plugin state: namespaced KV

- Every plugin gets a key-value store namespaced by plugin id, values as JSON, stored as rows in the one controller SQLite database ([ADR 0004](../adr/0004-controller-state-lives-in-one-sqlite-database.md); [./04-state-store.md](./04-state-store.md)).
- This is the only durable state a plugin has. Plugins keep nothing on disk: no files under Hydra Home, no caches outside the database. Consequences: plugin state is inside the Data Root, moves with promotion ([ADR 0005](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)), and is covered by the daily backup.
- Typical contents: polling cursors per connection (GitHub `since` markers, Gmail `historyId`), last-seen markers, small caches. Secrets do not go in KV (section 7).
- KV is plugin-wide. Per-connection state is the plugin's own convention inside its namespace (key it by `connectionId`).

**Open:** whether a plugin's KV namespace is wiped when the plugin is disabled, or only on explicit user reset. The tickets pin disable as deactivate-plus-drop-contributions and say nothing about state retention; retaining it (so re-enabling resumes cursors) is the reading consistent with "disable is a toggle".

## 7. Plugin secrets

- The host API includes a **plugin-scoped secrets service**: `get`, `set`, `delete`, `list` (names only) over secret values owned by the plugin.
- Storage is the one owner-scoped secrets table in the controller database with owner kind `plugin` and owner id = plugin id; each value encrypted per-value under the keychain-held master key ([ADR 0015](../adr/0015-secrets-are-encrypted-per-value-under-a-keychain-held-master-key.md); [./13-security.md](./13-security.md)). The plugin secrets service is a scoped view over that table: a plugin can only reach its own owner scope.
- A plugin receives plaintext only through the service at runtime, in memory. Secret values never appear in the event log, in API responses, in KV, or in Notifications; references only.
- Plugin secrets are packable at export, so promotion carries them like every other secret.
- **Connection credentials are not plugin secrets.** They are owned by the Connection (owner kind `connection`) and reached through the `connections` capability, which hands the plugin the decoded credential for a connection it services. Plugin-owned secrets are for values that are the plugin's own and not tied to one Connection.

**Open:** where a BYO OAuth client id and secret live: as plugin config plus a plugin-owned secret (one client shared by all Connections of the type), or as per-Connection credentials as the setup recipe in [./08-events-and-connections.md](./08-events-and-connections.md) section 9.2 writes. Ticket 18 pins only "BYO OAuth client where the provider demands one".

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

**Open:** behaviour when `activate()` throws or the deactivate function fails: whether the controller retries, marks the plugin as errored in Settings, and whether it emits a Notification. The tickets are silent.

## 9. Versioning

- One `hostApi` integer names the core host contract (hook signatures, manifest shape, catalog semantics). It is checked at load and is the only version number in the plugin system.
- **Capability APIs evolve additively.** New optional fields, new methods, new event kinds and new contribution facets are added without renaming.
- **A breaking change mints a new capability name** (`channels.v2`). The old name keeps working until it is retired; a plugin requests whichever it was built against. There is no per-capability version matrix and no version field on a capability. Load-time compatibility is one integer check plus name lookup.
- Contribution schemas (event kinds, action input/output schemas) follow the same rule inside a plugin: add, do not rename; a breaking change is a new contribution id. This extends ticket 11's rule, pinned for capability APIs, to contributions; it is the spec's extension.

## 10. Connections and plugin-defined connection types

Connections are core-owned; plugins define types and drive setup. The full Connection model, credential kinds, setup flows and the labels/topic rule are in [./08-events-and-connections.md](./08-events-and-connections.md). The plugin-side facts ([ADR 0010](../adr/0010-external-accounts-are-core-owned-connections.md)):

- A plugin **declares the connection types it services** through the `connections` capability. Types are namespaced by the defining plugin; two plugins wanting the same external service each define their own type and the user authenticates twice. Deduping on OAuth identity is post-v1.
- The plugin **drives the flow that establishes a connection**: paste-a-token (GitHub PAT, Slack and Discord bot tokens) or a BYO-OAuth-client redirect flow to the controller's own origin (Google). Policy is pinned in [./13-security.md](./13-security.md): BYO OAuth client where the provider demands one, no Hydra-hosted relay, paste-a-token as the universal fallback. The controller displays the exact redirect URI derived from the origin the user's browser is using.
- The **core owns** storage, listing, status, the single connected-accounts UI, and the credential secrets. The plugin reads a connection's decoded credentials and per-connection config through the `connections` capability and reports status (for example "token expiring") back through it.
- **Ingest is per connection**: one loop per enabled connection, every event stamped with its `connectionId`. Triggers select connections explicitly; outbound actions name their connection.
- A Resource may reference the Connection used to reach it; the `resources` capability exposes that link to the plugin.

**Open:** the shape of the setup-flow contribution: how a plugin declares a paste-token form versus an OAuth redirect flow, and how the controller routes the OAuth callback (`/oauth/callback`) to the plugin that started the flow. The policy and per-provider path are pinned; the plugin-boundary mechanics are not.

## 11. Notifications from plugins

Rationale and the full Notification model: [ADR 0012](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md), [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md). At the plugin boundary:

- **Producing.** A plugin with the `notifications` capability emits a Notification (for example Gmail warning that its OAuth token is expiring). It becomes one persisted core-owned Notification record like every other producer's. The plugin decides nothing about delivery.
- **Delivering.** Delivery is core-push, never plugin-claim. The core router alone decides fan-out. A **sink** is a channel contribution that optionally implements notification delivery; it rides the channel extension point, so the fixed set of four stays intact. The web app's notification center always records the notification regardless of sinks.
- **User control.** The user toggles delivery per channel connection. V1 routing policy is deliver-to-all-enabled. **Producer-side muting** (silence a chatty plugin's notifications) is a separate control from sink-side toggles.
- **Sink contract grows additively.** V1 sinks implement `deliver` (returning a delivery ref) and `resolved` (edit the delivered message when the decision is taken anywhere), and report clicks to the core, which authenticates and executes them ([./12-assistants.md](./12-assistants.md) section 11.6). Post-v1 fields (device class, presence, receipts) are optional; a sink that reports nothing is treated as always available. Presence-aware routing lands as a router upgrade touching no plugin.
- **No second path.** A plugin MUST NOT deliver a user-facing notification by any route other than the `notifications` capability, even when it has a channel connection in hand. Assistants speaking unprompted in a conversation are not notifications; the no-double-fire rule and its router mechanism are in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.5.

## 12. V1 inventory

### Built-in plugins

| Plugin | Contributions | Connection types | Notes |
|---|---|---|---|
| `github` | event source (watched-repo polling: issue and PR lifecycle, notifications); workflow actions | `github` (PAT paste; BYO OAuth app + device flow optional) | per-connection watch list seeded from repo Resources; git credentials for runners derive from these Connections ([ADR 0016](../adr/0016-git-credentials-derive-from-connections.md)) |
| `gmail` | event source (`history.list` polling: headers, subject, snippet, ids); workflow actions (body fetch on demand) | `gmail` (BYO Google OAuth client, redirect flow) | emits `system` enrichment where a sender rule recognises the originating system |
| `discord` | channel (+ notification sink) | `discord` (bot token paste) | conversation container = channel or DM |
| `slack` | channel (+ notification sink) | `slack` (bot token paste) | conversation container = thread |
| `claude-code` | provider definition | none | adapter built into the runner |
| `codex` | provider definition | none | adapter built into the runner |
| `pi` | provider definition | none | adapter built into the runner; child process per session |

Behaviour per plugin: providers in [./06-providers.md](./06-providers.md), event sources and connections in [./08-events-and-connections.md](./08-events-and-connections.md), channels in [./12-assistants.md](./12-assistants.md).

### Core emitters and built-ins that are not plugins

- **Cron**: a core scheduler emitting `cron.tick` into the pipeline; schedules live in workflow start triggers.
- **Manual**: direct run creation and the synthetic-event API.
- **Platform events**: `run.completed`, `run.failed`, `task.created`, `task.updated`, emitted by the controller.
- **Built-in workflow actions**: `workflow.run`, `notify`, `task.create`, `task.update`, `task.query`.
- **Hydra-as-a-tool**: the runner-shipped `hydra` CLI plus skill files the runner materializes into sessions; not a plugin contribution ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)).
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
- **Connection dedupe on OAuth identity** across plugin-namespaced types: later nicety.
- **Manifest review / trust gating** for third-party plugins: with dynamic loading.

## Sources

Tickets:

- Plugin architecture: API shape, loading, dogfooding - https://github.com/rogierpennink/hydra/issues/11
- Provider adapter interface - https://github.com/rogierpennink/hydra/issues/12
- Workflow model: recipes, triggers, human gates - https://github.com/rogierpennink/hydra/issues/13
- Event & trigger ingress design - https://github.com/rogierpennink/hydra/issues/14
- Triage engine & user-set bounds - https://github.com/rogierpennink/hydra/issues/15
- Agent-operates-system surface - https://github.com/rogierpennink/hydra/issues/16
- Assistant design: memory, identity, channel binding - https://github.com/rogierpennink/hydra/issues/17
- Security & secrets model - https://github.com/rogierpennink/hydra/issues/18
- Web app architecture - https://github.com/rogierpennink/hydra/issues/19
- Assemble the v1 spec (Intake handoffs: `system` field, labelable Connections) - https://github.com/rogierpennink/hydra/issues/21
- Controller packaging & install story - https://github.com/rogierpennink/hydra/issues/24
- Research: smoothest Connection-setup path - https://github.com/rogierpennink/hydra/issues/32

ADRs:

- [ADR 0006 - Plugins request capability scopes in a manifest and register contributions in code](../adr/0006-plugins-request-capabilities-and-register-contributions-in-code.md)
- [ADR 0007 - Provider adapter is a thin interface behind a normalized event stream](../adr/0007-provider-adapter-is-a-thin-interface-behind-a-normalized-event-stream.md)
- [ADR 0009 - All events flow through one persisted pipeline](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)
- [ADR 0010 - External accounts are core-owned Connections](../adr/0010-external-accounts-are-core-owned-connections.md)
- [ADR 0012 - Notifications are core-routed; sinks are dumb](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)
- [ADR 0013 - Agents operate Hydra through the public API](../adr/0013-agents-operate-hydra-through-the-public-api.md)
- [ADR 0015 - Secrets are encrypted per-value under a keychain-held master key](../adr/0015-secrets-are-encrypted-per-value-under-a-keychain-held-master-key.md)
- [ADR 0016 - Git credentials derive from Connections](../adr/0016-git-credentials-derive-from-connections.md)
