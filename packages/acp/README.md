# @hercule/acp

A client for the Agent Client Protocol (ACP): JSON-RPC 2.0 over the stdio of an agent process. A harness adapter in the runner uses it to talk to an agent that speaks ACP, such as `agy acp`.

The package depends on `effect` only.

## Where the code comes from

The code is copied from the `effect-acp` package of [T3 Code](https://github.com/pingdotgg/t3code) (`packages/effect-acp`), at commit `c6fe23dd2871126cd189cf197761849e7ef0f91d`. T3 Code is MIT licensed, Copyright (c) 2026 T3 Tools Inc.; the notice is in `LICENSE-t3code.txt`.

| File here | File in `packages/effect-acp` | Changes |
|---|---|---|
| `src/client.ts`, `src/protocol.ts`, `src/rpc.ts`, `src/errors.ts`, `src/compat.ts`, `src/schema.ts` | the same path | none |
| `src/_internal/stdio.ts`, `src/_internal/shared.ts` | the same path | none |
| `src/*.test.ts`, `src/_internal/stdio.test.ts` | the same path | the platform layer is `@effect/platform-bun` instead of `@effect/platform-node`, because the tests run on Bun; fixture paths |
| `src/agent.testing.ts` | `src/agent.ts` | none |
| `src/acp-mock-peer.testing.ts` | `test/fixtures/acp-mock-peer.ts` | the platform layer, and the import of the agent |
| `src/antigravity-initialize.fixture.json` | `test/fixtures/antigravity-initialize.json` | none |
| `src/_generated/*` | the same path | generated here, see below |

Left out: `src/agent.test.ts`, and the `./agent` export. Hercule never acts as an ACP agent. The agent half itself is kept as `agent.testing.ts` because the client's tests start it as the peer they talk to (`acp-mock-peer.testing.ts`); no export of this package reaches it.

## Generated schemas

`src/_generated` is written by `scripts/gen-acp-types.ts` and checked in. Never edit it by hand.

```
pnpm gen:acp-types
```

The script downloads the JSON Schema of two ACP releases from `https://github.com/agentclientprotocol/agent-client-protocol/releases` and turns each definition into an Effect Schema with `@effect/openapi-generator`:

| File | ACP release |
|---|---|
| `schema.gen.ts`, `meta.gen.ts` | `schema-v2.0.0-alpha.3` |
| `schema-v1.gen.ts` | `schema-v1.21.0` |

Both are needed: the client offers protocol version 2 and falls back to version 1 when the agent answers `initialize` in the version 1 shape.

To move to a newer ACP release, change the two release constants at the top of the script, run it, and read the diff of `src/_generated`: it is the protocol's changelog.
