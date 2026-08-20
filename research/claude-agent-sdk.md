# Claude Agent SDK (TypeScript) - what a provider adapter can rely on

Research for hydra issue #2. All claims verified against official Anthropic docs and the SDK's
GitHub changelog on 2026-08-20. Package: `@anthropic-ai/claude-agent-sdk`, latest v0.3.237
(bundles Claude Code CLI v2.1.237).

## Summary

**The adapter can rely on:**

- A single entry point, `query()`, returning an async generator of typed `SDKMessage` events
  plus a `Query` control object (interrupt, setPermissionMode, streamInput, close, etc.).
- Full session lifecycle: create, `continue`, `resume` by id, `forkSession`, plus on-disk
  session enumeration (`listSessions`, `getSessionMessages`) and a `SessionStore` adapter for
  mirroring transcripts to external storage.
- A well-defined permission pipeline (hooks -> deny -> ask -> mode -> allow -> `canUseTool`)
  that is entirely programmable, with `PreToolUse` hooks as the only step that sees every call.
- MCP in all transports (stdio, HTTP, SSE) plus zero-process in-app servers via
  `createSdkMcpServer()`/`tool()`.
- Programmatic subagents (`agents` option) with per-agent tools, model, permission mode.
- Headless operation: no TTY needed, bundled native CLI binary, container guidance is
  first-party.

**Sharp edges:**

- One CLI subprocess per session, roughly 1 GiB RAM each; no built-in session timeout;
  memory grows over long sessions. The orchestrator owns process supervision and recycling.
- Session state lives on local disk under `~/.claude/projects/<encoded-cwd>/*.jsonl`; it does
  not move between hosts unless you use `SessionStore` (still alpha) or copy files.
