# Open items

The register of everything the spec assembly (2026-08-28) could not settle from the closed tickets and ADRs. Every `**Open:**`, `**Conflict:**`, `**Verify at build time:**` and `**Risk:**` line in documents 01-15 is indexed here, in one of four classes:

- **A. Decisions handed to tickets.** Real design questions. Each is on the [wayfinder map](https://github.com/rogierpennink/hydra/issues/1) as a child ticket; its resolution amends the owning document in place and removes the line. Grouped by ticket below.
- **B. Implementer's choices.** Details the spec deliberately leaves to build time. They are not design questions: any reasonable choice is fine, the constraint (if any) is stated, and the choice gets recorded in the owning document when made.
- **C. Verify at build time.** Facts about third-party systems to confirm against the pinned version before relying on them.
- **D. Standing risks.** Accepted knowingly; on record so nobody rediscovers them.

Beyond these, the map's **Not yet specified** section holds fog that is in scope but not yet sharp enough to ticket (see the end of this document); every prototype ticket is resolved (Pending prototypes, below). Resolved 2026-08-30: [Assistant runtime](https://github.com/rogierpennink/hydra/issues/40) (12, 11 §6.4, 06 §9, 10 §7.5, 13 §10, ADR 0024). Resolved 2026-08-31: [Notification lifecycle and shipped triage conventions](https://github.com/rogierpennink/hydra/issues/42) (10 rewritten for batch triage, 02 §Notification/§Trigger, 08 §4/§5.3/§10, 11 `notification`/`settings`, 13 §6.1, 14 Intake/check-in/center, ADR 0027, dated note on ADR 0011); [Runner substrate details](https://github.com/rogierpennink/hydra/issues/43) (03 throughout, 06 §2/§3/§4/§7/§9/§10/§11, 15 §1/§2/§4/§5/§9/§11/§12/§13, 13 §2.1, `ProviderRunnerContext` rename, reserved runners, ADR 0028, dated note on ADR 0018). Resolved 2026-09-01: [Operations details](https://github.com/rogierpennink/hydra/issues/44) (15 §1/§2/§5/§6/§7/§8/§9/§10, 04 §Secrets/§Retention/§Backups, 13 §1/§2.2/§3.3/§4.2/§4.3, 11 §2 `setup`/renames/§6.1; BYO TLS replaced by tailscale-managed HTTPS, `mint*Token` ops renamed `create*Token`); [Web app details](https://github.com/rogierpennink/hydra/issues/45) (14 §Wire format/§Auth/§Screens/§Check-in/§Workflow editing/§Onboarding/§Local alias/§Retention horizon, 07 §1 source-as-truth, 11 §2 `workflow.*`/`setup.complete`/`settings`, 04 §Retention, 06 §2/§9.1/Post-v1, 15 §4/§7, 12 §1, 03 §5, ADR 0029; graduated two tickets, below); [Domain model residue](https://github.com/rogierpennink/hydra/issues/46) (02 rules 9 and Ids, §Session/§Thread/§Agent/§Project/§Resource/§Workspace, new §Deletion rules; 03 §6.3; 04 §Truth model/§Retention; 06 §3/§4; 07 §4.2/§7.2; 08 §2/§5; 09 §Row/§Delete/§Platform events; 11 §1.4/§2/§4.1/§5; 12 §1/§7; 13 §4/§6; 14 §Screens/§Onboarding; ADR 0030); [Old agentick: is anything worth importing?](https://github.com/rogierpennink/hydra/issues/47) (01 §Standing decisions/§Out of scope/§Not yet specified: nothing imported, v1 starts empty, `.agentick/` ignored); [Prototype: the app shell and navigation](https://github.com/rogierpennink/hydra/issues/51) (14 §App shell: two-face sidebar, meta rows, composer as the thread's configuration, locks at start). Resolved 2026-09-02: [Revisit Effect for the backend](https://github.com/rogierpennink/hydra/issues/53) (11 §1.1/§1.2/§1.4/§1.5/§10, 14 §Packages/§Wire format/§Performance guardrails, 04 §Engine/§Repository interfaces, 05 §3/§4/§5, 06 §4, 08 §2, 09 §Operations, 15 §11, ADR 0031, dated notes on ADR 0013 and ADR 0017); [User knowledge in Hydra sessions](https://github.com/rogierpennink/hydra/issues/52) (06 §2.1/§9.1 User Material + Codex HOME amendment, 02 §Thread + rule additions, 14 §App shell instance lock/§Onboarding, CONTEXT.md **User Material**, ADR 0032).

To find the exact line for any entry: `grep -n '^\*\*Open:\*\*' docs/spec/<doc>.md`.

## A. Decisions handed to tickets

None open - every handed decision is resolved (the register above says where each landed).

## B. Implementer's choices

Not design questions. The constraint is stated where one exists.

- 03 §2.2: the full runner-protocol message catalogue (names, payloads, error shapes) - one versioned schema in the `protocol` package.
- 04 §Streams: flush cadence inside one long-running item (size or time threshold); message and turn boundaries are the pinned minimum.
- 06 §4.3: whether `TurnInput` carries more than text in v1 - start with text; attachments are additive.
- 06 §6.4: the exact field set of `session.usage.updated` beyond tokens plus context usage.
- 13 §2.1: secrets-table column names and cipher (see also the AEAD verification below).
- 13 §10: the exact in-context taint wrapper syntax - stable and greppable (the memory provenance line is pinned).
- 12 §5.1: the runner's idle timeout for assistant session processes - one controller-wide default, 15 minutes as the starting value.
- 08 §3: whether security audit entries become matchable platform events - not in v1, additive later.

## C. Verify at build time

- 04 §Engine: FTS5 is enabled in the pinned Bun's bundled SQLite and the minimum macOS system SQLite.
- 09 §Search: the FTS5 tokenizer and whether raw `MATCH` syntax is exposed or wrapped.
- 03 §6.1, 06 §9.1: whether the Codex app-server offers a system-prompt channel better than `AGENTS.md` in a scratch cwd.
- 06 §2: pi `mcpPassthrough` in the pinned version.
- 06 §9.1: the exact compaction / isolation knob names per pinned harness version, including `settingSources: []` (Claude) and the pi launch flags (`--no-context-files` and friends) for discovery being off in workspace-less sessions.
- 06 §10.3: the Hydra pi extension file against the pinned pi version (`tool_call` hook and `registerTool` API churn); the strict LF JSONL RPC framing.
- 07 §5: CEL parse-time limits; a CI corpus of representative expressions against the wrapper.
- 08 §5.2: Gmail's stale-`historyId` error path re-baselines at now.
- 13 §1: what counts as a tailnet address for the bind warning.
- 13 §2.1: AEAD cipher choice with per-row nonce and owner/name as associated data.
- 13 §2.3: the KDF from the promotion token.
- 13 §4.2: the password hash function (argon2id expected).
- 13 §9: the runner daemon's local channel for the git credential helper and how the helper authenticates.
- 15 §11: macOS notarization of a Bun-compiled binary - prototype notarize + staple first.
- 15 §11: serving the embedded SPA (`import index from "./index.html"` / `Bun.serve({ routes })`) through the Effect HTTP server on Bun (`@effect/platform-bun`), or beside it on the same port - confirm before the web bundle is wired in.

## D. Standing risks

- 06 §10.1: Claude subscription auth. Research read Anthropic's Agent SDK policy as forbidding claude.ai login for third-party products; the decisions (tickets 22, 23, charting) accept the t3-code posture: the user's own tool driving the user's own login through the unmodified vendor CLI. API-key, Bedrock and Vertex stay first-class on the same instance config as the fallback.

## Not yet specified (map fog)

In scope, not yet sharp enough to ticket; listed on the map under **Not yet specified**:

- A presentation layer over task status (kanban-style user-defined groupings above the fixed axis); the Tasks screen ships without it (14 §Screens).
- Platform-auto subscription detection ("this session opened PR #87" subscribes it automatically); explicit subscription is the v1 primitive.
- Execution-plan snapshot dedup/GC; content-hash dedup is the known escape hatch if per-run copies ever hurt.
- Task and Project pruning: both soft-delete in v1 ([Domain model residue](https://github.com/rogierpennink/hydra/issues/46)) and events live as long as a live Task refers to them (04 §Retention), so the log's real bound becomes task retention; the idea on record is hard-pruning deleted tasks with their runs and events after something like a year. Sharpens with dogfooding.

## Pending prototypes

- ~~[Prototype: the app shell and navigation](https://github.com/rogierpennink/hydra/issues/51)~~ - resolved 2026-09-01: 14 §App shell pins the two-face sidebar, the codexlip composer as the thread's configuration, and what locks at start.

- ~~[Prototype: rendering bound actions (label, description, describe line) in the Focus card](https://github.com/rogierpennink/hydra/issues/50)~~ - resolved 2026-09-01: 14 §The check-in view pins the answers ledger (label · describe line · description as fine print, nothing behind hover), 12 §11.6 the compact chat rendering.
- ~~[Prototype: mark & entity-glyph iconography](https://github.com/rogierpennink/hydra/issues/35)~~ - resolved 2026-08-30: 14 §Iconography and [design-language.md](../design-language.md) §Marks are pinned (bespoke family at Lucide's weight, `?` for decisions, one-mark-per-slot rule, legend at the sidebar foot).
