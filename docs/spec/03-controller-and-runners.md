# Controller and Runners

The controller is the single brain: it holds all domain state, interprets execution plans, schedules steps, and decides where sessions run. Runners are daemons on machines that host sessions and workspaces on the controller's behalf and own only material state (files, provider-native session data, an event outbox). This document specifies the split between the two, the protocol they speak, how a runner joins and leaves the fleet, how work is placed, what a runner executes sessions in and how it provisions and tears down workspaces, and how the controller itself moves to another machine (promotion). Rationale lives in [ADR 0002](../adr/0002-orchestration-stays-on-the-controller.md), [ADR 0003](../adr/0003-sessions-run-as-bare-processes.md) and [ADR 0005](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md).

## 1. The controller/runner split

### 1.1 What lives where

| Concern | Owner |
|---|---|
| Domain state: Tasks, Runs, Sessions as records, Workflows, Subscriptions, event log, queued input, queues and scheduling rows, capability snapshots | Controller ([04-state-store](./04-state-store.md)) |
| Run orchestration: interpreting execution plans, scheduling steps, placement decisions | Controller |
| Material state: workspace files, checkouts, bare caches, provider-native session data (transcripts, provider homes), the event outbox, process logs | Runner disk |
| Runner-local paths | Runner; opaque to the controller, keyed by id |

The unit of placement is the Session and the Workspace. Runners never interpret execution plans; plan-shipping to runners is a possible later optimization enabled by protocol capability negotiation (section 2.2), not v1.

Runners are semi-stateful: wiping a runner loses its workspaces and the resumability of its sessions, never history. The controller's normalized session streams remain the observable record ([06-providers](./06-providers.md)).

### 1.2 Disconnect semantics

A runner that loses its controller connection stays autonomous: its running sessions continue, their events buffer in the disk outbox, and everything replays on reconnect. Plan progression waits for the controller: a step cannot complete, and no new step can start, while the controller cannot see the runner.

### 1.3 Ids cross the boundary, paths do not

The controller authors a `SessionSpec` that carries `workspaceId` (or `null` for a workspace-less session), never a path. The runner's session supervisor resolves the id to a directory and hands the adapter a `ProviderRunnerContext` (cwd, session env, provider home, harness binary - the facts the runner resolved for this session on this machine); the adapter never sees workspace ids and the controller never sees paths. Full shapes in [06-providers](./06-providers.md).

## 2. The runner protocol

### 2.1 Transport

