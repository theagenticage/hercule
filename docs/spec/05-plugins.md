# Plugins

Hercule has one plugin concept. A plugin is a container that requests plugin capabilities in a coarse manifest and registers contributions, in code, into four fixed extension points: provider, channel, event source, workflow action. Loading is two-phase: a pure `register()` builds a persisted contribution catalog for every installed plugin, and `activate()` starts real machinery only for enabled plugins. Plugins program against a capability-sliced host API and never touch controller internals; their durable state is a namespaced KV and a scoped secrets service inside the controller database. In v1 every plugin is compiled into the controller and runs in-process; runner-side provider execution is built-in code written plugin-shaped. Channels, event sources, providers and their workflow actions are all built as plugins in v1 (dogfooding), so an internal plugin and a future third-party plugin differ only in trust, not in kind. Rationale: [ADR 0006](../adr/0006-plugins-request-capabilities-and-register-contributions-in-code.md).

## 1. The plugin concept

- There are no typed plugin kinds ("channel plugin", "provider plugin"). A plugin is a container; what it *is* follows from what it contributes.
- One plugin may contribute several things that share one configuration and one set of credentials. The `github` plugin contributes an event source and workflow actions; the `gmail` plugin likewise.
- **Plugin capabilities** are what a plugin may *call*: named slices of the host API requested in the manifest and granted at load (section 5). **Contributions** are what a plugin *provides*: named things registered into extension points through the granted capability APIs (section 4). The manifest lists capabilities, never contributions.
- The v1 extension points are fixed at four: **provider**, **channel**, **event source**, **workflow action**. Plugins cannot define new extension points. The notification sink is not a fifth point: it is an optional facet of a channel contribution (section 11).
- A catalog contribution is identified by its **qualified id**, `<pluginId>/<word>`: the plugin declares the bare word, the host mints the qualified form at registration, and that is the identity everywhere downstream ([ADR 0034](../adr/0034-a-catalog-contribution-is-identified-by-its-qualified-id.md)). It holds for every extension point - connection types (`github/github`), workflow actions (`github/pr.merge`), channel contributions (`discord/discord`), provider definitions - so the dotted plugin prefix the tickets use (`github.merge`) is retired. The word may contain dots (`pr.merge`) but never a `/`. Built-in core actions are operations and keep the operation id (`task.create`, [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 1); event kinds are dotted, with a namespace before the first dot, not by this rule (`github.issue.opened`); the namespace is not always the event's source (`task.created` has the source `platform`). A workflow step names an action contribution by id; an assistant binding names a channel contribution by id. *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); decided in [#389](https://github.com/theagenticage/hercule/issues/389).)* **Signal kinds are qualified the same way** (`github/review-requested`, `gmail/mail`), although a signal kind is a facet of an event source, not a contribution of its own (section 4.3). Event kinds stay dotted. Core signal kinds (`proposal`, `offer`, `unsure`, `fyi`) are unprefixed ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#93-core-kinds-and-signalraise)).
- Everything a plugin defines that names things outside Hercule is namespaced by the plugin: connection types (declared `gmail`, `github`; identified `gmail/gmail`, `github/github`) and External Ref canonicalization (`github:issue:owner/repo#42`) are owned by the defining plugin ([ADR 0010](../adr/0010-external-accounts-are-core-owned-connections.md); Task provenance in [./09-tasks.md](./09-tasks.md)).

## 2. Manifest

The manifest is deliberately coarse. It carries exactly ~~four~~ five things *(amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395): the mark joined, below)*:

| Part | Content |
|---|---|
| Identity | plugin id (stable, used as the namespace for KV, secrets, and the qualified ids of connection types and contributions), display name |
| `hostApi` | one integer naming the core host contract the plugin was built against; checked at load |
| Plugin capabilities | the list of capability names the plugin requests, scope-style ("the channels API", "the notifications API") |
| Config schema | an Effect Schema for the plugin's own configuration, persisted as the JSON Schema derived from it; the web app generates the plugin's settings form from that ([./14-web-app.md](./14-web-app.md)) |
| Mark | *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* the plugin's small icon, as SVG path data only; optional |

```ts
interface PluginManifest {
  id: string                 // "github", "gmail", "discord", "slack", "claude-code", "codex", "pi"
  displayName: string
  hostApi: number            // core host contract version integer
  capabilities: string[]     // requested plugin capabilities, e.g. ["event-sources", "workflow-actions", "connections", "events", "notifications", "secrets", "kv"]
  configSchema: Schema       // plugin-level configuration, in Effect Schema
  mark?: { paths: string[] } // added 2026-10-10: SVG path `d` strings on a fixed 16x16 viewBox
}
```

