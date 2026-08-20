# Research: portable provider installs & credentials across runners

Resolves rogierpennink/hydra#23. Researched 2026-08-20 against primary sources (vendor docs, vendor source at pinned versions, published ToS). Builds on `research/t3code.md`, `research/claude-agent-sdk.md`, `research/codex-app-server.md`, `research/pi-sdk.md`.

## TL;DR

- **Installs are trivially portable for all three.** Claude Code and Codex are self-contained native binaries with one-line installers; pi is an npm global install (Node >= 22.19). Reinstalling on a new runner is one command per provider; nothing about the install itself needs copying.
- **Credential copy works, with one hole and one time bomb.**
  - Codex: copying `$CODEX_HOME/auth.json` is *explicitly documented and supported* by OpenAI.
  - pi: `~/.pi/agent/auth.json` is plain JSON (raw vendor OAuth tokens, mode 0600) on every OS - no keychain, no machine binding. Copy works mechanically; not documented as a workflow, but container-mounting the auth dir is.
  - Claude Code: Linux stores a copyable `.credentials.json`; **macOS stores the OAuth credential in the Keychain**, so a macOS source machine has no file to export. Login state also splits across `~/.claude.json` outside the config dir unless `CLAUDE_CONFIG_DIR` is set.
  - Time bomb: OAuth **refresh-token rotation**. Codex documents reuse detection outright ("one auth.json per runner... do not share across machines"); two live copies race, the loser gets logged out. Same rotation mechanic exists in pi's flows and presumably Anthropic's. Copying is a bootstrap trick, not a fleet model.
- **No machine binding found anywhere.** No provider documents device fingerprinting or token audience pinning; Codex source has none; vendors' own docs bless moving credentials into containers/remote hosts.
- **ToS: your own account on your own machines is fine for all three vendors.** What is prohibited is sharing credentials with *other people*, and (Anthropic-specific) third-party *products* offering claude.ai login to their users.
- **Every provider has a headless login flow**, so the recommended runner-join design is: install the CLI (one command), then drive a per-runner login (device-code or paste-a-code), rather than shipping credentials around:
  - Codex: `codex login --device-auth` (device code, beta, must be enabled in ChatGPT settings) or SSH port-forward of `localhost:1455`.
  - Claude Code: `/login`'s documented paste-a-code fallback over SSH, or a 1-year `claude setup-token` in `CLAUDE_CODE_OAUTH_TOKEN`.
  - pi: device-code for ChatGPT and Copilot; paste-the-redirect-URL for Anthropic.

## 1. Claude Code

