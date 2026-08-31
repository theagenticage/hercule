# Open items

The register of everything the spec assembly (2026-08-28) could not settle from the closed tickets and ADRs. Every `**Open:**`, `**Conflict:**`, `**Verify at build time:**` and `**Risk:**` line in documents 01-15 is indexed here, in one of four classes:

- **A. Decisions handed to tickets.** Real design questions. Each is on the [wayfinder map](https://github.com/rogierpennink/hydra/issues/1) as a child ticket; its resolution amends the owning document in place and removes the line. Grouped by ticket below.
- **B. Implementer's choices.** Details the spec deliberately leaves to build time. They are not design questions: any reasonable choice is fine, the constraint (if any) is stated, and the choice gets recorded in the owning document when made.
- **C. Verify at build time.** Facts about third-party systems to confirm against the pinned version before relying on them.
- **D. Standing risks.** Accepted knowingly; on record so nobody rediscovers them.

Beyond these, the map's **Not yet specified** section holds fog that is in scope but not yet sharp enough to ticket (see the end of this document), and one prototype ticket is still open. Resolved 2026-08-30: [Assistant runtime](https://github.com/rogierpennink/hydra/issues/40) (12, 11 §6.4, 06 §9, 10 §7.5, 13 §10, ADR 0024). Resolved 2026-08-31: [Notification lifecycle and shipped triage conventions](https://github.com/rogierpennink/hydra/issues/42) (10 rewritten for batch triage, 02 §Notification/§Trigger, 08 §4/§5.3/§10, 11 `notification`/`settings`, 13 §6.1, 14 Intake/check-in/center, ADR 0027, dated note on ADR 0011); [Runner substrate details](https://github.com/rogierpennink/hydra/issues/43) (03 throughout, 06 §2/§3/§4/§7/§9/§10/§11, 15 §1/§2/§4/§5/§9/§11/§12/§13, 13 §2.1, `ProviderRunnerContext` rename, reserved runners, ADR 0028, dated note on ADR 0018).

To find the exact line for any entry: `grep -n '^\*\*Open:\*\*' docs/spec/<doc>.md`.

## A. Decisions handed to tickets

### [Operations details: bootstrap config, first run, login, upgrade, backups, key file](https://github.com/rogierpennink/hydra/issues/44)

Owning documents: [15](./15-packaging-and-operations.md), [04](./04-state-store.md), [13](./13-security.md).

- 15 §6: the complete bootstrap key list, TOML names and `HYDRA_*` mapping; whether BYO TLS paths are bootstrap or controller state.
- 15 §1, §2: the installer's binary path and PATH handling; `hydra service` verbs beyond `install`; the ops command that mints a runner join token.
- 15 §7: how the user retrieves the one-time setup URL under a service unit; setup token lifetime; what the API and web app allow before the password exists.
- 11 §6.1: how `hydra login` takes the password under the never-prompts rule; 13 §4.2: the lifetime of the login-issued bearer token.
- 15 §5, 04 §Secrets, 13 §2.2: the location of the plain-file master key on headless Linux; the CLI credential file's location and name.
- 15 §8, §9, §10, 04 §Backups: pre-migration copy method; release signing scheme; update-check cadence; backup time, retention and restore procedure.
- 04 §Retention, 15 §6: concrete defaults for `retention.events` and `retention.security`.

### [Web app details: workflow text format, onboarding steps, Settings > Bounds, WS envelope](https://github.com/rogierpennink/hydra/issues/45)

Owning document: [14](./14-web-app.md).

- 14 §Workflow editing: the text format the editor edits (JSON, YAML, other).
- 14 §Onboarding: the onboarding steps beyond password, timezone confirmation (the user's timezone setting pinned by [Assistant runtime](https://github.com/rogierpennink/hydra/issues/40), 12 §5.2) and default assistant.
- 14 §Screens: what Settings > Bounds shows; which tier standing workflows render under in check-in.
- 14 §Live model: the WebSocket wire format; 14 §Auth: bearer token storage between page loads; 14 §Local alias: the loopback port for `GET /identity`.

### [Domain model residue: id format, remaining status axes, identity rules](https://github.com/rogierpennink/hydra/issues/46)

Owning document: [02](./02-domain-model.md), with [04](./04-state-store.md), [08](./08-events-and-connections.md), [09](./09-tasks.md), [07](./07-workflows.md).

- 04 §Truth model, 02 §Rules, 08 §2, 09 §Row: the id format for Hydra-owned entities; whether the event table's primary key is the log position or a Hydra id plus position.
- 02 §Session, §Workspace, §Connection: confirm the consolidated status enums (owned by 06 §4.1, 03 §6.3, 08 §8.1).
- 02 §Task, 09 §Delete: whether hard delete emits `task.deleted`; 02 §Provenance: whether an entry must carry at least one of `ref` / `eventId` / `runId`.
- 02 §Agent, 07 §4: which session defaults an Agent carries; whether a chat-first session can exist without an Agent row.
- 02 §Project, §Resource: Project-Resource cardinality and further Project fields; whether a repo Resource is identified by its remote URL.

### [Old agentick: is anything worth importing?](https://github.com/rogierpennink/hydra/issues/47)

Graduated from the map's fog; no spec line references it. Resolution amends [01](./01-overview-and-scope.md).

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

## D. Standing risks

- 06 §10.1: Claude subscription auth. Research read Anthropic's Agent SDK policy as forbidding claude.ai login for third-party products; the decisions (tickets 22, 23, charting) accept the t3-code posture: the user's own tool driving the user's own login through the unmodified vendor CLI. API-key, Bedrock and Vertex stay first-class on the same instance config as the fallback.

## Not yet specified (map fog)

In scope, not yet sharp enough to ticket; listed on the map under **Not yet specified**:

- A presentation layer over task status (kanban-style user-defined groupings above the fixed axis); the Tasks screen ships without it (14 §Screens).
- Platform-auto subscription detection ("this session opened PR #87" subscribes it automatically); explicit subscription is the v1 primitive.
- Execution-plan snapshot dedup/GC; content-hash dedup is the known escape hatch if per-run copies ever hurt.

## Pending prototype

- ~~[Prototype: mark & entity-glyph iconography](https://github.com/rogierpennink/hydra/issues/35)~~ - resolved 2026-08-30: 14 §Iconography and [design-language.md](../design-language.md) §Marks are pinned (bespoke family at Lucide's weight, `?` for decisions, one-mark-per-slot rule, legend at the sidebar foot).
