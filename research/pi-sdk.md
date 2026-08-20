# Research: pi.dev SDK - what can the provider adapter rely on?

Resolves rogierpennink/hydra#4. Researched 2026-08-20 against primary sources (pi.dev, github.com/earendil-works/pi, npm).

## TL;DR

- pi is a TypeScript-native coding harness by Earendil Inc (MIT). npm: `@earendil-works/pi-coding-agent` (latest 0.84.2, published 2026-08-14, ships `.d.ts` types, Node >= 22.19).
- Four integration modes: interactive TUI, print mode (`pi -p`), stdin/stdout JSONL RPC (`pi --mode rpc`), and an in-process TypeScript SDK (`createAgentSession()`).
- Unlike Claude Code (subprocess-wrapped CLI behind the Agent SDK) and Codex (Rust binary behind JSON-RPC app-server), pi is library-first: the SDK is the real product surface, RPC is the fallback for non-Node integrators.
- Tool-call interception is first-class: a `tool_call` event fires before execution and can block with `{ block: true, reason }`. Custom tools register via Typebox schemas.
- Sharp edges: pre-1.0 version churn (0.x, frequent releases), no per-action permission prompting built in (allowlist/denylist + blocking hooks instead), and auth is BYO-provider (pi is multi-provider, not tied to one vendor account).

## Identity and packaging

- Official site: https://pi.dev. Repo: https://github.com/earendil-works/pi (monorepo; agent lives in `packages/coding-agent`). MIT, "Earendil Inc. and Contributors".
- Main package `@earendil-works/pi-coding-agent`: CLI bin `pi` plus library exports `.` and `./client`, with TypeScript types (`dist/index.d.ts`). dist-tags: `latest` 0.84.2, `legacy-node20` 0.74.2. Engines: node >= 22.19.0.
- Sibling packages (dependencies of the main one): `@earendil-works/pi-ai` (unified LLM API), `@earendil-works/pi-agent-core` (agent with transport abstraction), `@earendil-works/pi-protocol` / `@earendil-works/pi-client` (transport-neutral CBOR protocol/client for *remote* pi sessions), `@earendil-works/pi-tui`.
- Lineage: the project originated in Mario Zechner's `badlogic/pi-mono` (`@mariozechner/*` scope, last touched 2026-04); the `@mariozechner/pi` package now describes an unrelated vLLM tool. The Earendil scope is the live one.

## SDK surface (TypeScript)

Source: `packages/coding-agent/docs/sdk.md`.

- Entry point: `createAgentSession(options?): Promise<CreateAgentSessionResult>`. For full lifecycle management: `createAgentSessionRuntime(factory, config)` where the factory recreates cwd-bound services.
- Prompting: `session.prompt(text, options?)`; `session.steer(text)` queues a steering message mid-stream; `session.followUp(text)` queues after the agent stops.
- Tools: `tools: ["read", "bash", "edit"]` allowlist, `customTools: [defineTool(...)]`, `excludeTools`, `noTools`.
- Auth: `ModelRuntime` with `setRuntimeApiKey(provider, key)` and `checkAuth(providerId)`. Resolution priority: runtime overrides -> `auth.json` -> env vars. Custom `authPath` / `modelsPath` supported (important for hydra: per-workspace credential isolation is possible).

## Session lifecycle and persistence

Sources: `docs/sdk.md`, README.

- Sessions are JSONL files with a *tree* structure: every entry has `id` and `parentId`, so branching happens in-place in one file. Default dir `~/.pi/agent/sessions/` (keyed by cwd), overridable via `--session-dir` or `PI_CODING_AGENT_SESSION_DIR`.
- Resume: `SessionManager.continueRecent(cwd)` or `SessionManager.open(path)`. Runtime API: `newSession()`, `switchSession()`, `fork()`.
- RPC equivalents: `new_session`, `switch_session`, `fork`, `clone`, `get_tree`, `get_entries`, `set_session_name`.

## Streaming

- SDK: `session.subscribe((event) => {})`. Event vocabulary: `agent_start/end`, `turn_start/end`, `message_start`, `message_update` (with `text_delta` / `thinking_delta`), `message_end`, `tool_execution_start/update/end`, `queue_update`, `compaction_start/end`, retry events.
- RPC mode streams the same events as JSON lines on stdout; commands go in on stdin as one-per-line JSON with optional `id` correlation and `type: "response"` replies. Framing is strict LF-delimited JSONL (`docs/rpc.md`).

## Tool and permission hooks

Sources: `docs/extensions.md`, README.

