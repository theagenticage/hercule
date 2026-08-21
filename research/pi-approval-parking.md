# Research: can a pi extension park a tool call for approval?

Resolves rogierpennink/hydra#26. Researched 2026-08-21 against pi source at
github.com/earendil-works/pi, commit `5cd93f688aaab89dbb6dfa4aca535f21796ae185`
(2026-08-20, v0.84.x era), plus `docs/extensions.md`, `docs/rpc.md`, in-repo
example extensions, and upstream issues. Follow-up to the pi SDK research
(#4, `research/pi-sdk.md` on `origin/research/pi-sdk`).

## Verdict: parking works

The `tool_call` extension handler is **awaited by pi with no timeout**. A
handler can simply not return until an external approval decision arrives,
then return `undefined` to let the call execute or `{ block: true, reason }`
to deny it. That is exactly Claude `canUseTool`-style park-and-resume. It is
not an accident of implementation: pi's own first-party example extension
(`permission-gate.ts`) is built on this pattern, and RPC mode has a dedicated
request/response sub-protocol whose entire design assumes the handler pends
until the client answers.

The #4 finding "blocking cancels the call, nothing resumes it" stands - but it
only applies to *returning* `{ block: true }`. Parking means not returning
yet; approval never goes through a blocked-then-resumed state at all.

## The await chain (verified in source)

Handler signature allows async (`packages/coding-agent/src/core/extensions/types.ts:1209`):

```ts
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
```

1. **Dispatch awaits each handler, sequentially, no timeout, no race**
   (`packages/coding-agent/src/core/extensions/runner.ts`, `emitToolCall`):
   `const handlerResult = await handler(event, ctx);` - plain await in a
   `for` loop over extensions/handlers. First `{ block: true }` short-circuits.
   Notably there is no try/catch here (unlike `tool_result` dispatch): handler
   errors propagate and block the call - "fail-safe" per `docs/extensions.md`
   ("`tool_call` errors block the tool (fail-safe)").
2. **Session hook awaits dispatch**
   (`packages/coding-agent/src/core/agent-session.ts`, `_installAgentToolHooks`):
   `this.agent.beforeToolCall = async ({ toolCall, args }) => { ... return await runner.emitToolCall({...}) }`.
3. **Agent loop awaits the hook before executing the tool**
   (`packages/agent/src/agent-loop.ts`, `prepareToolCall`):
   `const beforeResult = await config.beforeToolCall({...}, signal);` then:
   - `beforeResult?.block` -> error tool result (`reason` as content), call never executes;
   - `undefined` -> call proceeds to `tool.execute(...)`;
   - `signal?.aborted` (checked after the await) -> "Operation aborted" error result.

So the approval flow is: handler fires -> hydra surfaces `request.opened` ->
handler awaits the controller's decision -> return `undefined` (allow, tool
runs normally) or `{ block: true, reason }` (deny, model sees the reason).
No deny-and-retry loop, no lost call.

## What pends while parked

- **No LLM connection is held open.** The loop fully consumes the assistant
  stream before executing tools (`agent-loop.ts:193` `streamAssistantResponse`
  completes, then line 214 `executeToolCalls`). A park sits *between* provider
  HTTP requests - indefinite parking costs nothing upstream.
- **The turn stays active.** `agent_end`/`turn_end` don't fire; `ctx.isIdle()`
  is false. Steering/follow-up input queues normally and is consumed after the
  tool batch.
- **`tool_execution_start` has already been emitted** for the parked call
  (`agent-loop.ts:445`/`:500` - `tool_execution_start` fires before
  `prepareToolCall`). UIs show the tool as started; hydra should overlay
  "awaiting approval" state on it.

## First-party proof: `permission-gate.ts`

`packages/coding-agent/examples/extensions/permission-gate.ts` is pi's own
approval-gate example. Its `tool_call` handler awaits an indefinite user
prompt and converts the answer into allow/deny:

```ts
const choice = await ctx.ui.select(`Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);
if (choice !== "Yes") return { block: true, reason: "Blocked by user" };
// falls through -> return undefined -> tool executes
```

`docs/extensions.md` lists it in the example catalog as "Block dangerous
commands" using `on("tool_call")` + `ui.confirm`.

## Headless/RPC modes park too

`docs/rpc.md` ("Extension UI over RPC", lines ~1163-1203): dialog methods
(`select`, `confirm`, `input`, `editor`) "emit an `extension_ui_request` on
stdout and **block until** the client sends back an `extension_ui_response`
with the matching `id`". `ctx.hasUI` is `true` in RPC mode. An optional
`timeout` field auto-resolves with a default - opt-in only; without it the
handler pends indefinitely.

For hydra's chosen integration (SDK inside a hydra-owned child process, per
the #12 resolution) the extension doesn't even need `ctx.ui`: it awaits
hydra's own IPC to the controller and resolves on the decision. In `json`
and `print` modes `ctx.hasUI` is false and UI methods are no-ops - the
permission-gate example blocks by default there; hydra's adapter path is
unaffected since it awaits its own channel, not `ctx.ui`.

## Caveats

1. **Abort does not forcibly unpark.** `Agent.abort()` only aborts the
   `AbortController` (`packages/agent/src/agent.ts:319`); the loop is still
   `await`ing `beforeToolCall` and only checks `signal?.aborted` *after* the
   handler resolves (`agent-loop.ts:620-635`). A handler that ignores abort
   keeps the run pending after the user hits abort. The extension must race
   the external decision against `ctx.signal` (exposed on `ExtensionContext`,
   `runner.ts` `createContext`; documented in `docs/extensions.md` "ctx.signal")
   and return promptly on abort - the loop then produces "Operation aborted".
2. **A park serializes the whole tool batch.** Even in pi's default parallel
   tool mode, `tool_call` preflights run sequentially and execution closures
   only start after *all* preflights resolve (`executeToolCallsParallel`,
   `agent-loop.ts:489-546`; documented: "sibling tool calls ... are
   preflighted sequentially, then executed concurrently", `docs/extensions.md`).
   One parked call delays every sibling call in the message. Fine for an
   approval gate (Claude behaves equivalently), just not free.
3. **Handler exceptions deny (fail-safe).** An error thrown while parked (e.g.
   a broken IPC channel) blocks the call with the error message as the tool
   result; the agent continues. Wrap the wait so infrastructure failures
   produce a clear deny reason.
4. **No contractual guarantee.** Pre-1.0 (0.84.x); the awaited-handler
   behavior is verified in source and relied on by first-party examples and
   the RPC dialog protocol, but no doc sentence promises "handlers may pend
   indefinitely". Upstream issue earendil-works/pi#5954 (structured approval
   primitive, closed no-action) shows no dedicated approval API is planned -
   the awaited `tool_call` handler *is* the sanctioned seam. Pin the version;
   add an adapter build-time test that a pending handler delays execution.

## Consequence for the provider adapter contract (#12)

pi's provisional access-mode rows **upgrade to native park-and-resume**:

| Hydra mode | pi (was) | pi (now) |
|---|---|---|
| approval-required | `tool_call` hook -> `request.opened`, deny-with-reason + retry after approval | `tool_call` hook parks -> `request.opened` -> decision resumes: `undefined` = allow (call executes as-is), `{ block: true, reason }` = deny |
| auto-accept-edits | hook: allow edits, ask rest (ask = deny-and-retry) | hook: allow edits, park rest |
| auto | asks-instead | asks-instead only in the sense that hydra's own policy decides; mechanically the hook can auto-allow/park per call - no vendor limitation left |
| full-access | hook allows all | unchanged |

The declared asks-instead/deny-and-retry degradation is **withdrawn**: pi
joins Claude (`canUseTool`) as a true park-and-resume provider. Codex remains
the RPC-approval-request case. The adapter must implement caveat 1 (race
`ctx.signal`) so interrupts pass through a parked approval.

## Sources

- pi monorepo @ `5cd93f688` (2026-08-20):
  - `packages/coding-agent/src/core/extensions/runner.ts` (`emitToolCall`, `createContext`)
  - `packages/coding-agent/src/core/extensions/types.ts` (`ExtensionHandler`, `ToolCallEvent`, `ToolCallEventResult`)
  - `packages/coding-agent/src/core/agent-session.ts` (`_installAgentToolHooks`)
  - `packages/agent/src/agent.ts` (`abort()`), `packages/agent/src/agent-loop.ts` (`prepareToolCall`, `executeToolCallsSequential/Parallel`, main loop)
  - `packages/coding-agent/examples/extensions/permission-gate.ts`
  - `packages/coding-agent/docs/extensions.md` (tool_call semantics, ctx.signal, error handling, mode behavior table)
  - `packages/coding-agent/docs/rpc.md` (extension UI request/response sub-protocol)
- Upstream: earendil-works/pi#5954 (approval primitive, closed no-action), #6450, #7147
- Prior hydra research: #4 (`research/pi-sdk.md`), #12 resolution (access-mode table)
