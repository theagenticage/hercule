# Research: Codex app-server protocol

Resolves [#3](https://github.com/rogierpennink/hydra/issues/3). Feeds the provider adapter interface ticket (#12).

Primary sources: `openai/codex` repo at tag `rust-v0.148.0` (released 2026-08-18, [releases](https://github.com/openai/codex/releases/tag/rust-v0.148.0)) and the official Codex docs (developers.openai.com, which now redirects to learn.chatgpt.com). The authoritative protocol document is the [app-server README](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/README.md) - it is what OpenAI's own VS Code extension is built on.

## TL;DR for adapter designers

- Spawn `codex app-server`, speak newline-delimited JSON-RPC 2.0 over stdio (the `"jsonrpc":"2.0"` field is omitted on the wire). One `initialize` request + `initialized` notification per connection, then thread/turn APIs.
- Core model: **Thread** (conversation) > **Turn** (one user input to agent completion) > **Item** (message, reasoning, command, file change, tool call). Drive with `thread/start` / `thread/resume` / `thread/fork` and `turn/start`; stream `item/*` and `turn/*` notifications.
- Approvals are **server-to-client JSON-RPC requests** (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`). The adapter must answer them or the turn stalls.
- Auth: ChatGPT OAuth (browser or device-code) or API key, both exposed as `account/*` RPCs; credentials persist in `$CODEX_HOME/auth.json` (default `~/.codex`), so headless machines can reuse a copied auth file.
- Fully headless-capable: stdio transport, no TTY. Sandboxing (Seatbelt on macOS, bubblewrap on Linux) is enforced by Codex itself, not the client.
- Stability: a stable/experimental split gated by `capabilities.experimentalApi`, with generated TypeScript types per CLI version (`codex app-server generate-ts`). No cross-version protocol guarantee - pin the CLI version and regenerate types on upgrade.

## 1. Startup and transport

- The app server is a subcommand of the Codex CLI: `codex app-server`. The CLI ships on npm as `@openai/codex` (bundles platform binaries, including `codex-linux-sandbox`; see [linux-sandbox README](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/linux-sandbox/README.md)).
- Protocol: "bidirectional communication using JSON-RPC 2.0 messages (with the `"jsonrpc":"2.0"` header omitted on the wire)" - [README, Protocol](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/README.md#protocol).
- Transports (same section):
  - **stdio** (default, `--stdio`): newline-delimited JSON (JSONL). The one to build on.
  - websocket (`--listen ws://IP:PORT`): explicitly "experimental / unsupported... Do not rely on it for production workloads".
  - unix socket (`--listen unix://...`): websocket-over-unix-socket for local control-plane clients; `codex app-server proxy` bridges it to stdio.
- Handshake: exactly one `initialize` request per connection (client sends `clientInfo {name, title, version}`, optional `capabilities`), then an `initialized` notification. Requests before that get `"Not initialized"`; a second `initialize` gets `"Already initialized"` ([README, Initialization](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/README.md#initialization)).
- `initialize` response returns the server's user-agent string, `codexHome`, and platform info. `capabilities.optOutNotificationMethods` suppresses named notifications per connection (exact match only).
- Backpressure: bounded internal queues; when saturated, requests fail with JSON-RPC error `-32001` "Server overloaded; retry later." Clients should retry with exponential backoff + jitter (README, Protocol).
- Logging: `RUST_LOG` filters; `LOG_FORMAT=json` emits JSON tracing on stderr.

## 2. Session / thread lifecycle

All from [README, Lifecycle Overview and API Overview](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/README.md#lifecycle-overview):

- `thread/start` - new conversation. Params: `model`, `cwd`, `approvalPolicy`, `sandbox` (or experimental `permissions` profile - the two cannot be combined), `personality`, `ephemeral: true` for in-memory-only threads. Emits `thread/started` and auto-subscribes the connection to that thread's turn/item events. Note: starting with `cwd` + `workspace-write` marks that project trusted in the user's `config.toml`.
- `thread/resume` - reopen a stored thread by id; same override rules as `thread/start`. By default replays full turn history in `thread.turns`; `excludeTurns: true` plus `thread/turns/list` pages it instead. Resume uses the thread's last persisted model/reasoning unless overridden.
- `thread/fork` - branch a stored thread into a new thread id with copied history; optional `lastTurnId` boundary.
- `thread/list` (cursor pagination, filters), `thread/read` (inspect without resuming), `thread/archive` / `thread/unarchive` / `thread/delete`, `thread/name/set`, `thread/compact/start` (history compaction).
- `turn/start` - add user input, begin generation. Returns the initial `turn` object immediately; progress streams as notifications. Per-turn overrides for model, cwd, sandbox policy, approval policy.
- `turn/steer` - inject additional user input into an in-flight turn (rejected for review/compaction turns).
- `turn/interrupt` - cancel by `(threadId, turnId)`; the turn ends with `status: "interrupted"`.
- Threads persist as rollout files under the Codex home (the TS SDK docs name `~/.codex/sessions` - [sdk/typescript/README](https://github.com/openai/codex/blob/rust-v0.148.0/sdk/typescript/README.md)). Unsubscribing (`thread/unsubscribe`) keeps a thread loaded; the server unloads it after 30 minutes with no subscribers/activity, then emits `thread/closed`.
- Single-writer constraint: only one app-server process can hold a paginated thread open for writing; a second process's `thread/resume`/`archive`/`delete` fails with JSON-RPC `-32600` (README, "Example: Start or resume a thread").

## 3. Streaming events

JSON-RPC notifications on stdout after `turn/start` ([README, Events](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/README.md#events)):

- Turn level: `turn/started` -> item events -> `turn/completed` (`turn.status`: `completed` | `interrupted` | `failed`; failures carry `{error: {message, codexErrorInfo?}}`). Also `turn/diff/updated` (aggregated unified diff snapshot after each file change) and `turn/plan/updated` (agent plan steps). Token usage streams separately via `thread/tokenUsage/updated`.
- Item lifecycle is always `item/started` -> zero or more deltas -> `item/completed` (authoritative final state).
- Item types (`ThreadItem` tagged union): `userMessage`, `agentMessage`, `plan`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `collabToolCall`, `webSearch`, `imageGeneration`, `imageView`, `sleep`, `enteredReviewMode`/`exitedReviewMode`, `contextCompaction`.
- Delta notifications: `item/agentMessage/delta` (streamed text), `item/reasoning/summaryTextDelta` and `item/reasoning/textDelta`, `item/commandExecution/outputDelta` (live stdout/stderr).
- Mid-turn errors arrive as an `error` notification with a `codexErrorInfo` enum (`ContextWindowExceeded`, `UsageLimitExceeded`, `HttpConnectionFailed {httpStatusCode?}`, `Unauthorized`, `SandboxError`, ...) and may precede `turn/completed` with `status: "failed"` (README, Errors).

## 4. Approval / permission flow

Server-initiated JSON-RPC **requests** to the client; the client must respond ([README, Approvals](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/README.md#approvals)):

- Command execution: `item/started` (pending `commandExecution`) -> `item/commandExecution/requestApproval` request (`itemId`, `threadId`, `turnId`, `command`, `cwd`, `reason`) -> client responds `{"decision": ...}` with `accept`, `acceptForSession`, `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`, `decline`, or `cancel` -> `serverRequest/resolved` -> final `item/completed` (`completed` | `failed` | `declined`).
- File changes: same shape via `item/fileChange/requestApproval` with decisions `accept` / `acceptForSession` / `decline` / `cancel`.
- Related server-to-client requests an adapter may also need to answer: `item/tool/requestUserInput` (blocking user questions), `mcpServer/elicitation/request` (MCP server forms), `item/permissions/requestApproval` (the built-in `request_permissions` tool asking for extra filesystem/network access), `item/tool/call` (experimental client-hosted dynamic tools).
- Whether approvals fire is controlled by the approval policy (`untrusted`, `on-request`, `on-failure`, `never`) combined with the sandbox mode; policies are documented at [developers.openai.com/codex/sandboxing](https://developers.openai.com/codex/sandboxing). For unattended runs, `approvalPolicy: "never"` avoids server-side approval requests entirely.

## 5. Auth model

From [README, Auth endpoints](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/README.md#auth-endpoints) and [developers.openai.com/codex/auth](https://developers.openai.com/codex/auth):

- Modes: **ChatGPT managed** (recommended; Codex owns the OAuth flow and token refresh; plan type surfaced, e.g. `plus`/`pro`), **API key** (usage-based billing), personal access token (`codex login --with-access-token` / `CODEX_ACCESS_TOKEN`), and experimental Amazon Bedrock keys.
- RPCs: `account/read` (current state, optional token refresh), `account/login/start` (`type: "apiKey" | "chatgpt" | "chatgptDeviceCode" | "amazonBedrock"`), `account/login/cancel`, `account/logout`, notifications `account/login/completed` and `account/updated`.
- ChatGPT browser flow: `account/login/start {type: "chatgpt"}` returns an `authUrl`; the app server hosts the localhost callback (port 1455 per the auth docs). Device-code flow returns `verificationUrl` + `userCode` - the right choice for headless boxes.
- Storage: credentials cache in `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`); `cli_auth_credentials_store` config selects `file` | `keyring` | `auto`. Docs explicitly bless copying `auth.json` to remote/containerized machines. Tokens are auto-refreshed during use.
- ChatGPT-specific extras: `account/rateLimits/read` + `account/rateLimits/updated` (quota windows, `usedPercent`, `resetsAt`), earned reset credits, workspace messages. Useful for adapter-level quota surfacing; absent on API-key auth.

## 6. Headless operation

- The stdio transport is plain JSONL over stdin/stdout - no TTY required. The app server exists precisely to power non-terminal frontends (VS Code extension).
- Headless auth: pre-seed `$CODEX_HOME/auth.json`, use the device-code flow, or API-key login (auth docs above).
- Alternative non-interactive path: `codex exec --experimental-json` (one-shot, JSONL events on stdout). OpenAI's own TypeScript SDK `@openai/codex-sdk` wraps **that**, not the app server - it spawns the CLI per turn ([sdk/typescript/src/exec.ts](https://github.com/openai/codex/blob/rust-v0.148.0/sdk/typescript/src/exec.ts), args `["exec", "--experimental-json"]`). For hydra's long-lived interactive sessions with approvals and steering, the app server is the richer surface; `codex exec` is a fallback for fire-and-forget runs.

## 7. Sandboxing assumptions

From [developers.openai.com/codex/sandboxing](https://developers.openai.com/codex/sandboxing) and the [linux-sandbox README](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/linux-sandbox/README.md):

- Modes: `read-only`, `workspace-write` (default for local dev), `danger-full-access`. Passed per thread/turn (`sandbox` / `sandboxPolicy`, or the newer experimental `permissions` profiles).
- Enforcement is inside Codex, per platform: macOS Seatbelt; Linux/WSL2 bubblewrap (`bwrap` from PATH, falling back to a bundled `codex-resources/bwrap`; requires unprivileged user namespaces - WSL1 is unsupported and sandboxed commands are rejected there); Windows has its own sandbox setup (`windowsSandbox/setupStart` RPC).
- The client does not enforce sandboxing; it only chooses the policy and answers approval escalations. But note the escape hatches the adapter itself can invoke: `thread/shellCommand` runs "unsandboxed with full access", and `process/spawn` runs "without the Codex sandbox". Treat those as privileged operations in hydra's own permission model.
- Enterprise `requirements.toml`/MDM can constrain allowed approval policies and sandbox modes (`configRequirements/read`).

## 8. Protocol stability and sharp edges

- **Stable vs experimental split.** Methods/fields are gated: without `initialize.capabilities.experimentalApi = true`, experimental surface is rejected with `"<descriptor> requires experimentalApi capability"`. Experimental APIs have "no backwards-compatible guarantees" ([README, Experimental API Opt-in](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/README.md#experimental-api-opt-in)). A lot of the surface is experimental (thread settings, queues, realtime, environments, plugins - several methods are even marked "under development; do not call from production clients yet").
- **Typed bindings are per-version.** `codex app-server generate-ts --out DIR` / `generate-json-schema` emit TypeScript or JSON Schema "specific to the version of Codex you used to run the command" ([README, Message Schema](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/README.md#message-schema)). There is no published cross-version protocol version number - the adapter should pin a CLI release and regenerate/verify types on upgrades.
- **Release cadence is fast** (0.14x releases days apart), and the protocol crate distinguishes v1 (legacy) and v2 (`codex-rs/app-server-protocol/src/protocol/{v1.rs, v2/}`). Current v2 method names (`thread/*`, `turn/*`, `item/*`) replaced the older camelCase v1 API (`newConversation`, `sendUserMessage`).
- **Non-standard JSON-RPC framing**: the `jsonrpc` field is omitted; strict JSON-RPC client libraries may need configuration or a thin custom codec.
- **Older/parallel interfaces to avoid**: `codex mcp-server` (Codex-as-MCP, "experimental and subject to change without notice" - [codex_mcp_interface.md](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/docs/codex_mcp_interface.md)); `codex proto` / `protocol_v1.md` is the legacy internal event stream. The app server is the interface OpenAI itself builds rich clients on.
- Other sharp edges for the adapter:
  - Must implement the server-to-client request handlers (approvals, elicitations, user input) even if the answer is always "decline", or turns can hang.
  - `-32001` overload errors are expected behavior; build in retry.
  - Single-writer-per-thread (`-32600`) means hydra must not attach two app-server processes to one thread for writes.
  - `thread/start` with workspace-write marks the project trusted in the user's `config.toml` - a side effect on shared machines.
  - Some notifications are explicitly `[UNSTABLE]` (e.g. `item/autoApprovalReview/*`); ignore unknown notifications by default to stay forward-compatible.
  - ChatGPT-auth-only features (rate limits, workspace messages, some plugin/search APIs) silently narrow under API-key auth.

## Sources

- App-server protocol README (primary): https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/README.md
- Protocol types: https://github.com/openai/codex/tree/rust-v0.148.0/codex-rs/app-server-protocol/src/protocol
- Codex MCP interface (experimental alternative): https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/docs/codex_mcp_interface.md
- Legacy protocol spec: https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/docs/protocol_v1.md
- Linux sandbox: https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/linux-sandbox/README.md
- TypeScript SDK (wraps `codex exec`, not app-server): https://github.com/openai/codex/tree/rust-v0.148.0/sdk/typescript
- Auth docs: https://developers.openai.com/codex/auth
- Sandboxing docs: https://developers.openai.com/codex/sandboxing
- Release observed: https://github.com/openai/codex/releases/tag/rust-v0.148.0 (2026-08-18)
