# Security and secrets

Hercule v1 is a single-user system whose supported perimeter is a home LAN or a tailnet. Every secret value (Connection credentials, plugin secrets, runner credentials, core key material) lives encrypted per-value in one owner-scoped table in the controller database, under a master key held in the OS keychain that never leaves its machine. Users authenticate with a password and opaque revocable API keys; sessions authenticate with a per-session token that inherits the agent's permission profile, enforced at the service layer so HTTP and in-process callers are bound alike. Git credentials are derived on demand from Connections and never land on runner disk. The event log is the audit log. This document states the perimeter, the secrets model, both credential kinds, the grant families and shipped profiles, the escalation flow, the access-mode fallback guardrail, taint handling for assistant memory, audit retention, and - honestly - what v1 does not defend against.

## 1. Perimeter and threat model

- **Supported perimeter: LAN or tailnet.** The controller serves plain HTTP by default. A tailnet is already encrypted; a home LAN is a proportionate trust boundary for one user.
- **Bind warning.** When the controller binds to an address that is neither loopback nor a tailnet address, it prints a warning at startup. It does not refuse.
- **CORS allows one origin.** *(Added 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275), [ADR 0037](../adr/0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md).)* The controller answers CORS for exactly one origin: `app://hercule`, the desktop app's renderer ([./17-desktop-app.md](./17-desktop-app.md)).
  - **A request from that origin** gets `access-control-allow-origin: app://hercule`.
  - **A preflight from that origin** gets the methods the API uses, the request headers `authorization` and `content-type`, and `access-control-max-age: 7200`. Every request that carries the bearer token is preflighted, and Chromium caches a preflight for each URL for at most two hours, so the maximum saves a round trip on each repeat request.
  - **Any other origin** gets no CORS header, so a page on that origin cannot read a response.
  - **Every response other than a preflight's carries `vary: origin`,** because the answer now depends on the request's origin, and a cache must not hand one origin's answer to another. A preflight's answer needs no `vary`: HTTP caches do not store answers to `OPTIONS`, and the browser keeps its preflight answers per origin.
  - **The preflight is answered before authentication,** and it runs no operation.
  - **The desktop app's requests carry only the headers the preflight allows.** `client-core` turns off Effect's trace headers (`b3`, `traceparent`), which it would otherwise add to every request. The controller does not read them.
  - **CORS is not authentication.** It decides only whether a page may read a response. Every operation except `setup.read` and `auth.login` still requires the bearer token.
  - **Why allowing the origin is safe:** no web page can take the origin `app://hercule`. Only an app that registers the scheme itself can use it.
  - **The WebSocket is not affected.** CORS does not apply to the upgrade, and the socket authenticates with its ticket (§4).