- By default the SDK loads filesystem settings, CLAUDE.md, `.mcp.json`, `.claude/agents` from
  cwd and `~/.claude`. Multi-tenant isolation requires `settingSources: []`,
  `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and per-session `cwd`.
- `env` option *replaces* the subprocess environment (must spread `process.env`).
- Claude subscription (claude.ai Pro/Max) login is explicitly not allowed for third-party
  products; API key / Bedrock / Vertex / Foundry only.
- 0.x semver, weekly-ish releases pinned to CLI versions; several breaking changes already
  shipped (0.1.0 rename and defaults, 0.2.115 env semantics, 0.2.142 V2 API removal).
- The SDK does not sandbox anything itself; sandboxing is your infrastructure's job.

## 1. Architecture and runtime model

- `query()` spawns a separate `claude` CLI process and talks to it over stdio with a JSON
  protocol. The subprocess owns the shell, the working directory, and the JSONL transcripts.
  One agent session = one subprocess; N concurrent sessions = N subprocesses.
  [Hosting](https://code.claude.com/docs/en/agent-sdk/hosting)
- The SDK bundles a native CLI binary via npm optional dependencies
  (`@anthropic-ai/claude-agent-sdk-{darwin-arm64,darwin-x64,linux-x64,linux-x64-musl,win32-x64}`).
  `npm ci --omit=optional` installs no binary; then you must install Claude Code natively and
  set `pathToClaudeCodeExecutable`. SDK version tracks the CLI version (v0.3.191 bundles
  Code v2.1.191), so upgrading the SDK is how you upgrade the CLI.
  [Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart),
  [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- Node.js 18+ required. `executable` option can select node/bun/deno.
  [Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)
- `cwd` option sets the session working directory (defaults to `process.cwd()`); pass it per
  `query()` when sessions need separate filesystems.
  [Hosting](https://code.claude.com/docs/en/agent-sdk/hosting)
- `env` **replaces** the subprocess environment rather than merging (since v0.2.115); spread
  `...process.env` to keep `PATH` and `ANTHROPIC_API_KEY`.
  [Hosting](https://code.claude.com/docs/en/agent-sdk/hosting),
  [CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- `startup()` pre-warms a subprocess before the prompt is known (~20x faster first response),
  useful for pooling. [CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)

## 2. Session lifecycle

Source: [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)

- **Create**: every `query()` call starts a new session by default. The session id appears
  early on the init `system` message (`message.session_id`) and on every `result` message.
- **Continue**: `continue: true` resumes the most recent session in the current directory,
  no id tracking.
- **Resume**: `resume: <sessionId>` returns to a specific session with full context. Since
  CLI v2.1.223 the lookup searches beyond the current project directory; older bundled CLIs
  only search the current project dir and its worktrees.
- **Fork**: `resume: <id>` + `forkSession: true` creates a new session seeded with a copy of
  the original history; the original is untouched. Forking branches conversation history only,
  not the filesystem.
- **Storage**: transcripts are JSONL files under `~/.claude/projects/<encoded-cwd>/` (or
  `$CLAUDE_CONFIG_DIR/projects/`). Same machine only, unless mirrored.
- **Cross-host resume**: `sessionStore` option (S3/Redis/Postgres reference adapters exist)
  mirrors transcripts to your backend; the SDK dual-writes (local first, store second) and
  mirror writes are best-effort - a dropped batch emits a
  `{ type: "system", subtype: "mirror_error" }` message. Still marked alpha in the changelog.
  [Hosting](https://code.claude.com/docs/en/agent-sdk/hosting),
  [CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- **Enumeration/metadata**: `listSessions()`, `getSessionMessages()`, `getSessionInfo()`,
  `renameSession()`, `tagSession()` operate on the on-disk store - enough to build a session
  picker or cleanup logic without parsing JSONL yourself.
  [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- **Opt-out**: `persistSession: false` keeps a session memory-only.
- **File state**: sessions persist conversation, not files. File snapshot/undo is separate
  (`enableFileCheckpointing: true` + `rewindFiles()`).
- The experimental V2 session API (`createSession()` send/stream) was **removed** in 0.3.142;
  `query()` is the only supported surface.

## 3. Streaming and event model

Source: [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)

- `query({ prompt, options })` accepts a string (single-turn) or
  `AsyncIterable<SDKUserMessage>` (streaming input, enables multi-turn interaction and the
  dynamic control methods). Returns `Query extends AsyncGenerator<SDKMessage, void>`.
- Message stream includes: `system`/`init` (session id, tools, MCP server statuses, model,
  account info), `assistant` (wraps the Claude API message; content blocks for text, thinking,
  tool_use), `user`, tool results, `stream_event` partial deltas when
  `includePartialMessages: true`, compact-boundary markers, hook and task-progress messages,
  and a final `result` message with `subtype` (`success`, `error_max_turns`,
  `error_max_budget_usd`, `error_during_execution`), `total_cost_usd`, usage, and
  `session_id`. Messages originating inside a subagent carry `parent_tool_use_id`.
- A single-shot `query()` **throws after yielding an error result**; capture `session_id`
  in the loop before the throw. Process-spawn failures yield no result message at all.
  [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- `Query` control methods (most require streaming-input mode): `interrupt()`,
  `setPermissionMode()`, `setModel()`, `setMaxThinkingTokens()`, `streamInput()`,
  `supportedCommands()`, `supportedModels()`, `supportedAgents()`, `mcpServerStatus()`,
  `setMcpServers()`, `getContextUsage()`, `accountInfo()`, `stopTask()`, `close()`.
- Cancellation: `abortController` option; budget cap via `maxBudgetUsd`; turn cap via
  `maxTurns`. There is **no top-level wall-clock session timeout** - the orchestrator must
  enforce deadlines itself. [Hosting](https://code.claude.com/docs/en/agent-sdk/hosting)
- Stall/timeout env knobs: `API_TIMEOUT_MS`, `CLAUDE_CODE_MAX_RETRIES`,
  `CLAUDE_STREAM_IDLE_TIMEOUT_MS`, `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`.

## 4. Tools, permissions, hooks

Source: [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions),
[Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)

- Evaluation order per tool call: **hooks -> deny rules -> ask rules -> permission mode ->
  allow rules -> `canUseTool` callback**. A hook deny wins even in `bypassPermissions`.
- Permission modes: `default`, `dontAsk` (deny instead of prompt - good for headless),
  `acceptEdits`, `bypassPermissions` (requires `allowDangerouslySkipPermissions: true`),
  `plan`, `auto` (model-classified). Mode can be changed mid-session with
  `setPermissionMode()`.
- `allowedTools` auto-approves (does **not** restrict the tool set, and does not constrain
  `bypassPermissions`); `disallowedTools` with a bare name removes the tool from context,
  scoped rules like `Bash(rm *)` deny in all modes. Locked-down recipe:
  `allowedTools: [...]` + `permissionMode: "dontAsk"`.
- `canUseTool(request, { signal })` is only invoked when the flow falls through to a prompt;
  auto-approved tools never reach it (the SDK emits a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`
  warning for shadowing configs). For checks on every call, use a `PreToolUse` hook.
