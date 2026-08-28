# Security and secrets

Hydra v1 is a single-user system whose supported perimeter is a home LAN or a tailnet. Every secret value (Connection credentials, plugin secrets, runner credentials, core key material) lives encrypted per-value in one owner-scoped table in the controller database, under a master key held in the OS keychain that never leaves its machine. Users authenticate with a password and opaque revocable API keys; sessions authenticate with a per-session token that inherits the agent's permission profile, enforced at the service layer so HTTP and in-process callers are bound alike. Git credentials are derived on demand from Connections and never land on runner disk. The event log is the audit log. This document states the perimeter, the secrets model, both credential kinds, the grant families and shipped profiles, the escalation flow, the access-mode fallback guardrail, taint handling for assistant memory, audit retention, and - honestly - what v1 does not defend against.

## 1. Perimeter and threat model

- **Supported perimeter: LAN or tailnet.** The controller serves plain HTTP by default. A tailnet is already encrypted; a home LAN is a proportionate trust boundary for one user.
- **Bind warning.** When the controller binds to an address that is neither loopback nor a tailnet address, it prints a warning at startup. It does not refuse.
- **Optional TLS.** The user may supply their own certificate and key (BYO TLS). On a tailnet, `tailscale cert` provides a real Let's Encrypt certificate for `<node>.<tailnet>.ts.net` with no public exposure; this is the documented way to give the controller an HTTPS origin, which Google OAuth redirects require (see §3.3). Tailscale Funnel is not needed for anything in this document: the user's browser already reaches the controller.
- **No hostile-internet hardening in v1.** Rate limiting of login attempts, brute-force lockout, CSRF machinery, and similar public-exposure defences are out of scope. Revisited if multi-tenant hosting arrives.
- **Disk theft is in scope.** Any copy of the database, a backup, or a promotion bundle is useless without the master key (§2).
- **Shared-machine limit, stated honestly.** Sessions run as bare processes under the same OS user as the runner ([ADR 0003](../adr/0003-sessions-run-as-bare-processes.md)). Agent/user credential separation (§5) defends against accident and drift, not against a malicious process on the same machine. Real isolation (OS sandboxing, containers) is post-v1.
- **Controller-runner trust.** Runners dial the controller and authenticate a durable per-runner credential; the controller has a persistent identity (ID + key material) that runners verify at whatever address it appears, so "controller moved" announcements cannot be spoofed. Mechanics in [./03-controller-and-runners.md](./03-controller-and-runners.md).

