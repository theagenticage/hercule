# Research: structured output across provider harnesses

Resolves [#28](https://github.com/rogierpennink/hydra/issues/28). Feeds the provider adapter spec (#12) and the workflow model (#13, ADR 0008: "prompts persuade, schemas route").

Question: an agent step declares an output schema and the graph routes on the schema-conforming
result. Per provider harness, how does the runner best obtain that result - native
structured-output support, a closing prompt with parse-and-retry, or a `submit_result` custom
tool whose input schema *is* the output schema?

Researched 2026-08-21 against primary sources: code.claude.com docs and the
`anthropics/claude-agent-sdk-typescript` changelog; `openai/codex` at tag `rust-v0.148.0`
(protocol and core source); `earendil-works/pi` at main (docs, examples, and source). Builds on
`research/claude-agent-sdk.md`, `research/codex-app-server.md`, `research/pi-sdk.md` (their
research branches).

## TL;DR - recommendation per provider

| Provider | Mechanism | Why |
|---|---|---|
| Claude Agent SDK | **Native**: `outputFormat: { type: "json_schema", schema }` on `query()`; read `structured_output` off the final `result` message | First-class feature; the SDK validates and re-prompts on mismatch, with a distinct error subtype when retries run out |
| Codex app-server | **Native**: `outputSchema` on `turn/start` (stable, not experimental-gated); parse the turn's final `agentMessage` item text | Enforced server-side by the Responses API as strict JSON-Schema constrained decoding |
| pi SDK | **`submit_result` custom tool** (`customTools` + `defineTool`, Typebox schema = output schema, `terminate: true`), with an idle-detection re-prompt loop | No native output-schema option exists; the tool pattern is first-party endorsed (pi ships a `structured-output.ts` example), args are schema-validated with model-visible error feedback, and `constrainedSampling` can enforce the schema at the provider |

The custom-tool trick is confirmed workable on all three harnesses (Claude: in-process MCP
tools; Codex: MCP servers or experimental `dynamicTools`; pi: native `registerTool`/
`customTools`), but only pi needs it. The closing-prompt-plus-parse fallback is strictly worse
everywhere: no enforced schema, hand-rolled retry, and fragile extraction of JSON from prose.
The adapter spec should model "structured result" as a per-provider capability implemented by
whichever mechanism is native, not as a shared prompt convention.

## 1. Claude Agent SDK: native structured outputs

Source: [Structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)
(all claims in this section from that page unless noted).

- **API**: pass `outputFormat: { type: "json_schema", schema }` (TS; `output_format` in
  Python) in `query()` options. The schema is plain JSON Schema; the docs show generating it
  from Zod via `z.toJSONSchema(schema, { target: "draft-7" })`.
- **Result**: the final `result` message carries a `structured_output` field with the
  validated data. The agent may run arbitrary multi-turn tool use first; the schema
  constrains only the final output.
- **Enforcement and retries are built in**: "the SDK validates the output against it,
  re-prompting on mismatch." Exhausted retries produce result subtype
  `error_max_structured_output_retries` (and a single-shot `query()` then throws after
  yielding that result).
- **Failure modes to handle** (documented, so hydra's runner must branch on all three):
  1. `subtype === "success"` with `structured_output` present - the good path;
  2. `subtype === "error_max_structured_output_retries"` - validation never converged (or a
     model-fallback retraction went unreplaced; the result's `errors` list distinguishes);
  3. `subtype === "success"` with **no** `structured_output` - run finished without producing
     one; the docs say to treat this as a failure too.
- **Schema limits**: JSON Schema draft-07 only (newer-draft declarations are rejected);
  supported features include basic types, `enum`, `const`, `required`, nesting, `$ref`, per
  the [API structured-outputs limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations).
  An invalid schema fails the run at startup (since CLI v2.1.205; before that it was silently
  ignored - one more reason to pin versions).
- **Maturity**: shipped in SDK 0.1.45, validation-error and empty-message fixes in 0.2.23,
  a discarded-valid-output bug fixed in 0.2.105, and a `terminal_reason` value
  `structured_output_retry_exhausted` added in 0.3.204
  ([CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)).
  Treat it as stable but pin the SDK, per the general 0.x caveat from
  `research/claude-agent-sdk.md`.

**Custom-tool alternative (works, unnecessary)**: in-process MCP tools via
`createSdkMcpServer()` + `tool(name, description, zodSchema, handler)` would support a
`submit_result` pattern - handlers receive Zod-validated args, and errors return to the model
as tool results it can react to
([Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)). But there is no way
to force a tool call, and native structured outputs already provide the validate-and-retry
loop, so the tool route is pure extra machinery here.

**Recommendation**: native `outputFormat`. Map subtype (2) and (3) above to a
schema-failure outcome the graph can route on.

## 2. Codex app-server: native `outputSchema` on `turn/start`

- **API**: `TurnStartParams` has `output_schema: Option<JsonValue>` - "Optional JSON Schema
  used to constrain the final assistant message for this turn" - and it is **not**
  experimental-gated (neighbouring fields carry `#[experimental(...)]`; this one does not):
  [app-server-protocol/src/protocol/v2/turn.rs](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs)
  (wire name `outputSchema`, per the generated
  [TurnStartParams.json](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server-protocol/schema/json/TurnStartParams.json)).
  Per-turn, which matches hydra's step granularity exactly.
- **Enforcement is server-side constrained decoding**, not a parse-and-retry loop: core
  attaches the turn's `final_output_json_schema` to each model request
  ([core/src/session/turn.rs](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/core/src/session/turn.rs)),
  and codex-api sends it as Responses API `text.format = { type: json_schema, strict: true,
  name: "codex_output_schema" }`
  ([codex-api/src/common.rs](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/codex-api/src/common.rs)).
  The model cannot emit a non-conforming final message; there is no client-side retry to
  configure.
- **Result**: the conforming JSON *is* the text of the turn's final `agentMessage` item
  (`item/completed`). The first-party TS SDK exposes the same thing as `turn.finalResponse`
  when `outputSchema` is passed to `thread.run()`
  ([sdk/typescript/README.md, "Structured output"](https://github.com/openai/codex/blob/rust-v0.148.0/sdk/typescript/README.md)).
  The runner parses that text (it is already schema-valid; `JSON.parse` + a defensive
  validation is enough).
- **Schema limits**: OpenAI strict mode accepts a subset of JSON Schema (e.g. objects need
  `additionalProperties: false`, all properties required). The TS SDK README points at
  `zod-to-json-schema` with `target: "openAi"` for exactly this reason. Hydra should validate
  step schemas against the strict subset at recipe-validation time, since an unsupported
  schema surfaces only as a turn failure at run time.
- **Caveats**:
  - the schema is attached to *every* model request in the turn, so any free-text assistant
    commentary the model would have emitted is also constrained; expect turns with an output
    schema to produce tool calls plus one final JSON message, and don't render the final
    message as prose;
  - a turn can still end `failed` or `interrupted` for ordinary reasons (context window,
    usage limits - `codexErrorInfo` enum per `research/codex-app-server.md`); the runner
    treats "turn completed but final item is not an `agentMessage`" as a missing-output
    failure and may retry with a fresh `turn/start`;
  - no cross-version protocol guarantee - pin the CLI and regenerate types (same caveat as
    prior research).
- **Custom-tool alternative (works, unnecessary)**: MCP servers are supported
  (`mcpToolCall` items), and client-hosted `dynamicTools` exist on `thread/start` with
  `name`/`description`/`input_schema` specs plus an `item/tool/call` server-to-client request -
  but that surface is experimental-gated (`#[experimental("thread/start.dynamicTools")]`,
  [thread.rs](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs),
  [protocol/src/dynamic_tools.rs](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/protocol/src/dynamic_tools.rs)).
  Native `outputSchema` is both stable and stronger.

**Recommendation**: native `outputSchema` on the step's `turn/start`; parse the final
`agentMessage`.

## 3. pi SDK: no native support; `submit_result` tool is the endorsed pattern

- **No native output-schema option.** Neither `createAgentSession()` /
  `session.prompt()` ([docs/sdk.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md))
  nor RPC mode ([docs/rpc.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md))
  accepts a response format or output schema. The underlying `pi-ai` layer has
  constrained-sampling plumbing, but the coding agent only exposes it per *tool*, not per
  *response*.
- **The custom-tool pattern is first-party endorsed**: pi ships
  [examples/extensions/structured-output.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/structured-output.ts) -
  a `structured_output` tool built with `defineTool`, whose Typebox `parameters` are the
  output schema, returning `terminate: true` "so the agent can end on a tool call without
  paying for an extra follow-up LLM turn". [docs/extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
  documents the `terminate` semantics and links that example by name. For an SDK embedding,
  pass the tool via `customTools: [submitResultTool]` (and include it in `tools` if that
  allowlist is used) - no extension files needed (docs/sdk.md, "Custom Tools").
- **Schema violations self-correct.** The agent loop validates every tool call's arguments
  against the tool's Typebox schema before execution (`validateToolArguments` in
  [agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts),
  implemented in [ai/src/utils/validation.ts](https://github.com/earendil-works/pi/blob/main/packages/ai/src/utils/validation.ts)
  with type coercion first); a failure becomes an error tool result fed back to the model,
  which retries within the same turn. The tool's `execute` only ever sees schema-valid args,
  so whatever it captures for the runner is schema-conforming by construction.
- **Optional hardening**: a tool can set
  `constrainedSampling: { type: "json_schema", strict: "prefer" }` and providers that support
  strict function calling then enforce the argument schema at sampling time
  ([ai/src/types.ts](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts));
  `defineTool` passes the field through
  ([coding-agent/src/core/tools/tool-definition-wrapper.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/tool-definition-wrapper.ts)).
  Use `"prefer"` - pi is multi-provider and `pi-ai`'s strict transform rejects schema
  features some providers can't constrain on (`$ref`, `oneOf`, `patternProperties`, ...:
  [ai/src/api/constrained-sampling.ts](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/constrained-sampling.ts)).
- **The gap the runner must own: the agent can finish without calling the tool.** Nothing in
  pi forces a tool call. The loop is: prompt with an instruction to finish via
  `submit_result`; on `agent_end` (SDK `subscribe` events) check whether the tool captured a
  result; if not, re-prompt ("You must call submit_result with ...") for a bounded number of
  attempts, then fail the step with a missing-output reason. Two pi quirks to respect:
  `terminate` on an `execute` result is a *hint* honored only "when every finalized tool
  result in that batch is terminating" (docs/extensions.md), so the agent may still emit a
  trailing assistant message - ignore it, the tool args are the result; and Typebox string
  enums must use `StringEnum` from `pi-ai`, not `Type.Union` of literals, for Google-API
  compatibility (docs/extensions.md) - relevant when hydra compiles a step's JSON Schema to
  the tool's Typebox schema.

**Recommendation**: `submit_result` custom tool via `customTools`, `terminate: true`,
`constrainedSampling: { type: "json_schema", strict: "prefer" }`, plus an adapter-side
finished-without-calling re-prompt loop (bounded, e.g. 2 retries) that maps exhaustion to the
same schema-failure outcome as the other providers.

## Cross-provider notes for the adapter spec

- **One capability, three shapes.** Declare `structuredOutput` as a provider capability
  (fits ADR 0007's declared-facts model). All three providers can support it natively-enough
  that no closing-prompt fallback needs to be specced at all; a future harness without any
  mechanism would declare `structuredOutput: unsupported` rather than getting a silently
  flaky prompt-based emulation.
- **Normalize the failure taxonomy.** Every mechanism has the same three outcomes the graph
  may need to route on: `ok(value)`, `schema-failure` (retries/validation exhausted - Claude's
  `error_max_structured_output_retries`, Codex turn failure, pi re-prompt exhaustion), and
  ordinary run failure. Emit them as one normalized event shape.
- **Validate once more at the runner.** Codex output is API-enforced and Claude/pi outputs
  are harness-validated, but the runner should still run the declared schema over the value
  before routing - it is cheap, catches harness regressions (e.g. the Claude 0.2.105 bug
  class), and gives one uniform error surface.
- **Validate schemas at recipe time against the intersection of provider limits** if a step
  may run on any provider: JSON Schema draft-07 (Claude), OpenAI strict subset (Codex),
  pi-ai strict-transform subset (pi, only if `constrainedSampling` is used). The strict
  subsets are the binding constraint; a lint at recipe validation beats a runtime turn
  failure.

## Sources

- Claude Agent SDK structured outputs: https://code.claude.com/docs/en/agent-sdk/structured-outputs
- Claude API JSON Schema limitations: https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations
- Claude Agent SDK custom tools: https://code.claude.com/docs/en/agent-sdk/custom-tools
- Claude Agent SDK changelog: https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
- Codex app-server turn params: https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs and generated schema https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server-protocol/schema/json/TurnStartParams.json
- Codex enforcement wiring: https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/core/src/session/turn.rs, https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/core/src/client_common.rs, https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/codex-api/src/common.rs
- Codex dynamic tools (experimental): https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs, https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/protocol/src/dynamic_tools.rs
- Codex TS SDK structured output: https://github.com/openai/codex/blob/rust-v0.148.0/sdk/typescript/README.md
- pi structured-output example: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/structured-output.ts
- pi SDK and extension docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md, https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- pi validation and constrained sampling: https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts, https://github.com/earendil-works/pi/blob/main/packages/ai/src/utils/validation.ts, https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts, https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/constrained-sampling.ts