- The runner dials the controller and holds one persistent WebSocket. Runners accept no inbound connections from the controller.
- The controller MUST be reachable by every runner (LAN, tailnet, or public address; the user's choice). Reachability tricks such as pairing codes, tunnels and short-lived WS tickets belong to client-to-controller connections ([14-web-app](./14-web-app.md)), not to this link.
- The runner authenticates with its durable per-runner credential (section 3.2). The runner authenticates the controller's logical identity (section 8.1), not its address.
- The local runner on the controller machine joins over a loopback WebSocket as a supervised child process of the controller (`hydra runner --local`); it is an ordinary fleet member with no special code path ([15-packaging-and-operations](./15-packaging-and-operations.md)).

### 2.2 Framing and hello

- Messages are versioned typed JSON.
- The first exchange on every connection is `hello`. It carries, in both directions: the protocol version, the negotiated capability list (the protocol's extensibility seam: later features such as plan-shipping or OS sandboxing are advertised here and used only when both sides list them), and, from the runner, its probed facts (section 4).
- The hello exchange settles protocol compatibility. A hard refusal happens only on protocol incompatibility; any other version skew between controller and runner is warn-don't-block (section 2.4).

### 2.3 Sequencing, acks and the outbox

- Every runner-to-controller event carries a monotonic sequence number. The controller acknowledges sequence numbers.
- The runner keeps a disk-backed outbox of unacknowledged events. On reconnect it replays everything after the last acknowledged sequence number. This is the only disconnect buffer; there is no separate replay protocol.
- The runner reconnects with exponential backoff, 1 s doubling to a 30 s cap, retrying forever. The backoff resets to zero on an OS wake or network-change signal, so a laptop lid-open reconnects immediately.
- Seq/ack state is keyed by the controller's logical identity, so it survives the controller changing address (section 8).
- Controller-to-runner traffic on the same socket includes placement commands (start, resume, fork, stop, interrupt a session; provision or tear down a workspace), input delivery (queued input flushed on `turn.completed` and steering, both controller-owned domain state riding this channel), approval decisions, probe requests, the reachability probe used during promotion (section 8.2), and the remote upgrade command (section 2.4).

**Open:** the ticket material pins the hello exchange, seq/ack and the outbox, but not the full message catalogue (names, payloads, error shapes) of the controller-to-runner and runner-to-controller messages. The implementer defines it as one versioned schema in the shared `protocol` package.

**Command delivery across a disconnect is reconciliation, not a command queue** (resolved 2026-08-31, [#43](https://github.com/rogierpennink/hydra/issues/43)). The controller's domain state *is* the intent: a Session in `starting`, a Workspace in `provisioning`, queued input rows. Commands carry an id and are idempotent. On every reconnect - the same exchange as after a runner restart (section 6.2) - the runner reports what it actually has and the controller re-issues whatever its domain state says should exist but does not; a duplicate command for work the runner already has is a no-op. There is no persisted per-runner command queue: a second queue would be a second source of truth for the same intent.

### 2.4 Fleet version skew

- Controller and runner ship as the same binary ([15-packaging-and-operations](./15-packaging-and-operations.md)); skew is expected and surfaced, never hidden.
- Policy is warn-don't-block: a runner on a different binary version stays online and accepts placements; the fleet UI shows the skew. The only hard refusal is protocol incompatibility at hello.
- The controller can upgrade a runner remotely with one WS command that reuses the runner's own self-update path. Upgrade the controller first, then runners, as a UI-nudged convention.
- Provider harness versions differ per runner as well; that skew is a fact in the capability snapshot (section 4.2), not a protocol concern.

## 3. Registration and join

### 3.1 The join exchange

1. The user mints a single-use join token in the web app or the ops CLI.
2. On the new machine the user runs one command: `hydra runner join <controller-url> --token <token>`.
3. The exchange upgrades the token to a durable per-runner credential. It is fully programmatic: no interactive prompts, so a future auto-installer can drive it end to end. A one-line installer is acceptable in v1.
4. Join then installs the provider CLIs (section 3.3) and registers the machine's service unit by default (`--no-service` skips it; [15-packaging-and-operations](./15-packaging-and-operations.md)); a `--reserved` flag marks the runner reserved (section 5.5). A provider-CLI install failure never fails the join: the harness simply reports as absent in the runner's facts, with an "Install" retry in the fleet UI.
5. The controller records the new runner (identity, credential, name, probed facts) and the runner appears in the fleet as `online`.

The fleet UI reserves an "Add machine" spot showing the join command with a freshly minted token; fleet auto-discovery and push-install are post-v1.

The join token is single-use and expires after **1 hour**. Outstanding tokens are listable and revocable, and the "Add machine" spot mints a fresh one each time it is opened, so an expired token costs one page refresh.

### 3.2 What the runner sets up on enrollment

- A random storage directory for all its workspaces, caches and other material state, under the runner area of Hydra Home (`~/.hydra/runner/`, [15-packaging-and-operations](./15-packaging-and-operations.md)). A re-enlisted machine therefore never overwrites a previous life's folders. Legacy folders from earlier lives MAY surface very discreetly in the UI for manual recovery; Hydra never adopts them automatically.
- Its durable credential: an opaque random token, stored locally on the runner in `~/.hydra/runner/runner.json` (mode 0600, alongside the controller URL, the controller's logical identity and public key, and the storage-directory name; [15-packaging-and-operations](./15-packaging-and-operations.md)) and stored hashed on the controller ([13-security](./13-security.md)). It is not a secrets-table entry.
- A name. The controller MAY auto-assign a fun name (mythological names are the suggested scheme); the user can rename at any time.

### 3.3 Provider CLIs and login

Hydra installs the provider CLIs (Claude Code, Codex, pi: one command each) at join, and installs nothing else: everything else on the machine is the owner's responsibility and is probed, not installed (section 6.6).

Provider credentials are never distributed by Hydra. Hydra drives each provider's own headless login on the runner and relays the login URL or device code to the user's browser wherever they are; the vendor CLI stores its own credential on that runner. Copying a credential file onto a runner is a bootstrap shortcut the user may take; from then on that credential belongs to exactly one runner, because refresh-token rotation with reuse detection makes shared credentials log each other out. The per-provider login flows and their fallbacks are specified in [15-packaging-and-operations §12](./15-packaging-and-operations.md); provider-home isolation (one home per provider instance) in [06-providers](./06-providers.md); findings in `research/provider-portability.md` (branch `research/provider-portability`).

**Login is a post-join step driven from the fleet UI** (resolved 2026-08-31, [#43](https://github.com/rogierpennink/hydra/issues/43)): login belongs to a provider *instance*, which is controller state the join command knows nothing about, and the auto-joined local runner exists before any user does. The runner's fleet page lists each provider instance x this runner with its auth state and a "Log in" action; clicking runs the vendor's headless login on that runner and relays the login URL or device code to the browser (Claude: paste-a-code; Codex: device code; pi: API key entry as the v1 path, terminal `/login` as the OAuth fallback - flows in [15-packaging-and-operations §12](./15-packaging-and-operations.md)). The same action serves re-login after expiry. The join exchange stays prompt-free.

### 3.4 The local runner

The default install starts an ordinary local runner, auto-joined at first boot, hosted as a supervised child process of the controller. It gets the same random storage directory, credential and states as any other runner ([15-packaging-and-operations](./15-packaging-and-operations.md)).

## 4. Runner capabilities

A Runner Capability is a fact about a runner used for placement. Two kinds:

- **Probed facts**, self-reported by the runner at hello and refreshed on change: OS and architecture, RAM (feeds the session cap default), docker presence, toolchains (section 6.6), provider binaries and their auth state. Probing is credential-file-free: auth state comes from each provider's own side-effect-free probe, never from reading credential files. The controller never probes a runner actively.
- **Labels**, free-form strings the user applies to a runner (`gpu`, `office`, `fast-disk`). Labels are placement filters and nothing more.

### 4.1 Reporting

Probed facts are runner facts, not session events: they arrive in hello and in subsequent fact updates, not in a session's normalized event stream.

### 4.2 Capability snapshots

Per provider instance x runner, the controller keeps a `CapabilitySnapshot` (auth state, harness version, model catalog). It is probed runner-side, side-effect-free, stored in the controller DB, and re-probed on interval, on demand, on config change and when the placement target changes. Shape and probe methods in [06-providers](./06-providers.md).

Probed facts refresh at hello, on demand ("Re-probe" on the runner page), and hourly; disk free and RAM ride the 60-second watermark check (section 6.2). (Resolved 2026-08-31, [#43](https://github.com/rogierpennink/hydra/issues/43).)

## 5. Placement

### 5.1 Policy

Placement is deliberately dumb and runs in this order:

1. **Capability filter.** Runners lacking a required probed fact or label are excluded (e.g. an agent step requiring `git`, or a label the workflow names).
2. **Explicit choice.** If the request names a runner, use it - including a reserved one (section 5.5).
3. **Default runner.** Otherwise the fleet-level default runner. Never a reserved runner (the default runner cannot be flagged reserved).
4. **Controller's local runner.** If no default is set, the local runner on the controller machine - unless it is flagged reserved.

No load balancing, no migration, no failover.

### 5.2 Pin once landed

- A Workspace is pinned to the runner it was provisioned on.
- A Session is pinned to the runner it started on: provider session state lives on that disk. Resume and fork happen on the same runner.
- A session that names a workspace is placed on that workspace's runner; the filter and choice steps above apply only to the runner selection that happens before a workspace exists.

### 5.3 Per-runner session cap

- Each runner has `maxConcurrentSessions`. Default: derived from probed RAM at roughly one session per 2 GiB, floor 1. User-overridable per runner.
- A full runner queues its placements. Queued placements are visible in the UI. Work never spills to another runner.
- A runner below its disk-space watermark (section 6.2) also stops accepting placements; they queue the same way.
- Placements pinned to a runner that is `offline` or `unreachable` wait for its return.

### 5.4 The "local" alias

"Local" is a client-resolved placement alias meaning "the runner on the machine the user is operating". It is distinct from the default runner, is a UI convenience only, and is not offered when that machine has no runner. Resolution: the runner serves `GET /identity` on a loopback-only port it owns and reports as a probed fact (`identity.port`, default 4939; resolved 2026-09-01, [#45](https://github.com/rogierpennink/hydra/issues/45)) and the client matches the returned id against online fleet runners; placement correctness never depends on this detection ([14-web-app](./14-web-app.md)).

When the operating machine has a runner, **interactive sessions default to "local"**: sessions the user opens from the client ("just open X", chat-first sessions) are placed on that machine's runner unless the user picks another, so working from a laptop feels like working locally. Workflow placements ignore this and use the default runner. Resolving the "local" alias counts as explicit choice for a reserved runner (section 5.5). (Resolved 2026-08-31, [#43](https://github.com/rogierpennink/hydra/issues/43).)

### 5.5 Reserved runners

A runner may be flagged **reserved**: it hosts only work explicitly placed on it, and placement fallback never chooses it. Explicit means the request names the runner (a UI pick or a workflow's named runner), the client's "local" alias resolved it, or the placement follows a workspace already living there (pin-once-landed: the workspace's creation was itself an explicit act). The default-runner and local-runner fallback steps skip reserved runners, and the fleet default runner cannot be flagged reserved.

The flag exists for personal machines: a laptop joined as a runner should host "open this repo here", never a 3 a.m. cron routine that happened to fall through placement. Set it at join (`--reserved`; the "Add machine" spot offers a "Personal machine - only runs work you send to it" checkbox) or toggle it on the runner page at any time. The controller's auto-joined local runner is not reserved by default, so a single-machine install keeps hosting scheduled work.

## 6. Execution substrate

### 6.1 Bare processes

Sessions run as provider subprocesses directly on the runner, as the runner's OS user, cwd'd into their workspace. Linux and macOS runners only; no Windows in v1. No containers ([ADR 0003](../adr/0003-sessions-run-as-bare-processes.md)).

Isolation in v1 is provider-native mechanisms (Codex's sandbox, Claude Code's permission modes) plus Hydra's own access modes and approval flows ([06-providers](./06-providers.md), [13-security](./13-security.md)). Native OS sandboxing is post-v1 and returns as a probed capability behind hello negotiation.

Adapters run sessions in isolated provider homes, one per provider instance, so the machine owner's global instructions, skills and packages never leak into Hydra sessions ([06-providers](./06-providers.md)).

Workspace-less sessions (`workspaceId: null`) get `cwd: null` for Claude Code and pi. Codex alone gets a runner-provisioned scratch directory as its cwd, because `thread/start` needs one and instructions travel as `AGENTS.md` in it. That directory is not a Workspace: it has no id, no status and no teardown rule beyond the runner deleting it when the session exits. [06-providers](./06-providers.md) uses the same words.

**Verify at build time:** confirm whether the Codex app-server protocol offers a better channel for instructions than `AGENTS.md` in a scratch cwd before relying on the scratch directory for workspace-less Codex sessions.

### 6.2 Session supervision

The runner's session supervisor:

- Resolves `SessionSpec.workspaceId` to a directory and starts the session through the provider adapter with a `ProviderRunnerContext`.
- Injects the session's environment: `HYDRA_API_URL` and `HYDRA_TOKEN` (the session token minted by the controller at session start, dead when the session ends), `HYDRA_SESSION=1`, and the git credential configuration derived from the workspace's designated Connection (mechanics in [13-security](./13-security.md)). It makes the `hydra` binary reachable from the session (PATH prepend or absolute path: Open in [15-packaging-and-operations](./15-packaging-and-operations.md)) and materializes the shipped skill files ([11-public-api-and-agent-surface](./11-public-api-and-agent-surface.md)).
- Enforces two runner-owned timeouts, an inactivity timeout and an absolute timeout, since the harnesses have none built in. On expiry the runner stops the session and reports it as exited with the timeout as the reason (the reported outcome is this spec's consolidation; the tickets pin only the two timeouts).
- Enforces the session cap (section 5.3).
- Watches free disk space against a watermark; below it the runner reports itself as not accepting placements.
- Reconciles after a runner restart: it asks each adapter to list its live sessions and reports the outcome to the controller, so sessions the controller believes are running but the runner no longer has are marked exited.

There are no per-session CPU or memory caps.

Defaults (resolved 2026-08-31, [#43](https://github.com/rogierpennink/hydra/issues/43)): **inactivity 30 minutes, absolute 8 hours**. Inactivity means no normalized event from the harness while a turn is running - a stuck-harness detector, not an idle-between-turns rule (idle process unloading is the assistant runtime's, [12-assistants](./12-assistants.md)). Both timeouts are about the work, so they are controller-wide defaults with a per-agent override carried on the session spec, never per runner. The disk watermark is about the machine: **10 GiB free** by default, overridable per runner, checked every 60 seconds and before each placement.

### 6.3 Workspace kinds

A Workspace is a provisioned working area on one runner containing 0..N checkouts. A Checkout is one working copy of one resource; in v1 only git repos are checkout-able.

| Kind | Checkouts | Lifetime | Use |
|---|---|---|---|
| Primary | exactly 1 | long-lived; at most one per (resource, runner) | the resource's main checkout, shared by "just open X" sessions |
| Ephemeral, single | 1 | one job | the normal unit for workflow agent steps |
| Ephemeral, scratch | 0 | one job | sessions that need a working directory but no repo (e.g. mail sessions; mail truth lives on the server, reached through tools) |
| Ephemeral, multi-repo | several | one job | one root directory with one checkout subdirectory per resource |

A session may also run with no workspace at all (`workspaceId: null`; cwd rules in section 6.1).

Concurrent sessions in one primary workspace are allowed; the UI surfaces the overlap, there is no locking. A dirty primary is the next session's starting reality.

**Workspace status** (consolidated from the pinned lifecycle facts in 6.4, 6.5 and 6.7; [02-domain-model](./02-domain-model.md) mirrors it):

| Status | Meaning |
|---|---|
| `provisioning` | checkout(s) being created, setup command running |
| `ready` | usable; the normal state of a primary and of an ephemeral while its job runs |
| `unusable` | setup command failed; never handed to a session |
| `kept-on-failure` | ephemeral whose run failed, kept until the user dismisses the failed run |
| `lost` | its runner was retired, or the runner reported the directory gone |
| `deleted` | torn down by teardown or the TTL reaper; terminal, record kept |

Transitions: `provisioning -> ready | unusable`; `ready -> deleted` (clean completion) or `ready -> kept-on-failure` (failure); `kept-on-failure -> deleted` on dismissal or reaping; `unusable -> deleted` by reaping; any non-terminal status `-> lost` on runner retirement. Primaries are `ready` for their whole life unless they become `lost`.

Non-repo resources get no workspaces in v1: folder resources need a versioning story for non-git materials (post-v1), and mailboxes never produce workspaces.

### 6.4 Checkouts, cache and provisioning

- **Bare cache.** Each runner keeps one bare git cache per resource, under its storage directory. Ephemeral checkouts are git worktrees off that cache, on the branch the run names (default `hydra/run-<runId>`, a template on the workflow's workspace policy; [07-workflows.md](./07-workflows.md) section 4.4). No worktree pooling.
- **Primary.** Always a standalone clone with `origin` pointing at the real remote. Two ways to come into being, one resulting shape:
  - *Adopt in place*: an existing local checkout the user points at becomes the primary, untouched, and seeds the runner's bare cache locally.
  - *Clone fresh*: on a runner with no existing checkout the primary is cloned once from the remote, with hardlink object sharing against the cache.
- Primaries live wherever the user's checkout is or wherever the user chooses; caches and ephemerals live under the runner's storage directory.
- Git's one-branch-one-worktree guard applies uniformly across a runner's ephemerals; primaries are standalone clones, so the guard never spans the two kinds.
- Git credentials for clone, fetch and push derive from the checkout's Connection and are delivered on demand, never written to runner disk; mechanics in [13-security](./13-security.md) ([ADR 0016](../adr/0016-git-credentials-derive-from-connections.md)).

Branch naming is pinned in [07-workflows.md](./07-workflows.md) section 4.4: default `hydra/run-<runId>`, overridable per workflow, renamable by the agent; "task branch" is a shipped-workflow convention.

### 6.5 Setup command and `.workspaceinclude`

- A repo resource MAY carry one optional setup command, stored in controller state (never in the repo). The runner runs it in every fresh ephemeral checkout of that resource. A non-zero exit marks the workspace `unusable`; that the placement which needed it then fails is this spec's consolidation (the ticket pins only the unusable marking).
- Fresh worktrees copy untracked files listed by the repository's `.workspaceinclude` file (an existing vendor convention Hydra reads; not Hydra configuration stored in the repo). The copy is configurable.

The copy source is the resource's primary workspace **on the same runner** (paths never cross runners). When that runner has no primary for the resource, nothing is copied and workspace provisioning emits a warning. "Configurable" means a per-resource disable flag only; there is no alternative file name. (Resolved 2026-08-31, [#43](https://github.com/rogierpennink/hydra/issues/43).)

### 6.6 Toolchains

Toolchains (node, python, go, docker, ...) are the machine owner's responsibility. The runner probes them and reports them as capabilities; placement filters on them. Hydra installs only provider CLIs (section 3.3). Hydra-managed toolchains and a revived Environment concept are post-v1.

The probed toolchain list is deliberately minimal in v1 (resolved 2026-08-31, [#43](https://github.com/rogierpennink/hydra/issues/43)): **`git` and `gh`** only, reported as `{ name, version, path }` (raw `--version` output, parsed to semver where it parses). Anything else the owner installs by hand and, if placement needs it, expresses as a user label (`node`, `gpu`); the fuller answer is the post-v1 Environment concept. Placement filters match toolchain names (optionally a semver range) and labels.

### 6.7 Teardown

| Situation | Ephemeral workspace |
|---|---|
| Clean completion | deleted |
| Failure | kept until the user dismisses the failed run; re-runs provision fresh workspaces |
| Orphaned (owning run gone, session gone, runner restarted mid-job) | collected by the runner's TTL reaper |

Primary workspaces are never torn down by Hydra and bare caches persist for the runner's life (this spec's consolidation; the ticket's teardown rules cover ephemerals only).

A retired runner's workspaces are marked `lost` in the controller (section 7); the disk itself is not touched.

Reaper TTLs (resolved 2026-08-31, [#43](https://github.com/rogierpennink/hydra/issues/43)): orphaned ephemerals are reaped after **24 hours**; `kept-on-failure` workspaces are kept until the failed run is dismissed or **14 days**, whichever comes first - the run record keeps a "workspace reaped" note so a stale failed run never pretends its files still exist. Both are controller-wide settings.

## 7. Runner states

| State | Meaning | Placements | Sessions |
|---|---|---|---|
| `online` | connected, hello complete | accepted (subject to cap and watermark) | running |
| `offline` | announced shutdown: outbox flushed, sessions cleanly interrupted and resumable | wait for return | interrupted, resumable |
| `unreachable` | silence: no announcement, connection lost | wait for return | unknown; UI shows "state unknown, last seen X" |
| `draining` | user-initiated: no new placements, running sessions finish | refused | run to completion |
| `retired` | terminal: credential revoked, workspaces marked lost, session records preserved but unresumable | refused | none |

Transitions (the tickets pin the five states, drain -> retire, and force-retiring an unreachable runner; the rest of this list is this spec's consolidation):

- `online -> offline` on an announced shutdown; `offline -> online` on reconnect (outbox replays).
- `online -> unreachable` when the socket drops without an announcement and stays down; `unreachable -> online` on reconnect (outbox replays). An `unreachable` runner's sessions may well still be running; the controller reports honestly that it does not know.
- `online | offline | unreachable -> draining` by user action.
- `draining -> retired` by user action once sessions have finished, or immediately by force. Force-retiring an `unreachable` runner is allowed with an explicit confirmation.
- `retired` is terminal. Re-enlisting the same machine creates a new runner: new identity, credential, name and labels, a new storage directory, no workspace adoption. The old records stay under the retired runner.

Silence threshold (resolved 2026-08-31, [#43](https://github.com/rogierpennink/hydra/issues/43)): WebSocket ping every **15 seconds**; `online -> unreachable` after **60 seconds** without a pong (four missed intervals). Reconnect backoff is section 2.3's (1 s doubling to 30 s, reset on wake or network change).

## 8. Promotion and portability

Promotion moves the controller to another machine by migrating its state; it is never a live handoff, and there is never a moment with two authoritative controllers ([ADR 0005](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)).

### 8.1 Logical controller identity

The controller has a persistent identity: an id plus key material, created at install and carried in the bundle. Runners authenticate that identity at whatever address it appears. Address announcements and the forwarding pointer (8.3) are signed with it, so "controller moved" cannot be spoofed. Because the new machine resumes the same identity, runner seq/ack state and outboxes continue as if the controller had merely reconnected.

### 8.2 The pull ceremony

Old controller A, new machine B.

1. **Mint.** On A (CLI or web app) the user mints a short-lived, single-use promotion token. Minting freezes nothing. Authority originates on the controller, mirroring runner join: nobody on the network can pull state uninvited.
2. **Run.** On B the user runs `hydra promote --from <A-addr> --token <t>`. The command binds B's port so it can answer probes, then contacts A. Install, moving day and promotion are one story: `promote` is auto-initialization with the Data Root arriving by pull ([15-packaging-and-operations](./15-packaging-and-operations.md)).
3. **Probe.** A, over its live runner connections, asks each runner to check that it can reach B's address. The confirm screen shows the fleet with a check per runner. The user states or confirms B's reachable address here (detected default, overridable; plain `IP:PORT` fully supported, nothing assumes Tailscale). *Specified but droppable for v1: shipping without the probe changes nothing structural.*
4. **Confirm.** The commit point, before anything freezes.
5. **Transfer.** A goes read-only and streams the bundle: the SQLite database plus secrets packed at export (re-encrypted under a key derived from the promotion token; B re-wraps them under its own master key, which never leaves a machine: [13-security](./13-security.md)). B starts serving under the same logical identity. During the window event polling and mutations pause; in-flight sessions on runners keep running and buffer to their outboxes.
6. **Switch.** A announces the new address (signed) and seals itself. Runners reconnect to B and replay their outboxes.

Aborting at any point before step 6 restores A untouched. Cold move: no drain phase, no session interruption.

### 8.3 Sealing and fencing

After promotion A is sealed: it refuses to serve and answers anything that dials the old address (runners that missed the announcement, stale browser bookmarks) with a signed forwarding pointer naming B. Un-sealing requires an explicit force flag (disaster recovery only). When A is fully gone, the last-resort escape hatch is a local re-point command run on each runner.

The re-point command (resolved 2026-08-31, [#43](https://github.com/rogierpennink/hydra/issues/43)) is **`hydra runner set-controller <url>`**: it keeps the runner's existing credential and verifies at hello that the identity at the new address is the one it enrolled with; on mismatch it refuses with "this is a different controller; use `hydra runner join`". A fresh join token is never needed for a re-point, because a controller that cannot resume the logical identity is by definition a different controller - and that path is re-enlistment, not re-pointing.

### 8.4 Bundle fallback

When A and B cannot see each other: export a bundle file on A, carry it, import on B. Pull is internally export plus import, so both paths produce the same result.

### 8.5 Portability rules

- **The bundle is relocatable.** The controller DB holds no absolute paths and runner-side paths are opaque runner-owned facts keyed by id that promotion never rewrites; the rules are stated once in [04-state-store](./04-state-store.md).
- **Secrets are packable**: the running controller can enumerate and extract them for export. Keychain storage is allowed; write-only machine-bound storage is not ([13-security](./13-security.md)).
- **Future artifact or blob storage lives inside the Data Root** and moves with the bundle; streaming or resumable transfer is the escape hatch if volume ever hurts.

### 8.6 Fleet continuity

- A's local runner is an ordinary fleet member and survives promotion as itself: same identity, name, workspaces; it re-points to B like every other runner. No retire, no re-enlist. "Laptop" stays named "laptop".
- B gets a fresh auto-joined local runner, standard controller behaviour.
- The fleet-level default runner is unchanged by promotion. Promotion changes who the brain is, not where work runs.
- "Local" (section 5.4) resolves on the client device and therefore follows the user, not the controller.

## Post-v1

- Fleet auto-discovery and push-install; v1 keeps the fully programmatic join exchange and the reserved "Add machine" spot.
- Plan-shipping to runners (self-orchestration while disconnected); v1 keeps hello capability negotiation so it lands without a protocol break.
- Native OS sandboxing (macOS Seatbelt, Linux Landlock), containers as a remoter option; both return as a probed runner capability behind hello negotiation.
- Hydra-managed toolchains and an Environment concept (named toolchain plus setup bundles); v1 keeps toolchains as probed facts and the setup command in controller state.
- Folder-resource workspaces; v1 workspaces are git-only.
- Runner-side plugin loading; v1 runner-side provider execution is built-in but plugin-shaped ([05-plugins](./05-plugins.md)).
- Load balancing, session migration and failover between runners; v1 pins work where it lands.
- Windows runners.
- Artifact storage on the controller; when it lands it lives inside the Data Root (8.5).

## Sources

Tickets:

- [Controller/runner architecture: registration, placement, scheduling](https://github.com/rogierpennink/hydra/issues/7)
- [Runner execution substrate](https://github.com/rogierpennink/hydra/issues/8)
- [Controller promotion & portability](https://github.com/rogierpennink/hydra/issues/10)
- [Research: portable provider installs & credentials across runners](https://github.com/rogierpennink/hydra/issues/23)
- [Provider adapter interface](https://github.com/rogierpennink/hydra/issues/12) (SessionSpec / ProviderRunnerContext boundary, capability snapshots)
- [Agent-operates-system surface](https://github.com/rogierpennink/hydra/issues/16) (session token injection)
- [Security & secrets model](https://github.com/rogierpennink/hydra/issues/18) (git credential helper, packed secrets)
- [Web app architecture: observability-first, desktop-shell-ready](https://github.com/rogierpennink/hydra/issues/19) ("local" alias detection)
- [Controller packaging & install story](https://github.com/rogierpennink/hydra/issues/24) (local runner as child process, Hydra Home, fleet skew)
- [Runner substrate details: protocol guarantees, defaults, provider CLI delivery](https://github.com/rogierpennink/hydra/issues/43) (reconciliation delivery, thresholds and defaults, reserved runners, join/login split, re-point command)

ADRs:

- [ADR 0002 - Orchestration stays on the controller](../adr/0002-orchestration-stays-on-the-controller.md)
- [ADR 0003 - Sessions run as bare processes on runners](../adr/0003-sessions-run-as-bare-processes.md)
- [ADR 0005 - Promotion is migration behind a stable controller identity](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)
- [ADR 0016 - Git credentials derive from connections](../adr/0016-git-credentials-derive-from-connections.md) (referenced)
- [ADR 0018 - Hydra ships as one self-contained binary](../adr/0018-hydra-ships-as-one-self-contained-binary.md) (referenced)

Research: `research/provider-portability.md` (branch `research/provider-portability`).