**Verify at build time:** what counts as "a tailnet address" for the bind warning (Tailscale's `100.64.0.0/10` CGNAT range plus its IPv6 range) - the tickets say "non-loopback/non-tailnet" without listing ranges.

## 2. Secrets at rest

Decision and rationale: [ADR 0015](../adr/0015-secrets-are-encrypted-per-value-under-a-keychain-held-master-key.md).

### 2.1 The secrets table

One owner-scoped secrets table in the controller SQLite database ([./04-state-store.md](./04-state-store.md)). Each row holds one secret value, encrypted individually. The SQLite file itself stays plain; whole-database encryption is rejected.

| Field | Meaning |
|---|---|
| `ownerKind` | `connection` \| `plugin` \| `runner` \| `core` |
| `ownerId` | the owning Connection, plugin, or runner id; a fixed name for `core` |
| `name` | key within the owner's namespace (e.g. `oauth.refreshToken`, `pat`, `clientSecret`) |
| `ciphertext` | the value encrypted under the master key |
| `createdAt`, `rotatedAt` | timestamps; rotation replaces the ciphertext in place |

What lives here:

- **Connection credentials**: pasted tokens (GitHub PAT, Slack and Discord bot tokens), OAuth client id/secret the user registered (BYO client), and OAuth refresh tokens obtained through a Connection's setup flow. Access tokens refreshed from a refresh token are also stored here when the plugin persists them.
- **Plugin secrets**: whatever a plugin writes through the plugin secrets API (§2.4).
- **Runner-scoped secrets**: the `runner` owner kind is reserved for secrets scoped to one runner. The runner's own credential is not stored here: it is an opaque token stored hashed like every other token (§4.5).
- **Core**: the controller's own key material (its persistent identity from [ADR 0005](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)) and any other core-owned secret.

What does not live here: provider (Claude Code, Codex, pi) login credentials. Those stay with the vendor CLI on each runner (§8). Secret-valued provider-instance settings (an API key for an API-billed instance) go through this table; their owner kind is Open in [./06-providers.md](./06-providers.md).

ADR 0015 originally listed "runner credentials" among the encrypted rows; it is amended (2026-08-28): the runner credential is a token and is stored hashed (§4.5), and the `runner` owner kind stays reserved for runner-scoped secrets.

**Open:** field names above are consolidated from ADR 0015's prose ("owner-scoped", "per-value"); the tickets pin the owner set and per-value encryption but not column names or the cipher.

**Verify at build time:** choose an AEAD cipher (e.g. XChaCha20-Poly1305 or AES-256-GCM) with a per-row nonce and the row's owner/name as associated data.

### 2.2 Master key

- One **master key** per controller machine, created at first run (`hydra serve` auto-initializes it; [./15-packaging-and-operations.md](./15-packaging-and-operations.md)).
- Held in the OS keychain: macOS Keychain via the `security` CLI ([ADR 0018](../adr/0018-hydra-ships-as-one-self-contained-binary.md)); on Linux the desktop keychain where one exists (Secret Service is the intended reading; the sources say only "OS keychain"). Fallback on headless Linux: a plain key file inside Hydra Home, outside the Data Root, mode 0600.
- The controller runs as a user-level service precisely so it can read the login keychain without a prompt.
- **The master key never leaves its machine.** It is not in the database, not in backups, not in a promotion bundle. Backups (`VACUUM INTO` snapshots) therefore contain inert ciphertext; copying the backups directory offsite is safe.

**Open:** the tickets say "plain key file fallback on headless Linux" without pinning its path; place it under Hydra Home but outside `data/` so promotion never moves it.

### 2.3 Promotion re-wrapping

Promotion ([./03-controller-and-runners.md](./03-controller-and-runners.md), [ADR 0005](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)) requires that controller secrets are enumerable and extractable by the running controller. This model satisfies it:

1. Export on the old controller decrypts every secrets row under its master key and re-encrypts the packed secrets under a key derived from the **single-use promotion token**.
2. The bundle travels (pull, or export/import file).
3. The new controller derives the same key from the token, decrypts, and re-wraps every value under its own freshly created master key.

Write-only machine-bound storage is forbidden for exactly this reason.

**Verify at build time:** the key-derivation function from the promotion token (a KDF over a high-entropy token; the token must be long enough that the derived key is not brute-forceable if the bundle leaks).

### 2.4 Plugin secrets API

The host API ([./05-plugins.md](./05-plugins.md)) exposes a plugin-scoped secrets service. It is a scoped view over the secrets table: a plugin reads and writes rows with `ownerKind = plugin`, `ownerId = <its own id>`, and can address the credentials of Connections of its own types through the Connection host API. A plugin never sees another plugin's rows or another type's Connection credentials.

### 2.5 Exposure rules

- Secret values never appear in the event log, in API responses, in Notifications, in process logs, or in the web app. API responses carry references only (owner, name, existence, `rotatedAt`).
- Only the two runtime paths that need plaintext receive it: the plugin or core code acting via a Connection (in-process, controller-only), and the runner daemon's on-demand git credential fetch (§9), delivered over the authenticated runner WebSocket and held in memory only.
- The web app's Secrets settings screen lists references and supports set/rotate/delete; it never displays a stored value.

## 3. Connection credentials and setup policy

Setup flows and their UI are owned by [./08-events-and-connections.md](./08-events-and-connections.md). The security policy they follow:

### 3.1 Policy

- **BYO OAuth client** where a provider demands one (Google). Hydra ships no OAuth client id and hosts no OAuth relay.
- **Paste-a-token is the universal fallback**, and the primary path for Slack and Discord bot tokens and for GitHub (a personal access token).
- All resulting credentials are stored as Connection-owned secrets (§2.1).

### 3.2 Per-provider path

Google = redirect flow to the controller's own HTTPS origin (BYO client); GitHub = PAT paste; Slack and Discord = bot-token paste. The setup recipes (Google consent-screen status, redirect-URI registration, token-lifetime traps) are in [./08-events-and-connections.md](./08-events-and-connections.md), from `research/connection-setup-ux.md` (branch `research/connection-setup-ux`).

### 3.3 Redirect URIs and the HTTPS origin

- The controller derives the exact redirect URI from the origin the user's browser is already using and displays it for the user to register. No Hydra-hosted relay is involved.
- On a tailnet, `tailscale cert` gives the controller a real certificate for `https://<node>.<tailnet>.ts.net`, which Google accepts as a redirect host; raw private IPs and `.local`/`.internal` names are rejected. `http://localhost` is a same-machine fallback only.

## 4. User authentication

Resolves the credential side of [ADR 0013](../adr/0013-agents-operate-hydra-through-the-public-api.md).

### 4.1 Principles

- No OAuth machinery for Hydra's own auth. No JWTs.
- Every credential Hydra issues is an opaque random token. The database stores only a hash; resolution is one indexed lookup, which satisfies the constraint that token -> session -> agent -> profile resolution adds no meaningful endpoint latency.
- Both user credential kinds and session tokens resolve to the same actor-stamped API ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)).

