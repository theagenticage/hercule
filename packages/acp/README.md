# @hercule/acp

The ACP (Agent Client Protocol) client: it talks to a harness that speaks ACP over its stdin and stdout.

- `src/` is ours:
  - `connection.ts` opens the connection. It calls T3's typed client (`AcpClient.make`, `client.agent.*` and the handlers). T3's generated schemas decode what the harness sends, and `connection.ts` decodes each reply and message again with the ACP version 1 schema when T3 refused it or let through more than version 1 allows.
  - `types.ts` holds our own plain types and the interface of a connection. `connection.ts` assigns T3's values to them, so when a sync removes or retypes a required field, `pnpm typecheck` fails there.
  - `unreadable.ts` explains a refused value: the message, the field, the value, and the advice to sync. It takes the schema as a parameter and imports nothing from the copy.
  - `wire.ts` remembers the lines that cross the wire: the untouched `params` (`raw`) of the line T3 is handling, the open requests of the harness, the reply that belongs to each call (by its request id), and the secrets of the session. `quoteHarnessText` hides them and cuts any harness text that goes into a message.
  - `stdio.ts` turns the harness's pipes into the stdio T3 reads and writes.
  - `error.ts` holds the errors.
  - `index.ts` is the package's interface.
  - `testing.ts` and `recordings/` are the fake harness (`@hercule/acp/testing`). `*.testing.ts` files hold helpers of this package's own tests.
- `vendor/effect-acp/` is `packages/effect-acp` of [T3 Code](https://github.com/pingdotgg/t3code), copied unchanged. MIT licence, Copyright (c) 2026 T3 Tools Inc. (see `vendor/effect-acp/LICENSE`). Commit: `3a63e0ca37a50d31f78b0188960557ff69964e76`.

## What we use of the copy

`src/connection.ts` imports these files of the copy:

- `client.ts`: the client (`make`, `agent.*`, the handlers, `raw`).
- `protocol.ts`: `acpRequestIdentity`, which names a request id the way the client's handlers do.
- `errors.ts` and `compat.ts`: the errors and the compatibility types.
- `_generated/schema-v1.gen.ts`: the ACP version 1 schemas. `src/connection.ts` decodes a message again with them to find the field T3 refused, and to check each reply that T3 accepted.

Through `client.ts` the rest of the copy is linked: `rpc.ts`, `_internal/`, `schema.ts` and the other generated files.

The `elicitation/complete` notification gets a handler that only reports it: this client advertises only the form mode, which never sends it, but T3 keeps every one it receives without bound when nothing handles it.

`agent.ts` (the agent side of the protocol), every `*.test.ts` and `test/` are copied only for T3's tests, which run in our suite.

Only `src/connection.ts` imports the copy, tests and `import type` included. `pnpm dep-lint` enforces it. The same check keeps the package's import graph to `effect`, so that the runner can link the package: nothing links it yet.

## When the harness sends a value T3 does not know

T3's schemas refuse a value they do not know, such as a new tool kind in an approval request or a new config option type, and `connection.ts` refuses what ACP version 1 does not allow even where T3's own schemas accept it (they also accept version 2 shapes and empty out what version 1 refuses). You see it as:

- an `AcpError` with reason `unreadable`, or
- a report through `onUnhandledMessage`,

and the message names the ACP message, the field and the value. It happens after the pinned `agy` version was raised, or when a harness adds a feature.

First remedy: sync with T3 Code (below). T3 usually has the new value by then.

## If syncing is not enough

Rogier decided on 2026-11-25 to start with T3's typed client: less to maintain is worth more than tolerance for unknown values. If T3 cannot keep up, our own decoding can be added later as a change of `connection.ts` only:

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
2. Run `pnpm test:node packages/acp`, `pnpm typecheck` and `pnpm dep-lint`.
3. Read `git diff` of `packages/acp/vendor` for what matters to us:
   - `client.ts`: `make`, `agent.*`, the handlers (`handleSessionUpdate`, `handleRequestPermission`, `handleElicitation`, `handleElicitationComplete`, `handleUnknownExtNotification`) and `raw.notifications`, which `src/connection.ts` calls. T3 sets `title` on an approval request only when it read it as version 2 (`normalizePermissionRequest`), and `connection.ts` refuses such a request. How T3 decides that a harness speaks ACP version 2 (an `info` field in the reply to `initialize`) is repeated in `connection.ts`.
   - `protocol.ts`: the `decode_failed` log event (`src/connection.ts` reports a notification T3 drops from it), the outgoing `decoded` log event (it gives each call its request id, in the fiber of the call, before the frame is queued) and `acpRequestIdentity`.
   - `errors.ts`, `compat.ts` and `_generated/`: the shapes `src/types.ts` must still satisfy. `pnpm typecheck` shows a required field that went away or changed type in `connection.ts`. An optional field is not checked that way: `src/connection.integration.test.ts` plays the recordings of a real harness through the connection and compares each update, tool call, form and answer with the recorded one, so a rename or a dropped field fails there.
   - The Effect version T3 uses (the `effect` entry of `catalog` in T3 Code's `pnpm-workspace.yaml`) against ours (`effect` in `package.json`). When they differ, the copy may call an API our Effect version does not have.
   - Any new import in the copy other than `effect`: `pnpm dep-lint` fails on it.

Never edit a file under `vendor/`. A fix we need goes to T3 Code first.
