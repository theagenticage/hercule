# @hercule/acp

The ACP (Agent Client Protocol) client: it talks to a harness that speaks ACP over its stdin and stdout.

- `src/` is ours:
  - `connection.ts` opens the connection. It calls T3's typed client (`AcpClient.make`, `client.agent.*` and the handlers) and turns what the client returns into our own types. T3's generated schemas decode everything the harness sends, and decode strictly: a value they do not know is not passed on silently.
  - `types.ts` holds our own plain types and the interface of a connection. `connection.ts` assigns T3's values to them, so when a sync removes or retypes a required field, `pnpm typecheck` fails there. A field that is absent means "not known", never "none".
  - `error.ts` holds the errors.
  - `stdio.ts` turns the harness's pipes into the stdio T3 reads and writes.
  - `index.ts` is the package's interface.
  - `testing.ts` and `recordings/` are the fake harness (`@hercule/acp/testing`): its answers come from a recording or from a test's own script. `*.testing.ts` files hold helpers of this package's own tests.
- `vendor/effect-acp/` is `packages/effect-acp` of [T3 Code](https://github.com/pingdotgg/t3code), copied unchanged. MIT licence, Copyright (c) 2026 T3 Tools Inc. (see `vendor/effect-acp/LICENSE`). Commit: `3a63e0ca37a50d31f78b0188960557ff69964e76`.

## What we copy and what we do not

We copy `src/` and `test/` of T3's `packages/effect-acp`, and T3's root `LICENSE`, which is the licence of the whole repository. We do not copy:

- `package.json` and `tsconfig.json` of T3's package: ours are `packages/acp/package.json` and the root `tsconfig`.
- `scripts/generate.ts`, which generates the schemas. We copy what it generated.

The generated schemas in `src/_generated/` come from the ACP schemas `schema-v1.21.0` (`schema-v1.gen.ts`) and `schema-v2.0.0-alpha.3` (`schema.gen.ts`). T3's client reads both, and decides per message which one applies.

## What we use of the copy

`src/connection.ts` imports these files of the copy:

- `client.ts`: the client (`make`, `agent.*`, the handlers, `raw`).
- `protocol.ts`: `acpRequestIdentity`, which names a request id the way the client's handlers do, and the log events that `connection.ts` reads (below).
- `errors.ts` and `compat.ts`: the errors and the compatibility types.

Through `client.ts` the rest of the copy is linked: `rpc.ts`, `_internal/`, `schema.ts` and the generated files.

The `elicitation/complete` notification gets a handler that only reports it: this client advertises only the form mode, which never sends it, but T3 keeps every one it receives without bound when nothing handles it.

`agent.ts` (the agent side of the protocol), every `*.test.ts` and `test/` are copied only for T3's tests, which run in our suite.

Only `src/connection.ts` imports the copy, tests and `import type` included, and the rest of the repository imports `@hercule/acp` only (and `@hercule/acp/testing`). An import rule in `eslint.config.js` enforces both, so `pnpm lint` fails otherwise. `pnpm dep-lint` keeps the package's import graph to `effect`, so that the runner can link the package: nothing links it yet.

## When the harness sends a value T3 does not know

T3's schemas refuse a value they do not know, such as a new tool kind in an approval request or a new config option type. Every such refusal is loud. You see it as:

- an `AcpError` with reason `unreadable`, or
- a report through `onUnhandledMessage`,

and the message names the ACP message, the field T3 expected and the value. It happens after the pinned `agy` version was raised, or when a harness adds a feature.

First remedy: sync with T3 Code (below). T3 usually has the new value by then.

## If syncing is not enough

Rogier decided on 2026-11-25 to start with T3's typed client: less to maintain is worth more than tolerance for unknown values. What this gains: a new tolerance in T3's schemas reaches us with a sync and no work of ours, and every malformed reply is loud instead of being half read.

Move away from it when the loud failures keep coming: a harness release that we must support breaks a call with `unreadable` again and again, and T3 does not have the fix after a sync. Then our own decoding can be added as a change of `connection.ts` only:

- Call `client.raw.request` and `client.raw.notify` instead of `client.agent.*`.
- Answer the harness's requests and read `session/update` in our own line reader, before T3 sees the lines.
- Decode with our own open schemas to the types in `types.ts`.
- `initialize` must then send `protocolVersion: 1` itself.

The interface in `index.ts` stays the same, so nothing outside `connection.ts` changes.

## Lint, formatting and tests

The copy is excluded from eslint, oxlint and oxfmt (`eslint.config.js`, `.oxlintrc.json`, `.oxfmtrc.json`), so that a sync is a plain copy. Its own tests run in our suite (`pnpm test:node packages/acp`). They need `@effect/platform-node`, which is why it is a dev dependency.

## Sync with T3 Code

Run from the repository root. `<commit>` is the T3 Code commit to copy.

```sh
T3=$(mktemp -d)
git clone https://github.com/pingdotgg/t3code "$T3"
git -C "$T3" checkout <commit>

V=packages/acp/vendor/effect-acp
rm -rf "$V/src" "$V/test" "$V/LICENSE"
cp -r "$T3/packages/effect-acp/src" "$T3/packages/effect-acp/test" "$V/"
cp "$T3/LICENSE" "$V/LICENSE"
rm -rf "$T3"
```

Then:

1. Put the new commit in this README (above).
2. Run `pnpm test:node packages/acp`, `pnpm typecheck`, `pnpm lint` and `pnpm dep-lint`.
3. Read `git diff` of `packages/acp/vendor` for what matters to us:
   - `client.ts`: `make`, `agent.*`, the handlers (`handleSessionUpdate`, `handleRequestPermission`, `handleElicitation`, `handleElicitationComplete`, `handleUnknownExtNotification`) and `raw.notifications`, which `src/connection.ts` calls. T3 sets `title` on an approval request only when it read the request as version 2 (`normalizePermissionRequest`), and `connection.ts` refuses a request with a `title` that the harness sent with a version 1 `toolCall`.
   - `protocol.ts`: `acpRequestIdentity`, the `onIncomingRequest` hook, and the log events `connection.ts` reads to word an `unreadable` failure (the incoming and outgoing `decoded` events and `decode_failed`).
   - `errors.ts`, `compat.ts` and `_generated/`: the shapes `src/types.ts` must still satisfy. `pnpm typecheck` shows a required field that went away or changed type in `connection.ts`. An optional field is not checked that way: `src/connection.integration.test.ts` plays the recordings of a real harness through the connection and compares each update, tool call, form and answer with the recorded one, so a rename or a dropped field fails there.
   - The Effect version T3 uses (the `effect` entry of `catalog` in T3 Code's `pnpm-workspace.yaml`) against ours (`effect` in `package.json`). At the pinned commit T3 is on Effect 4.1.5 and we are on 4.0.7. When they differ, the copy may call an API our Effect version does not have.
   - Any new import in the copy other than `effect`: `pnpm dep-lint` fails on it.

`pnpm typecheck` may fail inside `vendor/` on an unused or fallthrough check only: T3's `tsconfig.json` does not turn those on, ours does. Keep the last copy, or fix it at T3 Code first.

Never edit a file under `vendor/`. A fix we need goes to T3 Code first.