### 4.2 Password login

- One user, username + password, set during first-run onboarding in the web app. The password is stored as a slow hash.
- Login returns an opaque bearer token the client holds and sends as `Authorization: Bearer <token>` on every HTTP call. No cookies, no CSRF machinery; this works identically in a future desktop shell ([ADR 0017](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)).

**Verify at build time:** the password hash function (no source names one; argon2id is the expected choice).

**Open:** the lifetime of the login-issued bearer token. Ticket #18 pinned 30 days rolling for the (superseded) cookie; nothing pins it for the bearer token.

### 4.3 API keys

- Long-lived, opaque, revocable. Always the user's identity, never an agent's.
- Minted in the web app (Settings) or via `hydra login` (password in, token out). The CLI stores it in a credential file with mode 0600 inside Hydra Home; location in [./15-packaging-and-operations.md](./15-packaging-and-operations.md).
- Revocable individually; a revoked key fails on its next use.
- Used by the ops CLI and scripts. The ops CLI and the runner-shipped `hydra` CLI are the same binary; the difference is the credential ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)).

### 4.4 WebSocket ticket

The web app's live socket ([./14-web-app.md](./14-web-app.md)) connects with a **short-lived, single-purpose ticket** (5 minutes) fetched over authenticated HTTP. The long-lived bearer token is never placed in a URL.

### 4.5 Runner credentials

A runner joins with a single-use join token and receives a durable per-runner credential ([./03-controller-and-runners.md](./03-controller-and-runners.md)). The credential is an opaque random token; the controller stores only its hash, like every other token. Retiring a runner revokes it. Runner credentials are not user credentials: a runner can do exactly what the runner protocol allows, nothing on the public API.

### 4.6 Post-v1

Passkeys and 2FA are post-v1. Nothing in v1 forecloses them: the login op is the only place that checks a password.

## 5. Session tokens and agent/user separation

- At session start the controller mints a **session token** whose subject is the Session row. The runner injects `HYDRA_API_URL` and `HYDRA_TOKEN` into the provider process. The token carries the agent's permission profile and is revoked when the session ends.
- Every mutation is stamped `actor: user | session:<id>`.
- The `hydra` CLI resolves credentials in this order: environment token first, the credential file second ([./15-packaging-and-operations.md](./15-packaging-and-operations.md)).
- The runner also sets `HYDRA_SESSION=1` in every session's environment. When that marker is present, the CLI **refuses file credentials** entirely: it uses the environment token or fails. Accidental fallback from an agent to the user's identity is therefore impossible, even on the controller machine where the user's own `hydra login` credential file exists.
- This is accident-proof, not malice-proof. A session is a bare process under the same OS user; a process that deliberately unsets `HYDRA_SESSION` and reads the credential file can impersonate the user. That is outside the v1 threat model (§1) and is the post-v1 sandboxing item.

## 6. Permission profiles

Mechanism: every agent carries a **permission profile**; the session token inherits it; enforcement sits at the service layer so it binds HTTP and in-process callers alike ([ADR 0013](../adr/0013-agents-operate-hydra-through-the-public-api.md)). This section pins the content.

### 6.1 Grant families

