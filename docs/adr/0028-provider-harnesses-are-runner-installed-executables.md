# 28. Provider harnesses are runner-installed executables, floor-pinned and explicitly updated

Date: 2026-08-31

## Status

Accepted. Amends [ADR 0018](./0018-hercule-ships-as-one-self-contained-binary.md) (the embedded Claude binary clause is withdrawn). Decided by [Runner substrate details (#43)](https://github.com/theagenticage/hercule/issues/43).

## Context

ADR 0018 planned to embed the Claude Agent SDK's native Claude Code binary inside the Hercule executable (~250-270 MB per platform, `extractFromBunfs` at boot), while spec 03 §3.3 separately installed `claude` on each runner for login - two copies of the same harness. pi was assumed to be hosted through its SDK in a Hercule-owned child process, compiling pi's pre-1.0 TypeScript API into the Hercule binary and tying pi's version to Hercule releases. Harnesses ship weekly; Hercule will not, and the user explicitly wants to update harnesses independently ("they change way more often than I intend to release hercule updates").

Facts established for this decision: the Claude native installer pins exact versions (`install.sh | bash -s 2.1.N`) and SDK 0.3.N bundles a byte-identical CLI 2.1.N (checksum-verified against the release manifest); `DISABLE_AUTOUPDATER=1` stops background updates. The Codex installer pins via `CODEX_RELEASE`; Codex never auto-installs updates. pi ships an official standalone Bun-compiled binary with an install script and a `pi update` self-updater; its RPC mode plus one extension file covers everything the adapter needs (approval park-and-resume via `extension_ui_request`, `submit_result` with `terminate: true`), but its RPC protocol carries no version and breaks a few times a year.

## Decision

All three harnesses are **external executables installed per runner at join**, never embedded:

- **Claude Code**: the vendor-installed `claude` drives sessions via `pathToClaudeCodeExecutable` (t3code's posture); the SDK compiles into Hercule but its per-platform CLI packages are excluded from the build.
- **Codex**: the vendor static binary, driven over `codex app-server`, stable surface only.
- **pi**: the official standalone binary, driven over `pi --mode rpc` with one Hercule extension file passed via `-e`. No pi code compiles into Hercule.

**Version policy: floor-pinned, explicitly updated.** Each Hercule release stamps a per-harness **minimum** (Claude: the CLI version its compiled-in SDK bundles; Codex and pi: the release the adapter was built against) and a **tested-max**. Below the minimum blocks placement for that instance x runner; above the tested-max warns ("untested") but runs - most updates are not breaking. Join installs the vendor's latest (>= the floor by construction). Vendor auto-updaters are disabled (`DISABLE_AUTOUPDATER=1`; `check_for_update_on_startup = false`; `PI_SKIP_VERSION_CHECK=1`) so a harness never changes under a running session; updates are explicit fleet actions - the controller checks vendor latest and the Fleet view offers per-runner "Update harness" (running the vendor's own updater over the runner WebSocket) and "Update all". Fleet-managed harness updates, listed post-v1 by ticket #24, are thereby v1.

## Consequences

- The Hercule binary drops from ~250-270 MB to roughly 60-70 MB; `extractFromBunfs` and its verify item disappear; one copy of each harness per runner.
- Version skew is real and surfaced: the capability snapshot shows harness version, below-floor, and above-tested-max per instance x runner.
- pi's RPC breakage risk is carried by the tested-max warning plus regression tests on the extension seams; the Hercule extension file must track pinned-pi API churn.
- If the vendor installer path ever breaks, downloading the SDK's own platform package (pinned by definition) is the recorded fallback for Claude.
