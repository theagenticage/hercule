# Research: t3-code's provider integration and remote support

Resolves rogierpennink/hydra#22. Source: [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (shallow clone, 2026-08-20). File paths below are relative to that repo.

TL;DR for hydra:

- Claude subscription auth is **not a token trick**: t3-code spawns the user's installed Claude Code CLI through the Agent SDK (`pathToClaudeCodeExecutable`) and lets the CLI use its own stored OAuth login. Multi-account = `CLAUDE_CONFIG_DIR` per provider instance.
- The provider abstraction is a small imperative adapter interface plus one large normalized event union (`ProviderRuntimeEvent`, ~48 event types). Providers stay dumb; an event-sourced orchestration engine above them owns state.
- Remote support never splits the runtime. One server owns everything; "remote" is purely a connection concern (direct WS, relay tunnel, Tailscale, desktop-managed SSH). This maps directly onto hydra's controller/runner question - t3-code's answer is "there is no controller/runner split; there are servers and clients".

## 1. Claude subscription auth

### Mechanism

t3-code depends on `@anthropic-ai/claude-agent-sdk` (`apps/server/package.json`, `^0.3.170`) and drives it in-process from the server:

- `ClaudeAdapter` (`apps/server/src/provider/Layers/ClaudeAdapter.ts`) calls the SDK's `query()` with `pathToClaudeCodeExecutable` pointed at the user's installed `claude` binary (configurable `binaryPath`, default `claude`). The SDK spawns that CLI as a subprocess; the CLI performs API calls with whatever credentials it has.
- **Auth is fully delegated to Claude Code's own login.** The user runs `claude auth login` (browser OAuth) once; the CLI stores the OAuth credential in the macOS keychain / its config dir. t3-code never sees, extracts, or refreshes the token. No `claude setup-token`, no keychain reads, no `CLAUDE_CODE_OAUTH_TOKEN`.
- Multiple accounts: `ClaudeSettings.homePath` sets `CLAUDE_CONFIG_DIR` on the spawned process (`apps/server/src/provider/Drivers/ClaudeHome.ts`). The code comment is instructive: they deliberately do NOT override `HOME`, because relocating `HOME` breaks the macOS keychain lookup and the CLI reports "Not logged in". `CLAUDE_CONFIG_DIR` isolates config while keeping the keychain reachable. Each config dir is a separate login, so work/personal accounts are two provider instances (`docs/user/providers-claude.md`).
- Auth status detection: a periodic capability probe (`probeClaudeCapabilities` in `apps/server/src/provider/Layers/ClaudeProvider.ts`) runs a throwaway SDK `query()` (`persistSession: false`, hooks disabled, MCP stripped, 25s timeout) and reads the SDK's init-message `AccountInfo`: `email`, `subscriptionType` (mapped to labels Pro/Max/Max 5x/Max 20x/Team/Enterprise), `tokenSource`, `apiProvider` (`firstParty` vs `bedrock`). That is how the UI shows "Claude Max Subscription" per instance. The probe cache is keyed by binary + resolved config dir so two instances never cross-contaminate account metadata.
- API-key and third-party routes exist as environment variables on the provider instance, not as separate code paths: `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` for OpenRouter/Claude Code Router (docs show setting `ANTHROPIC_API_KEY` to empty to stop the CLI from using the cached Anthropic login).

### ToS caveats

None visible in code or docs - and that is the point of the design. Because the actual API traffic is produced by unmodified Claude Code, launched via Anthropic's own Agent SDK, with the user's own interactive login, t3-code stays inside the supported "wrap the harness" posture rather than harvesting an OAuth token and calling the API directly. Hydra should copy this: **never extract subscription tokens; always let the vendor CLI hold its own credentials.** (`claude setup-token` exists for headless use, but t3-code does not touch it; on a headless box the user logs in via the CLI inside the same config dir.)

### Session mechanics worth copying

