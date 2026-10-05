# Codex subagent usage across forks and resumes

[Report Codex subagents, #437](https://github.com/theagenticage/hercule/issues/437) owns this probe. It resolves spec 06 §13.5's expected inherited total and checks the cancellation case identified during review of #442.

## Method

The probe runs the real Codex 0.154.0 app-server against a local HTTP server implementing the Responses API. Deterministic model responses invoke Codex's actual native tools. Codex creates threads, copies history, executes tools, asks approvals, persists threads and restores them after process restart. The local fixture supplies model responses and exact numeric usage; it does not manufacture app-server notifications.

Every process uses a throwaway `CODEX_HOME`, `HOME` and working directory. The fixture uses a dummy API key, makes no external API calls and reads no user login. Processes are stopped by their captured handles, their exits are awaited, and the temporary homes are removed. The binary was downloaded from [OpenAI's 0.154.0 release](https://github.com/openai/codex/releases/tag/rust-v0.154.0); the installed CLI was left unchanged.

The committed tests are [adapter.integration.test.ts](../../apps/runner/src/providers/codex/adapter.integration.test.ts) and [mock-model.testing.ts](../../apps/runner/src/providers/codex/mock-model.testing.ts). Run the fixture without a subscription:

```sh
HERCULE_CODEX_TEST_BINARY=/absolute/path/to/codex \
  bun --bun run vitest run --project node \
  apps/runner/src/providers/codex/adapter.integration.test.ts
```

The binary override is optional; without it, the tests use `codex` on `PATH`. Tests skip when no binary is available.

## Native forks start at zero

Both V1 `spawn_agent { fork_context: true }` and V2 `spawn_agent { fork_turns: "all" }` were exercised with the pinned binary's default paginated thread history.

- V1's tool discovery exposes `multi_agent_v1.spawn_agent`; the fixture discovers and invokes that native tool.
- V2 advertises `collaboration.spawn_agent` directly; the fixture invokes that native tool.
- The child's model context contains the root's prior user-message marker. `thread/read` reports the root as both `parentThreadId` and `forkedFromId`.
- A child's first successful model call reports `total == last`, containing only that child's 300 input tokens and 10 output tokens. It does not start from the parent's Token Usage.
- Cancelling a new child's first response before `response.completed` emits no child usage report.
- The parent's spawn notification precedes its usage update for the model call that requested the spawn. The last parent total observed at spawn therefore is not a reliable fork baseline.

This result is specific to native subagent forks under the tested history settings. A public `thread/fork` used to fork a Session is a separate lifecycle path and retains the existing restored-history handling.

The pinned source copies model context through [`load_agent_model_context` and `spawn_forked_thread`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/agent/control/spawn.rs). For paginated histories it reads the latest model context, rather than the parent's complete event log, and excludes inherited `TokenUsageRecord` entries. A fork's origin metadata alone does not establish its initial token total.

## Native resume can repeat old usage under a new turn

The probe lets a child use 300 input tokens and 10 output tokens, stops the app-server, then resumes the root in another process. The root continues its known child using V1 `resume_agent` plus `send_input`, or V2 `followup_task`.

| Moment | Child total | Child last | Owning turn |
| --- | --- | --- | --- |
| Initial successful call | 300 input, 10 output | 300 input, 10 output | Original child turn |
| Root restored in another process | No child report | No child report | None |
| Continued child's first response cancelled | 300 input, 10 output | 300 input, 10 output | New child turn |

The final report is historical usage, although its `turnId` names the new turn. Without an earlier baseline, `total - last` makes the baseline zero and counts those historical tokens again. Checking the usage notification's turn ID cannot distinguish this case.

The approved implementation carries the last attributed native report privately with the known Subagent on resume. The controller stores the provider's report without interpreting Codex counters. The adapter restores its previous native total from that report and starts its new process's count at zero. The cancelled call then adds zero; the next successful call adds only its new usage. The Session snapshot remains the root plus every subagent.

## Restoring older records that have no saved report

Explicit `thread/resume` on a known child succeeds in both V1 and V2. It replays the child's restored usage after its RPC response, attributed to the old turn, before new work starts. This gives older records a baseline without scanning vendor files.

A child that has never reported usage emits no replay. The adapter therefore cannot wait indefinitely for a usage notification. A subsequent metadata-only `thread/read` acts as the end of replay: the pinned protocol serializes both requests on the same thread, and the resume handler sends its replay before returning. See [request serialization declarations](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server-protocol/src/protocol/common.rs), [resume implementation](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/src/request_processors/thread_processor.rs) and [replay attribution](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/src/request_processors/token_usage_replay.rs).

Two cheaper alternatives do not work:

- `excludeTurns: true` deliberately suppresses restored usage replay.
- `thread/unsubscribe` after replay removes child notifications from the observing connection. A later parent `followup_task` still starts the child model request, but the adapter no longer receives the child's turn events.

This fallback loads the historical child. One small V2 child with one turn took 5 ms to attach, increased loaded threads from one to two, and increased app-server RSS from 75,472 KiB to 79,760 KiB. This is an illustrative single-child measurement, not a large-history benchmark. Saving native reports avoids this extra attachment on ordinary later resumes.

## Acceptance evidence

The real-process integration checks both Codex tool generations. A root spawns two inherited children. Each child asks a real command approval. Both requests remain open while the root finishes. The test answers the second request first, observes that child's completion while the first request remains unresolved, then answers the first. It checks descriptions, parentage, models, command attribution and exact usage.

Each child uses 600 input tokens and 20 output tokens across its command call and final answer. The Session snapshot is 2,500 input/80 output for V1, or 2,400 input/70 output for V2. The difference is V1's tool-discovery model call. The same cases pass on pinned 0.154.0 and installed 0.160.1.

The restart cases run both V1 and V2 with a saved native report and with that report absent on an older record. After restarting the app-server, they cancel a known child's first response, require its new-process usage to remain zero, then complete another child call and require exactly 300 input/10 output tokens. These cases also check that introductions reuse known subagent IDs, once per process.

Removing only the saved-report baseline assignment, while still reporting that the report was valid, makes both native saved-report restart tests fail numerically: the cancelled call incorrectly counts 300 input/10 output tokens. Restoring that assignment makes both tests pass. The complete local-model integration file passes eight tests on both 0.154.0 and 0.160.1; the two subscription-only tests remain skipped in those local runs.

A separate authorized login-backed run against pinned 0.154.0 passed the existing output-schema success and impossible-schema failure tests. That run copied only the nominated login file into a temporary instance home and removed that home afterwards. The concurrent-subagent scenario uses the deterministic local model, so the exact timing and totals do not depend on a remote model choosing to delegate.