- Extensions are TypeScript modules loaded via jiti (no compile step) from `~/.pi/agent/extensions/` or project `.pi/extensions/`; they get an `ExtensionAPI` and can register tools, commands, shortcuts, event handlers, UI components.
- Interception: the `tool_call` event fires after `tool_execution_start` and *before execution*, receives mutable `input`, and can return `{ block: true, reason, terminate? }`. This is the permission-hook seam for an adapter (equivalent role to Claude Code's `canUseTool`).
- Custom tools: `pi.registerTool({ name, parameters: Type.Object(...), async execute(toolCallId, params, signal, onUpdate, ctx) })` - Typebox schemas.
- There is no built-in per-action approval prompt loop like Claude Code's permission modes; pi's model is allowlist/denylist flags (`--tools`, `--exclude-tools`, `--no-tools`) plus blocking hooks, plus a project trust gate (`/trust`, `~/.pi/agent/trust.json`) controlling whether project-local extensions load at all.

## Auth model

- Multi-provider by design: subscription auth (Anthropic Pro/Max, ChatGPT Plus/Pro, GitHub Copilot) via `/login`, and API keys for 20+ providers via `--api-key`, env vars (e.g. `ANTHROPIC_API_KEY`), or `auth.json`.
- Embedding: `ModelRuntime` overrides win over `auth.json` and env, so hydra can inject credentials programmatically without touching user dotfiles.

## Headless operation

- `pi -p "query"`: print mode, exits after response, reads piped stdin; site lists print/JSON output.
- `pi --mode rpc`: long-lived headless process, JSONL over stdin/stdout, full command set including `prompt`, `steer`, `follow_up`, `abort`, `bash`/`abort_bash`, model/thinking-level switching, `compact`, `export_html`.
- SDK: fully headless in-process, no TUI dependency.
- Remote: `pi-protocol`/`pi-client` add a framed-CBOR transport for driving remote pi sessions (used by integrations like OpenClaw).

## Structural comparison

| | Claude Code | Codex | pi |
|---|---|---|---|
| Core | closed CLI, wrapped by Agent SDK spawning it as subprocess | Rust binary; `codex exec` or JSON-RPC app-server | TypeScript library; CLI/TUI/RPC are layers on it |
| Programmatic surface | `query()` async generator, `canUseTool`, MCP | JSON-RPC methods/notifications | in-process `createAgentSession()` + subscribe, or JSONL RPC |
| Custom tools | MCP servers | MCP | native `registerTool` (Typebox), jiti-loaded TS extensions |
| Permission gate | permission modes + `canUseTool` callback | approval policy requests over RPC | blocking `tool_call` event + allow/deny lists + trust gate |
| Sessions | resume by id, provider-managed | rollout files, thread resume | tree-structured JSONL files, in-place forking |
| Vendor lock | Anthropic | OpenAI | provider-agnostic (own `pi-ai` layer) |

Philosophy difference that matters for the adapter: pi deliberately omits sub-agents and plan mode ("powerful defaults but skips features like sub agents and plan mode" - README); those arrive via extensions. Hydra features assuming planner/sub-agent semantics cannot rely on pi providing them.

## Sharp edges / risks for an adapter

1. Pre-1.0: 0.84.2 with rapid release cadence; SDK types are shipped but API stability is not promised. Pin versions; expect breakage.
2. In-process SDK means pi runs inside hydra's Node process unless we choose RPC mode - crash/isolation tradeoff. RPC mode gives Codex-like process isolation at the cost of the richer typed API.
3. No built-in interactive approval flow: hydra must build approvals on the blocking `tool_call` event itself (block, surface to user, re-prompt). Nothing resumes a blocked call - blocking cancels it.
4. Node >= 22.19 required (a `legacy-node20` dist-tag exists but trails latest).
5. Extension/trust model executes arbitrary TypeScript; project-local `.pi/extensions` are a supply-chain surface hydra should keep disabled or gated for managed workspaces.
6. Docs live in the repo (`docs/sdk.md`, `docs/rpc.md`, `docs/extensions.md`) and are current, but there is no versioned/stable spec document like Codex's protocol schema.

## Sources

- https://pi.dev (modes, packaging, session tree, extensibility)
- https://github.com/earendil-works/pi - `packages/coding-agent/README.md`, `docs/sdk.md`, `docs/rpc.md`, `docs/extensions.md`
- npm registry metadata: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-protocol`, `@earendil-works/pi-client`, `@mariozechner/pi` (lineage check)