- Hooks are in-process callbacks registered via `options.hooks` with optional matchers.
  SDK-supported events include `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
  `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`,
  `PermissionRequest`, `Notification`; some CLI events (`SessionStart`, `SessionEnd`,
  `Setup`, `PostCompact`, ...) are settings-file-only, not SDK callbacks. Hooks can block,
  modify input, or inject context.
- `settingSources` controls which filesystem settings load (`user`/`project`/`local`).
  Defaults load all sources; pass `[]` for hermetic behavior. Note some inputs (auto memory)
  load regardless of `settingSources` and need env flags to disable.
  [Hosting - multi-tenant isolation](https://code.claude.com/docs/en/agent-sdk/hosting)

## 5. MCP support

Source: [MCP](https://code.claude.com/docs/en/agent-sdk/mcp)

- `mcpServers` option accepts stdio (`command`/`args`/`env`), `http`, and `sse` server
  configs; `.mcp.json` in the project also loads when the `project` setting source is on;
  `strictMcpConfig: true` ignores filesystem MCP config.
- In-process servers: `createSdkMcpServer({ name, tools })` with `tool(name, description,
  zodSchema, handler)` - typed custom tools with no extra process.
- Tool naming: `mcp__<server>__<tool>`; allow with wildcards (`mcp__github__*`). MCP tools
  need explicit allow rules; `acceptEdits` does not auto-approve them.
- Init message reports per-server status (`pending`/`connected`/`failed`/`needs-auth`/
  `disabled`); `mcpServerStatus()`, `reconnectMcpServer()`, `toggleMcpServer()`,
  `setMcpServers()` at runtime. No interactive OAuth: complete OAuth yourself and pass a
  bearer token in `headers`.
- Tool search is on by default (large tool sets are deferred out of context). Tool results
  over 25k tokens are written to a file (`MAX_MCP_OUTPUT_TOKENS` to raise).

## 6. Subagents

Source: [Subagents](https://code.claude.com/docs/en/agent-sdk/subagents)

- Defined programmatically via `agents: Record<string, AgentDefinition>` (description,
  prompt, tools, model, permissionMode, maxTurns, background, effort, mcpServers...), or as
  markdown files in `.claude/agents/` (programmatic wins on name conflict). A built-in
  `general-purpose` subagent always exists unless disabled via
  `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`.
- Claude invokes subagents through the `Agent` tool; include `Agent` in `allowedTools` to
  avoid prompts. Subagents get fresh context (only the Agent tool's prompt string passes
  down); only the final message returns to the parent. Since CLI v2.1.198 subagents run in
  the background by default.
- Caps: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3), `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`
  (default 20), `maxBudgetUsd` for spend. No per-subagent wall-clock deadline; use
  `maxTurns` per AgentDefinition.
- Subagents are resumable within a resumed parent session (agentId in the Agent tool result).

## 7. Auth and billing

Sources: [Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart),
[Overview](https://code.claude.com/docs/en/agent-sdk/overview)

- Supported: `ANTHROPIC_API_KEY` (read from subprocess env; `.env` files are not auto-loaded),
  Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`), Claude Platform on AWS
  (`CLAUDE_CODE_USE_ANTHROPIC_AWS=1`), Google Cloud Agent Platform / Vertex
  (`CLAUDE_CODE_USE_VERTEX=1`), Microsoft Foundry (`CLAUDE_CODE_USE_FOUNDRY=1`).
  `ANTHROPIC_BASE_URL` can route through a key-injecting proxy.
- **Claude.ai subscription login is not permitted**: "Unless previously approved, Anthropic
  does not allow third party developers to offer claude.ai login or rate limits for their
  products, including agents built on the Claude Agent SDK." Hydra must design around API-key
  billing (or Bedrock/Vertex), not user subscriptions.