*(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); decided in [#394](https://github.com/theagenticage/hercule/issues/394) and [#389](https://github.com/theagenticage/hercule/issues/389).)* **The mark.** Intake shows the mark of the plugin a signal or an event came from.

- `mark.paths` holds path `d` strings only, drawn on a fixed 16×16 viewBox. There is no SVG document, no `<style>`, no other element and no colour, so a mark cannot carry script or tracking, and the apps draw it in the theme's colour.
- The core checks the mark when it loads the plugin: each string must be path data only (path commands and numbers), and all strings together must stay under about 4 KB.
- The API returns the mark with the plugin, so every client draws it the same way. How the apps draw it, and what they draw for a plugin with no valid mark, is in [./17-desktop-app.md](./17-desktop-app.md).
- A plugin has one mark, its own. A system reached through another plugin is shown as text ("Sentry, via Gmail"), never as a mark.

*(Amended 2026-09-06, [#63](https://github.com/theagenticage/hercule/issues/63).)* `configSchema` is an **Effect Schema**, not a JSON Schema, which is what section 5's "authored in Effect Schema, persisted as JSON Schema" always said; this snippet was the stale spelling. The host derives the JSON Schema from it and persists that, and it decodes the stored config against the live schema before handing it to `activate()` - neither is possible from JSON alone. It is the one thing in the manifest that is not plain data, which is why the manifest is static data shipped with the package rather than a serializable record. The derivation refuses shapes the generated form cannot render: the supported set is a flat struct of string, number, integer, boolean, enum and array-of-string properties, and a plugin whose schema goes beyond it is refused at load with the reason shown in Settings > Plugins.

Rules:

- No contribution appears in the manifest. A VS Code-style declarative contribution list was rejected ([ADR 0006](../adr/0006-plugins-request-capabilities-and-register-contributions-in-code.md)).
- The manifest is static data shipped with the plugin package; the controller reads it before running any plugin code.
- The tickets pin the ~~four~~ five parts *(amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395))* and the name `hostApi`; the other field names above are this spec's spelling and MUST be used consistently.

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
- Starts real machinery: opens channel connections, ~~starts one ingest loop per connection for each event source~~, and so on. *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The core, not `activate()`, opens an event source's handle for each Connection (section 4.3).
- Returns a deactivation function that stops everything it started. Deactivate-then-activate is the only reconfiguration protocol (section 8). *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The core gives the deactivation function 10 seconds, and treats one that has not returned by then as failed (section 8).

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
  connectionType: string                       // the qualified id of the plugin's own Connection type it ingests for
  kinds: Record<string, EventKindDeclaration>  // "github.issue.opened" -> payload schema + description
  feeds: Record<string, FeedDeclaration>       // named poll feeds; at least one
  open(connection: IngestConnection, ctx: IngestContext): Effect<IngestHandle, AuthError | PluginError>
}

interface EventKindDeclaration { description: string; schema: Schema }
interface FeedDeclaration { defaultIntervalSeconds: number; minIntervalSeconds?: number }  // positive integers; min <= default <= 86400
interface IngestConnection { id: string; config: unknown }  // config decoded with the Connection type's configSchema

// What the core hands the ingest handle of one Connection.
interface IngestContext {
  emit(e: EmittedEvent): Effect<void, PluginError>      // the `events` capability; connection-stamped by the host; payload and raw at most 256 KiB each
  state: KeyValueStore                                   // this Connection's state (section 6): cursors, snapshots
  credentials(): Effect<Record<string, string>, ConnectionUnavailable>  // read through the type's runtime, OAuth refreshed
  resources?: { list(): Effect<LinkedResource[]> }       // the Resources linked to this Connection; only with `resources`
}

interface EmittedEvent {
  kind: string; dedupKey: string; occurredAt: string; payload: unknown
  refs: string[]; url?: string; system?: string; raw?: JsonObject
}
interface LinkedResource { id: string; kind: "repo" | "folder" | "mailbox"; label: string | null; remote: string | null }

// What the core calls on an open handle.
interface IngestHandle {
  poll(feed: string): Effect<{ nextAfterSeconds?: number }, AuthError | PluginError>  // stopped after 5 minutes
  close: Effect<void>                                    // run once, after the last poll; given 10 seconds
}
```

*(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The block above is now the interface as shipped. It changed in these places:

- `feeds` is required. ~~A push source declares `{}`.~~ *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* A source declares at least one feed, and no feed's default interval may be longer than 86,400 seconds (one day), the longest interval a Connection may set. The minimum is at most the default, so it is bounded too. The host refuses a source that breaks either rule when the plugin registers it, because it would hold a handle open that is never polled.
- `connectionConfigSchema` is gone. A Connection's config is decoded with the `configSchema` of its Connection type (section 10), so it exists for a type with no event source too. The source's `connectionType` must be a type of its own plugin, and a type has at most one source.
- `emit` returns nothing. A duplicate dedup key succeeds and writes nothing, so there is no event id to return.
- `status()` is gone. The core sets a Connection's status from what `open` and `poll` return (section 8.1).
- `credentials()` and `resources` are new. A plugin needs credentials to call its service, and `resources` lists the linked Resources again on each call, so a repo the user links later is in the next answer.
- `poll` is required, and `close` is an `Effect` value, not a function. The core never runs two polls of one handle at the same time.
- *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* Limits the core applies to a handle:
  - A poll that runs longer than 5 minutes is stopped and counts as a failure (section 8.1). The 5 minutes start once the poll holds the handle's lock, so time spent waiting for another feed's poll does not count.
  - `close` gets 10 seconds. When it fails or times out, the core logs an error and the Connection is closed anyway.
  - `emit` refuses a `payload` or a `raw` larger than 256 KiB, each measured on its own as UTF-8 JSON, with a `PluginError`.
  - `emit`, `state.set` and `state.delete` are refused when the Connection was deleted, or is no longer `connected` or `error`. The check runs in the transaction of the write, so nothing is written after a delete or a disable has committed. The refusal is a defect, so a plugin that catches its own errors cannot keep writing. The core neither counts nor logs it, because it closes the handle within seconds.
  - `nextAfterSeconds` above 86,400 counts as 86,400, and a value that is not a finite number is ignored.

Division of labour in one line: **core clock, plugin numbers.**

- The core drives the lifecycle exactly as it does for channels: ~~`open()` once per `connected` Connection of the type after `activate()`, `close()` on disable, deactivate, Connection removal or status change~~ `open()` once per Connection of the type that is `connected` or `error` while the plugin is active, and `close()` once the Connection is deleted, disabled or `needs-reauth`, or the plugin stops. A change to the Connection's config or feed intervals closes the handle and opens a new one. *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The core owns the timers - one per (Connection, feed), fired at the per-Connection interval, ~~paused during controller promotion,~~ backed off on errors (section 8.1) - and reports health uniformly. *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89): promotion is not built, so there is nothing to pause for yet.)*
- The plugin owns the cadence *numbers*: each feed declares its `defaultIntervalSeconds` (and optionally a `minIntervalSeconds` floor), and `poll()` may return `nextAfterSeconds` as a per-tick floor derived from what the wire said (`X-Poll-Interval`, `Retry-After`, quota math); the core never fires sooner. The user may override the interval per Connection, per feed, ~~clamped to the plugin's floor~~ *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* in `feedIntervals` ([./08-events-and-connections.md](./08-events-and-connections.md) section 8.1). An override below the feed's floor is refused, not clamped. The floor is `minIntervalSeconds`, or `defaultIntervalSeconds` when the feed declares no minimum.
- ~~**Push sources declare no feeds**: a source holding a persistent connection (a websocket, post-v1 webhook delivery) opens it inside `open()`, emits whenever the wire says so,~~ ~~reports `status()`, and never implements `poll`. The core restarts a dead handle with backoff.~~ *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* ~~and is never polled. The core retries a failed `open()` with backoff. A handle has no way to report that its connection died after `open()`, so the core cannot restart it yet.~~ Poll and push are one contribution shape (ADR 0009's push-agnostic boundary); the Discord channel plugin's gateway socket already proves the always-on pattern in v1. *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* A source with no feeds is refused (above), so a purely push-driven source cannot be written. A source that holds a persistent connection (a websocket, post-v1 webhook delivery) opens it inside `open()` and emits whenever the wire says so, but it must declare at least one feed as well. No v1 event source is push-driven, so the first one decides what its feed polls. A handle has no way to report that its connection died after `open()`, so the core cannot restart it.
- **Kind names are prefixed** with the plugin id (`github.`), enforced at `register()`. Kinds and their payload schemas are catalog data, so ~~trigger filters and UI validate against them~~ the UI can show them, and old events still render, while the plugin is disabled. *(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* A trigger cannot name a kind of a plugin that is disabled or did not start: its source ingests nothing, so the trigger could never match, and validation refuses it. A plugin may not declare a kind the core declares ([./08-events-and-connections.md](./08-events-and-connections.md) section 2), because a trigger names a kind by its name alone; the registration fails. *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* This prefix rule is for event kinds. A signal kind's word is qualified by the host instead, as a contribution id is (section 1).
- **Emit is the whole output**: the plugin supplies `kind`, `dedupKey`, `occurredAt`, `payload`, `refs` (canonicalized by this plugin: `github:issue:owner/repo#42`), `url`, `system` and `raw` per the envelope in [./08-events-and-connections.md](./08-events-and-connections.md); the host stamps `connectionId`. The core persists, deduplicates, matches and dispatches; a plugin never sees triggers, subscriptions or dispatch.
- **Baseline at now**: a newly established connection emits no history. *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* As built, the first poll of each feed only records where the feed stands. The same happens after Reset plugin state (section 6), and for a GitHub repo that joins the watch list ([./08-events-and-connections.md](./08-events-and-connections.md) section 5.1).

*(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); decided in [#389](https://github.com/theagenticage/hercule/issues/389), [#397](https://github.com/theagenticage/hercule/issues/397) and [#393](https://github.com/theagenticage/hercule/issues/393).)* **Signal kinds, Intake settings and the user's identity.** An event source gains the parts below. None of them is built yet.

```ts
interface EventSourceContribution {
  // ...the fields above, plus:
  signalKinds?: SignalKindDeclaration[]        // the kinds of Signal this source's events can raise; none when left out
}

interface EventKindDeclaration {
  description: string
  schema: Schema
  availableToTriage: boolean                   // required: the default of the kind's Intake switch (section 8.2)
}

interface SignalKindDeclaration {
  word: string                                 // "review-requested"; identified as "github/review-requested"
  label: string                                // "Review requested"
  description: string                          // one line for the user, shown in Settings > Intake
  from: string[]                               // the event kinds the rule reads
  rule: string                                 // CEL over `event`; returns "yes", "no" or "undecided"
  guidance: string                             // what the Screener reads when the rule returns "undecided"
  threadRef: string                            // CEL over `event`; the thread the signal is about
  namesYou: boolean                            // the kind names the user directly, not a team
  priority: TaskPriority                       // the default; `build` may change it
  matchFields: { name: string; label: string; path: string }[]  // what an Ignore Rule may match on; `path` is CEL over `event`
  ends: SignalEndDeclaration[]                 // the events that end an open signal of this kind
  build(event: Event, ctx: SignalBuildContext): Effect<SignalDraft, PluginError>
}

interface SignalEndDeclaration {
  eventKind: string
  condition?: string                           // CEL over `event`
  resolution: "decided" | "withdrawn"
  outcome: string                              // CEL returning the line the signal shows once it has ended ("Merged by Marta")
  actionId?: string                            // the action this end stands for, when there is one: an approval on GitHub and Approve
}

interface SignalBuildContext {
  connection: IngestConnection                 // the Connection the event arrived through
  credentials(): Effect<Record<string, string>, ConnectionUnavailable>
}

interface SignalDraft {
  title: string
  asker?: string
  place?: string
  priority?: TaskPriority
  blocks: Block[]
  actions: BoundAction[]                       // this plugin's own actions only; never Done
}

interface IngestConnection {
  // ...the fields above, plus:
  accountId: string                            // the user's account on the service, from the Connection
  displayName: string
}

interface IngestContext {
  // ...the members above, plus:
  openSignals(): Effect<{ kind: string; threadRef: string; raisedAt: string }[]>  // the open signals on this Connection
}

interface EmittedEvent {
  // ...the fields above, plus:
  title: string                                // one line, built from the payload
  author: string | null                        // who caused the event on its own system
}
```

- **A signal kind is a facet of the event source**, like an event kind. It is not a contribution and not a fifth extension point, so a plugin update can add a kind without registering anything new. The host qualifies the word to `<pluginId>/<word>` (section 1). Everything but `build` is data: the plugin never writes a Signal, and the core evaluates the rule, the thread, the match fields and the ends.
- **What the core does with a kind**: it runs the rule, checks known work and Ignore Rules, replaces an older signal on the same thread, sends an `undecided` event to the Screener, and calls `build`. That path is in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#92-how-a-plugins-signal-is-raised), and what happens when `build` fails is in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent). How a kind's `ends` end a signal is in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#96-when-a-signal-leaves). The `Block` types are in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#95-blocks), and `BoundAction` in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent). Whether a kind is on is an Intake setting (section 8.2).
- **`build` is the one piece of plugin code.** It turns the event into the signal's content. It binds only its own plugin's actions, and the core fills in each one's Connection with the signal's own (section 4.4). It never declares Done: the core adds Done and the workflows that can take the signal ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent)). It may read the service through `ctx.credentials()`, as Gmail's `build` reads the thread.
- **`availableToTriage` is required**, so every plugin author decides for every event kind whether triage may read it. Adding it is a change to the host contract (section 9).
- **The user's identity lives on the Connection** (`accountId` and `displayName`, [./08-events-and-connections.md](./08-events-and-connections.md) section 8.1). The core hands both to the source, and the source works out at ingest the facts its rules need, such as `byYou`, `toYou` and `reviewer: you | team`, and writes them into the payload. Platform Identity is not widened.
- **`openSignals()`** lists the open signals of this Connection, so a source can watch the threads that have one: for example, read a pull request's reviews only while a review request on it is open.
- **`title` and `author`** are new envelope fields, set at emit and never changed ([./08-events-and-connections.md](./08-events-and-connections.md) section 2).