- **Optional HTTPS, tailscale-managed.** *(Amended 2026-09-01, [#44](https://github.com/theagenticage/hercule/issues/44); tickets #18/#32 pinned BYO cert/key paths, replaced here.)* HTTPS is a controller feature, not a config concern: v1's only HTTPS consumer is the Google OAuth redirect origin (§3.3), and the documented cert source was already `tailscale cert` - so the controller runs it itself. When the user enables HTTPS (a Settings toggle, or prompted as a step in the Google Connection's declarative setup flow, [./08-events-and-connections.md](./08-events-and-connections.md)), the controller shells out to `tailscale cert`, stores the material under `<home>/tls/`, opens an HTTPS listener on a second port (controller state, default 4938), and re-mints before expiry - renewal is automatic, which BYO paths never gave. Runner WS and LAN HTTP traffic stay on the plain listener, untouched. There are no cert-path keys anywhere; cert material is machine-owned and never travels (a cert is bound to this machine's tailnet node name; a promoted controller mints its own). BYO cert paths return post-v1 only with a real non-tailscale need. Tailscale Funnel is not needed for anything in this document: the user's browser already reaches the controller.
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
| `ownerKind` | `connection` \| `plugin` \| `runner` \| `provider-instance` \| `core` |
| `ownerId` | the owning Connection, plugin, runner, or provider-instance id; a fixed name for `core` |
| `name` | key within the owner's namespace (e.g. ~~`oauth.refreshToken`~~ `oauth.tokens` *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*, `pat`, `clientSecret`) |
| `ciphertext` | the value encrypted under the master key |
| `createdAt`, `rotatedAt` | timestamps; rotation replaces the ciphertext in place |

What lives here:

- **Connection credentials**: pasted tokens (GitHub PAT, Slack and Discord bot tokens), ~~OAuth client id/secret the user registered (BYO client), and OAuth refresh tokens obtained through a Connection's setup flow. Access tokens refreshed from a refresh token are also stored here when the plugin persists them.~~ and the token set a redirect flow or a device flow obtained. *(Amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183).)* A token set is one secret, `oauth.tokens`: the access token, and the refresh token and expiry when the provider issues them. The core writes it, and rewrites it in place when it refreshes the access token; a plugin never stores a token itself. The BYO OAuth client is not a Connection credential: its client id is plugin config and its client secret is a plugin-owned secret ([./05-plugins.md](./05-plugins.md) section 7). *(Amended 2026-10-02, [#326](https://github.com/theagenticage/hercule/issues/326).)* Only the Connection operations and the core write Connection credentials, because new ones must be checked to belong to the same account ([./05-plugins.md](./05-plugins.md) section 10.1). The public `secret.set` and `secret.delete` refuse the `connection` owner kind with `validation`, as they refuse `core` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2).
- **Plugin secrets**: whatever a plugin writes through the plugin secrets API (§2.4).
- **Runner-scoped secrets**: the `runner` owner kind is reserved for secrets scoped to one runner. The runner's own credential is not stored here: it is an opaque token stored hashed like every other token (§4.5).
- **Provider-instance secrets**: secret-valued instance settings (API keys such as `ANTHROPIC_API_KEY` or `ZAI_API_KEY`, base-URL credentials) under the `provider-instance` owner kind. The controller decrypts them and sends them inline with each probe or session request over the runner WebSocket; they are held in memory for the operation and never land on runner disk ([./06-providers.md](./06-providers.md) §2.1; resolved 2026-08-31, [#43](https://github.com/theagenticage/hercule/issues/43)).
- **Core**: the controller's own key material (its persistent identity from [ADR 0005](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)) and any other core-owned secret.

What does not live here: provider (Claude Code, Codex, pi) login credentials. Those stay with the vendor CLI on each runner (§8).

*(Amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183).)* **Two setup tables hold a secret in plain text.** They are the one exception to encrypting secrets at rest:

- a redirect flow's pending setup row (`oauth_setups`) stores its PKCE `code_verifier`;
- a device flow's pending setup row (`device_setups`) stores the provider's `device_code`.

Both values are short-lived and single-use. The row is deleted when it is used, and swept once it has expired. The value is useless without the user's approval in the provider's own UI. The device code also never leaves the controller ([./05-plugins.md](./05-plugins.md) section 10.1). The token a flow obtains is encrypted like every other Connection credential.

ADR 0015 originally listed "runner credentials" among the encrypted rows; it is amended (2026-08-28): the runner credential is a token and is stored hashed (§4.5), and the `runner` owner kind stays reserved for runner-scoped secrets.

**Open:** field names above are consolidated from ADR 0015's prose ("owner-scoped", "per-value"); the tickets pin the owner set and per-value encryption but not column names. Column names are the implementer's ([./16-open-items.md](./16-open-items.md) B); the cipher is settled below.

The cipher is **AES-256-GCM** through WebCrypto, with a fresh 12-byte random nonce per write and the associated data `<ownerKind>|<ownerId>|<name>` (resolved 2026-09-04, [#56](https://github.com/theagenticage/hercule/issues/56)): an AEAD the runtime already carries, so it costs no dependency ([ADR 0018](../adr/0018-hercule-ships-as-one-self-contained-binary.md)), where XChaCha20-Poly1305 would. Binding the owner and name into the associated data makes a rename a re-encrypt, and makes a row edited or swapped in outside Hercule fail to decrypt rather than read cleanly. Owner ids and names therefore carry no `|`; the repository rejects one.

### 2.2 Master key

- One **master key** per controller machine, created at first run (`hercule serve` auto-initializes it; [./15-packaging-and-operations.md](./15-packaging-and-operations.md)).
- Held in the OS keychain: macOS Keychain via the `security` CLI ([ADR 0018](../adr/0018-hercule-ships-as-one-self-contained-binary.md)). Fallback everywhere else: a plain key file inside Hercule Home, outside the Data Root, mode 0600. *(Narrowed 2026-09-04, [#56](https://github.com/theagenticage/hercule/issues/56): this paragraph previously also named the Linux desktop keychain where one exists, reading "OS keychain" as Secret Service. v1 implements the macOS keychain and the key file, and nothing else - a D-Bus Secret Service path is a second store to keep correct for a platform no v1 user is on. Linux therefore always uses the key file, headless or not; Secret Service returns when a Linux user asks for it.)*
- The controller runs as a user-level service precisely so it can read the login keychain without a prompt.
- **The master key never leaves its machine.** It is not in the database, not in backups, not in a promotion bundle. Backups (`VACUUM INTO` snapshots) therefore contain inert ciphertext; copying the backups directory offsite is safe.

The plain key file is **`~/.hercule/master.key`**, mode 0600 (resolved 2026-09-01, [#44](https://github.com/theagenticage/hercule/issues/44)): at the Hercule Home root, outside `data/` and `backups/`, so promotion never moves it and backups stay inert.

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
- The web app's Secrets settings screen lists references and supports set/rotate/delete; it never displays a stored value. It lists `core` and `connection` references too, but offers no set, rotate or delete for them, because the API refuses those writes (§2.1) *(amended 2026-10-02, [#326](https://github.com/theagenticage/hercule/issues/326))*.

## 3. Connection credentials and setup policy

Setup flows and their UI are owned by [./08-events-and-connections.md](./08-events-and-connections.md). The security policy they follow:

### 3.1 Policy

- ~~**BYO OAuth client** where a provider demands one (Google). Hercule ships no OAuth client id and hosts no OAuth relay.~~ **BYO OAuth client** where a provider demands a client secret (Google). Hercule ships no OAuth client secret and hosts no OAuth relay. A public client id for a device flow is shippable, because a device flow needs no secret: the GitHub plugin ships the client id of Hercule's own OAuth App. *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*
- **Paste-a-token is the universal fallback**, and the primary path for Slack and Discord bot tokens ~~and for GitHub (a personal access token)~~. For GitHub, a personal access token is the fallback to the device flow *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*.
- All resulting credentials are stored as Connection-owned secrets (§2.1).

### 3.2 Per-provider path

Google = redirect flow to the controller's own HTTPS origin (BYO client); GitHub = ~~PAT paste~~ device flow through Hercule's own OAuth App, with PAT paste as the fallback *(amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183))*; Slack and Discord = bot-token paste. The setup recipes (Google consent-screen status, redirect-URI registration, token-lifetime traps) are in [./08-events-and-connections.md](./08-events-and-connections.md), from `research/connection-setup-ux.md` (branch `research/connection-setup-ux`).

### 3.3 Redirect URIs and the HTTPS origin

- The controller derives the exact redirect URI from the origin the user's browser is already using and displays it for the user to register. No Hercule-hosted relay is involved.
- On a tailnet, `tailscale cert` gives the controller a real certificate for `https://<node>.<tailnet>.ts.net`, which Google accepts as a redirect host; raw private IPs and `.local`/`.internal` names are rejected. `http://localhost` is a same-machine fallback only.
- The controller runs `tailscale cert` itself when HTTPS is enabled (§1): the Google Connection setup flow can surface "Enable HTTPS via Tailscale" as one of its declarative steps, which is where the cert finally lives next to the feature that needs it. Prerequisite surfaced in the same step: MagicDNS and the tailnet's HTTPS toggle must be on.

## 4. User authentication

Resolves the credential side of [ADR 0013](../adr/0013-agents-operate-hercule-through-the-public-api.md).

### 4.1 Principles

- No OAuth machinery for Hercule's own auth. No JWTs.
- Every credential Hercule issues is an opaque random token. The database stores only a hash; resolution is one indexed lookup, which satisfies the constraint that token -> session -> profile resolution adds no meaningful endpoint latency (the profile id sits on the Session row, copied at spawn).
- Both user credential kinds and session tokens resolve to the same actor-stamped API ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)).

### 4.2 Password login

- One user, username + password, set during first-run onboarding in the web app. The password is stored as a slow hash: **argon2id, via `Bun.password`** (resolved 2026-09-04, [#57](https://github.com/theagenticage/hercule/issues/57); native in the pinned Bun, so Hercule carries no hashing dependency, and `Bun.password.verify` reads the algorithm and parameters back off the stored string, which is what lets the parameters be raised later without a migration).
- Login returns an opaque bearer token the client holds and sends as `Authorization: Bearer <token>` on every HTTP call. No cookies, no CSRF machinery; this works identically in a future desktop shell ([ADR 0017](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)).


The bearer token's lifetime is **30 days rolling** (resolved 2026-09-01, [#44](https://github.com/theagenticage/hercule/issues/44)): carried over from ticket #18's cookie number - each authenticated use extends it, and logout revokes it server-side. Where the web app stores it between page loads is [./14-web-app.md](./14-web-app.md)'s.

### 4.3 API keys

- Long-lived, opaque, revocable. Always the user's identity, never an agent's.
- Minted in the web app (Settings) or via `hercule login` (password in, token out; `--password-stdin` scripted, echo-off TTY prompt as the one exception to the never-prompts rule, [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) §6.1). The CLI stores it in `~/.hercule/credentials.json`, mode 0600 ([./15-packaging-and-operations.md](./15-packaging-and-operations.md)).
  - **`hercule login` is two calls** (pinned 2026-09-04, [#57](https://github.com/theagenticage/hercule/issues/57)): `auth.login` with the username and password returns a 30-day bearer (§4.2), and `apiKey.create { name }` under that bearer mints the long-lived key. The key is what lands in the credential file; the bearer is discarded and never written to disk. There is no login mode that hands out a long-lived key directly - minting a key is an authenticated operation like any other, and this keeps it that way. The key's name defaults to the machine's hostname, so a laptop's key is distinguishable in Settings from one minted in the web app; `--name` overrides it.
- Revocable individually; a revoked key fails on its next use.
- Used by the ops CLI and scripts. The ops CLI and the runner-shipped `hercule` CLI are the same binary; the difference is the credential ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)).

### 4.4 WebSocket ticket

The web app's live socket ([./14-web-app.md](./14-web-app.md)) connects with a **short-lived, single-purpose ticket** (5 minutes) fetched over authenticated HTTP. The long-lived bearer token is never placed in a URL.

### 4.5 Runner credentials

A runner joins with a single-use join token and receives a durable per-runner credential ([./03-controller-and-runners.md](./03-controller-and-runners.md)). The credential is an opaque random token; the controller stores only its hash, like every other token. Retiring a runner revokes it. Runner credentials are not user credentials: a runner can do exactly what the runner protocol allows, nothing on the public API.

### 4.6 Post-v1

Passkeys and 2FA are post-v1. Nothing in v1 forecloses them: the login op is the only place that checks a password.

## 5. Session tokens and agent/user separation

- At session start the controller mints a **session token** whose subject is the Session row. The runner injects `HERCULE_API_URL` and `HERCULE_TOKEN` into the provider process. The token carries the agent's permission profile and is revoked when the session ends.
- Every mutation is stamped `actor: user | session:<id>`.
- The `hercule` CLI resolves credentials in this order: environment token first, the credential file second ([./15-packaging-and-operations.md](./15-packaging-and-operations.md)).
- The runner also sets `HERCULE_SESSION=1` in every session's environment. When that marker is present, the CLI **refuses file credentials** entirely: it uses the environment token or fails. Accidental fallback from an agent to the user's identity is therefore impossible, even on the controller machine where the user's own `hercule login` credential file exists.
- This is accident-proof, not malice-proof. A session is a bare process under the same OS user; a process that deliberately unsets `HERCULE_SESSION` and reads the credential file can impersonate the user. That is outside the v1 threat model (§1) and is the post-v1 sandboxing item.
- *(Amended 2026-10-03, [#310](https://github.com/theagenticage/hercule/issues/310).)* The marker has a second effect. A session no longer inherits the runner's `HERCULE_*` variables, `HERCULE_HOME` among them ([./06-providers.md](./06-providers.md) section 9.3), so commands that act on a Home, such as `hercule serve`, refuse the default Home inside a session and ask for one by name ([./15-packaging-and-operations.md](./15-packaging-and-operations.md) section 5). Like the credential refusal, this stops accidents only.

*(Amended 2026-09-12, [#162](https://github.com/theagenticage/hercule/issues/162).)* A resume mints a **fresh** session token for the same session id, carried on the `SessionStart` that carries the resume ([./03-controller-and-runners.md](./03-controller-and-runners.md) section 2); the token revoked when the session exited stays revoked. A session that is resumed in place ([./06-providers.md](./06-providers.md) section 4.1) therefore still holds exactly one live token, and a token never outlives the process it was minted for.

*(Amended 2026-09-22, [#200](https://github.com/theagenticage/hercule/issues/200).)* A session row holds its token hash only while it is `starting`, `idle` or `busy`; the database refuses any other row that holds one, so every move out of those statuses clears the hash in the same write. A session whose runner never returns does not keep its token for ever: the controller ends it once its absolute timeout has passed with nothing heard about it ([./03-controller-and-runners.md](./03-controller-and-runners.md) section 6.2).

## 6. Permission profiles

Mechanism: every agent carries a **permission profile**, copied onto each Session at spawn (a Thread takes the `thread.profileId` setting, [./02-domain-model.md](./02-domain-model.md)); the session token carries the session's profile; enforcement sits at the service layer so it binds HTTP and in-process session callers alike ([ADR 0013](../adr/0013-agents-operate-hercule-through-the-public-api.md)). Run and plugin actors are ungated ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 3.1). This section pins the content.

### 6.1 Grant families

A profile is a set of grants. Grants are coarse: one family per operation area, with read/write-style verbs inside the family, plus a few custom verbs where a shipped profile needs the distinction. Finer grants can land inside a family later without breaking existing profiles. `task` is split into `create`, `update`, `delete` rather than one `write` because the worker profile gets "read/create/update" and no delete. Family names are singular, matching the operation vocabulary ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 1.3, [ADR 0021](../adr/0021-one-operation-vocabulary-coarse-grants-explicit-routes.md)); ticket #18 pinned them plural and the rename is this spec's, by decision of [Public API operation catalogue](https://github.com/theagenticage/hercule/issues/38).

| Family | Covers (operation families) | Verbs |
|---|---|---|
| `task` | `task.*` | `read`, `create`, `update`, `delete` |
| `workflow` | `workflow.*`, `trigger.*`~~; `run.rerun`~~ | `read`, `write`~~, `run` (start a stored workflow, rerun), `submit` (start an unstored definition)~~ *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))* |
| `run` | `run.*` (read, cancel, start, rerun) | `read`, `write`, `start` (start a run of a stored or an unstored workflow, rerun; replaces `workflow.run` and `workflow.submit`, amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79)) |
| `session` | `session.*`, `input.*`, `transcript.*` | `read` (records and transcripts), `spawn` (spawn, continue), `steer` (input, interrupt, stop, respond, queue edits) |
| `subscription` | `subscription.*` | `read`, `write` |
| `notification` | `notification.*` | `read`, `write` (create, act, withdraw own; act by the user only, *amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85)*: a session or a run holding `write` is refused `notification.act`, section 6.5) |
| `settings` | `settings.*` (the user settings store: timezone, topic order, mutes, last-checked markers) | `read`, `write` |
| `event` | `event.*` | `read`, `emit`, `audit` (the security entries of the log: the audit kinds under `secret.`, `auth.` and `user.`; amended 2026-09-15, [#68](https://github.com/theagenticage/hercule/issues/68)) |
| `connection` | `connection.*` and plugin actions that act via a Connection | `read`, `manage` (create, edit, delete, credentials), `use` (act via a Connection~~; dormant in v1~~, see 11 section 2; *amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89): checked whenever a caller chooses the Connection a step acts through, and on every `event.emit`*) |
| `infra` | `runner.*`, `plugin.*`, `provider.*`, `controller.*` | `read`, `write` |
| `workspace` | `workspace.*` | `read`, `write` (provision, dispose) |
| `agent` | `agent.*`, `assistant.*`, `binding.*`, `conversation.*` | `read`, `write` |
| `memory` | `memory.*` (`list`, `read`, `search` / `write`, `append`, `delete`) | `read`, `write` |
| `permission` | `profile.*`, `permission.decide` | `read`, `write` |
| `project` | `project.*` | `read`, `write` |
| `resource` | `resource.*` | `read`, `write` |
| `secret` | `secret.*` (references only on read) | `read`, `write` |
| `credential` | `apiKey.*`, `user.read` *(added 2026-09-29, [#275](https://github.com/theagenticage/hercule/issues/275))*, `user.setPassword` | `read`, `write` |

The operation-to-grant mapping is an explicit table in the contract package; [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2 names the grant beside every operation. `permission.request` is granted to every profile and is not itself a grant; `auth.login`, `auth.wsTicket` and `setup.*` are outside the grant model.

**Grants are unscoped in v1 (hard rule).** A grant on a family covers every entity in that family: `session.read` reads any session, `task.update` updates any task. Scoped grants ("the sessions you spawned", "this project's tasks") are the post-v1 finer grants. The one exception is `memory`: a session token's memory operations are pinned to its own assistant ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 6.4), because [ADR 0020](../adr/0020-assistant-memory-is-reached-only-through-the-api.md) and [./12-assistants.md](./12-assistants.md) promise that memory is never shared between assistants.

**Bulk-destructive operations** (delete-many, cancel-all and the like) are withheld from every profile but `unrestricted` regardless of family. The v1 catalogue contains none: every delete, cancel and stop takes one id. The rule stands for future operations; how they are tagged is an implementation choice made when the first one lands.

### 6.2 Shipped profiles

| Profile | Default for | Grants | Withholds |
|---|---|---|---|
| **assistant** | assistants | `task` (read, create, update, delete), `workflow` (read~~, run, submit~~), `run` (read, write, start *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))*), `session` (read, spawn, steer), `subscription` (read, write), `notification` (read, write), `event` (read, emit), `memory` (read, write), `settings` (read), and `read` on `connection`, `infra`, `workspace`, `agent`, `permission`, `project`, `resource` | `workflow.write`, `connection.manage`, `connection.use`, `infra.write`, `workspace.write`, `agent.write`, `permission.write`, `project.write`, `resource.write`, `secret`, `credential`, `event.audit`, direct work tools (no Workspace), bulk-destructive operations |
| **worker** | agent steps in workflows | `task` (read, create, update), `notification` (read, write), `subscription` (read, write), `run` (read), `event` (read) | `task.delete`, `session.spawn`, ~~`workflow.run`, `workflow.submit`~~ `run.start` *(amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79))* (so a workflow cannot fan out recursively unless granted), `session.read`, `memory`, `event.audit`, everything the assistant profile withholds |
| **unrestricted** | nobody by default | user parity: everything the user can do | nothing; assigned only explicitly |

- The assistant profile encodes "delegate, don't do": the orchestration surface plus read on everything that is not a secret, so it can answer "what is going on" about anything in the system, including any session's transcript. It is hard by configuration, not by caste, and loosenable per assistant ([./12-assistants.md](./12-assistants.md)).
- *(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* The grants `workflow.run` and `workflow.submit` became one grant, `run.start`, with the one operation that replaced their two ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2). Migration `0026` gives every profile that held either old grant, shipped or written by the user, `run.start` in its place; a profile with neither is left alone. The grant moved to the `run` family because the operation starts a run and belongs to it.
- The worker profile is the trust floor for workflow agent steps. A workflow that needs a step to spawn sessions, start runs or read transcripts assigns a profile that grants it.
- *(Amended 2026-09-28, [#82](https://github.com/theagenticage/hercule/issues/82).)* Withholding `run.start` does not stop a session from causing a run. The worker profile holds `task.create`, and creating a Task emits `task.created`; a session with `event.emit` can post a manual event. Either event matches start triggers like any other event, so a start trigger on its kind starts a run although the session holds no `run.start`. The loop guard and the spawn bound that limit this come with [#87](https://github.com/theagenticage/hercule/issues/87) ([./08-events-and-connections.md](./08-events-and-connections.md) section 4.1). *(Amended 2026-10-04, [#89](https://github.com/theagenticage/hercule/issues/89).)* Posting a manual event now needs `connection.use` beside `event.emit`, because every kind `event.emit` accepts is a plugin's kind, and its event starts the same workflows as one sent through a Connection ([./08-events-and-connections.md](./08-events-and-connections.md) section 5.4). So a session needs both grants to cause a run this way. The `assistant` profile holds `event.emit` and withholds `connection.use`, so it cannot post any event: its `event.emit` grant has no use left until the profile is changed.
- The worker's `notification` cell gained `read` (amended 2026-09-04, [State store and first run](https://github.com/theagenticage/hercule/issues/56)): it read `write` alone, which would have left a worker able to create a notification and unable to read it back, while every other family in the table lists its read verb explicitly. The seeded profile carries `notification.read`.
- Profiles are named records the user edits in Settings > Permission profiles ([./14-web-app.md](./14-web-app.md)); the three shipped ones are seeded at first run and can be edited but not deleted. The agent -> profile assignment is a field on the Agent ([./02-domain-model.md](./02-domain-model.md)), set with `agent.update`.
- **`event.read` was wider than the Withholds column, and no longer is** *(recorded 2026-09-04, [#59](https://github.com/theagenticage/hercule/issues/59); resolved 2026-09-15, [#68](https://github.com/theagenticage/hercule/issues/68))*: both profiles hold `event.read`, and the one event log carries the audit entries for the `secret` and `credential` families this column withholds - their metadata, never a secret value. The session-actor ticket resolved it with the `event.audit` verb: those entries, and the ones about the user's own account, are returned only to an actor holding it. Neither shipped agent profile does; `unrestricted` does, as user parity requires; the user is unaffected. `event.read` keeps returning everything else, and the operations still name `event.read` alone - the split is inside the service ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2, `event`).
- **`event.read` covers the platform events' payloads** *(recorded 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81))*: the run and task platform events carry the run's outcome and the task's fields, and `event.read` returns them without asking for `run.read` or `task.read`. Both shipped agent profiles hold those grants anyway, so neither sees more than before. A profile the user writes with `event.read` and without `task.read` or `run.read` does see those payloads through the log ([./08-events-and-connections.md](./08-events-and-connections.md)).
- This table is the single normative statement of the shipped profiles; [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) and [./12-assistants.md](./12-assistants.md) link here.

### 6.3 Enforcement and 403s

- The service layer checks the actor's grants before executing an operation, before any entity is loaded. The user actor (password login or API key) has full parity: no profile applies. *(Amended 2026-09-04, [#57](https://github.com/theagenticage/hercule/issues/57).)* On HTTP the same static check also runs in transport middleware, ahead of payload decoding, so a caller without the grant gets 403 rather than 400 on a malformed body ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) §1.5). The check in the method stays: it is what binds in-process callers.
- A denied call returns HTTP 403 whose body names the missing grant (`{ error: { code: "forbidden", details: { grant: "session.spawn" } } }`, envelope in [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 1.5). The `hercule` CLI surfaces that name verbatim so the agent can ask for it, and `hercule <entity> <verb> --help` names the grant up front.
- Resolution is one indexed lookup from token hash to session to agent to profile, cached per session and invalidated on session end, profile edit, or a decided Permission Request.
- **A session may only continue a session on its own permission profile** *(amended 2026-09-16, [#68](https://github.com/theagenticage/hercule/issues/68))*. `session.continue` carries the parent's profile onto the fork ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2), and grants are unscoped (section 6.1): a session holding `session.read` and `session.spawn` can find every session on the controller, so without this it could fork one on a wider profile and drive it with a prompt of its own choosing - an escalation the profile never granted. A parent on any other profile is refused 403 naming `session.spawn`. The rule sits in the service rather than in the static grant check, because it is a fact about the parent row and so needs a read; the static check runs before the payload is decoded and has no id to read.
- **Only the user forks a Thread** *(added 2026-10-04, [#75](https://github.com/theagenticage/hercule/issues/75))*. A fork of a Thread is a new Thread, and only the user opens a Thread ([./02-domain-model.md](./02-domain-model.md) Thread). So `session.continue` on a parent with no Agent is refused 403 naming `session.spawn` for every actor but the user (session, run and plugin actors), even a session on the Thread's own profile. Without this, a session could open a Thread with a prompt of its own choosing, and on the controller's local runner that Thread sees the user's own material. The user forking their own Thread is unchanged, and so is steering an exited Thread with a granted `session.steer`.
- **A session may only spawn from an Agent whose permission profile grants nothing beyond its own** *(Amended 2026-09-19, [#76](https://github.com/theagenticage/hercule/issues/76).)* An Agent whose profile carries a grant the spawning session's profile lacks is refused 403 naming `session.spawn`; the user actor passes every profile. The reason is the fork rule's: grants are unscoped (section 6.1), so a session holding `agent.read` and `session.spawn` can find every Agent on the controller, and without this it could drive one on a wider profile with a prompt of its own choosing. A subset rather than an exact match, so that an assistant may still delegate to a narrower worker.
- **A session may only spawn at or below the access mode the Agent itself names** *(Amended 2026-09-19, [#76](https://github.com/theagenticage/hercule/issues/76).)* The per-spawn `accessMode` of [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2 is an override the Agent expects, and the user's is unrestricted ([./02-domain-model.md](./02-domain-model.md) Agent); a session actor's may only move down the chain of [./06-providers.md](./06-providers.md) section 8.4. A call naming a more permissive mode than the Agent's own is refused 403 naming `session.spawn`. It is the grant rule above by the other axis: without it a session could drive a narrow Agent - one the grant rule lets it spawn from - on full access with a prompt of its own choosing, which is more of the machine than the Agent was ever configured for. Every other per-spawn field stays an override for both actors: `model`, `options`, `runnerId`, `workspace` and `projectId` say where and on what the work runs, not how much of the machine it may touch.

### 6.4 Escalation: Permission Request

1. The agent calls `permission.request { grant, reason, operation? }` (granted to everyone; `hercule permission request <grant> --reason "..."`). `operation` optionally names the call it wanted to make (`{ op: "connection.create", input }`), so the user sees what the agent is trying to do, not only which family it lacks.
2. The controller creates a **Permission Request** Notification ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)) naming the session, the agent, the grant, the reason and the operation, and, when the caller is a session, registers a `{ kind: "request" }` subscription for that session in the same call. The response carries `requestId` and `subscriptionId`.
3. The user decides in the web app, or from an interactive channel sink where the click must come from an **owner** platform identity - a trusted identity may command an assistant but not decide ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4), through the bound `permission.decide` with one of three outcomes: **`session`** (a session-scoped grant overlay that dies with the session), **`profile`** (edits the agent's profile; every future session of every agent on that profile gains it), or **`deny`**.
4. The decision arrives as queued input on a turn boundary and the agent retries the original operation itself, so the actor stays `session:<id>`. There is no blocking wait, consistent with the no-blocking rule in [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md).

A fourth outcome, **`once`** (a one-use overlay consumed by the first successful call of the named operation), is post-v1; `operation` on the request is the field it needs ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 10).

Raising and deciding a Permission Request are audited (section 11).

### 6.5 Decision Notification actions

Decision Notifications carry bound actions: answers that bind an operation proposed by an agent, a run, a plugin or the core, executed when the user chooses one ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4). The actor of the executed operation is the user who clicked; it runs under user parity.

**Authoring is not profile-checked** ([ADR 0022](../adr/0022-proposing-is-not-doing.md)): a session may propose an operation its own profile forbids; the user's informed click is the authorisation. The guardrails are: ~~a per-operation `bindable` flag that withholds the `credential`, `secret`, `infra` and `permission` families, `connection.manage` and bulk-destructive operations from non-core producers~~ *(amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85))* a curated list of the operations an answer may run, which applies to every producer, the core included, and which a test keeps free of every operation needing a grant in the `credential`, `secret`, `infra` or `permission` family, or `connection.manage` ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4); a core-rendered `describe(input)` line on every answer that the producer can neither write nor suppress; and an audit entry naming decider, proposer and (for channel clicks) the channel connection. Channel clicks execute only from owner platform identities ([./12-assistants.md](./12-assistants.md) section 4.1); trusted identities and any other sender are refused with an ephemeral reply.

*(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85).)* Built, apart from channel clicks, which arrive with the sinks in [#99](https://github.com/theagenticage/hercule/issues/99):

- **Only the user takes an answer.** `notification.act` needs `notification.write`, and both shipped agent profiles hold it so that they can create notifications. A session or a run calling `notification.act` is still refused with `forbidden`: if an agent could take an answer, it could run, as the user and under the user's parity, the operation it had just proposed, and the user's click would authorise nothing.
- **Checked twice.** The core checks an answer's operation against the list and its schema when the notification is created, and again when the user takes the answer, so a record created under an older list or schema cannot run an operation the current list refuses.
- **Which producer may bind what.** The list says what any answer may run; the producer's identity narrows it, because the click runs as the user and would otherwise let one agent aim the user at another agent's session. ~~`session.respond`~~ `session.respondToApprovalRequest` *(renamed 2026-10-01, [#309](https://github.com/theagenticage/hercule/issues/309))* is the core's alone: it answers a runner's permission request, and only the core creates those decisions. A session binds `session.input` only to itself (`sessionId: "me"`), and a session in an assistant's conversation not at all, because its input comes only through `conversation.send`. A run binds `session.input` to any session, since its steps drive sessions they did not spawn. Each refusal is a `validation` error on `notification.create` ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4).
- **The describe line hides nothing that runs.** Every field the operation will run with appears in full: no text is cut short and no input or option is left out, so a producer cannot hide part of the operation past a cut. An input that holds a Connection id shows the Connection's label.
- **Audit.** Taking an answer writes `notification.decided { notificationId, actionId, op, producer }`, stamped with the actor `user`; the resolution's `origin` says where the answer came from: `web` (the web app's login token), `api` (an API key, such as the CLI) or, once sinks exist, `connection:<id>`.

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

- **Auth by delegation.** Hercule never holds, extracts, proxies, or distributes provider (Claude Code, Codex, pi) login tokens. Each runner logs in to each provider itself, with the vendor CLI storing its own credential.
- **Per-runner headless login, Hercule-driven.** Provider CLIs are installed on request from the runner's fleet page (amended 2026-09-07, [#64](https://github.com/theagenticage/hercule/issues/64); previously pinned as installed at join). Hercule then drives each provider's own headless login on that runner, relaying the URL or user code to the user's browser wherever they are; it is a post-join step, driven from the fleet page ([./03-controller-and-runners.md](./03-controller-and-runners.md) §3.3). The per-provider flows (device code, paste-a-code, `setup-token`) are in [./15-packaging-and-operations.md](./15-packaging-and-operations.md) §12.
- **Never distribute vendor tokens across the fleet.** Refresh-token rotation with reuse detection (documented by OpenAI, structurally the same in pi) means two live copies race and the loser is logged out. Copying a credential file is a bootstrap shortcut owned by exactly one runner afterward.
- **Probing without credential files.** Runners self-report per-provider auth state through vendor APIs (Agent SDK init `AccountInfo`, Codex `account/read`, pi `checkAuth`), never by reading credential files ([./03-controller-and-runners.md](./03-controller-and-runners.md)).
- **ToS posture.** All three vendors permit a user's own account on machines the user owns; prohibitions target sharing with other people and (Anthropic) third-party products offering claude.ai login. Hercule as the user's own tool driving vendor CLIs under the user's own logins stays inside every posture. The Claude Agent SDK itself accepts API key, Bedrock, Vertex, or Foundry auth; subscription use goes through the user's own `claude` binary ([./06-providers.md](./06-providers.md)).
- **Provider-home isolation.** Every session runs inside its provider instance's isolated, Hercule-owned provider home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`): one instance = one login = one home, long-lived on that runner, never per session. That home holds the runner's own vendor login and keeps the user's global instructions, skills and packages out of Hercule sessions; details in [./06-providers.md](./06-providers.md). *(Amended 2026-10-04, [#75](https://github.com/theagenticage/hercule/issues/75).)* A Thread on the controller's local runner is the one exception: it sees the user's own skills and instructions, User Material ([./06-providers.md](./06-providers.md) section 9.1). Two consequences are accepted, for parity with the user's own Claude Code:
  - In an `approval-required` Thread, the user's own Claude skills, agents and commands can let tools run without an approval card while they are active, through `allowed-tools`, `hooks:` and an agent's `permissionMode`. Codex and pi skills carry instructions only and do not change approvals, as far as verified.
  - The Thread trusts the shared instance home as its "user" settings source. Another session of the instance with full access could write a `settings.json` or a skill there, and the next Thread would load it. This is not new reach, because such a session could already edit the user's real `~/.claude`.

## 9. Git credentials

Decision and rationale: [ADR 0016](../adr/0016-git-credentials-derive-from-connections.md). Resolves the handoff from the execution substrate ([./03-controller-and-runners.md](./03-controller-and-runners.md)).

### 9.1 Derivation and delivery

- Clone, fetch, and push authenticate with the **GitHub Connection of the checkout being touched**. Runners hold no user-managed git credentials.
- The runner configures each session with a git credential helper through env-injected `GIT_CONFIG_*` variables (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`), never by writing to the checkout's `.git/config` or the user's global config.
- The helper is a small command that asks the **runner daemon** over its local channel. The daemon resolves checkout -> Resource -> Connection, fetches the token from the controller on demand over the runner WebSocket, and answers the helper. The token is held in memory for the duration of the git operation; nothing lands on runner disk. Short-lived tokens become a drop-in upgrade later.
- *(Amended 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183).)* The token the controller hands out is the Connection's pasted `pat`, or the access token in its `oauth.tokens` secret when it was set up by the device flow. The controller only reads it and never refreshes it, because a GitHub OAuth App token never expires and has no refresh token ([./08-events-and-connections.md](./08-events-and-connections.md) §9.3).

**Verify at build time:** the runner daemon's local channel for the helper (Unix socket path or loopback port, and how the helper authenticates to the daemon so only the daemon's own sessions can ask). The tickets pin the shape, not the transport.

*(Amended 2026-09-16, [#72](https://github.com/theagenticage/hercule/issues/72).)* Answered. **Transport:** a Unix socket at `<runner storage>/daemon.sock`, mode 0600 in a directory mode 0700, so no other OS user reaches it; no port is bound. **Authentication:** the helper proves nothing itself and the daemon resolves nothing. `hercule git-credential get` sends git's `protocol`/`host`/`path` down the socket together with the `HERCULE_TOKEN` its environment carries - the session token of section 5, minted per session and revoked when it exits - and the daemon relays that as `CredentialRequest { requestId, remote, sessionToken }` to the controller. The controller verifies the token, canonicalises the remote, and answers only when that resource is a checkout of that session's own workspace; anything else is `CredentialAnswer { error }` and the helper prints nothing, which is git's signal to fall through to the machine's own helpers (section 9.5). The machine asks as itself only while it is provisioning a workspace, sending `{ requestId, remote, workspaceId }` in place of the token, and the controller answers only while that workspace is `provisioning` on that runner. Nothing is minted on the runner and no identity is inferred from the OS: a process-tree check was rejected (PID reuse races, double-fork reparenting, and it stops nothing a same-user process could not already do by reading `runner.json`). What stays outside the model is what section 12 already accepts: a same-OS-user process is at parity with the runner, and an agent can always read the token of its own repository.

*(Amended 2026-09-25, [#259](https://github.com/theagenticage/hercule/issues/259).)* The machine also asks as itself while it runs a **workspace step** (section 9.6), because no session runs the step, so no session token exists. It sends the same `{ requestId, remote, workspaceId }` form, naming the run's workspace. No new secret and no new frame are added. The controller answers that form in two cases, and refuses every other with `unauthorized`:

- the workspace is `provisioning` on that runner (as above);
- a workspace step's record is `running` in that workspace, in a run that is `running` and pinned to that runner.

The remote must still canonicalise to a checkout of that workspace, so the credential only ever works for the workspace's own remotes. A step that has ended, a controller step of the same run (such as `wait`), and another runner naming the workspace all get `unauthorized`. The runner puts the workspace id in the environment of its own git only while it provisions a workspace or runs a workspace step; a session's git carries its session token instead.

*(Amended 2026-09-27, [#263](https://github.com/theagenticage/hercule/issues/263); [ADR 0036](../adr/0036-a-workspace-is-kept-by-leases-its-holders-release.md).)* **The two rules, as the controller now answers them.** Neither rule changes what it allows; what changes is where the facts are read.

- **The session-token rule** answers only while the session holds an active Workspace Lease on a workspace on that runner with a checkout of the remote. A session releases its lease when it exits, which is also when its token is revoked, so the two checks agree; the lease is the fact the workspaces domain owns.
- **The workspace-step rule** is answered through a port, `WorkspaceStepActivity`, which the workspaces domain declares and the runs domain implements, because step records belong to runs. It asks whether a workspace step's record is `running` in that workspace, in a run pinned to that runner. A run's active lease is not enough: a run holds its lease through controller steps such as `wait`, and through the time between steps, when no push should be possible.

### 9.2 Per-checkout identity

- `credential.useHttpPath=true` makes git include the repository path in the credential lookup, so the helper resolves identity per checkout.
- The helper answers with a **username hint** from the Connection so git's credential matching distinguishes accounts on the same host. One workspace can therefore mix GitHub accounts at the git level (multi-repo workspaces with one checkout per Resource). This matches Git Credential Manager's own multi-account guidance.
- Commit author = per-checkout `user.name` / `user.email` from the Connection, injected the same way.

*(Amended 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257).)* Per-checkout commit authors are not built yet. The author of every commit - one a session's agent makes, and one the `git.commit` workspace action makes - comes from the workspace's **designated** Connection (section 9.3). In a multi-repo workspace whose checkouts use different Connections, every checkout's commits carry that one author until per-checkout identity is built. Credentials are already per checkout (above); only the author is not.

### 9.3 `gh` and `GH_TOKEN`

- The `gh` CLI acts as one account per host per process (confirmed as of gh 2.40+). Each session gets `GH_TOKEN` injected from the **workspace's designated Connection**, so `gh` works out of the box.
- A workspace designates exactly one GitHub Connection for this purpose ([./02-domain-model.md](./02-domain-model.md)). In a multi-repo workspace whose checkouts use different Connections, git operations stay per-checkout while `gh` uses the designated one.
- ~~Workspace-less sessions get the user-designated default GitHub Connection, or no `GH_TOKEN` if none is designated.~~ A session whose workspace designates no Connection, which includes every workspace-less session, gets the user's default GitHub Connection: the user setting `github.defaultConnectionId`, set in Settings > Profile. With no default set it gets no `GH_TOKEN`. The default applies only to Threads the user starts and to an assistant's conversation sessions. A session spawned from an Agent gets none, whether the user or an agent spawned it, because the Agent supplies every default a user setting would. A fork keeps its parent's Connection *(amended 2026-09-25, [#92](https://github.com/theagenticage/hercule/issues/92))*.

### 9.4 Identity follows the repo

Identity follows the repo, never the agent, in v1. Per-agent git identity (an agent -> Connection association) is a post-v1 policy addition on unchanged plumbing.

### 9.5 Non-GitHub remotes

Runner-local, user-managed auth (`ssh` keys, `git credential` stores the user configures on the machine) remains the documented fallback for remotes that are not GitHub Connections. Hercule does not manage those credentials.

### 9.6 Workspace actions

*(Added 2026-09-25, [#257](https://github.com/theagenticage/hercule/issues/257).)* A workspace action is a workflow action that runs in a run's workspace on the run's runner ([./07-workflows.md](./07-workflows.md) section 8, [ADR 0035](../adr/0035-an-action-declares-where-it-runs.md)). A workflow can be fired by an external event, such as a GitHub issue or an email, so its templates carry text an outsider wrote. The rules below keep that text from ever becoming a command on the runner's machine.

- **Argument lists, never shell strings.** Every process a workspace action starts is started from an argument list, with no shell. A template fills an argument and nothing else. An issue titled `fix; rm -rf ~` becomes a commit message as one argument to `git commit`; no shell reads it, so the `rm` never runs. Paths come after `--`, so a path that starts with `-` is never read as an option.
- **Process group.** Each process leads its own process group. Stopping a step sends SIGTERM to the whole group, waits 5 seconds, then sends SIGKILL. The grace period lets git remove its `index.lock`, so a stopped step does not leave the checkout locked.
- **One step per workspace.** A workspace runs one workspace step at a time, so two parallel steps never collide on `index.lock`.
- **Deadline.** Each action has a 10-minute deadline. Past it the step is stopped as above and fails with `timeout`.
- **Little output is kept.** A failed step's message holds the tail of git's stderr. Nothing else of stdout or stderr is kept.
- **Credentials.** `git.commit` needs none. ~~The credentials for a push arrive with `git.push` ([#259](https://github.com/theagenticage/hercule/issues/259)), through the helper of section 9.1.~~ *(amended 2026-09-25, [#259](https://github.com/theagenticage/hercule/issues/259))* `git.push` gets its credential through the helper of section 9.1, in the workspace-step case added there: only for the checkout's own remote, and only while the step runs.

## 10. Taint and provenance in assistant memory

Resolves the handoff from [./12-assistants.md](./12-assistants.md). Prior art: OpenClaw taint-gating and Hermes context-not-instructions marking in `research/assistant-systems.md` (branch `research/assistant-systems`).

- Third-party text in a shared channel (anything not from an owner or trusted platform identity, and every bot line) is **context, never instructions**. It enters the session wrapped in explicit data-not-instructions markers.
- The markers survive through rotation and distillation: the distiller sees the same wrapping, and its prompt is hardened against treating quoted content as directives.
- **Session taint is set by the core**: a session is tainted from the moment the core delivers it any wrapped line, for the rest of that incarnation; the agent passes nothing. Every memory write from a tainted session carries **provenance metadata on the document** (one entry per source conversation, latest date), set by the write op, shown beside the document in the memory view and rendered by `read` as a trailing line: `> provenance: session s_12, Discord #general, 2026-08-30, includes third-party content`. Metadata rather than an in-body line so the next `write` cannot silently erase it and it never eats cap. The user clears an entry after review; the session stays tainted until rotation ([./12-assistants.md](./12-assistants.md) section 6.7).
- Hard-excluding third-party content from distillation is rejected: it discards the signal shared-channel assistants exist to keep.
- Only **owner** and **trusted** platform identities can command an assistant ([./12-assistants.md](./12-assistants.md) section 4.1); only owner identities decide bound actions. Identities are claimed by a one-time pairing code DMed to the bot; unknown DM senders are ignored, never answered.
- **Stated limit:** a trusted identity's DM is its own conversation with the same assistant and therefore the same memory, which holds facts about the owner. Granting trusted grants that; there is no per-identity memory partition in v1 (single user). Bots can never be paired, so no bot can command.

The provenance line's shape is pinned above; the in-context wrapper syntax stays an implementer's choice ([./16-open-items.md](./16-open-items.md) B), stable and greppable.

## 11. Audit

The event log ([./04-state-store.md](./04-state-store.md)) is the audit log; there is no separate audit subsystem.

- Every mutation on the public API carries `actor: user | session:<id>`.
- Auth and security event kinds: `auth.login.succeeded`, `auth.login.failed`, `auth.apiKey.minted`, `auth.apiKey.revoked`, `permission.requested`, `permission.decided`, `secret.created`, `secret.rotated`, `secret.deleted`, `runner.joined`, `runner.retired`. Names are indicative; the kinds pinned by ticket #18 are login success/failure, token minted/revoked, permission request raised/decided, secret created/rotated.
- **Kinds emitted as of 2026-09-04** ([#57](https://github.com/theagenticage/hercule/issues/57)), following `<entity>.<verb>ed` under `source: "platform"`: `auth.login.succeeded`, `auth.login.failed`, `auth.logout`, `auth.apiKey.minted`, `auth.apiKey.revoked`, `user.passwordChanged`, `setup.completed`, `settings.updated`, `profile.created`, `profile.updated`, `profile.deleted`, `secret.created`, `secret.rotated`, `secret.deleted`. Added 2026-09-04 ([#59](https://github.com/theagenticage/hercule/issues/59)): `task.created`, `task.updated`, `task.deleted`, `project.created`, `project.updated`, `project.deleted` - the task kinds are matchable platform events as well ([./09-tasks.md](./09-tasks.md) Platform events), and both populations share the one log. *(Amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81): `task.created` and `task.updated` are no longer written as audit entries but as platform events, which the event router evaluates; `task.deleted` is still an audit entry only.)* `auth.login.failed` carries `actor: null`, because nobody is authenticated at the moment it is written. Later tickets add their own; the list grows, it is not re-cut. *(Added 2026-09-28, [#84](https://github.com/theagenticage/hercule/issues/84) and [#85](https://github.com/theagenticage/hercule/issues/85): `notification.created`, `notification.withdrawn` and `notification.decided`; the last names the answer taken, its operation and the producer that proposed it, section 6.5.)*
- **Retention.** Security events and actor-stamped mutations are kept at least 90 days; the full retention statement (event log TTL, per-session streams, domain rows) is in [./04-state-store.md](./04-state-store.md).

## 12. What v1 does not defend against

Stated explicitly by the tickets:

- **Hostile internet exposure.** No brute-force protection, no lockout, no CSRF defence. Do not expose the controller publicly; use a tailnet.
- **Local malice on a shared machine.** Bare-process sessions under the same OS user can read the user's `hercule login` credential file, provider credential files, and any workspace on that runner. `HERCULE_SESSION` stops accidents only.
- **A compromised runner.** A runner that fetches git tokens on demand can see the tokens for any checkout it hosts while an operation runs. Retiring the runner revokes its credential; the Connection tokens it saw should be rotated by the user.
- **Prompt injection beyond taint marking.** Wrapping and prompt hardening reduce, not eliminate, the chance an assistant follows third-party text. The provenance line makes the outcome auditable.
- **A stolen master key.** Anyone with the machine's keychain (or the headless key file) and the database has every secret.
- **Vendor-side credential races** when a user copies a provider credential to two runners despite the guidance.
- **Device-code phishing.** *(Added 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183).)* The GitHub plugin's client id is shared and public, so an attacker can start a device flow as Hercule's app and trick a user into entering the attacker's code, which grants the attacker a token. GitHub shows the app's name and the scopes it asks for, and the user should enter only a code their own Hercule showed them. Hercule cannot prevent this; it comes with every device flow.
- **A deleted Connection's token stays valid.** *(Added 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183).)* Revoking an OAuth App token needs the app's client secret, which Hercule does not ship (§3.1). Deleting a GitHub Connection in Hercule therefore leaves its token valid at GitHub. The web app's delete confirmation says so, and the docs point the user to `github.com/settings/applications` to revoke it.
- **The `workflow` scope.** *(Added 2026-10-02, [#183](https://github.com/theagenticage/hercule/issues/183).)* A device-flow GitHub token carries `workflow`, which pushing a change under `.github/workflows` needs. It also lets the token, and any agent that can use it, edit a repository's CI. A user who wants narrower access pastes a fine-grained PAT instead ([./08-events-and-connections.md](./08-events-and-connections.md) §9.3).
- **A stolen desktop signing certificate.** *(Added 2026-10-01, [#308](https://github.com/theagenticage/hercule/issues/308).)* The Keychain gives the desktop app's token key to any app signed with the same certificate and bundle identifier (spec 17, §Auth and the token). Whoever holds the certificate's private key, or can push to `main` and so have CI sign a build, can make an app the Keychain trusts with that key. The key lives only in the `desktop-signing` environment's secrets, which only `main` can use ([docs/signing-certificate.md](../signing-certificate.md)). And while the certificate is self-signed, the app's entitlements turn library validation off, so the libraries the app itself loads are not checked against its signature.

## Post-v1

- OS sandboxing (Seatbelt/Landlock) and containers as probed runner capabilities; v1 keeps sessions as bare processes and the `HERCULE_SESSION` marker so the credential seam is already in place.
- Passkeys and 2FA; v1 keeps a single password-check site.
- Per-agent git identity (agent -> Connection association); v1's credential helper already resolves per checkout, so this is policy only.
- Hostile-internet hardening (rate limiting, lockout) if multi-tenant hosting arrives.
- Finer grants inside families; v1 keeps families coarse so profiles do not break.
- Short-lived git tokens (e.g. GitHub App installation tokens) as a drop-in behind the same on-demand helper.
- MCP-based hercule-as-a-tool, which would carry the same session token.
- BYO TLS cert/key paths (a non-tailscale CA), and TLS between fleet machines - the latter a genuine bootstrap-config concern when it lands ([#44](https://github.com/theagenticage/hercule/issues/44)).

## Sources

Tickets:

- Security & secrets model - https://github.com/theagenticage/hercule/issues/18
- Research: portable provider installs & credentials across runners - https://github.com/theagenticage/hercule/issues/23
- Research: smoothest Connection-setup path - https://github.com/theagenticage/hercule/issues/32
- Agent-operates-system surface - https://github.com/theagenticage/hercule/issues/16
- Provider adapter interface (fallback guardrail handoff) - https://github.com/theagenticage/hercule/issues/12
- Controller promotion & portability (packable secrets) - https://github.com/theagenticage/hercule/issues/10
- Plugin architecture (plugin secrets API) - https://github.com/theagenticage/hercule/issues/11
- Assistant design (taint handoff) - https://github.com/theagenticage/hercule/issues/17
- Web app architecture (bearer auth, WS ticket) - https://github.com/theagenticage/hercule/issues/19
- Controller/runner architecture (join credential) - https://github.com/theagenticage/hercule/issues/7
- Runner execution substrate (git credential handoff) - https://github.com/theagenticage/hercule/issues/8
- Controller packaging & install story (keychain, backups) - https://github.com/theagenticage/hercule/issues/24
- Assemble the v1 spec (bound-action authorisation, provider-home isolation) - https://github.com/theagenticage/hercule/issues/21
- Operations details: bootstrap config, first run, login, upgrade, backups, key file - https://github.com/theagenticage/hercule/issues/44

ADRs:

- [ADR 0015 - Secrets are encrypted per-value under a keychain-held master key](../adr/0015-secrets-are-encrypted-per-value-under-a-keychain-held-master-key.md)
- [ADR 0016 - Git credentials derive from Connections](../adr/0016-git-credentials-derive-from-connections.md)
- [ADR 0013 - Agents operate Hercule through the public API](../adr/0013-agents-operate-hercule-through-the-public-api.md)
- [ADR 0003 - Sessions run as bare processes](../adr/0003-sessions-run-as-bare-processes.md)
- [ADR 0005 - Promotion is migration behind a stable controller identity](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)
- [ADR 0017 - The web app is a static pure client of the public API](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)
- [ADR 0020 - Assistant memory is reached only through the API](../adr/0020-assistant-memory-is-reached-only-through-the-api.md)
- [ADR 0021 - One operation vocabulary, coarse grants, explicit routes](../adr/0021-one-operation-vocabulary-coarse-grants-explicit-routes.md)
- [ADR 0035 - An action declares where it runs](../adr/0035-an-action-declares-where-it-runs.md) (workspace actions, section 9.6)

Research: `research/provider-portability.md` (branch `research/provider-portability`), `research/connection-setup-ux.md` (branch `research/connection-setup-ux`), `research/assistant-systems.md` (branch `research/assistant-systems`).