- Cost accounting: `total_cost_usd` and usage on the result message; `maxBudgetUsd` cap;
  OTEL export for metrics. Governed by Anthropic's Commercial Terms of Service.

## 8. Sandboxing and headless operation

Source: [Hosting](https://code.claude.com/docs/en/agent-sdk/hosting)

- The SDK provides **no sandbox of its own**; the docs assume you run it inside a container
  or sandbox (Docker, gVisor, Firecracker, or providers like Modal/E2B/Fly). Tool execution
  (Bash etc.) happens with the subprocess's OS privileges in `cwd`.
- Headless is the normal mode: no TTY required, works in CI/containers; first-party
  Dockerfiles/K8s manifests exist in the claude-cookbooks hosting directory. An
  alternative for zero-infra hosting is Anthropic's separate Managed Agents product.
- Network needs: outbound HTTPS to `api.anthropic.com` (or Bedrock/Vertex endpoints) plus any
  MCP endpoints; docs recommend an egress proxy for allowlisting and credential injection.
- Resources: starting point 1 GiB RAM, 5 GiB disk, 1 CPU per agent; memory grows with session
  length; concurrency per host = (RAM - overhead) / per-session ceiling. Pin resumed sessions
  to the container holding the live subprocess (consistent hashing on sessionId).
- Multi-tenant isolation checklist: `settingSources: []`, per-tenant `CLAUDE_CONFIG_DIR`,
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, per-tenant `cwd`, per-tenant egress rules.
- Observability: OTEL traces/metrics/logs via env vars (`CLAUDE_CODE_ENABLE_TELEMETRY=1` etc.);
  prompt text excluded by default.

## 9. Version stability and sharp edges

Source: [CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md),
[Hosting](https://code.claude.com/docs/en/agent-sdk/hosting)

- Latest: v0.3.237 (parity with Claude Code v2.1.237). Cadence: frequent patch releases
  (roughly weekly), version-locked to CLI releases. Still 0.x; docs say "take patch releases
  continuously and review the changelog before taking a minor".
- Breaking history to date:
  - **0.1.0**: renamed from `@anthropic-ai/claude-code` SDK to `@anthropic-ai/claude-agent-sdk`;
    Claude Code system prompt no longer the default (opt in via
    `systemPrompt: { type: 'preset', preset: 'claude_code' }`); filesystem settings no longer
    loaded by default at that point; `customSystemPrompt`/`appendSystemPrompt` merged into
    `systemPrompt`.
  - **0.2.115**: `options.env` replaces instead of merges the subprocess environment.
  - **0.2.142**: V2 session API removed; MCP servers connect in background by default;
    TodoWrite replaced by Task tools.
  - **0.3.234**: minor type removal in `ExitReason`.
- Behavior also shifts with the bundled CLI (e.g. Task->Agent tool rename in CLI v2.1.63,
  background-by-default subagents in v2.1.198, cross-directory resume in v2.1.223), so the
  adapter should pin the SDK version and treat CLI-version-gated behavior as part of the
  contract.
- Gotchas checklist for the adapter:
  - single-shot `query()` throws after the error result (wrap iteration in try/catch);
  - `sessionStore` is alpha and mirror writes are best-effort (watch `mirror_error`);
  - `bun build --compile` needs `extractFromBunfs()` for the bundled binary;
  - some Query control methods only work in streaming-input mode;
  - no session timeout, no per-subagent deadline - supervise externally;
  - `usage_EXPERIMENTAL...` API is explicitly unstable.

## Implications for hydra's provider adapter

- The natural adapter seam is `query()` + the `SDKMessage` stream: normalize SDK message
  types into hydra's event model, and expose session id, result subtype, and cost from the
  `result` message.
- Model the harness lifecycle as: spawn (`query()`/`startup()`), stream, interrupt, resume
  (id + cwd + same host or SessionStore), fork. All exist natively; nothing must be faked.
- Treat isolation as hydra's job: per-session cwd, `settingSources: []` unless the project's
  own `.claude/` config is wanted, env allowlisting, container/sandbox per agent.
- Pin the SDK exactly; wrap it behind the adapter interface so 0.x breaking changes stay
  contained.