A profile is a set of grants. Grants are coarse: one family per operation area, with read/write/run-style verbs inside the family. Finer grants can land inside a family later without breaking existing profiles. `tasks` is split into `create`, `update`, `delete` rather than one `write` because ticket #18 gives the worker profile "tasks read/create/update" and no delete.

| Family | Covers | Verbs |
|---|---|---|
| `tasks` | Task search/read/create/update/delete | `read`, `create`, `update`, `delete` |
| `workflows` | Workflow definitions and starting runs | `read`, `write`, `run` |
| `sessions` | Spawning, steering, reading sessions | `read`, `spawn`, `steer` |
| `notifications` | Creating Notifications, reading the notification center | `read`, `write` |
| `subscriptions` | Registering session subscriptions | `read`, `write` |
| `connections.use` | Acting via a Connection (outbound actions naming a connection) | `use` |
| `connections.manage` | Creating, editing, deleting Connections and their credentials | `write` |
| `infra` | Runners, plugins, promotion, service operations | `read`, `write` |
| `secrets` | The secrets table (set/rotate/delete references) | `write` |
| `credentials` | User credential management (password, API keys) | `write` |
| `memory` (provisional) | Assistant memory ops (`hydra memory ...`) | `read`, `write` |

Ticket #18 pins the family names `tasks`, `workflows`, `sessions`, `notifications`, `subscriptions`, `connections.use`, `connections.manage`, `infra`, `secrets`, `credentials` and "read/write/run-style verbs per family".

**Open:** the exact verb set per family is not pinned beyond "read/write/run-style"; the table above is the minimum the shipped profiles need. The operation catalogue in [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) maps operations to these verbs.

**Open:** `memory` is provisional: it is not in #18's family list, but [ADR 0020](../adr/0020-assistant-memory-is-reached-only-through-the-api.md) makes memory an API surface an agent must be granted. Confirm `memory` as a family or fold it into the assistant profile by another name; 02, 11 and 12 point here.

A `permissions.request` operation (§6.4) is granted to every profile and is not itself a grant.

"Bulk-destructive ops" (delete-many, cancel-all and the like) are withheld from the shipped non-unrestricted profiles regardless of family.

**Open:** which operations count as bulk-destructive is not enumerated; the service layer must tag them.

### 6.2 Shipped profiles

| Profile | Default for | Grants | Withholds |
|---|---|---|---|
| **assistant** | assistants | `tasks` (read, create, update, delete), `workflows` (read, run), `sessions` (read, spawn, steer), `notifications`, `subscriptions`, `memory` (provisional), status reads | `infra`, `connections.manage`, `secrets`, `credentials`, `workflows.write` (consolidated: #18 grants `workflows.run` only), direct work tools (workspaces), bulk-destructive ops |
| **worker** | agent steps in workflows | `tasks` (read, create, update), `notifications` (write), `subscriptions` (write) | `tasks.delete`, `sessions.spawn`, `workflows.run` (so a workflow cannot fan out recursively unless granted), `memory`, everything the assistant profile withholds |
| **unrestricted** | nobody by default | user parity: everything the user can do | nothing; assigned only explicitly |

- The assistant profile encodes "delegate, don't do": orchestration surface only, no workspace, no direct work tools. It is hard by configuration, not by caste, and loosenable per assistant ([./12-assistants.md](./12-assistants.md)).
- The worker profile is the trust floor for workflow agent steps. A workflow that needs a step to spawn sessions or start runs assigns a profile that grants it.
- Profiles are named records the user edits in Settings > Permission profiles ([./14-web-app.md](./14-web-app.md)); the three shipped ones are seeded at first run. The agent -> profile assignment is a field on the Agent ([./02-domain-model.md](./02-domain-model.md)).
- This table is the single normative statement of the shipped profiles; [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) and [./12-assistants.md](./12-assistants.md) link here.

### 6.3 Enforcement and 403s

- The service layer checks the actor's grants before executing an operation. The user actor (password login or API key) has full parity: no profile applies.
- A denied call returns HTTP 403 whose body names the missing grant (`tasks.delete`, `sessions.spawn`). The `hydra` CLI surfaces that name verbatim so the agent can ask for it.
- Resolution is one indexed lookup from token hash to session to agent to profile, cached per session and invalidated on session end or profile edit.

### 6.4 Escalation: Permission Request

1. The agent calls `permissions.request {grant, reason}` (granted to everyone; via `hydra permissions request ...`).
2. The controller creates a **Permission Request** Notification ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)) naming the session, the agent, the grant, and the reason.
3. The user decides in the web app (whether a channel sink can carry the decision is Open in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)). Approval offers two scopes: **this session only** (a session-scoped grant overlay that dies with the session) or **add to profile** (edits the agent's profile; every future session of every agent on that profile gains it). Denial is the third outcome.
4. The agent learns the outcome through its session subscription (queued input on a turn boundary) and retries the original operation. There is no blocking wait, consistent with the no-blocking rule in [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md).

Raising and deciding a Permission Request are audited (§11).

### 6.5 Decision Notification actions

Decision Notifications carry actions that bind an operation authored by an agent (e.g. "Start Bugfix" = start workflow X with task Y) and executed when the user clicks ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)). The actor of the executed operation is the user who clicked; the operation runs under user parity.