### 4.4 Workflow action

A workflow action is what an action step invokes ([ADR 0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md); step semantics in [./07-workflows.md](./07-workflows.md)).

```ts
interface WorkflowActionContribution {
  id: string                                   // the bare word "<entity>.<verb>", e.g. "pr.merge"; identified as "github/pr.merge"
  displayName: string
  description: string                          // shown in pickers only (amended 2026-10-10: no longer raw material for a describe line)
  input: Schema
  output: Schema                               // what edge conditions route on: steps.<id>.output.*
  connection?: { type: string }                // this action acts through one Connection of this type
  execute(input: unknown, ctx: ActionContext): Effect<unknown>
}

interface ActionContext {
  connection?: { id: string; credentials: Record<string, string>; config: unknown }   // present iff declared
  run: { runId: string; stepId: string }       // where this execution sits
  signal: AbortSignal                          // fires when the run is cancelled
}
```

*(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The block above is now the shape as shipped. `api` is not in it (see the bullets on #79 below), and `credentials` holds the Connection's credential fields by name.

*(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); decided in [#391](https://github.com/theagenticage/hercule/issues/391).)* **Where an action may be bound, and its describe line.** An action contribution gains two fields. Neither is built yet.

```ts
interface WorkflowActionContribution {
  // ...the fields above, plus:
  usableIn?: ("workflow.step" | "notification.answer" | "signal.answer")[]   // default ["workflow.step"]
  describe?(input: unknown): DescribeLinePart[]   // pure; required when an *.answer place is listed
}

type DescribeLinePart = { kind: "text" | "marked"; text: string }
```

- **`usableIn`** says where the action may be bound: as a workflow step, as a Bound Action on a Notification, or as an action on a Signal. It is the plugin's side of the `usableIn` column that core operations declare in the operation table ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#2-operation-catalogue)). What a Bound Action is, and the safety test every `*.answer` operation passes, are in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#74-bound-actions).
- **`describe`** returns the describe line for one frozen input. It must be pure: it reads only `input`, and never calls the service. Registration fails when an `*.answer` place is listed without it, and TypeScript refuses it too. The plugin that owns an action writes its describe line; the producer that binds it cannot change it, so [ADR 0022](../adr/0022-proposing-is-not-doing.md) holds. The core appends the source and the Connection: "Merges pull request **#113** in **acme/api** · GitHub · as **work**". The text a user types into a `field` is left out of the line.
- **`description`** ~~is raw material for a bound action's describe line~~ is shown in pickers only *(amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395))*.
- **The Connection is bound beside the input**, never inside it: `BoundOperation { op, connectionId?, input }`, with `connectionId` required exactly when the action declares a Connection. For the actions a signal kind's `build` binds, the core fills in the signal's own Connection. Who binds what, and the check at raise and at the click, are in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent).
- **A typed reply** is a Bound Action with `field?: { name, placeholder }`, where `name` is one top-level text field of the input (`body` on `github/issue.comment`). It exists on Signals only ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent)). The plugin declares nothing for it beyond a text field in its input.

Rules at the boundary:

- **Failure is a throw.** An action throws `ActionError { code, message, detail? }`; anything else thrown is wrapped as `code: "unexpected"`. The step record stores `{code, message}` and the run fails (`step-failed`, [./07-workflows.md](./07-workflows.md)). No retries, and actions never redirect the graph ([ADR 0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md)).
- **Connection is resolved by the core.** The step's `params` carry the Connection id, usually mapped from the triggering event's connection stamp so reply-as-the-triggering-account needs no special machinery ([ADR 0010](../adr/0010-external-accounts-are-core-owned-connections.md)); the core validates its type against the declaration and hands `execute` the decoded credential. The plugin never lists or picks Connections.
- **Actions may call the host** through `ctx.api`, a public-API client whose mutations are stamped `run:<runId>` with the `stepId` in the audit entry, on the same ungated parity footing as built-in actions ([ADR 0026](../adr/0026-workflow-actions-may-call-the-public-api-as-the-run.md); [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 3.1). Every `ctx.api` mutation is also summarised on the step record (op + entity id), so the run view reports what a step did beyond its declared output.
- *(Amended 2026-10-05, [#89](https://github.com/theagenticage/hercule/issues/89).)* **`execute()` relies only on its `input` and its `ActionContext`.** It must not depend on anything `activate()` set up, such as a client or a cache, because it can run when the plugin is not active: a run that has already started still executes the actions of a plugin that is disabled meanwhile, or that failed to start (section 8).
- **No event emission from `execute()`.** An action wanting to inject ~~a signal~~ an event *(amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395): "signal" now names the Intake record)* calls the `event.emit` operation explicitly, which stamps `source: "manual"` and the actor; the `events` capability's emit belongs to ingest loops only.
- **No blocking waits**: an action that would wait for something external is instead expressed as a subscription-holding run, not an action that sleeps ([./07-workflows.md](./07-workflows.md)). This generalises ticket 16's no-blocking rule, stated for API endpoints, to action contributions.
- **Single-purpose is the shipped convention, not a mechanism.** The v1 rosters below each do one external thing and return output; routing decisions belong in the graph. `ctx.api` is the escape hatch for deterministic logic (fan-out bookkeeping over a list) that would otherwise demand a pointless agent step; routing written into `execute()` is the smell the review bar catches.

*(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78).)* **Registration is built; ~~execution is not~~** *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79): execution is built too, below)*. A plugin that requests `workflow-actions` registers an action with `host.workflowActions.register(...)`. The host qualifies the word, and refuses a word with a `/`, an empty or overlong description, an action registered twice, and an input that is not a struct, because a step writes its params as named fields. It persists the catalog row with the JSON Schema of the input and the output, which `workflowAction.query` answers. Validation decodes a literal param against the live input schema that the boot keeps in memory, as an emit is read against a kind's live payload schema. ~~`execute` is typed and not called: runs do not execute action steps yet ([#79](https://github.com/theagenticage/hercule/issues/79)). So `ActionContext` carries `connection?` and `run` only, and `api` and `signal` join it with the run engine;~~ `ActionError` is `{ code, message }`. A step can name the actions of a plugin that is enabled and started; the actions of any other plugin stay in the catalog, and validation refuses them ([./07-workflows.md](./07-workflows.md) section 1).

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* **Execution is built.** The run engine calls a plugin action's `execute(input, ctx)` as a step of a run:

- `input` is the step's `params`, with their templates rendered and then decoded against the action's input schema ([./07-workflows.md](./07-workflows.md) section 5). A decode failure fails the step with the code `validation`, and `execute` is not called.
- `ctx` carries `run` (`{ runId, stepId }`) and `signal`, an `AbortSignal` that aborts when the run is cancelled.
- `api` is not shipped, not even as a stub that fails. ~~It joins with the first plugin action that needs it.~~ *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* No GitHub action needs it, so it is left to a follow-up ticket.
- ~~`connection` is never set yet. A run is refused at start while it has a step that calls a plugin action which declares a Connection ([./07-workflows.md](./07-workflows.md) section 7.1). The first plugin action that needs a Connection decides which param names it, and how the core checks and resolves it.~~ *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* `connection` is set when the action declares a Connection: `{ id, credentials, config }`, with credentials read through the Connection type's runtime (OAuth refreshed) just before `execute`. The step names the Connection in its `connection` param, which never reaches `input` ([./07-workflows.md](./07-workflows.md) section 3). The step fails without calling `execute` when the Connection is missing (`not_found`), has another type (`validation`), or is disabled or its credentials cannot be read (`connection_unavailable`). A Connection in `error` or `needs-reauth` is passed on, and the action reports what its service answers.
- The step record stores `{ code, message }` from an `ActionError`. Any other failure is stored as the code `unexpected`, and the controller's log holds the details. Either way the run fails with `step-failed`.
- What `execute` returns is encoded with the action's `output` schema before it becomes the step's output. A value the schema refuses fails the step with the code `unexpected`, because later steps read the output and must not route on a value of the wrong shape.
- `execute` is called after the step record is `running` and has committed, outside any transaction, because it reaches outside the database. A step record found `running` when the controller starts fails with the code `interrupted`: the action may or may not have taken effect, and runs never retry one ([./07-workflows.md](./07-workflows.md) section 7.2).