Sources: [setup](https://code.claude.com/docs/en/setup), [claude-directory](https://code.claude.com/docs/en/claude-directory), [authentication](https://code.claude.com/docs/en/authentication), [env-vars](https://code.claude.com/docs/en/env-vars), [devcontainer](https://code.claude.com/docs/en/devcontainer), [headless](https://code.claude.com/docs/en/headless), [cli-reference](https://code.claude.com/docs/en/cli-reference).

### Install

- Native installer (`curl -fsSL https://claude.ai/install.sh | bash`): launcher symlink at `~/.local/bin/claude` into versioned binaries under `~/.local/share/claude/versions/`; auto-updates. Also brew cask, apt/dnf/apk repos, and npm (`@anthropic-ai/claude-code` - which installs the *same native binary*; the installed `claude` does not invoke Node). Self-contained; reinstalling on the target machine is the documented path.

### Where state lives

- Config dir: `~/.claude` (settings, skills, session transcripts under `projects/`, history). `CLAUDE_CONFIG_DIR` relocates *every* `~/.claude` path.
- **Gotcha: OAuth account state is not in the config dir by default.** `~/.claude.json` (a separate file) holds "your OAuth account, personal MCP servers, and per-project trust... so mounting a volume at `~/.claude` alone doesn't keep you signed in" ([devcontainer docs](https://code.claude.com/docs/en/devcontainer)). Setting `CLAUDE_CONFIG_DIR` moves `.claude.json` inside it too - so hydra should always run Claude Code with `CLAUDE_CONFIG_DIR` set, making the login state one relocatable directory.

### Credential storage per OS

Per the [authentication docs](https://code.claude.com/docs/en/authentication), "Credential management":

- macOS: encrypted **macOS Keychain** (item name undocumented; observed as "Claude Code-credentials" in user issue reports - unconfirmed by Anthropic).
- Linux: `~/.claude/.credentials.json`, mode 0600 (under `CLAUDE_CONFIG_DIR` if set).
- Windows: `%USERPROFILE%\.claude\.credentials.json`.
- Opt-out of keychain (v2.1.181+): `CLAUDE_CODE_CREDENTIAL_HELPER_DISABLE_KEYCHAIN=1` forces file storage even on macOS ([env-vars](https://code.claude.com/docs/en/env-vars)). Note: that page says newer versions may also use Windows Credential Manager / `pass` on Linux, and spells the file `credentials.json` where the auth page says `.credentials.json` - two official pages disagree on the exact filename.

### Is copying enough?

- **Linux -> Linux: yes in principle.** Copy `CLAUDE_CONFIG_DIR` (containing `.credentials.json` and `.claude.json`). This is exactly the devcontainer persistence pattern Anthropic documents (volume-mount the dir + set `CLAUDE_CONFIG_DIR`), though machine-to-machine copy is not spelled out as a workflow.
- **macOS as source: no file to copy.** The credential lives in the Keychain with no documented export path. Either set `CLAUDE_CODE_CREDENTIAL_HELPER_DISABLE_KEYCHAIN=1` *before* logging in (so the credential lands in the file), or use `setup-token` (below).
- **Machine binding: none documented, either way.** Strong indirect evidence against binding: Anthropic's own docs persist credentials across devcontainer rebuilds and carry auth across Codespaces via a `CLAUDE_CODE_OAUTH_TOKEN` secret. The interactive login credential expires and auto-refreshes; behavior of one credential refreshed from two machines concurrently is undocumented.

### Headless login (no browser on the runner)

1. **Paste-a-code fallback in the normal `/login` flow** - documented for SSH/WSL2/containers: press `c` to copy the login URL, open it in any browser, paste the code back at the "Paste code here if prompted" prompt ([authentication](https://code.claude.com/docs/en/authentication#log-in-to-claude-code)). No local browser or port-forward needed.
2. **`claude setup-token`**: runs that same flow, prints a **one-year OAuth token** (not saved anywhere); set it as `CLAUDE_CODE_OAUTH_TOKEN` on the runner. Requires a Pro/Max/Team/Enterprise subscription. Limitations: model requests only (no Remote Control sessions, no claude.ai connectors); bare mode ignores it.
3. API key (`ANTHROPIC_API_KEY` / `apiKeyHelper`) for API-billed runners.

There is no device-code flow.

### ToS

- [Consumer Terms](https://www.anthropic.com/legal/consumer-terms): no device-count restriction; prohibition is on *sharing* credentials with anyone else. Automation is prohibited "except... where we otherwise explicitly permit it" - Claude Code plus its documented CI/`setup-token` path is such an explicitly provided method (reading, not a quoted clause).
- Distinct rule ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)): third-party developers may not *offer claude.ai login* in their products without approval. For hydra this repeats the t3code conclusion: stay in the "user's own tool wrapping the vendor harness under the user's own login" posture; never extract or proxy subscription tokens on behalf of other users.

## 2. Codex CLI

Sources: [openai/codex README @ rust-v0.148.0](https://github.com/openai/codex/blob/rust-v0.148.0/README.md), [login crate source](https://github.com/openai/codex/tree/rust-v0.148.0/codex-rs/login/src), [auth docs](https://developers.openai.com/codex/auth), [CI/CD auth guide](https://learn.chatgpt.com/docs/auth/ci-cd-auth), [OpenAI ToS](https://openai.com/policies/row-terms-of-use/), [account sharing policy](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy).

### Install

- One static binary. `curl -fsSL https://chatgpt.com/codex/install.sh | sh` installs to `~/.local/bin/codex` (`CODEX_INSTALL_DIR` overridable); alternatives: npm `@openai/codex`, brew cask, or a single-file tarball from GitHub Releases (Linux builds are musl-static). Copying the binary between same-arch machines works; reinstalling is one command.

### Credentials

- `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`). Struct `AuthDotJson` in `codex-rs/login/src/auth/storage.rs`: `OPENAI_API_KEY` (API-key mode) or `tokens: TokenData` = `id_token` + `access_token` (JWTs), `refresh_token`, `account_id` (`codex-rs/login/src/token_data.rs`).
- **Default store is the file on all platforms.** `AuthCredentialsStoreMode { #[default] File, Keyring, Auto, Ephemeral }` (`codex-rs/config/src/types.rs`); keyring (service "Codex Auth"; macOS Keychain / Linux keyutils+Secret Service) is opt-in via `cli_auth_credentials_store`. So no macOS/Linux portability asymmetry unless the user opted in.

### Copying is explicitly supported

[Auth docs](https://developers.openai.com/codex/auth), "Login on headless devices" -> "Fallback: Authenticate locally and copy your auth cache": run `codex login` on a machine with a browser, then "Copy `~/.codex/auth.json` to `~/.codex/auth.json` on the headless machine" (SSH and `docker cp` examples given). Caveat quoted there: "Treat `~/.codex/auth.json` like a password: it contains access tokens."

### But: refresh-token rotation with reuse detection

- Codex refreshes tokens when `last_refresh` is older than ~8 days (`TOKEN_REFRESH_INTERVAL = 8` in `codex-rs/login/src/auth/manager.rs`) and writes the rotated tokens back to auth.json. The manager distinguishes `refresh_token_reused` ("your refresh token was already used. Please log out and sign in again") from expiry/invalidation.
- The [CI/CD auth guide](https://learn.chatgpt.com/docs/auth/ci-cd-auth) is blunt: "Use one `auth.json` per runner or per serialized workflow stream. Do not share the same file across concurrent jobs or multiple machines." Reseed triggers include "another machine or concurrent job rotated the token first."
- Translation: a copied auth.json boots a runner instantly, but two live copies independently rotate and the second refresher gets logged out. **One login per runner is the supported steady state.**

### Headless login

- **Device-code flow, from the CLI**: `codex login --device-auth` (beta; prints code + `https://auth.openai.com/codex/device`; must be enabled in ChatGPT security settings / workspace permissions; server can 404 it) - `codex-rs/cli/src/login.rs`, `codex-rs/login/src/device_code_auth.rs`. Also exposed via app-server RPC (`account/login/start {type:"chatgptDeviceCode"}`).
- **SSH port-forward**, documented: `ssh -L 1455:localhost:1455 user@remote`, then `codex login` in the SSH session (browser flow's callback is `localhost:1455`).
- No machine binding found in source (no device fingerprint in the login crate) or docs.

### ToS

- [Terms of Use](https://openai.com/policies/row-terms-of-use/): "You may not share your account credentials or make your account available to anyone else" - other people, not other devices. The [account sharing policy](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy): "You are welcome to use your OpenAI account on multiple devices." OpenAI's own CI/CD guide automates auth.json reuse (while noting API keys remain the recommended default for automation).

## 3. pi coding agent

Sources: repo `earendil-works/pi` @ main 2026-08-20 - `packages/coding-agent/src/config.ts`, `packages/coding-agent/src/core/auth-storage.ts`, `packages/ai/src/auth/types.ts`, `packages/ai/src/auth/oauth/{anthropic,openai-codex,github-copilot,device-code}.ts`, docs `packages/coding-agent/docs/{quickstart,providers,containerization,security,sdk}.md`; npm `@earendil-works/pi-coding-agent@0.84.2`.

### Install and state

- `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` (Node >= 22.19; no native modules, no keychain deps). All state under `~/.pi/agent/` (override: `PI_CODING_AGENT_DIR`): `auth.json`, `settings.json`, `models.json`, `sessions/`, extensions, etc. (`getAgentDir()` in `config.ts`).

### Credentials: one plain file, every OS

- `~/.pi/agent/auth.json` (`getAuthPath()`; SDK `authPath` overrides). `FileAuthStorageBackend` (`core/auth-storage.ts`): plain JSON, mode 0600, dir 0700, `proper-lockfile` for cross-process locking. **Zero keychain/keytar/libsecret code in the entire repo** - identical file mechanism on macOS, Linux, Windows, Termux.
- Contents: `Record<providerId, Credential>`; OAuth credentials store the **raw vendor tokens** - Anthropic `{refresh, access, expires}` from `platform.claude.com/v1/oauth/token`; OpenAI/ChatGPT `{access, refresh, expires, accountId}`; Copilot stores the long-lived GitHub token as `refresh` and mints short-lived Copilot tokens from it (`packages/ai/src/auth/oauth/*.ts`).

### Portability

- Mechanically fully portable: no machine ID, no encryption, path-based lookup. Copying `~/.pi/agent/auth.json` (or the whole dir) to a new machine yields a logged-in install. Not documented as a named workflow, but the docs treat the dir as mountable credential state: `containerization.md` mounts `~/.pi/agent` into Docker ("Mounting your host `~/.pi/agent` exposes host auth and session files to the container").
- Because the file holds the *vendors'* OAuth tokens, rotation/ToS behavior is inherited from Anthropic/OpenAI/GitHub - pi's refresh writes rotated tokens back under a file lock, so the same two-machines-race caveat applies as for Codex.

### Headless login

All flows work without a local browser:

- Anthropic: PKCE with localhost:53692 callback *raced against* a manual prompt - "If the browser is on another machine, paste the final redirect URL here" (accepts full URL, `code#state`, or bare code).
- OpenAI/ChatGPT: choice of browser PKCE (localhost:1455, also with manual-paste fallback) or a **device-code flow** (`auth.openai.com/codex/device`).
- GitHub Copilot: pure GitHub device-code flow, no local server at all.
- Callback bind host overridable via `PI_OAUTH_CALLBACK_HOST`; headless paste-flow explicitly documented in `providers.md`.

## 4. What this means for hydra's runner design

1. **Preinstall burden is one command per provider, not an image-management problem.** All three install with a single command and are self-contained. Runner-join can automate installs; only credentials need a human in the loop.
2. **Per-runner login, not credential copying, is the durable model.** Refresh-token rotation with reuse detection (documented for Codex, structurally identical in pi; undocumented for Claude Code) means shared credentials race and log each other out. Vendors also make per-runner login cheap: every provider has an SSH-friendly flow (device-code or paste-a-code). Runner-join should *drive* these flows - run the provider's login command on the runner, relay the URL/user-code to the user's browser wherever they are, and let the CLI store its own credential. This also keeps hydra in the t3code "auth by delegation" posture: hydra never holds or moves tokens.
3. **Credential copy is still a legitimate bootstrap shortcut** where the user wants it (Codex documents it; pi is trivially copyable), but hydra should treat a copied credential as belonging to exactly one runner from then on.
4. **Claude Code specifics**: always set `CLAUDE_CONFIG_DIR` per provider instance so `.claude.json` + (on Linux) `.credentials.json` form one relocatable directory. On macOS runners, either accept the Keychain (t3code caveat: do not override `HOME`) or set `CLAUDE_CODE_CREDENTIAL_HELPER_DISABLE_KEYCHAIN=1` before first login to keep credentials file-based like Linux. `claude setup-token` (1-year token in `CLAUDE_CODE_OAUTH_TOKEN`, no rotation to race) is the cleanest fit for fleet-style runners, at the cost of yearly renewal and model-requests-only scope.
5. **Codex specifics**: prefer `codex login --device-auth` in runner-join, but it is beta and gated behind a ChatGPT settings toggle - fall back to the documented `ssh -L 1455` port-forward or auth.json seeding. Keep `cli_auth_credentials_store` at its `file` default on runners.
6. **Capability probing (ticket #7) fits all three**: Claude Code via SDK init `AccountInfo`, Codex via `account/read` / `account/rateLimits/read` RPCs, pi via `checkAuth(providerId)`. A runner can honestly self-report per-provider auth state without touching credential files.
7. **ToS is not the obstacle.** All three vendors permit your own account on multiple machines you own; prohibitions target sharing with other people and (Anthropic) third-party products offering claude.ai login. Hydra as the user's own tool, driving vendor CLIs under the user's own logins, stays inside every posture found.

## Sources

- Claude Code docs: https://code.claude.com/docs/en/setup, /claude-directory, /authentication, /env-vars, /devcontainer, /headless, /cli-reference, /agent-sdk/overview
- Anthropic Consumer Terms: https://www.anthropic.com/legal/consumer-terms; Usage Policy: https://www.anthropic.com/legal/aup
- Codex: https://github.com/openai/codex @ rust-v0.148.0 (README, codex-rs/login/src, codex-rs/config/src/types.rs, codex-rs/cli/src/login.rs); https://developers.openai.com/codex/auth; https://learn.chatgpt.com/docs/auth/ci-cd-auth
- OpenAI Terms of Use: https://openai.com/policies/row-terms-of-use/; account sharing policy: https://help.openai.com/en/articles/10471989-openai-account-sharing-policy
- pi: https://github.com/earendil-works/pi @ main 2026-08-20 (paths cited inline); https://pi.dev; npm `@earendil-works/pi-coding-agent@0.84.2`
- Prior hydra research: research/t3code.md, research/claude-agent-sdk.md, research/codex-app-server.md, research/pi-sdk.md