**Open:** whether the controller must additionally check that the authoring session's profile could have performed the bound operation (the ticket #21 handoff asks "how ... authorised" and the material does not answer).

## 7. Access-mode fallback guardrail

Resolves the handoff from [./06-providers.md](./06-providers.md). Access modes are ordered by permissiveness:

```
approval-required < auto-accept-edits < auto < full-access
```

- When a session's requested access mode is `unsupported` on the target provider, the controller substitutes a supported mode **before session start**, strictly downward: the most permissive supported mode that is equal or less permissive than the requested one.
- If no equal-or-less-permissive supported mode exists, session start fails with a clear error naming the requested mode and the provider's supported set.
- **The fallback chain is hardcoded in v1**, not configurable ([ADR 0007](../adr/0007-provider-adapter-is-a-thin-interface-behind-a-normalized-event-stream.md) and the glossary entry "Access Mode" in [../../CONTEXT.md](../../CONTEXT.md), both amended). Ticket #18 amends ticket #12's "configurable controller-side fallback map": escalation to a more permissive mode through fallback is forbidden, so there is nothing for a map to express beyond the fixed order. The shipped behaviour `auto -> auto-accept-edits` is what the order yields.
- Adapters carry no fallback logic; `SessionSpec.accessMode` always names a natively supported mode.

## 8. Provider credentials on runners

Decision from ticket #23 and `research/provider-portability.md` (branch `research/provider-portability`).

- **Auth by delegation.** Hydra never holds, extracts, proxies, or distributes provider (Claude Code, Codex, pi) login tokens. Each runner logs in to each provider itself, with the vendor CLI storing its own credential.
- **Per-runner headless login, Hydra-driven.** Provider CLIs are installed at runner join (pinned). Hydra then drives each provider's own headless login on that runner, relaying the URL or user code to the user's browser wherever they are; whether that happens inside `hydra runner join` or as a post-join step is Open in [./03-controller-and-runners.md](./03-controller-and-runners.md). The per-provider flows (device code, paste-a-code, `setup-token`) are in [./15-packaging-and-operations.md](./15-packaging-and-operations.md) §12.
- **Never distribute vendor tokens across the fleet.** Refresh-token rotation with reuse detection (documented by OpenAI, structurally the same in pi) means two live copies race and the loser is logged out. Copying a credential file is a bootstrap shortcut owned by exactly one runner afterward.
- **Probing without credential files.** Runners self-report per-provider auth state through vendor APIs (Agent SDK init `AccountInfo`, Codex `account/read`, pi `checkAuth`), never by reading credential files ([./03-controller-and-runners.md](./03-controller-and-runners.md)).
- **ToS posture.** All three vendors permit a user's own account on machines the user owns; prohibitions target sharing with other people and (Anthropic) third-party products offering claude.ai login. Hydra as the user's own tool driving vendor CLIs under the user's own logins stays inside every posture. The Claude Agent SDK itself accepts API key, Bedrock, Vertex, or Foundry auth; subscription use goes through the user's own `claude` binary ([./06-providers.md](./06-providers.md)).
- **Provider-home isolation.** Every session runs inside its provider instance's isolated, Hydra-owned provider home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`): one instance = one login = one home, long-lived on that runner, never per session. That home holds the runner's own vendor login and keeps the user's global instructions, skills and packages out of Hydra sessions; details in [./06-providers.md](./06-providers.md).

