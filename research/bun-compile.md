# Research: Bun compile feasibility matrix

Resolves [#34](https://github.com/rogierpennink/hydra/issues/34). Validates the single-binary bet from [ADR 0018](../docs/adr/0018-hydra-ships-as-one-self-contained-binary.md). Researched 2026-08-23 against primary sources (Bun docs, oven-sh/bun issues, Claude Agent SDK docs and npm tarball, pingdotgg/t3code source).

**Verdict: go-with-workarounds.** Every pillar of the bet is either first-class in Bun or has an officially documented workaround. Required workarounds are listed at the end; the one residual risk needing an early prototype is macOS notarization.

## 1. Claude Agent SDK inside a Bun-compiled binary

**Works, with an officially documented workaround.**

The premise has shifted since ADR 0018: current SDK versions (verified against npm `0.3.241`) no longer spawn a `cli.js` under node/bun by default. The SDK ships a **native Claude Code binary** per platform as optional dependencies (`@anthropic-ai/claude-agent-sdk-darwin-arm64`, `-linux-x64`, `-linux-arm64`, plus musl and win32 variants) and resolves it via `require.resolve`; on failure it throws "Native CLI binary for ${platform}-${arch} not found... or set options.pathToClaudeCodeExecutable". Options `pathToClaudeCodeExecutable?: string`, `executable?: 'bun' | 'deno' | 'node'`, and `executableArgs?: string[]` all exist in `sdk.d.ts`.

Inside a compiled binary, `require.resolve` fails in the virtual filesystem, and Anthropic's docs prescribe exactly our scenario: embed the platform binary with `import binPath from ".../claude" with { type: "file" }`, then call `extractFromBunfs(binPath)` (the `@anthropic-ai/claude-agent-sdk/extract` export - it extracts a file from Bun's `$bunfs` virtual filesystem to a real temp directory, because child processes cannot access `$bunfs`) and pass the result as `pathToClaudeCodeExecutable`. No node or bun needed on the machine.

Costs: each platform package is ~200MB (t3code source comment: "each a ~200MB bundled executable"), inflating the Hydra binary to roughly 250-270MB per platform and requiring first-run extraction to a temp dir. Cross-compiling means CI must install all platform optional deps and embed the matching one per target. Alternative to shrink binaries: download the claude binary at install time instead of embedding it.