- One long-lived `query()` per thread with a streaming prompt queue; `resume: <sessionId>` for continuation, `includePartialMessages: true` for deltas.
- Permissions via the SDK's `canUseTool` callback: the adapter turns each callback into a normalized `request.opened` event, parks the promise, and resolves it when the client answers `thread.approval.respond`. `AskUserQuestion` and `ExitPlanMode` are special-cased into structured user-input requests.
- Runtime modes map to SDK permission modes: `auto-accept-edits` -> `acceptEdits`, `full-access` -> `bypassPermissions` (+ `allowDangerouslySkipPermissions`).
- t3-code injects itself as an MCP server into the session (`mcpServers: { "t3-code": { type: "http", url, Authorization } }`) - a clean back-channel for host-provided tools.
- Windows spawn gotcha (`apps/server/src/provider/Drivers/ClaudeExecutable.ts`): the SDK spawns `pathToClaudeCodeExecutable` without a shell, so `claude.cmd` npm shims fail with `spawn EINVAL`; they resolve the shim to the real `bin/claude.exe`/`cli.js`.

## 2. Provider abstraction

### Shape

Three layers, all in `apps/server/src/provider/`:

1. **Driver** (`ProviderDriver`): static descriptor - `driverKind`, `configSchema` (Effect Schema), `defaultConfig`, and `create()` which builds a `ProviderInstance` (snapshot stream + adapter + text generation) in a child scope. Five built-ins in `builtInDrivers.ts`: `codex`, `claudeAgent`, `cursor`, `grok`, `opencode`.
2. **Registries**: `ProviderInstanceRegistry` (config -> live instance, keyed by `ProviderInstanceId`; multiple instances per driver) and `ProviderAdapterRegistry` (instance id -> live adapter).
3. **`ProviderService`**: routes by *thread*, not provider - callers name a thread; a session directory resolves which adapter owns it.

The adapter contract (`apps/server/src/provider/Services/ProviderAdapter.ts`) is small:

```
provider, capabilities { sessionModelSwitch: "in-session" | "unsupported" }
startSession / sendTurn / interruptTurn
respondToRequest (approval) / respondToUserInput
stopSession / stopAll / listSessions / hasSession
readThread / rollbackThread          // provider-native history, powers checkpoint revert
streamEvents: Stream<ProviderRuntimeEvent>   // the one output channel
```

All provider output flows through the single `streamEvents` stream; there are no per-call result streams.

### What is normalized

`ProviderRuntimeEvent` (`packages/contracts/src/providerRuntime.ts`) is a discriminated union of ~48 event types with a common base (`eventId`, `provider`, `providerInstanceId`, `threadId`, `createdAt`, optional `turnId`/`itemId`/`requestId`, optional provider-native `providerRefs`, optional `raw`). Normalized vocabulary:

- **Session/thread/turn lifecycle**: `session.started|configured|state.changed|exited`, `thread.started|state.changed|metadata.updated`, `turn.started|completed|aborted`, plus plan updates and turn diffs.
- **Items**: `item.started|updated|completed` with `CanonicalItemType` (`user_message`, `assistant_message`, `reasoning`, `plan`, `command_execution`, `file_change`, `mcp_tool_call`, `dynamic_tool_call`, `web_search`, `image_view`, `context_compaction`, `error`, `unknown`).
- **Streaming**: one `content.delta` event with a `RuntimeContentStreamKind` (`assistant_text`, `reasoning_text`, `plan_text`, `command_output`, ...).
- **Permissions**: `request.opened|resolved` with `CanonicalRequestType` (`command_execution_approval`, `file_change_approval`, `apply_patch_approval`, `tool_user_input`, ...), plus `user-input.requested|resolved` for structured questions. Approval decisions are a normalized `ProviderApprovalDecision`.
- **Subagents/hooks**: `task.started|progress|updated|completed` with a shared status vocabulary (Claude's `killed`->`cancelled`, `paused`->`idle` mapped at the adapter), `hook.*`, `tool.progress`.
- **Usage**: `thread.token-usage.updated` carries a normalized `ThreadTokenUsageSnapshot` (used/max, input/cached/output/reasoning, per-turn `last*` figures, `compactsAutomatically`).
- **Account/ops**: `auth.status`, `account.updated`, `account.rate-limits.updated`, `mcp.status.updated`, `model.rerouted`, `config.warning`, `runtime.warning|error` (with error class).

Cost is deliberately NOT normalized in the runtime stream. A separate usage subsystem (`packages/contracts/src/usage.ts`) scans the provider CLIs' own transcripts (`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/*.jsonl`, ccusage-style) and prices tokens against a LiteLLM rate table, tagging each bucket `providerReported` / `modelPriced` / `unpriced`. Smart: usage stays complete even for turns run outside t3-code, and subscription plans don't produce per-request cost anyway.

### What leaks through per-provider

- Every event may carry `raw` (`RuntimeEventRaw`): the untouched provider payload tagged with its source (`claude.sdk.message`, `claude.sdk.permission`, `codex.app-server.notification`, `acp.jsonrpc`, ...). Debuggability without polluting the canonical schema.
- Several payload fields are `Schema.Unknown` (account info, rate limits, MCP status, item detail) - normalized envelope, provider-shaped body.
- Per-driver config schemas differ (`ClaudeSettings` has `homePath`; `CodexSettings` has app-server args) and model/option descriptors are provider-specific (Claude effort/1M-context/fastMode, Codex service tier).
- Capabilities flags cover behavioral gaps (only some providers can switch model mid-session).
- Transports are entirely per-adapter: Claude = Agent SDK in-process; Codex = `codex app-server` JSON-RPC over stdio (own package `packages/effect-codex-app-server`); Cursor and Grok = ACP, the Agent Client Protocol (own package `packages/effect-acp`); OpenCode = its SDK/event stream. The `RuntimeEventRawSource` union is the honest list.

### Orchestration above the adapters

Providers do not own state. Clients dispatch typed commands over one RPC method (`orchestration.dispatchCommand`); a single-fiber **event-sourced engine** (`OrchestrationEngine`) turns commands into persisted events (SQLite, `node:sqlite`), applies them to projections in the same transaction, and publishes to `orchestration.subscribeThread` subscribers. Three queue-backed "drainable workers" bridge to providers: `ProviderRuntimeIngestion` (adapter event stream -> orchestration commands), `ProviderCommandReactor` (intent events -> adapter calls), `CheckpointReactor` (workspace checkpoints as hidden git refs around each turn, powering exact diffs and revert of both workspace and provider conversation via `rollbackThread`). Command receipts make retries idempotent; `drain()` gives deterministic tests instead of sleeps.

## 3. Remote support

### Architecture: one runtime boundary

From `docs/internals/remote.md`: *"a client talks to a T3 server over HTTP and WebSocket, and the server owns orchestration, providers, terminals, git, and filesystem operations. Remoteness is expressed at the connection layer, never by splitting the runtime."*

- An **ExecutionEnvironment** = one running T3 server, identified by a stable `environmentId` persisted at `<stateDir>/environment-id`. It owns provider auth, projects/threads, terminals, git, filesystem.
- Clients (web/desktop/mobile, sharing `packages/client-runtime`) keep local "known environment" records and a connection supervisor. There is **no central control plane**: the hosted web app stores environment entries browser-locally, and the relay is not in the hot path.
- Protocol: **Effect RPC over a single authenticated WebSocket** (`/ws`), typed contract in `packages/contracts/src/rpc.ts`. Unary methods + server-stream subscriptions (`orchestration.subscribeThread`, `terminal.attach`, ...). No hand-rolled push bus.
- There is **no session handoff or routing between machines**. A thread lives in exactly one environment. `RepositoryIdentity` groups projects across environments for UI only, never for routing. Reconnect = re-open the WebSocket and re-subscribe.

### Access methods (client-side taxonomy, `packages/client-runtime/src/connection/model.ts`)

| Target | What it is |
| --- | --- |
| `PrimaryConnectionTarget` | Platform-managed local server (desktop backend / CLI-served web) |
| `BearerConnectionTarget` | Any manually paired direct ws/wss endpoint |
| `RelayConnectionTarget` | Managed "T3 Connect" relay tunnel |
| `SshConnectionTarget` | Desktop-managed SSH environment |

Tailscale is deliberately *not* a target kind - the server runs `tailscale serve` and the resulting URL pairs through the ordinary bearer path. Endpoint *providers* contribute `AdvertisedEndpoint` records (URL pair + reachability hints); clients treat them as hints and let the connection attempt decide.

- **Pairing**: server prints/serves a pairing URL with a one-time code; hosted app variant puts the token in the URL *hash* so it never reaches the hosted origin, exchanges it directly with the backend, and stores the environment locally.
- **Relay (T3 Connect)**: for NAT'd hosts and mobile. A Cloudflare Worker (`infra/relay`) authenticated via Clerk (template JWTs for apps; PKCE public-client OAuth for the CLI, with an out-of-band paste-a-code flow for SSH/headless) brokers credentials and provisions a managed `cloudflared` tunnel hostname. **Application traffic then flows over the tunnel, not through the relay worker.** `t3 connect link` records intent; the next `t3 serve` reconciles and launches the tunnel.
- **SSH**: a launch-and-access helper owned by the desktop main process (`packages/ssh/src/tunnel.ts`): discover hosts from SSH config, launch or reuse a remote `t3` server, open a local port forward, health-check, optionally mint a remote pairing token, hand the renderer a local URL. Disconnect stops the server only if the launcher started it (servers marked `external` are left running). Explicit failure handling at each stage; no silent endpoint fallback.

### Environment auth

OAuth-shaped, capability-scoped (`docs/internals/environment-auth.md`): pairing links grant scope strings (`orchestration:read`, `orchestration:operate`, `terminal:operate`, ...); a one-time bootstrap credential is exchanged at `POST /oauth/token` (RFC 8693 token-exchange shape) for a 30-day bearer or 1-hour DPoP-bound token; every RPC method has a required scope. WebSocket upgrades use a short-lived (5 min) single-purpose ticket fetched over HTTP - never the long-lived token in a query string. Version coordination: the environment descriptor carries the server version so clients can prompt upgrades; the connection supervisor treats it as an ordinary reconnect.

## 4. Borrow / avoid for hydra

Borrow:

- **Auth by delegation.** Spawn vendor harnesses under their own logins; isolate accounts with the vendor's config-dir env var (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`); read account/subscription status from the harness's own init/status output. Never extract tokens.
- **Thin imperative adapter + fat normalized event union.** ~12 methods and one event stream is enough to cover five very different harnesses. Normalize lifecycle, items, deltas, approvals, tasks, token usage; keep `raw` passthrough tagged by source; allow `Unknown` payload bodies where vendors disagree.
- **Route by thread, not provider**; separate instance-config registry from live-adapter registry; multiple instances per driver as a first-class concept.
- **Event-sourced orchestration with events and projections in one transaction**, single-fiber command processing, idempotent command receipts, and drainable workers for deterministic tests. This is a strong fit for hydra's controller.
- **Remote = connection concern.** Stable environment id, advertised-endpoints-as-hints, pairing via one-time code with token-in-hash, short-lived WS tickets, scoped capabilities per RPC method. Relay only brokers - data flows over the tunnel.
- **Turn-bracketing checkpoints as hidden git refs**, with paired provider-side `rollbackThread`, for exact diffs and revert.
- **Usage from vendor transcripts** (ccusage approach) rather than trying to meter through your own pipeline.
- Small ops details: Windows npm-shim resolution for SDK spawns; capability probes with hooks/MCP disabled so health checks have no side effects; buffered-delta spill thresholds for slow clients.

Avoid / diverge:

- t3-code has **no controller/runner split and no cross-machine session routing** - each server is an island and clients aggregate. If hydra genuinely needs central orchestration across runners (queueing, scheduling, fleet view), that layer must be hydra's own; t3-code offers no prior art beyond "don't put the relay in the hot path".
- The event union is large (~48 types) and grew compatibility aliases and migration-era optional fields (`providerInstanceId` optional "during the driver/instance migration"). Starting fresh, hydra can keep the taxonomy but trim (realtime audio, hooks, files-persisted are t3-specific).
- The whole codebase is Effect-TS (Effect RPC, Effect Schema, fibers, scopes). The architecture transfers without Effect, but the code does not - treat it as a design reference, not a vendoring source.
- ACP (Agent Client Protocol) is how Cursor and Grok plug in; if pi.dev speaks ACP or JSON-RPC, an ACP-style adapter may be cheaper than a bespoke one - but t3-code still wrote a bespoke adapter per harness on top of the shared protocol client. Budget for that.