The v1 rosters (the words follow the entity-verb shape of the operation vocabulary in [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md); the Intake prototype's `github.merge` is spelled `github/pr.merge`):

| Plugin | Actions |
|---|---|
| `github` | `github/issue.read`, `github/issue.comment`, `github/issue.update` (labels, assignees, state); `github/pr.read`, `github/pr.comment`, `github/pr.review` (approve / request-changes / comment), `github/pr.update` (labels, reviewers, draft/ready, base), `github/pr.merge` (method, delete-branch), `github/pr.create` (from an already-pushed branch); `github/checks.rerun` (re-runs a pull request's failed checks) *(added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#391](https://github.com/theagenticage/hercule/issues/391))* |
| `gmail` | `gmail/message.read` (full body, parsed text + html), `gmail/thread.read`, `gmail/message.search` (Gmail query syntax, headers only), `gmail/message.send`, `gmail/message.reply` (in-thread), `gmail/message.modify` (add/remove labels: archive, mark read, star); `gmail/thread.archive` (archives the whole thread) *(added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); [#519](https://github.com/theagenticage/hercule/issues/519))* |

*(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); decided in [#391](https://github.com/theagenticage/hercule/issues/391) and [#519](https://github.com/theagenticage/hercule/issues/519).)* **Which actions may answer a signal.** Each of these lists `usableIn: ["workflow.step", "signal.answer"]` and has a pure `describe`. Every other action in the rosters is a workflow step only.

- `github`: `pr.review`, `pr.comment`, `issue.comment`, `pr.merge` and `checks.rerun`. The read actions do not. No kind's `build` binds `pr.merge`; it is listed so that a `signal.raise` caller, such as triage's "Merge dev bumps" offer, can bind it ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#93-core-kinds-and-signalraise)).
- `gmail`: `message.reply` and `thread.archive`. `message.read`, `thread.read`, `message.search`, `message.send` and `message.modify` are workflow steps only, because a new mail is not an answer to a signal.

Which kind binds which action, as which button, is in [./08-events-and-connections.md](./08-events-and-connections.md) sections 5.1 and 5.2.

*(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); decided in [#519](https://github.com/theagenticage/hercule/issues/519).)* **Gmail's answers send what Gmail would send.**

- **`thread.archive`** archives every mail in the thread. `message.modify` acts on one message, so archiving through it would leave the earlier mails in the inbox. `message.modify` stays a workflow step only.
- **`markRead?: boolean`** is an input of `message.reply` and `thread.archive`, false unless set, and marks the whole thread read. A workflow step that replies or archives does not mark mail read on its own; an agent's "received, will look Monday" reply should leave the mail unread. `gmail/mail`'s `build` sets it to true, because the user has read the mail in Hercule before answering.
- **What `build` freezes into a reply's input**, so what the user sees is what is sent:
  - **Recipients.** Reply goes to the sender, or to their `Reply-To` address when the mail has one. Reply all adds the latest mail's other `to` and `cc` recipients, minus the user.
  - **The sending address.** The address the mail was sent to, when it is one of the user's send-as addresses (an alias such as billing@acme.dev on the noor@acme.dev mailbox); otherwise the mailbox's own address.
  - **The signature.** The user's Gmail signature for the sending address. A mailbox with no signature adds nothing.
- **What `message.reply` sends.** It answers the signal's own mail, which is always the thread's latest, because a newer mail replaces the signal. It sets `In-Reply-To` and `References`, and the subject gets "Re: ". The body is, in order:
  1. the user's text;
  2. the frozen signature, placed as Gmail places it;
  3. the answered mail, quoted in full below an "On <date>, <name> <address> wrote:" line, including whatever that mail quoted itself.

  It is sent as plain text and HTML, as Gmail sends it.
- **The describe lines**, for a Connection labelled `work`:
  - Reply: "Sends your reply to **Marta Visser** (marta@brightline.nl), with her mail quoted below, and marks the thread read · Gmail · as **work**"
  - Reply all: "Sends your reply to **Marta Visser** (marta@brightline.nl), cc **Joost Bakker** (joost@brightline.nl), with her mail quoted below, and marks the thread read · Gmail · as **work**"
  - Archive: "Archives **Invoice INV-2291 has our old company name** and marks it read · Gmail · as **work**"

  Every recipient is named with their address, never "and N more": a reply all to 40 people is exactly what the line must show, and the address makes a look-alike sender (marta@brightIine.nl) visible. "from **billing@acme.dev**" is added only when the sending address is not the mailbox's own. The typed text is left out.

*(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The nine `github` actions are built. Each acts through a `github/github` Connection. `issue.update` and `pr.update` also change the title, body and open or closed state; `pr.merge` also takes the commit title and message and the expected head commit.

*(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* How the `github` actions behave at the edges:

- `pr.review` takes its decision in the input field `verdict` (`approve`, `request-changes` or `comment`), and returns it in the output field `verdict`, spelled as in the `github.pr.review-submitted` event (`approved`, `changes-requested`, `commented`). A body is required unless the verdict is `approve`.
- `pr.merge` with `deleteBranch` reads the pull request first, and holds the merge to the head commit it read, unless the step gives `sha`. A commit pushed in between makes GitHub refuse the merge, and the step fails with `conflict`, instead of merging work nobody saw and deleting its branch. The branch is deleted in the repository it is in, which for a pull request from a fork is the fork. A branch that is already gone (GitHub's "Reference does not exist") counts as deleted. Any other failure to delete fails the step, with a message that says the merge itself happened.
- `pr.update` sends up to four requests, in order: the pull request's own fields, the labels, the reviewers, the draft state. When one fails, the rest are not sent, and the error names the change GitHub refused, the changes already made (which stay made) and the ones not tried.
- The error codes: `unauthenticated` for a 401, `rate_limited` for a 429 or a 403 that is a rate limit (a secondary one included), `forbidden` for any other 403 and for GraphQL's `INSUFFICIENT_SCOPES`, `not_found` for a 404 or a 410, `conflict` for a 405 or 409, `validation` for a 422, and `unavailable` when GitHub cannot be reached, does not answer, or fails with a 5xx. A `rate_limited` message says when to try again.
- Every request to GitHub, from an action or a feed, times out after 30 seconds, counted until the whole body is read. The token is sent only to `https://api.github.com`: a request to any other origin, such as a next-page link that points elsewhere, is not sent.

~~Anything git (clone, push, branch) is not an action: it happens in the run's workspace.~~ *(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257); [ADR 0035](../adr/0035-an-action-declares-where-it-runs.md): git is a built-in workspace action, below.)* ~~Gmail bodies stay out of ingest and are fetched on demand through `gmail/message.read` / `gmail/thread.read`~~ Gmail bodies stay out of the event's payload. A workflow fetches them on demand through `gmail/message.read` / `gmail/thread.read`, and `gmail/mail`'s `build` reads the thread to lay out the signal *(amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395))*. Where mail text is kept is in [./08-events-and-connections.md](./08-events-and-connections.md) section 5.2.

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
| `event-sources` | register + activate | register an event-source contribution (kinds + schemas, ~~per-connection config schema~~ feeds) *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The per-Connection config schema is the Connection type's (section 10) |
| `workflow-actions` | register | register workflow actions |
| `connections` | register + activate | declare the connection types the plugin services and their setup flow; at runtime list the plugin's own connections, read their decoded credentials and per-connection config, report connection status |
| `events` | activate | emit events into the pipeline ([ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)) |
| `notifications` | activate | emit a Notification, withdraw one of its own ([ADR 0012](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)) |
| `resources` | activate | read Resources (repos, mailboxes) relevant to the plugin's connection types, e.g. to ~~seed~~ build a watch list *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* As built, an ingest handle lists the Resources linked to its Connection through `ctx.resources` (section 4.3) |
| `secrets` | activate | plugin-scoped secrets service (section 7) |
| `kv` | activate | plugin-scoped state (section 6) |
| `public-api` | activate | a client for the public API (below) |

Rules:

- `channels` and `notifications` are the capability names pinned by the tickets; the remaining spellings are this spec's and MUST be used consistently. The `events` capability has one method, `emit`; "`events.emit`" in [./08-events-and-connections.md](./08-events-and-connections.md) names that method, not a separate capability. The *set* of services is pinned: contribution registration per extension point, events emit, notifications emit, connections, resources read, secrets, KV, public-API client.
- A capability's registration surface is what `register()` receives; its runtime surface is what `activate()` receives. `register()` never sees a runtime surface.
- *(Added 2026-09-06, [#63](https://github.com/theagenticage/hercule/issues/63).)* **~~Three~~ ~~Six~~ Eight of the eleven exist so far**: `providers`, `kv` and `secrets` ([#63](https://github.com/theagenticage/hercule/issues/63)), `connections` ([#71](https://github.com/theagenticage/hercule/issues/71)), `event-sources` ([#77](https://github.com/theagenticage/hercule/issues/77)), ~~and~~ `workflow-actions` ([#78](https://github.com/theagenticage/hercule/issues/78), registration only; executed since [#79](https://github.com/theagenticage/hercule/issues/79)), and `events` and `resources` ([#89](https://github.com/theagenticage/hercule/issues/89)). *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* *(Amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78): the count was not updated when `connections` and `event-sources` shipped.)* All eleven names are valid in a manifest, so a manifest never has to be rewritten as the rest arrive, but a plugin requesting one that is not implemented is refused at load with that capability named, on the same footing as a `hostApi` mismatch (section 8). Nothing is granted silently and nothing is granted empty.
- *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* **Signals need no capability of their own.** A plugin's signal kinds are part of its event source, so `event-sources` declares them and the core raises them (section 4.3). A Signal is not a Notification, so `notifications` plays no part in it (section 11).
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
- KV has two views over the same table. `activate()` receives the **plugin-scoped** store: global, connection-agnostic state (a repo metadata cache, a sender-rule override map). Ingest and channel handles additionally receive a **Connection-scoped** view (`ctx.state`), ~~keys physically `<pluginId>/<connectionId>/...`~~ *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* rows of their own `connection_state` table, keyed by Connection id and key ([./04-state-store.md](./04-state-store.md)): cursors and per-connection markers live there, so the core can wipe exactly that slice when the Connection is deleted or re-baselined, without knowing the plugin's key conventions.

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
| Per-connection config | ~~event-source contribution's per-connection schema~~ the Connection type's `configSchema` *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* | controller state, one per Connection | GitHub: ~~watched-repo list for this account~~ extra repositories to watch, and how many days of check results to watch *(amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89))* |
| Provider-instance config | `ProviderDefinition.configSchema` | one per provider instance; logical settings on the controller, path resolution per [./06-providers.md](./06-providers.md) section 2.1 and its Conflict line | Claude Code instance: isolated provider home |

*(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* Intake settings are not a fourth level of configuration. They are core-owned data that sits beside these three, and changing them restarts nothing (section 8.2).

Lifecycle rules:

- **Installed = compiled in.** The set of installed plugins is fixed by the binary. Settings > Plugins lists them ([./14-web-app.md](./14-web-app.md)); management operations sit under the `infra` grant family ([./13-security.md](./13-security.md)).
- **`hostApi` check at load.** A plugin whose `hostApi` does not match the controller's is not loaded; `register()` is not run for it, so it contributes nothing. The controller surfaces the mismatch in Settings > Plugins. Since v1 plugins are compiled in, a mismatch is a build error in practice.
- **Enabled/disabled flag** per plugin in controller state. Disabling runs the plugin's deactivate function and ~~removes the validity of every one of its contributions everywhere~~ stops all new work through its contributions *(amended 2026-10-05, [#89](https://github.com/theagenticage/hercule/issues/89))*: workflows referencing its actions fail validation loudly, channel bindings on its channels stop resolving, its event sources stop ingesting, its provider instances cannot start sessions. The contributions stay in the catalog, marked as from a disabled plugin, so the UI can say what is missing. *(Amended 2026-10-05, [#89](https://github.com/theagenticage/hercule/issues/89).)* A run that has already started is not new work. Its plan was frozen when it started, so it finishes, and its steps still execute the disabled plugin's actions. The same holds for a plugin that failed to start. A step fails with `not_found` only when no loaded plugin registered its action.
- **Config change or toggle = deactivate + reactivate.** There is no hot-reconfigure protocol; a plugin never observes a config change while running. Config writes are validated against the manifest schema before the restart.
- **Connections survive toggles.** A Connection is a core record; disabling its plugin stops ingest and outbound use but deletes nothing. *(Amended 2026-10-05, [#89](https://github.com/theagenticage/hercule/issues/89).)* Outbound use here means new work: a run that has already started still acts through the plugin's Connections (above). A Connection that is itself disabled still fails the step that acts through it, with `connection_unavailable`.

Failure handling:

- **`activate()` throws**: the plugin enters an **`errored`** state (beside enabled, disabled and the `hostApi` mismatch) with the error shown in Settings > Plugins, and one `core.plugin-error` Notification is emitted. There is no automatic retry loop - a broken plugin retrying every 30 seconds is noise; it is retried at the next controller boot or by the user's Retry button. Transient per-Connection trouble is the ingest loop's business (section 8.1), not this state's.
- **Deactivate fails**: logged, the plugin is marked `errored`, its contributions are treated as disabled, and Settings says a controller restart clears the leftover machinery.
- *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* **Stopping a plugin** closes its ingest handles first (section 4.3), then runs its deactivate function. Deactivate gets 10 seconds; one that has not returned by then counts as a failed deactivate, as above, with the `plugin.errored` audit row and the `core.plugin-error` Notification. A deactivate that hung would otherwise hold up every other plugin's start and stop, and the controller's shutdown.
- *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* **Shutdown stops every running plugin** the same way: its ingest handles are closed, then its deactivate runs, so it releases what `activate()` acquired. A plugin that fails to stop is logged, and the others are still stopped.

*(Amended 2026-09-06, [#63](https://github.com/theagenticage/hercule/issues/63).)* **Retry and Reset plugin state are operations**, not screen-local behaviour: `plugin.retry` and `plugin.resetState` in the catalogue ([./11](./11-public-api-and-agent-surface.md) section 2), under `infra.write` like the other plugin writes. Retry re-runs `activate()` once and is refused with `validation` on a plugin that is not `errored`, so the button is never a second spelling of Enable. Reset is deactivate, wipe the plugin's KV rows and the `connection_state` rows of its Connections *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)*, activate again when the plugin is enabled; it is allowed while `inactive` and while `errored` too, since leftover state is one of the things an errored plugin may be stuck on. Both are reachable from every client, not only from Settings, which is what makes them recoverable when the screen is what is broken.

*(Amended 2026-09-06, [#63](https://github.com/theagenticage/hercule/issues/63).)* Two states join the `hostApi` mismatch as **load-time refusals**, on the same footing: a manifest naming a capability the host has not implemented yet, and a `configSchema` the generated form cannot render. A refused plugin is listed with its reason, `register()` is never run for it, it contributes nothing, and every write on it is refused with `validation`. Nothing is substituted silently. Until a notifications domain exists, the `core.plugin-error` Notification above is an audit row (`plugin.errored`, carrying the plugin id, the phase and the message); the notifications ticket routes from it.

### 8.1 Ingest-loop failures

`open()` or `poll()` throwing is the common failure (network blip, rate limit). The core retries with exponential backoff (base = the feed's interval, cap 15 minutes); after 5 consecutive failures the Connection goes `error` with one Notification. A success resets the counter and recovers `connected` without user action. A plugin throws a typed `AuthError` to send the Connection straight to `needs-reauth`, no retries.

*(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The rules as built:

- Failures are counted per feed, and separately for `open()`. A defect counts as a failure and is logged. *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* A poll stopped after 5 minutes counts as a failure too (section 4.3). A write refused because the Connection was deleted or left `connected` and `error` is neither counted nor logged.
- The wait after the n-th failure in a row is the interval times 2^n, capped at 15 minutes, or at the interval when that is longer. A failed `open()` backs off from the shortest feed interval~~, or from 60 seconds for a source with no feeds~~ *(amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89): every source has a feed, section 4.3)*.
- At the 5th failure in a row, a `connected` Connection goes `error`, with the plugin's message as its status detail, and the core raises one `core.connection-error` Notification, whose title reads the Connection's label as it is then, not as it was when the handle opened *(amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89))* ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.2). The Notification leaves out the plugin's message, because agents read Notifications and the message may hold a credential; the Connection's card shows it.
- A successful poll resets that feed's count. ~~Once no count is at 5, an `error` Connection goes back to `connected`.~~ *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* An `error` Connection goes back to `connected` once every feed has polled successfully since the handle opened, each feed's latest poll a success. A successful `open()` resets the count of `open()` failures, but does not clear `error`, because it proves nothing about the feeds. A healthy Connection gets no status write when a poll succeeds.
- An `AuthError` sends a `connected` or `error` Connection to `needs-reauth` with the error's message as detail, and closes the handle. No Notification is raised for it. *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The exception: when the Connection's credentials changed while the `open()` or poll ran, as after a reconnect, the `AuthError` is ignored. The core waits one interval and tries again with the new credentials, because the rejected ones are already gone.
- A rate limit is not a failure: the plugin returns `nextAfterSeconds`, and the core waits that long when it is longer than the interval. *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* The wait is at most 86,400 seconds, and a value that is not a finite number is ignored.
- A status change never overwrites `disabled`. *(Amended again 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* This holds for every status a plugin or a failed OAuth refresh reports too, not only for the ingest loop's.

### 8.2 Intake settings

*(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); decided in [#397](https://github.com/theagenticage/hercule/issues/397).)*

Intake settings decide what a plugin's events put into Intake. Only the core reads them: a signal kind's rule runs in the core, and so do triage's query and Everything. The plugin's code never reads them. So they are core-owned data, not plugin config. They sit beside the three levels of configuration in section 8, not inside them, and a change needs no reload of the plugin and reopens no ingest handle ([./08-events-and-connections.md](./08-events-and-connections.md) section 8.2). There is no general key-value store for plugin settings: it would have no second consumer.

**Two switches, independent of each other:**

- **Available to triage**, per event kind. When it is on, triage may read every event of the kind, and Everything lists them. The plugin declares its default in the kind's `availableToTriage` (section 4.3). A kind that is off still reaches workflows and subscriptions, and its events stay in the event log.
- **On or off**, per signal kind. When it is on, the kind's rule runs on its `from` events, whatever their event kind's switch says. When it is off, the kind is never raised. A signal kind declares no default: every kind is on until the user switches it off, and a kind that a plugin update adds arrives on.

Example: `github.pr.checks-completed` is not available to triage, and `github/checks-failed` is on. A failed check on the user's pull request raises a signal, and triage never reads the hundreds of green check runs a day.

Which events these switches make into Intake's events, the set triage reads and Everything lists, is in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#910-intakes-events-and-handlings).

**Three levels.** Each level stores only the kinds where it differs from the level below:

1. the plugin's declared default, in code;
2. the user's choice for the plugin, for all its Connections;
3. the user's choice for one Connection.

Both switches exist at levels 2 and 3. A stored entry always wins, and a kind with no entry follows the level below. Choosing the value the level below already gives removes the entry, so the kind follows the level below again. The server applies this on every write.

- Example: the user switches `github/team-review-requested` off for the GitHub plugin, then on for the Connection "work". Two entries are stored: off for the plugin, on for "work". The Connection "personal" has no entry, so it follows the plugin and is off.
- Example: `github.pr.labeled` is off by default. The user switches it on, then off again. Nothing is stored, so if a plugin update later turns the default on, the change reaches the user.

The writes are `plugin.updateIntake` for level 2 ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#runner-plugin-provider-controller-grant-family-infra)) and the `intake` field of `connection.update` for level 3 ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#connection); the Connection's field is in [./08-events-and-connections.md](./08-events-and-connections.md) section 8.1). `plugin.read` and `connection.read` return the value in effect for every kind, with the level it comes from. The server works out the levels; no client merges them.

What a change affects:

- A signal kind switched on is raised only from new events. Nothing is backfilled.
- A signal kind switched off raises no new signals. Its open signals stay and end the usual way.
- An event kind switched on or off changes Intake's events at once, on read ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#910-intakes-events-and-handlings)).
- When a Connection is deleted, its entries are deleted with it.
- When a plugin is disabled, its entries are kept.
- An entry for a kind that a plugin update removed is ignored on read and dropped on the next write.

Core events (`run.failed`, `cron.tick`) have no plugin and no Connection, so in v1 they have no Intake settings: they are never available to triage and never raise a signal by themselves. This is a v1 scope line, not a rule. A workflow on `run.failed` may still raise a core signal through `signal.raise` ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#93-core-kinds-and-signalraise)).

## 9. Versioning

- One `hostApi` integer names the core host contract (hook signatures, manifest shape, catalog semantics). It is checked at load and is the only version number in the plugin system.
- **Capability APIs evolve additively.** New optional fields, new methods, new event kinds and new contribution facets are added without renaming.
- **A breaking change mints a new capability name** (`channels.v2`). The old name keeps working until it is retired; a plugin requests whichever it was built against. There is no per-capability version matrix and no version field on a capability. Load-time compatibility is one integer check plus name lookup.
- Contribution schemas (event kinds, action input/output schemas) follow the same rule inside a plugin: add, do not rename; a breaking change is a new contribution id. This extends ticket 11's rule, pinned for capability APIs, to contributions; it is the spec's extension.
- *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* **Intake's additions to the host contract.** Two of them are required, so they change the core host contract and raise `hostApi`: `availableToTriage` on every event kind, and `title` on every emitted event (section 4.3). The rest are additive: `signalKinds`, `openSignals()`, the identity on `IngestConnection`, `author`, `usableIn`, `describe` and the manifest's `mark`. This spec does not fix the new integer; the ticket that builds the change does.

## 10. Connections and plugin-defined connection types

Connections are core-owned; plugins define types and drive setup. The full Connection model, credential kinds, setup flows and the labels/topic rule are in [./08-events-and-connections.md](./08-events-and-connections.md). The plugin-side facts ([ADR 0010](../adr/0010-external-accounts-are-core-owned-connections.md)):

- A plugin **declares the connection types it services** through the `connections` capability. The plugin declares a bare word; the host mints the qualified id `<pluginId>/<word>` and that is the type everywhere downstream, so two plugins may declare the same word and both load ([ADR 0034](../adr/0034-a-catalog-contribution-is-identified-by-its-qualified-id.md)). Two plugins wanting the same external service each define their own type and the user authenticates twice. Deduping on OAuth identity is post-v1.
- The plugin **drives the flow that establishes a connection**: paste-a-token (GitHub PAT, Slack and Discord bot tokens), ~~or~~ a BYO-OAuth-client redirect flow to the controller's own origin (Google), or a device flow through an OAuth App whose public client id the plugin ships (GitHub) *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*. A type may offer more than one, and the user picks one per connection (section 10.1). Policy is pinned in [./13-security.md](./13-security.md): BYO OAuth client where the provider demands ~~one~~ a client secret, no Hercule-hosted relay, no shipped client secret, paste-a-token as the universal fallback. The controller displays the exact redirect URI derived from the origin the user's browser is using.
- The **core owns** storage, listing, status, the single connected-accounts UI, and the credential secrets. The plugin reads a connection's decoded credentials and per-connection config through the `connections` capability and reports status (for example "token expiring") back through it.
- **Ingest is per connection**: one ~~loop per enabled connection~~ handle per Connection that is `connected` or `error` *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)*, every event stamped with its `connectionId`. Triggers select connections explicitly; outbound actions name their connection.
- A Resource may reference the Connection used to reach it; the `resources` capability exposes that link to the plugin.

### 10.1 The setup-flow contribution

A connection type is declared in `register()` with its setup flow as **catalog data**: a list of steps from a small fixed set, rendered entirely by the core (no UI extension point exists), so the Connections screen can show what setting a type up takes before the plugin is even enabled.

```ts
interface ConnectionTypeContribution {
  type: string                                 // the bare word: "github", "gmail", "discord", "slack"; the host qualifies it to `<pluginId>/<word>`. No `/` in the word
  displayName: string
  setup: SetupStep[]
  validate(credentials: Record<string, string>): Effect<{ accountId: string; displayName: string; detail?: string }, ConnectionValidationFailed, HttpClient>  // the pasted fields, or { accessToken } from a redirect or device flow
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

*(Amended 2026-10-02, [#326](https://github.com/theagenticage/hercule/issues/326).)* `validate` returns `accountId` beside `displayName`: the provider's stable id for the account (GitHub: the numeric user id), which does not change when the account is renamed. It is required and must not be empty; the core treats a `validate` that returns an empty `accountId` as a failed validation. The Connection records it, and a reconnect compares it (the bullet "Reconnect reuses the Connection id" below). It stays inside the controller: the public API never returns it.

- **The core runs the OAuth dance.** One generic authorization-code client (PKCE, token exchange, refresh) lives in the core, parameterised by the plugin's `OAuthDeclaration`; the plugin writes no OAuth code and never touches the client secret. The device flow client (RFC 8628) sits beside it, parameterised by the plugin's `DeviceDeclaration`. It stores its tokens in the same `oauth.tokens` secret, but it has no refresh: refresh uses only the type's `OAuthDeclaration`, so a connection set up by a device flow is never refreshed *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*. Refreshed access tokens are what `ctx.connection.credentials` hands the plugin at poll or execute time; a refresh failure sets `needs-reauth` uniformly.
- **Callback routing**: the core mints an opaque `state` referencing a pending-setup row `{type, connectionId?, expiresAt}` (the qualified type names its plugin) and serves `/oauth/callback` itself; the row, not the plugin, is what the callback resolves. The plugin is never routed a request. The row also carries the connection the flow will write: `label`, `labels` and `config` on the same terms as the device flow's row below *(amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323))*.
- **Which flows a type offers.** *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))* Three steps each obtain the credential in their own way: `credentials` (the user pastes it), `oauth` (a redirect flow) and `device` (a device flow). A type declares the steps it offers; when it declares more than one, the user picks one for each connection. GitHub declares `device` and `credentials`. Registration refuses a type when:
  - it has an `oauth` or `device` step without the matching declaration, because the flow would have nowhere to go;
  - it has a declaration with no step for it, because nothing could ever use it;
  - it has both an `oauth` and a `device` step, because refresh uses the `oauth` declaration's client for every `oauth.tokens` secret, including one the device flow's client issued;
  - it declares a credential field named `oauth.tokens`, because the core would read the pasted value as a token set.
- **The flow belongs to the connection, not its type.** *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))* The core reads it from the secrets the connection holds. A connection set up by a redirect flow or a device flow holds the `oauth.tokens` secret, and `credentials()` hands the plugin `{ accessToken }`. A connection set up by paste holds the declared credential fields, and `credentials()` hands the plugin those fields. `validate` receives the same shape, so a type that offers both reads whichever it was given. A reconnect offers the same choice as a first setup, and replaces whichever secrets the connection held. It keeps the connection's label, topics and config *(amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323))*, and it must sign in to the same account (the bullet "Reconnect reuses the Connection id" below) *(amended 2026-10-02, [#326](https://github.com/theagenticage/hercule/issues/326))*. A refresh calls the provider outside any transaction, so it stores its new tokens, or marks the connection `needs-reauth`, only if the connection still holds the token set it started from; a refresh that a reconnect overtook changes nothing and fails, and the plugin asks again.
- **The device flow.** *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))* `connection.startDeviceFlow` asks the provider for a device code and writes a pending device setup row: `{setupId, type, connectionId?, label?, labels?, config?, deviceCode, interval, nextPollAt, expiresAt}`. *(Amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323).)* A row for a new connection holds `labels` and `config`, and `label` only when the user gave one; with no `label`, the connection is named after the account. A row for a reconnect holds the `connectionId` and none of the three, because a reconnect keeps the connection's label, topics and config. It returns the setup id, the user code, the verification page, the interval and the expiry. Unlike the redirect flow, whose `state` is the row's identity because the provider sends it back, the device flow's handle is an opaque `setupId` the controller mints: the device code never leaves the controller, because anyone holding it could collect the token once the user approves. Expired rows are deleted on the next start, as pending-setup rows are. The provider's `expires_in` is capped at 30 minutes, so an unusual answer from the provider cannot keep a row alive for long. Its `interval` is ~~capped at 60 seconds~~ never shortened, because RFC 8628 §3.5 forbids polling sooner than the provider asks *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*. A flow whose first poll would come after its expiry is refused at start, so no setup screen waits longer than the capped expiry. Polling follows these rules:
  - **The client drives it, the controller paces it.** There is no controller-side timer. The web app (or `hercule connection poll-device-flow`) calls `connection.pollDeviceFlow` while the setup screen is open. A poll before `nextPollAt` answers `pending` without calling the provider. A poll that does call the provider first moves `nextPollAt` one interval forward. So the provider is asked at most once per interval, even when several clients poll the same setup.
  - **An approval is used once.** When the provider issues the token, the poll deletes the row before it does anything else, so only one poll can turn a setup into a connection. Every outcome that ends the flow deletes the row, and a poll on an unknown, deleted or expired row answers `expired`.
  - **`validate` is retried.** After the row is deleted, the plugin's `validate` checks the token. A failure is retried, up to 3 attempts with a short backoff, because the provider will not issue the token a second time. If the last attempt fails too, the poll answers `failed` with a message that tells the user to start again for a new code.
  - **The outcomes** are `pending`, `slow-down` (the provider asked for slower polling; the answer carries the new interval: at least five seconds longer, as RFC 8628 §3.5 requires, or longer still when the provider names one. When the next poll would come after the expiry, the poll answers `failed` instead), `unreachable` (the provider could not be reached this time; the flow stays open), `done` (with the connection), `expired`, `denied` (the user declined at the provider) and `failed` (the provider refused the flow for another reason, such as a bad client id or device flow being disabled on its app, or `validate` still failed after its retries, or *(amended 2026-10-02, [#326](https://github.com/theagenticage/hercule/issues/326))* a reconnect signed in to another account, as the bullet "Reconnect reuses the Connection id" below describes). The last four end the flow.
  - **On `done`** the token set is stored under `oauth.tokens`, as a redirect flow stores it. It is never refreshed: a type with a `device` step has no `OAuthDeclaration`, and refresh needs one. A GitHub OAuth App token never expires and comes with no refresh token, so it needs no refresh. When the provider stops accepting the token, the plugin reports `needs-reauth` (section 8.1), and the user signs in again.
- **Token endpoint errors.** *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))* Some providers, GitHub among them, answer a token request they refuse with HTTP 200 and an `error` field in the body. A body with an `error` field is never a success, whatever the status. What it means depends on the request:
  - In a code exchange or a refresh, any `error` is a refusal. A refused refresh sets `needs-reauth`, never the retried `error` state, because waiting will not fix it.
  - In a device flow poll, the RFC 8628 codes are the poll's outcomes: `authorization_pending` is `pending`, `slow_down` is `slow-down`, `expired_token` is `expired` and `access_denied` is `denied`. Any other code is `failed`. An HTTP 403 or 429 with no `error` field is `unreachable`, not a refusal: it is how a provider such as GitHub rate limits, and waiting fixes it.
- **A pending setup is not a Connection.** The Connection record exists once `validate()` has passed; `validate` names the account (`displayName`: the GitHub login, the Gmail address) for the Connections screen. *(Amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323).)* A new connection given no label is named after the account when its record is written, after `validate`: its label is the `displayName`, or the type's own `displayName` (such as "GitHub") when the account name is empty or only whitespace, cut to at most 128 UTF-16 code units without splitting a character. A reconnect stores the new `displayName` and keeps the label. The status enum stays `connected | needs-reauth | error | disabled` ([./08-events-and-connections.md](./08-events-and-connections.md) section 8.1).
- **Reconnect reuses the Connection id**, so triggers and Resources stay attached ([./08-events-and-connections.md](./08-events-and-connections.md) section 8.4). *(Amended 2026-10-02, [#326](https://github.com/theagenticage/hercule/issues/326).)* Because the id is kept, a reconnect must sign in to the same account. The core compares the `accountId` that `validate` returns with the one the Connection recorded, never the names: an account renamed at the provider is still the same account, and its reconnect is accepted. Every path that replaces a Connection's credentials makes this check: a reconnect through the redirect flow, a reconnect through the device flow, and `connection.setCredentials`. A sign-in or a credential for another account is refused, and nothing is written: the secrets, the `displayName` and the status stay as they were. The user is told to create a new Connection for that account. Each path reports the refusal its own way:
  - `connection.setCredentials` fails with `invalid_state`, and the message names both accounts.
  - A device flow poll answers `failed`, and the message names both accounts.
  - A redirect flow returns to the Connections screen with the outcome `other-account`. The outcome travels in the URL as a fixed word, so its message cannot name the accounts.

  In both token flows the account is known only after the user approved at the provider, so the refused token is thrown away.

## 11. Notifications from plugins

Rationale and the full Notification model: [ADR 0012](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md), [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md). At the plugin boundary:

- **Producing.** A plugin with the `notifications` capability emits a Notification (for example Gmail warning that its OAuth token is expiring). It becomes one persisted core-owned Notification record like every other producer's. The plugin decides nothing about delivery. The same capability offers `withdraw(notificationId, reason)` for a decision the plugin raised whose question has stopped existing ("token refreshed"); it works only on the plugin's own notifications, and it is the only mutation a producer has - records are otherwise immutable ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.7).
- **Delivering.** Delivery is core-push, never plugin-claim. The core router alone decides fan-out. A **sink** is a channel contribution that optionally implements notification delivery; it rides the channel extension point, so the fixed set of four stays intact. The web app's notification center always records the notification regardless of sinks.
- **User control.** The user toggles delivery per channel connection. V1 routing policy is deliver-to-all-enabled. **Producer-side muting** (silence a chatty plugin's notifications) is a separate control from sink-side toggles.
- **Sink contract grows additively.** V1 sinks implement `deliver` (returning a delivery ref) and `resolved` (edit the delivered message when the decision is taken anywhere), and report clicks to the core, which authenticates and executes them ([./12-assistants.md](./12-assistants.md) section 11.6). Post-v1 fields (device class, presence, receipts) are optional; a sink that reports nothing is treated as always available. Presence-aware routing lands as a router upgrade touching no plugin.
- **No second path.** A plugin MUST NOT deliver a user-facing notification by any route other than the `notifications` capability, even when it has a channel connection in hand. Assistants speaking unprompted in a conversation are not notifications; the no-double-fire rule and its router mechanism are in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.5.
- *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* **Signals are not Notifications.** A review request, or a mail the user has to answer, becomes a Signal in Intake, raised by the core from the plugin's signal kinds (section 4.3). It is its own record, never a Notification, and the `notifications` capability plays no part in it ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#91-the-record)). A plugin's Notifications are messages about the plugin itself, such as Gmail's expiring token. Signals are not delivered to chat sinks in v1.

## 12. V1 inventory

### Built-in plugins

| Plugin | Contributions | Connection types | Notes |
|---|---|---|---|
| `github` | event source (watched-repo polling: issue and PR lifecycle, notifications); workflow actions | `github/github` (~~PAT paste; BYO OAuth app + device flow optional~~ device flow through Hercule's own OAuth App, PAT paste as the fallback *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*) | per-connection watch list ~~seeded from repo Resources~~ *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* made of the linked repo Resources and the repos in the Connection's config, read on every poll; git credentials for runners derive from these Connections ([ADR 0016](../adr/0016-git-credentials-derive-from-connections.md)). *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* Its event source declares six signal kinds, from `github/review-requested` to `github/checks-failed` ([./08-events-and-connections.md](./08-events-and-connections.md) section 5.1), and the manifest ships its mark |
| `gmail` | event source (`history.list` polling: headers, subject, snippet, ids); workflow actions (body fetch on demand) | `gmail/gmail` (BYO Google OAuth client, redirect flow) | emits `system` enrichment where a sender rule recognises the originating system. *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* A sender rule matches subdomains too: `em.sentry.io` counts as Sentry. Its event source declares one signal kind, `gmail/mail` ([./08-events-and-connections.md](./08-events-and-connections.md) section 5.2), and the manifest ships its mark |
| `discord` | channel (+ notification sink) | `discord/discord` (bot token paste) | conversation container = channel or DM |
| `slack` | channel (+ notification sink) | `slack/slack` (bot token paste) | conversation container = thread |
| `claude-code` | provider definition | none | adapter built into the runner |
| `codex` | provider definition | none | adapter built into the runner |
| `pi` | provider definition | none | adapter built into the runner; child process per session |

Behaviour per plugin: providers in [./06-providers.md](./06-providers.md), event sources and connections in [./08-events-and-connections.md](./08-events-and-connections.md), channels in [./12-assistants.md](./12-assistants.md).

### Core emitters and built-ins that are not plugins

- **Cron**: a core scheduler emitting `cron.tick` into the pipeline; schedules live in workflow start triggers.
- **Manual**: direct run creation and the synthetic-event API.
- **Platform events**: `run.completed`, `run.failed`, `run.cancelled`, `task.created`, `task.updated`, emitted by the controller. *(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* Also `signal.screening-requested`, which the core emits when a signal kind's rule cannot decide and which starts the Screener ([./08-events-and-connections.md](./08-events-and-connections.md) section 5.5).
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
- The signal kind contract: what a plugin declares - https://github.com/theagenticage/hercule/issues/389
- Answers: plugin actions, the Reply and Done - https://github.com/theagenticage/hercule/issues/391
- Everything: events, handlings and search - https://github.com/theagenticage/hercule/issues/393
- The desktop Intake screen in spec 17 (plugin marks) - https://github.com/theagenticage/hercule/issues/394
- Write the Intake changes and the build tickets that replace #91 - https://github.com/theagenticage/hercule/issues/395
- Plugin intake settings - https://github.com/theagenticage/hercule/issues/397
- Gmail's answers: what a gmail/mail signal offers - https://github.com/theagenticage/hercule/issues/519

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
