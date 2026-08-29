# Open items

The register of everything the spec assembly (2026-08-28) could not settle from the closed tickets and ADRs. Every `**Open:**`, `**Conflict:**`, `**Verify at build time:**` and `**Risk:**` line in documents 01-15 is indexed here, in one of four classes:

- **A. Decisions handed to tickets.** Real design questions. Each is on the [wayfinder map](https://github.com/rogierpennink/hydra/issues/1) as a child ticket; its resolution amends the owning document in place and removes the line. Grouped by ticket below.
- **B. Implementer's choices.** Details the spec deliberately leaves to build time. They are not design questions: any reasonable choice is fine, the constraint (if any) is stated, and the choice gets recorded in the owning document when made.
- **C. Verify at build time.** Facts about third-party systems to confirm against the pinned version before relying on them.
- **D. Standing risks.** Accepted knowingly; on record so nobody rediscovers them.

Beyond these, the map's **Not yet specified** section holds fog that is in scope but not yet sharp enough to ticket (see the end of this document), and one prototype ticket is still open.

To find the exact line for any entry: `grep -n '^\*\*Open:\*\*' docs/spec/<doc>.md`.

## A. Decisions handed to tickets

### [Workflow execution semantics: joins, signals, errors, run states](https://github.com/rogierpennink/hydra/issues/36)

Owning document: [07-workflows.md](./07-workflows.md) (enums mirrored in [02](./02-domain-model.md)).

- 07 §4.3: join semantics for a step with several incoming edges; what a skipped step's outgoing edges do and what `steps.<id>.output` evaluates to.
- 07 §2.4: how a signal trigger attaches to the graph (held or discarded if early; fire once or many; whether downstream steps may read the matched event).
- 07 §4.4: effect of a CEL evaluation error at a step or edge site mid-run.
- 07 §6: whether `schema-failure` is routable or always run-failing.
- 07 §7.3: whether a cancelled run emits `run.failed`, nothing, or a distinct platform event.
- 07 §1: whether a disabled workflow may still be run manually; behaviour of a stored workflow that stops validating after the fact.
- 07 §3: whether a Connection reference is a first-class input type.
- 07 §5: template delimiter syntax for CEL in prompts and parameters.
- 06 §7: whether `outputSchema` must also ride `TurnInput` per graph iteration (it sits on `SessionSpec` today).

### [Actors and authorisation beyond sessions: runs, plugins, bound Notification actions](https://github.com/rogierpennink/hydra/issues/37)

Owning documents: [11 §3](./11-public-api-and-agent-surface.md), [10 §7.4](./10-triage-intake-and-notifications.md), [13 §6](./13-security.md).

- (Items 1 and 2 of the ticket, the actor value and gating of run action steps and plugins, were pinned by [Public API operation catalogue](https://github.com/rogierpennink/hydra/issues/38): `run:<id>` and `plugin:<id>`, ungated; 11 §3.1.)
- 11 §3.2, 10 §7.4, 13 §6.4, 02 §Notification: whether an agent-authored bound operation must have been within the authoring session's permission profile (or only the user's parity at click time).
- 10 §7.4: how the concrete operation is rendered so the click is informed.
- 10 §7.4: whether a bound operation can be executed from a channel sink and how that click is authenticated as the user.

### [Channel contribution interface and conversation ingress (Discord, Slack)](https://github.com/rogierpennink/hydra/issues/39)

Owning documents: [12 §11](./12-assistants.md), [05 §4](./05-plugins.md), [10 §7.3](./10-triage-intake-and-notifications.md).

- 12 §11, 05 §4.2: the channel contribution's TypeScript interface (inbound message shape, outbound send, scope model announcement).
- 12 §11: whether inbound chat messages flow through the persisted event pipeline as Events.
- 12 §2, §3: Slack and Discord container keys; the binding scope schema and specificity order.
- 12 §4: where the owner's platform identities are configured; the bound on stored unaddressed group context; whether the assistant's own and other bots' messages are excluded.
- 12 §11: message formatting, long-reply splitting, typing indicators; Discord intents and Slack OAuth scopes.
- 10 §7.3: what a channel sink renders for a decision Notification; whether an assistant's own conversation is a valid sink target.

### [Assistant runtime: rotation, heartbeat, injection, memory op edge cases](https://github.com/rogierpennink/hydra/issues/40)

Owning documents: [12](./12-assistants.md), [11 §6.4](./11-public-api-and-agent-surface.md), [06 §9.2](./06-providers.md).

- 12 §8.2: the heartbeat mechanism (a cron trigger has no way to deliver queued input as specified) and its defaults: cadence, standing prompt, target conversation, whether it counts toward the rotation timer.
- 12 §5: rotation ceiling and daily timer values; rotation while a turn is in flight; whether unaddressed group context carries to the successor.
- 12 §6.3, 06 §9.2: where injected memory lands per harness (`systemPrompt` vs first user turn).
- 12 §7: which access mode assistant sessions run under and whether harness work tools are disabled for workspace-less assistant sessions.
- 12 §6.4, 11 §6.4: memory op edge cases - header validation on `write`, `delete core`, `memory search` semantics, a v1 shrink guard (the on-record alternative to post-v1 version history).
- 12 §6.5: how the write op learns a write is distilled from a tainted conversation; the provenance line format.
- 12 §8.1, 10 §7.5: the no-double-fire mechanism (what "holding" means, which producers, record-or-not).
- 12 §1, §9: Assistant record fields beyond agent + bindings + memory + heartbeat; one or several web-chat conversations per assistant.

### [Plugin contribution interfaces and v1 event kinds (event source, workflow action, setup flow)](https://github.com/rogierpennink/hydra/issues/41)

Owning documents: [05](./05-plugins.md), [08](./08-events-and-connections.md).

- 05 §4: TypeScript signatures of the event-source and workflow-action contributions (the channel one is in the ticket above).
- 08 §5.1, §5.2: the v1 GitHub kind names and payload schemas; the Gmail default poll interval and whether it is per-Connection.
- 08 §2: whether `url` and `refs` are enrichable after ingest like `system`.
- 09 §Provenance: who canonicalizes External Refs for systems that have no plugin (Sentry, Tailscale, Hetzner via Gmail).
- 08 §5.5: the exact `run.completed` / `run.failed` payload fields.
- 05 §4.4: the v1 `github.*` / `gmail.*` action roster; whether built-in actions sit in the same contribution catalog under a core namespace.
- 05 §7, §8: the setup-flow contribution shape and OAuth callback routing; where a BYO OAuth client id and secret live.
- 05 §9, §10: whether a disabled plugin's KV namespace is retained; behaviour when `activate()` throws or deactivate fails.

### [Notification lifecycle and shipped triage conventions](https://github.com/rogierpennink/hydra/issues/42)

Owning document: [10](./10-triage-intake-and-notifications.md) (status axis mirrored in [02](./02-domain-model.md)).

- 10 §7.1: the Notification's one fixed status axis; whether a producer can withdraw or update a notification; whether muted notifications are recorded-but-not-delivered.
- 10 §7.6: whether an approval answered in the session view auto-resolves its notification.
- 10 §3, §4: the roster of shipped default workflows; which step's output on a run is the verdict for Intake detail; what accept / park / dismiss do to the Task; where topic ordering is stored.
- 10 §8 (Conflict): the events-view stamp vocabulary ("filed"/"held" vs "routed"/"attached"); 08 §10: how the "ignored" stamp is derived.
- 10 §5, 02 §Trigger: spawn-bound window shape; where held events are stored; whether a repeated filter error raises a Notification (08 §4.2).
- 10 §8: where the per-user "since you last checked" marker lives and what advances it.

### [Runner substrate details: protocol guarantees, defaults, provider CLI delivery](https://github.com/rogierpennink/hydra/issues/43)

Owning documents: [03](./03-controller-and-runners.md), [06 §2, §4](./06-providers.md), [15 §12, §13](./15-packaging-and-operations.md).

- 03 §2.3: delivery guarantees for controller-to-runner commands across a disconnect; the `online -> unreachable` silence threshold; join token lifetime; the runner-side re-point command after promotion.
- 03 §3.3: whether provider login runs inside `hydra runner join` or as a post-join step.
- 06 §2.1 (Conflict): provider-instance config (binary path, config dir) versus the no-runner-paths rule; the secrets owner kind for provider-instance secrets and how the runner obtains them.
- 06 §4.2: the field through which the runner hands the adapter the session environment (`env` on `RunnerContext`).
- 15 §2, 06 §9.3: how a session reaches the `hydra` binary.
- 15 §12: which Claude Code binary drives sessions (embedded vs runner-installed); how pi's package lands on a runner without Node; Hydra-pinned vs vendor-latest CLI versions at join; coupling of `hydra service install` and join.
- 15 §4, §5: local runner crash-restart policy and auto-join token handoff; where a runner persists its credential and controller URL; whether a runner upgrade drains or interrupts sessions.
- 03 §5, §6: probe cadence for toolchain facts and the probed toolchain list; session timeout and disk watermark defaults; reaper TTL; task-branch naming for ephemeral checkouts (also 07 §4.2); `.workspaceinclude` source when no primary workspace exists.

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
- 14 §Onboarding: the onboarding steps beyond password and default assistant.
- 14 §Screens: what Settings > Bounds shows; which tier standing workflows render under in check-in.
- 14 §Live model: the WebSocket wire format; 14 §Auth: bearer token storage between page loads; 14 §Local alias: the loopback port for `GET /identity`.

### [Domain model residue: id format, remaining status axes, identity rules](https://github.com/rogierpennink/hydra/issues/46)

Owning document: [02](./02-domain-model.md), with [04](./04-state-store.md), [08](./08-events-and-connections.md), [09](./09-tasks.md), [07](./07-workflows.md).

- 04 §Truth model, 02 §Rules, 08 §2, 09 §Row: the id format for Hydra-owned entities; whether the event table's primary key is the log position or a Hydra id plus position.
- 02 §Session, §Workspace, §Connection: confirm the consolidated status enums (owned by 06 §4.1, 03 §6.3, 08 §8.1).
- 02 §Task, 09 §Delete: whether hard delete emits `task.deleted`; 02 §Provenance: whether an entry must carry at least one of `ref` / `eventId` / `runId`.
- 02 §Agent, 07 §4: which session defaults an Agent carries; whether placement inputs live on the Agent or the agent step; whether a chat-first session can exist without an Agent row.
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
- 13 §10: the exact taint marker syntax (in-context wrapper and memory provenance line) - stable and greppable.
- 08 §3: whether security audit entries become matchable platform events - not in v1, additive later.

## C. Verify at build time

- 04 §Engine: FTS5 is enabled in the pinned Bun's bundled SQLite and the minimum macOS system SQLite.
- 09 §Search: the FTS5 tokenizer and whether raw `MATCH` syntax is exposed or wrapped.
- 03 §6.1, 06 §9.1: whether the Codex app-server offers a system-prompt channel better than `AGENTS.md` in a scratch cwd.
- 06 §2: pi `modelSwitch` in the SDK; pi `mcpPassthrough` in the pinned version.
- 06 §9.1: the exact compaction / isolation knob names per pinned harness version.
- 06 §10.3: pi's SDK under the Bun host; how the pinned pi package reaches the host on a runner.
- 07 §5: CEL parse-time limits; a CI corpus of representative expressions against the wrapper.
- 08 §5.2: Gmail's stale-`historyId` error path re-baselines at now.
- 10 §5: whether Resume's held backlog counts against the spawn bound again.
- 13 §1: what counts as a tailnet address for the bind warning.
- 13 §2.1: AEAD cipher choice with per-row nonce and owner/name as associated data.
- 13 §2.3: the KDF from the promotion token.
- 13 §4.2: the password hash function (argon2id expected).
- 13 §9: the runner daemon's local channel for the git credential helper and how the helper authenticates.
- 15 §11: macOS notarization of a Bun-compiled binary - prototype notarize + staple first.
- 15 §11: where `extractFromBunfs` places the extracted Claude binary and whether it re-extracts per boot.

## D. Standing risks

- 06 §10.1: Claude subscription auth. Research read Anthropic's Agent SDK policy as forbidding claude.ai login for third-party products; the decisions (tickets 22, 23, charting) accept the t3-code posture: the user's own tool driving the user's own login through the unmodified vendor CLI. API-key, Bedrock and Vertex stay first-class on the same instance config as the fallback.

## Not yet specified (map fog)

In scope, not yet sharp enough to ticket; listed on the map under **Not yet specified**:

- A presentation layer over task status (kanban-style user-defined groupings above the fixed axis); the Tasks screen ships without it (14 §Screens).
- Platform-auto subscription detection ("this session opened PR #87" subscribes it automatically); explicit subscription is the v1 primitive.
- Execution-plan snapshot dedup/GC; content-hash dedup is the known escape hatch if per-run copies ever hurt.

## Pending prototype

- [Prototype: mark & entity-glyph iconography](https://github.com/rogierpennink/hydra/issues/35): the marks and entity glyphs in 14 §Iconography are placeholders; the legend toggle's placement is part of the same ticket. Not blocking implementation of anything but the final icon set.