**t3code prior art is weaker than ADR 0018 assumed**: t3code does NOT use `bun build --compile`. Its server runs under Node/Electron (`engines: node ^22.16 || ^23.11 || >=24.10`, spawned via Electron's `process.execPath` with `ELECTRON_RUN_AS_NODE`), excludes the SDK's platform packages from packaging, and passes the user's installed `claude` executable via `pathToClaudeCodeExecutable`. The compiled-binary support we rely on comes from Anthropic's own SDK docs instead, which is a stronger source anyway.

- Agent SDK TypeScript reference (options table + "Bun compilation" section with `extractFromBunfs`): https://code.claude.com/docs/en/agent-sdk/typescript
- npm package (exports `./extract`, optionalDependencies list): https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
- t3code server package.json: https://github.com/pingdotgg/t3code/blob/main/apps/server/package.json
- t3code desktop build script (SDK exclusion + ~200MB comment): https://github.com/pingdotgg/t3code/blob/main/scripts/build-desktop-artifact.ts

## 2. Self-spawn (local runner child, per-session pi children)

**Works. Role dispatch via spawn is fine; arbitrary on-disk TS entrypoints work via documented `BUN_BE_BUN=1`.**

In a compiled binary, `process.execPath` is the compiled binary itself, and spawning it boots the embedded entrypoint with your argv (stated verbatim in oven-sh/bun#35129). So `spawn(process.execPath, ["runner", "--local"])` and branching on `process.argv` is exactly the supported pattern.

For pi's TypeScript entrypoints: `BUN_BE_BUN=1` is real and documented - "Set the `BUN_BE_BUN=1` environment variable to run a standalone executable as if it were the `bun` CLI itself. The executable ignores its bundled entrypoint and exposes the full `bun` CLI instead" (new in Bun v1.2.16). The full CLI includes `run`, so `BUN_BE_BUN=1 ./hydra run /path/to/pi.ts` executes arbitrary on-disk TypeScript with no external runtime.

Caveats:
- `child_process.fork()` / `cluster.fork()` inside compiled binaries is broken (module path demoted to argv, self-respawn storm - #35129, open). Use `spawn`, never `fork`.
- argv[0] handling has an open issue (#32851).
- The binary does not automatically substitute itself when code shells out to a literal `bun` command (#14459, #36724 open) - always spawn `process.execPath` explicitly.
- Workers must be listed as extra compile entrypoints; `--compile-exec-argv` embeds `process.execArgv`.

- Single-file executables docs (BUN_BE_BUN, workers, execArgv): https://bun.com/docs/bundler/executables
- fork() inside compiled executable: https://github.com/oven-sh/bun/issues/35129
- Origin feature request for BUN_BE_BUN: https://github.com/oven-sh/bun/issues/16262
- BUN_BE_BUN false-activation bug (closed): https://github.com/oven-sh/bun/issues/23205
- Literal `bun` shell-out doesn't self-substitute: https://github.com/oven-sh/bun/issues/14459, https://github.com/oven-sh/bun/issues/36724

## 3. bun:sqlite in compiled binaries

**Works.**

Docs state directly: "You can use `bun:sqlite` imports with `bun build --compile`." WAL is supported (`PRAGMA journal_mode = WAL`); on macOS Bun uses Apple's system SQLite (built with persistent WAL), on Linux Bun statically links its own. `VACUUM INTO` is plain SQL (SQLite >= 3.27) and both linked SQLites are far newer, so the daily-backup story in ADR 0018 holds. `serialize()`/`deserialize()` and `fileControl()` are supported.

Caveats:
- Extension loading on macOS requires `Database.setCustomSQLite(pathToDylib)` (Apple's build disallows extensions), which would mean shipping a dylib on disk. Works by default on Linux. Hydra currently needs no extensions, so this is moot.
- Migrations must not load filesystem-relative `.sql` files at runtime - they will not be in the binary. Inline SQL as TS strings (bundled automatically), or embed `.sql` files via `with { type: "file" }`, or use Bun 1.4's `--asset`.
- The live database itself just lives on disk as normal; nothing about compiled mode affects that.

- bun:sqlite docs: https://bun.com/docs/api/sqlite
- Executables docs (SQLite + embedded-files sections): https://bun.com/docs/bundler/executables

## 4. Embedding and serving the web bundle

**Works.**

Three documented mechanisms, in order of fit:
1. **Full-stack executables** (Bun >= 1.2.17): `import index from "./index.html"` + `Bun.serve({ routes: { "/": index } })` - Bun bundles JS/CSS/assets, embeds them, and serves them with correct MIME types and cache headers. This is the paved path for Hydra's static SPA (ADR 0017).
2. Per-file `with { type: "file" }` imports, returning `/$bunfs/root/...` paths readable via `Bun.file()`, servable as `new Response(Bun.file(path))`.
3. Bun 1.4's `--asset <path>`, which embeds a file or whole directory keeping original filenames.

Gotchas: embedded asset names get content hashes by default (override with `--asset-naming="[name].[ext]"`); `Bun.embeddedFiles` excludes bundled `.ts/.js` source; `Bun.serve` routes do not yet accept in-memory Blobs directly (#39304 open); prefer `Bun.file()`/`readFileSync` over `fs.open()` on `$bunfs` paths (#38020 open).

- Executables docs (full-stack section, embed assets, asset-naming): https://bun.com/docs/bundler/executables
- Bun 1.4 blog (`--asset` flag): https://bun.com/blog/bun-v1.4
- Issues: https://github.com/oven-sh/bun/issues/39304, https://github.com/oven-sh/bun/issues/38020

## 5. Cross-compilation and macOS signing

**Build: works. Signing: works with workaround. Notarization: undocumented - the one open risk.**

`--target` cross-compiles for a different OS/arch from one host; supported targets include all three we need (`bun-darwin-arm64`, `bun-linux-x64`, `bun-linux-arm64`), plus darwin-x64, musl variants, and Windows (not needed). Linux-to-macOS cross-compile is within the documented contract. The baseline/modern split is obsolete: on x64 Bun ships one binary targeting Nehalem (SSE4.2) with AVX2/AVX-512 selected at runtime.

Signing: `codesign` historically corrupted compiled binaries; support landed via #15525 / PR #17207 and docs now state "Codesign support requires Bun v1.2.4 or newer", with a documented codesign command and JIT entitlements plist (`allow-jit`, `allow-unsigned-executable-memory`, etc.). A regression in v1.3.12 ("invalid or unsupported format for signature", #29361/#29276) was fixed July 2026 - pin a known-good Bun version in CI. `codesign` itself must run on a macOS runner even if the build ran on Linux.

**Notarization is not mentioned anywhere in Bun's docs.** The entitlements are documented but notarize+staple of a Bun compiled binary needs our own verification. Prototype this early; it is the main residual risk to the `curl | sh` install story on macOS.

Size ballpark: hello-world `bun-darwin-arm64` was ~57MB (issue #14546); Hydra plus the embedded ~200MB claude binary lands around 250-270MB per platform.

- Executables docs (cross-compile table, codesign section, baseline note): https://bun.com/docs/bundler/executables
- Codesign feature: https://github.com/oven-sh/bun/issues/15525, https://github.com/oven-sh/bun/pull/17207
- v1.3.12 regression (fixed): https://github.com/oven-sh/bun/issues/29361, https://github.com/oven-sh/bun/issues/29276
- Size: https://github.com/oven-sh/bun/issues/14546

## 6. Bun-vs-Node compat for our dependency set

**Works; use Bun-native WebSockets and the `security` CLI; avoid keytar and native addons.**

- **WebSocket server**: `Bun.serve()` has a first-class native WebSocket server (pub/sub, backpressure, per-message deflate) - prefer it over `ws`. The `ws` package works as a fallback: Bun 1.4 added its missing `'upgrade'`/`'unexpected-response'` events, and node:http passes 97% of Node's own tests per the same release notes.
- **Keychain**: keytar is archived upstream (atom/node-keytar, last push Dec 2022) - do not use it. Shell out to the macOS `security` CLI via `Bun.spawn`; needs nothing special. If a native addon were ever wanted: Bun supports N-API and docs say `.node` files can be embedded into executables; the 1.3.6 multi-addon regression (#26045) is fixed.
- **child_process**: status "partially implemented" - IPC cannot pass http server socket handles, some `channel.ref()/unref()` gaps, and fork() is broken in compiled mode (see section 2). The Agent SDK uses plain `spawn` with pipes, and its Bun-compile flow is officially documented (section 1), which is Anthropic's own statement of support.
- **SDK dependencies**: zero runtime deps; peerDeps only `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod` - all pure JS (verified from the npm tarball).

- WebSockets docs: https://bun.com/docs/api/websockets
- Bun 1.4 blog (ws events, node:http): https://bun.com/blog/bun-v1.4
- Node compat page (child_process status): https://bun.com/docs/runtime/nodejs-apis
- keytar archived: https://github.com/atom/node-keytar
- N-API compile fixes: https://github.com/oven-sh/bun/issues/26045, https://github.com/oven-sh/bun/issues/23904

## Recommendation

**Go-with-workarounds.** Required workarounds, all against documented mechanisms:

1. **Agent SDK**: embed the per-target `@anthropic-ai/claude-agent-sdk-<platform>` native binary via `with { type: "file" }` + `extractFromBunfs()` + `pathToClaudeCodeExecutable` (Anthropic's documented pattern). Accept ~200MB per-platform growth and first-run temp extraction; CI must install all platform optional deps for cross-builds. If size hurts, switch to downloading the claude binary at install time.
2. **Self-spawn**: role dispatch via `spawn(process.execPath, [role, ...])`; never `fork()`. Pi's on-disk TS entrypoints run via `BUN_BE_BUN=1 <hydra> run <file.ts>` (Bun >= 1.2.16).
3. **Migrations and assets**: never load unbundled filesystem-relative files - inline SQL strings or embed via import attributes / `--asset`; web bundle via the full-stack HTML-import compile (Bun >= 1.2.17).
4. **Signing**: codesign with JIT entitlements on a macOS runner, Bun >= 1.2.4, pinned past the 1.3.12 regression. **Prototype notarize+staple early** - Bun does not document notarization and it is the one claim we could not verify against a primary source.
5. **Keychain**: `security` CLI subprocess, not keytar.

Fallback costs, for the record:
- **Node SEA**: single JS entrypoint only (no runtime TS for pi, no BUN_BE_BUN equivalent), no bun:sqlite (better-sqlite3 native addon must ship on disk beside the binary), clumsier asset embedding via sea-config, plus postject and per-platform signing steps. Loses most of what makes the single-binary story cheap.
- **npm-global**: abandons the "no external runtime" requirement (Node on every runner machine, the exact thing ADR 0018 rejected), but eliminates all compile-mode risk and matches how t3code itself ships. Pragmatic escape hatch if notarization or SDK embedding proves painful in practice.