## 9. Git credentials

Decision and rationale: [ADR 0016](../adr/0016-git-credentials-derive-from-connections.md). Resolves the handoff from the execution substrate ([./03-controller-and-runners.md](./03-controller-and-runners.md)).

### 9.1 Derivation and delivery

- Clone, fetch, and push authenticate with the **GitHub Connection of the checkout being touched**. Runners hold no user-managed git credentials.
- The runner configures each session with a git credential helper through env-injected `GIT_CONFIG_*` variables (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`), never by writing to the checkout's `.git/config` or the user's global config.
- The helper is a small command that asks the **runner daemon** over its local channel. The daemon resolves checkout -> Resource -> Connection, fetches the token from the controller on demand over the runner WebSocket, and answers the helper. The token is held in memory for the duration of the git operation; nothing lands on runner disk. Short-lived tokens become a drop-in upgrade later.

**Verify at build time:** the runner daemon's local channel for the helper (Unix socket path or loopback port, and how the helper authenticates to the daemon so only the daemon's own sessions can ask). The tickets pin the shape, not the transport.

### 9.2 Per-checkout identity

- `credential.useHttpPath=true` makes git include the repository path in the credential lookup, so the helper resolves identity per checkout.
- The helper answers with a **username hint** from the Connection so git's credential matching distinguishes accounts on the same host. One workspace can therefore mix GitHub accounts at the git level (multi-repo workspaces with one checkout per Resource). This matches Git Credential Manager's own multi-account guidance.
- Commit author = per-checkout `user.name` / `user.email` from the Connection, injected the same way.

### 9.3 `gh` and `GH_TOKEN`

- The `gh` CLI acts as one account per host per process (confirmed as of gh 2.40+). Each session gets `GH_TOKEN` injected from the **workspace's designated Connection**, so `gh` works out of the box.
- A workspace designates exactly one GitHub Connection for this purpose ([./02-domain-model.md](./02-domain-model.md)). In a multi-repo workspace whose checkouts use different Connections, git operations stay per-checkout while `gh` uses the designated one.
- Workspace-less sessions get the user-designated default GitHub Connection, or no `GH_TOKEN` if none is designated.

### 9.4 Identity follows the repo

Identity follows the repo, never the agent, in v1. Per-agent git identity (an agent -> Connection association) is a post-v1 policy addition on unchanged plumbing.

### 9.5 Non-GitHub remotes

Runner-local, user-managed auth (`ssh` keys, `git credential` stores the user configures on the machine) remains the documented fallback for remotes that are not GitHub Connections. Hydra does not manage those credentials.

## 10. Taint and provenance in assistant memory

Resolves the handoff from [./12-assistants.md](./12-assistants.md). Prior art: OpenClaw taint-gating and Hermes context-not-instructions marking in `research/assistant-systems.md` (branch `research/assistant-systems`).

- Third-party text in a shared channel (anything not from the owner's configured platform identities) is **context, never instructions**. It enters the session wrapped in explicit data-not-instructions markers.
- The markers survive through rotation and distillation: the distiller sees the same wrapping, and its prompt is hardened against treating quoted content as directives.
- A memory write distilled from a conversation containing tainted content carries a **one-line provenance marker** in the memory document (e.g. `> distilled from #general on 2026-08-27; includes third-party content`). The user can already read and edit memory, so this is auditable and correctable.
- Hard-excluding third-party content from distillation is rejected: it discards the signal shared-channel assistants exist to keep.
- Only the owner's configured platform identities can command an assistant in v1 (single user).

**Open:** the exact marker syntax (both the in-context wrapper and the memory provenance line) is not pinned; keep it stable and greppable.

## 11. Audit

The event log ([./04-state-store.md](./04-state-store.md)) is the audit log; there is no separate audit subsystem.

- Every mutation on the public API carries `actor: user | session:<id>`.
- Auth and security event kinds: `auth.login.succeeded`, `auth.login.failed`, `auth.apiKey.minted`, `auth.apiKey.revoked`, `permission.requested`, `permission.decided`, `secret.created`, `secret.rotated`, `secret.deleted`, `runner.joined`, `runner.retired`. Names are indicative; the kinds pinned by ticket #18 are login success/failure, token minted/revoked, permission request raised/decided, secret created/rotated.
- **Retention.** Security events and actor-stamped mutations are kept at least 90 days; the full retention statement (event log TTL, per-session streams, domain rows) is in [./04-state-store.md](./04-state-store.md).

## 12. What v1 does not defend against

Stated explicitly by the tickets:

- **Hostile internet exposure.** No brute-force protection, no lockout, no CSRF defence. Do not expose the controller publicly; use a tailnet.
- **Local malice on a shared machine.** Bare-process sessions under the same OS user can read the user's `hydra login` credential file, provider credential files, and any workspace on that runner. `HYDRA_SESSION` stops accidents only.
- **A compromised runner.** A runner that fetches git tokens on demand can see the tokens for any checkout it hosts while an operation runs. Retiring the runner revokes its credential; the Connection tokens it saw should be rotated by the user.
- **Prompt injection beyond taint marking.** Wrapping and prompt hardening reduce, not eliminate, the chance an assistant follows third-party text. The provenance line makes the outcome auditable.
- **A stolen master key.** Anyone with the machine's keychain (or the headless key file) and the database has every secret.
- **Vendor-side credential races** when a user copies a provider credential to two runners despite the guidance.

## Post-v1

- OS sandboxing (Seatbelt/Landlock) and containers as probed runner capabilities; v1 keeps sessions as bare processes and the `HYDRA_SESSION` marker so the credential seam is already in place.
- Passkeys and 2FA; v1 keeps a single password-check site.
- Per-agent git identity (agent -> Connection association); v1's credential helper already resolves per checkout, so this is policy only.
- Hostile-internet hardening (rate limiting, lockout) if multi-tenant hosting arrives.
- Finer grants inside families; v1 keeps families coarse so profiles do not break.
- Short-lived git tokens (e.g. GitHub App installation tokens) as a drop-in behind the same on-demand helper.
- MCP-based hydra-as-a-tool, which would carry the same session token.

## Sources

Tickets:

- Security & secrets model - https://github.com/rogierpennink/hydra/issues/18
- Research: portable provider installs & credentials across runners - https://github.com/rogierpennink/hydra/issues/23
- Research: smoothest Connection-setup path - https://github.com/rogierpennink/hydra/issues/32
- Agent-operates-system surface - https://github.com/rogierpennink/hydra/issues/16
- Provider adapter interface (fallback guardrail handoff) - https://github.com/rogierpennink/hydra/issues/12
- Controller promotion & portability (packable secrets) - https://github.com/rogierpennink/hydra/issues/10
- Plugin architecture (plugin secrets API) - https://github.com/rogierpennink/hydra/issues/11
- Assistant design (taint handoff) - https://github.com/rogierpennink/hydra/issues/17
- Web app architecture (bearer auth, WS ticket) - https://github.com/rogierpennink/hydra/issues/19
- Controller/runner architecture (join credential) - https://github.com/rogierpennink/hydra/issues/7
- Runner execution substrate (git credential handoff) - https://github.com/rogierpennink/hydra/issues/8
- Controller packaging & install story (keychain, backups) - https://github.com/rogierpennink/hydra/issues/24
- Assemble the v1 spec (bound-action authorisation, provider-home isolation) - https://github.com/rogierpennink/hydra/issues/21

ADRs:

- [ADR 0015 - Secrets are encrypted per-value under a keychain-held master key](../adr/0015-secrets-are-encrypted-per-value-under-a-keychain-held-master-key.md)
- [ADR 0016 - Git credentials derive from Connections](../adr/0016-git-credentials-derive-from-connections.md)
- [ADR 0013 - Agents operate Hydra through the public API](../adr/0013-agents-operate-hydra-through-the-public-api.md)
- [ADR 0003 - Sessions run as bare processes](../adr/0003-sessions-run-as-bare-processes.md)
- [ADR 0005 - Promotion is migration behind a stable controller identity](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)
- [ADR 0017 - The web app is a static pure client of the public API](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)
- [ADR 0020 - Assistant memory is reached only through the API](../adr/0020-assistant-memory-is-reached-only-through-the-api.md)

Research: `research/provider-portability.md` (branch `research/provider-portability`), `research/connection-setup-ux.md` (branch `research/connection-setup-ux`), `research/assistant-systems.md` (branch `research/assistant-systems`).
