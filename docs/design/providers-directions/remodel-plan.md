# The provider remodel: decisions and ticket plan (draft, for review)

Status: agreed with Rogier in a grilling session on 2026-10-30, including the GPT-6.1 Sol
review's findings (Q61-Q69) and the ticket plan in section 3. Nothing here is normative yet: it becomes spec text, a
GLOSSARY change and an ADR in one PR, and only then build tickets. Q-numbers refer to the
grilling rounds.

Inputs: the prototype in this folder (variant I, `?variant=i`), `README.md` here, and three
research write-ups:

- `research/fleet-sign-in.md` on branch `research/fleet-sign-in`
- `research/model-catalogs.md` on branch `research/model-catalogs`
- `research/usage-sources.md`, uncommitted, in the worktree
  `/home/rogier/.local/share/hercule/runner/9f6dd658f457452b/cache/01a11895-1bb8-70f5-b877-330bc92fdd49.git/.claude/worktrees/agent-a07dbce30f4f05c4f`

## 1. Decisions

### 1.1 Names (Q2-Q5, Q16)

- **Harness**: the agent program (Claude Code, Codex, pi). Today's "Provider", renamed
  everywhere. The rename lands first, alone, with no behaviour change, so that afterwards
  "provider" has one meaning only.
- **Provider**: the company that serves models and bills for them (Anthropic, OpenAI,
  OpenRouter, Z.ai, OpenCode, MiniMax). A new plugin contribution.
- **Provider Account**: one account at one provider ("Anthropic · Work"). Replaces Provider
  Instance. Code always says `ProviderAccount` / `providerAccountId`: bare "account" stays
  reserved for a future Hercule user concept. The Providers page says "Account".
- **Model Profile**: a named model menu, picked from the accounts. May become a more general
  Profile later.
- **Harness Home**: the folder a harness runs in for one account on one runner.
- Harness and provider ids are qualified ids (ADR 0034, #176).
- (Q69) An account is a provider plus an optional label: "Anthropic", or "Anthropic · Work". The
  add sheet asks for a label only when an account at that provider already exists. Labels are
  unique per provider. The card shows who is signed in and the plan under the name.
- The desktop page stays "Providers", with two sections: Accounts and Models.

### 1.2 Scope (Q6-Q9, Q13, Q48)

- Account kinds in v1:
  - Anthropic: long-lived token (`claude setup-token`), per-machine sign-in, API key.
  - OpenAI: per-machine Codex login, API key.
  - OpenRouter: key. Z.ai: key. OpenCode: Go key, Zen key. MiniMax: pay-as-you-go key, plan key.
- The Claude long-lived token is supported, with our reading of Anthropic's terms written down
  (spec 13): Hercule hands the token to the unmodified Claude Code and never calls Anthropic with
  a subscription credential itself.
- (Q65) Hercule performs the token flow: it runs `claude setup-token` on a runner that has Claude
  Code, the way it runs `claude auth login` today (the CLI prints a URL and reads the pasted code on
  stdin), takes the token from the output, and stores it on the controller. Pasting an existing
  token is not offered. Its expiry is exactly one year from that moment. Ticket 2 first checks that
  `setup-token` runs without a terminal; if it needs one, the runner gives it a pseudo-terminal.
- Later, filed but not built now: Hercule-held ChatGPT sign-in (for Codex and pi), the OpenCode
  harness.
- Out: Bedrock, Vertex, Copilot, local models, custom base URLs, Claude Code against another
  vendor's Anthropic-compatible endpoint.
- Desktop: full redesign. Web: only what keeps it working on the new contract (composer,
  Settings › Threads), no Providers page. Android: no change (it has no model menu).

### 1.3 Model identity and the provider abstraction (Q10/Q17, Q11/Q18, Q33, Q49, Q50)

- A model is identified by (Provider Account, the provider's own model id). No identity across
  accounts: GLM 5.3 from Z.ai and from OpenRouter are two entries in two sections.
- Model lists never come from a harness choice. A harness translates (provider, model id) into
  its own arguments and environment. Example: GLM 5.3 from Z.ai in pi is
  `--model zai/glm-5.3` + `ZAI_API_KEY`; from OpenRouter it is `openrouter/z-ai/glm-5.3`.
  pi refuses model ids it does not know over RPC, so Hercule writes a pi `models.json` entry for
  those (OpenRouter), from the catalog's details.
- A **Provider** (plugin contribution) owns: its account kinds; reading an account's catalog
  with that account's credential; reading usage and expiry where it can; its rules on harnesses
  (a Claude subscription runs only in Claude Code); its default selection (1.9); the small model
  it suggests for Text Generation.
- A **Harness** owns which providers and account kinds it can run, the translation above, and
  which of a provider's models it can run (Claude Code: every Anthropic model; Codex: every model
  of an OpenAI account; pi: the models in pi's own list for that provider, plus any OpenRouter
  model through `models.json`).
- "Can run in" for an account = the provider allows it, the harness supports it, and the
  harness is installed on at least one runner. Harnesses that fail show struck through, with the
  reason. Per model, the same plus the harness's model rule.
- Sign-in methods are declared, never drawn per provider. Account kinds use the same setup steps
  as Connection types (`credentials`, `oauth`, `device`; `packages/plugin-host/src/connections.ts`),
  the same core OAuth2 client and the same secret handling, plus one step only providers use:
  `harness-login` (sign in on a runner through the harness, today's `provider.login`). A provider
  adding OAuth later changes no UI.
- A Provider Account is **not** a Connection: separate concepts and tables, shared setup
  machinery.

### 1.4 Catalogs (Q19, Q32, Q42, Q46, Q47)

| Provider | Catalog source |
|---|---|
| Anthropic (token, per-machine, key) | Claude Code's `supportedModels()` on a runner, with that account's credential (today's probe) |
| OpenAI (Codex login, key) | Codex's `model/list` on a runner (today's probe) |
| OpenRouter | `GET /api/v1/models/user` with the key, from the controller |
| Z.ai, OpenCode, MiniMax | pi's own model list for that provider, on a runner (today's pi probe, generalised) |

- No models.dev. If no runner can run the probe, the card says so ("Install Codex on a runner to
  list this account's models").
- The controller stores each account's catalog with the date each model was first seen.
  Refreshed every 4 hours and on "Refresh".
- (Review 6, Q66) An account's catalog is its latest successful read, from whichever runner made
  it. A failed read keeps the last good list, with its time and the error; it never removes models.
  Placement ignores models: a session on a runner whose harness does not know the model fails to
  start with the harness's own error (harness version warnings already exist). Rogier controls
  upgrades, so runner version skew is not designed for. t3 code, for comparison, reads the same
  live harness lists and adds a hand-curated manifest; it runs on one machine only.
- (Review 6) Model options (reasoning effort, thinking level) belong to the harness that runs the
  entry, not to the catalog: Codex's efforts for an entry in Codex, pi's levels for the same model
  in pi.
- The account read carries the model count. The browser shows the stored catalog with
  "Updated 3 hours ago · Refresh"; count and browser always agree.
- #908 (pi `--offline` hides newer models) matters, because pi's list is a catalog source.

### 1.5 Sessions, placement, homes, compatibility (Q20, Q21, Q34, Q45)

- A session stores `providerAccountId` + `harnessId` + the model, replacing `instanceId`.
- A runner can take a session when the harness is installed there and the account works there:
  key and token accounts work on every runner (the controller sends the secret at session start);
  a per-machine account works only where it is signed in.
- Runner checks split: harness installed and version, per runner; sign-in state, per account per
  runner.
- One Harness Home per account per harness per runner, derived as
  `providers/<accountId>/<harnessId>/`.
- Existing homes never move. Moving is unsafe: Codex stores absolute transcript paths in its
  SQLite state and never corrects them; on macOS Claude Code's Keychain login is named after a
  hash of the config folder's path. A migrated account carries a nullable `legacyHomeFolder`
  (its old instance id). **One function** resolves an account's home for a harness, and it is the
  only code that reads `legacyHomeFolder`.
- (Review 5) The runner cannot see `legacyHomeFolder`, so the controller resolves the home and
  sends it, as an opaque folder name, in every frame that runs a harness for an account: session
  start (also resume and fork), probe, sign-in, and Text Generation. The legacy folder is bound to
  the account's original harness: a second harness on a migrated account always gets a derived
  home, never the legacy one.
- Compatibility: one database migration that rewrites rows (with an upgrade-test fixture); a
  runner protocol bump (old runners are refused at hello, as before); public API fields change
  with no compatibility layer. Frozen run plans hold no instance ids.
- (Review 1, Q61) Not every client ships with the controller: the Android app is
  installed on its own, and its wire models require `instanceId` on sessions and assistants. It
  ignores unknown keys. Rule: before the contract drops a field, every independently installed
  client stops requiring it, in a release of its own.
- (Review 2) Secrets are encrypted with their owner kind, owner id and name as associated data
  (`apps/controller/src/secrets/repository.ts`). Re-owning a secret (`provider-instance` →
  `provider-account`) is therefore a decrypt and re-encrypt inside the migration, with the Master
  Key, in the migration's transaction. If any value fails to decrypt, the migration fails and the
  boot stops on the pre-migration backup.

### 1.6 What other records point at (Q22, Q23)

- Agents, assistants, the Text Generation setting and the thread default each name a Provider
  Account, a model and optionally a harness (absent = the account's default harness at start).
  Never a Model Profile. An Agent may use any model in its account's catalog.
- Text Generation "automatic": the first account, in the accounts' order, whose provider suggests
  a small model, run in that account's default harness.
  (Review 10, Q63) "Accounts' order" is the order they were added, and accounts that cannot
  run anywhere right now are skipped. No ordering UI. `controller.read` reports which account and
  model "automatic" resolves to.
- Deleting an account is refused while an Agent, an assistant, the Text Generation setting, the
  thread default, or a queued or running session uses it; the message lists them. Profiles do not
  block: the confirm dialog names the profiles it leaves. Past threads keep the id; continuing one
  says the account was deleted.

### 1.7 Threads and the composer (Q24-Q26, Q35-Q37)

- A thread's account and harness are fixed when it starts. In a running thread the menu shows
  only entries with that account and harness, as one flat list, with "Other models start a new
  thread." Switching account inside a session would be a declared harness capability (like
  `modelSwitch`), never probed; no harness has it in v1.
- A project may name one Model Profile. **This contradicts GLOSSARY's Project** ("no behaviour,
  no defaults"); Rogier decided the exception and GLOSSARY is amended. A new thread in that project
  opens the menu on that profile and starts on the user's most recent entry in it, else the
  profile's default entry. Only the start: changing the project's profile later does not touch
  existing threads. Outside a project, or in a project without a profile: the thread default
  (Settings › Threads). Agents keep their own entry. Set on the project (new-project dialog, and
  where a project is edited); the Providers page does not mention projects.
- The composer menu is an accordion: one profile open at a time. The open profile shows up to
  three entries from it that the user picked most recently ("Recent within profile", kept by the
  client, per device). "Older" is dropped.
- An entry that cannot run now is shown greyed with the reason, never hidden; a per-machine login
  also gets the sign-in button.

### 1.8 Harness choice, three levels (Q12)

1. The account's default harness, in the account sheet: the vendor's own harness, else pi.
2. Per profile, per account: a pill, "Same as the account" until changed.
3. Per model, a ⋯ menu: move the model to another harness, or also offer it in a second one
   (an entry `gpt-6-1-sol@pi`).

Installing harnesses belongs to the Machines page.

### 1.9 Default selection and new models (Q29, Q40, Q41/Q46, Q53)

- When an account joins a profile (first run, "Add an account to <profile>", "Use in …" on a
  card) it brings its provider's default selection:
  - Anthropic, OpenAI: what Claude Code and Codex show in their own pickers, without legacy models;
  - Z.ai, OpenCode, MiniMax: pi's current models for that provider;
  - OpenRouter: nothing ("Browse models").
- The profile's default entry is the provider's own default model.
- First run is just "Add an account"; the first profile is "Main".
- (Review 10, Q63) Deleting a profile that projects use: the confirm names the projects,
  and they fall back to the thread default. Taking out the default entry makes the first remaining
  entry the default. A profile may be empty (the teaching state). A default entry that cannot run
  is still where a new thread starts, greyed with the reason; nothing picks another silently.
- Profile lists never change by themselves. A model that newly joins a provider's default
  selection (checked every 4 hours, when catalogs refresh) is announced at the top of that
  account's section, in the composer and on the Providers page: "New · Opus 5.6 · released 26 Oct
  [Add] [Not now]", per profile. OpenRouter never announces (its default selection is empty).

### 1.10 Usage and expiry (Q14, Q27, Q28, Q38, Q39, Q51, Q52)

- One controller domain owns usage: per Provider Account, the latest windows or credit, each with
  the time it was read and its reset time. Every place that shows usage reads it there. Per-session
  token counts stay with sessions.
- Sources:
  - Claude per-machine sign-in: the Agent SDK usage read on a runner (needs no turn, as t3 code
    does) and `rate_limit_event`s from sessions.
  - Claude long-lived token: `rate_limit_event`s from sessions only (the token lacks
    `user:profile`). Research inside the usage ticket whether any terms-compatible way exists.
  - Codex ChatGPT sign-in: `account/rateLimits/read` and `account/rateLimits/updated`.
  - Keys: OpenRouter `GET /api/v1/key`; OpenCode Go `/zen/go/v1/usage`; Z.ai quota endpoint;
    MiniMax plan `token_plan/remains`. Anthropic and OpenAI keys, OpenCode Zen: nothing.
- Subscription usage is only read through the vendor's harness, never by calling the vendor with
  a subscription credential.
- An active read at most every 15 minutes per account, skipped when a session reported within
  that window.
- No gauge where nothing is reported; never an estimate.
- (Review 11, Q64) One account is one vendor identity. At each per-machine sign-in the
  harness reports who signed in (Claude Code's and Codex's account reads give the email and
  plan). The first sign-in sets the account's identity; a sign-in as someone else on another
  machine is refused, saying who the account belongs to. Usage records keep the time of the
  reading, and an older reading never replaces a newer one.
- Expiry: Claude token = the moment Hercule ran the token flow + 1 year (Q65);
  OpenRouter `expires_at`; per-machine logins show as failed once a session cannot sign in. A
  rejected credential (401) is "failed"; a network error is not. Replacing a credential resets its
  warnings. Warnings on the card and the composer entry
  from 30 days out; one notification at 14 days; one when an account fails.
- #625 (wait for a rate limit to reset) stays its own ticket and reads from the usage domain.

### 1.11 Contract and CLI (Q44)

| Group | CLI | Operations |
|---|---|---|
| `harness` | `hercule harness` | list, read |
| `provider` | `hercule provider` | list, read |
| `providerAccount` | `hercule provider-account` | list, read, readCatalog (`read-catalog`), create, update, delete, signIn, submitSignInCode, refresh |
| `modelProfile` | `hercule model-profile` | list, read, create, update, delete |

- (Review 7) Sign-in keeps today's two steps: `signIn` starts it on a runner (URL, and for a
  device login the code and its expiry); `submitSignInCode` sends the code the browser returned to
  the waiting CLI. A runner going offline ends the attempt with a message. Replacing a key or token
  affects sessions started afterwards; running sessions keep what they started with.
- `modelProfile.update` replaces the whole profile (accounts in order, per-account harness,
  entries in order, default entry). (Review 9, Q67) It carries the revision it was read
  at; a stale revision is refused with a conflict, and the client reads the profile again and
  re-applies the user's one change. The default entry must be one of the entries, and an entry
  (account, model, harness) appears at most once; both are checked in the same transaction.
- (Review 8) The spec names, for every new operation: its grant (and how existing Permission
  Profiles and escalations naming `provider.*` grants migrate), its audit kind, and the live topic
  that tells clients to read again. Live updates reach every surface that shows an account without
  Settings being open: a sign-in, a failed account or a runner going offline changes the composer's
  greyed entries and the Text Generation status. `--instance` flags become `--account` (plus
  `--harness` where it applies); skill text, orientation text and help examples that name
  `hercule provider` or `--instance` change in the same ticket as the command.
- `modelProfile.list` returns each entry with its name and whether it can run now, so the
  composer never reads a catalog. Only the picker and the browser call `readCatalog`.
- `providerAccount.list` includes each account's usage.
- `hercule provider` changes meaning; the old commands are not kept.

### 1.12 Migration (Q43)

- Facts: Claude Code and Codex instances have no secret fields (all are per-machine sign-ins);
  pi's has `zaiApiKey`.
- (Q62) The migration produces exactly what adding the account fresh would produce. Each instance
  becomes one Provider Account (same id, never one per runner): Claude Code → Anthropic,
  per-machine; Codex → OpenAI, per-machine; pi → Z.ai key, its secret re-encrypted under the field
  name a fresh Z.ai account uses.
- Names follow Q69: an instance still named after its harness ("Claude Code", "Codex", "pi") was
  created by the controller and gets no label; a name the user typed becomes the label, as typed.
  Rogier's five become Anthropic, Anthropic · work, OpenAI, OpenAI · work, Z.ai.
- Identity comes from the runners' current sign-in reports (checks already carry identity and plan).
  If runners disagree, the account starts with no identity and the next sign-in sets it.
- The instance's harness becomes the account's default harness; its folder is its
  `legacyHomeFolder`.
- Sessions, Agents, assistants, settings: `instanceId` → `providerAccountId` + `harnessId`.
- One Model Profile "Main" with every migrated account and its default selection. (Review 13:
  created by the migration of the ticket that adds Model Profiles, not by the accounts migration.)
- (Review 4, Q62) Every instance becomes an account; none is dropped. The controller cannot
  prove an instance unused: snapshots keep only the latest sign-in report, and an offline runner may
  hold a login. An account you don't want is one delete away. The controller stops creating
  instances at boot.
- `session.spec` JSON is rewritten too, not only columns.
- (Review 3) Upgrade-test fixture: one instance of each kind with a real encrypted Z.ai key; a
  session, an exited session with a native id, an Agent, an assistant with a conversation, an
  explicit Text Generation selection, the thread default. It checks that they read as accounts,
  that the Z.ai key reaches a runner decrypted, and that the exited session resumes in its original
  home with its native id.

### 1.13 Desktop surfaces (Q30, Q31, Q54)

- Machines keeps harness install and version per runner. Signing in on a machine moves to the
  account sheet; keys move to the account.
- The model browser (catalogs over 40 models) loads nothing until opened, then reads the account's
  stored catalog once and filters in the renderer; dropped when it closes. No idle work. Budgets in
  spec 17 §Performance.

## 2. Docs, old tickets, open issues (Q55-Q57, Q59, Q60)

- One PR on a `spec/` branch: a new ADR "Harnesses and provider accounts are separate" (amends
  ADRs 0007, 0015, 0028, 0030, 0034, 0044); GLOSSARY (Harness, Provider, Provider Account, Model
  Profile, Harness Home; Provider Instance retired; the Project exception); specs 06 (rewritten),
  03, 11, 13, 14, 17. Research write-ups pushed on `research/` branches; the prototype pushed as
  `prototype/desktop-settings-providers`. No new design book edition.
- #404, #405 closed with decision comments when the spec PR opens; #406 closed by it; #401 updated
  and closed once the build tickets exist. Nothing is copied from their text.
- Open issues: #586, #585 built by the account-kinds ticket; #219, #218, #140, #148 closed now
  (replaced or works as designed); #174 closed by the accounts ticket; #176 in the rename and the
  accounts ticket; #163, #591, #589, #209, #470 folded into the accounts ticket; #908 should land
  before pi-sourced catalogs matter; #625, #622, #684, #444 stay open.
- Build tickets are created after the spec PR merges and the ticket list is agreed, labelled
  `ready-for-agent`; the two later slices `needs-triage`.
- A separate `needs-triage` issue: a key passed to a harness can be printed into a stored
  transcript; mask known secret values before storing.

## 3. Ticket plan (third draft, after the review)

Rule (Rogier): fewer tickets, and every ticket delivers something visible and testable in the UI,
starting from the UI. Only ticket 0 has nothing to show. After every merge the product keeps
working: threads start, agents and assistants run, Android reads sessions.

| # | Ticket | What you can see when it merges | Needs |
|---|---|---|---|
| 0 | **Rename Provider → Harness**, with qualified harness ids; the Android app stops requiring `instanceId` | Nothing; a refactor and a small Android release | - |
| 1 | **Your accounts on the Providers page** | Settings › Providers lists your migrated accounts as cards. The account sheet signs in on a machine (start, paste the code), renames, and deletes (with the refusal rules). Machines loses its sign-in rows | 0, with the Android build from 0 installed |
| 2 | **Add an account** | The add-account sheet. New: Anthropic key, Claude long-lived token (Hercule runs the flow), OpenAI key (Codex or pi). The default-harness choice, with reasons. One vendor identity per account. First run becomes "Add an account". A key account runs on any runner | 1 |
| 3 | **A curated model menu** | Settings › Providers › Models with one profile, "Main": a section per account, the picker, reorder, make default, take out, Refresh. The composer (desktop and web) shows exactly that menu: Recent within profile, greyed entries with reasons. New accounts bring their default selection | 2, #908 |
| 4 | **Several profiles** | Profile tabs, the new-profile dialog (name; empty or a copy), rename, duplicate, delete, the empty state, "Use in …", the composer's accordion, a project's profile and how a new thread starts | 3 |
| 5 | **Harness choice per profile and per model** | The pill per account in a profile, the model ⋯ menu (Runs in, Also offer in), "in pi" tags, per-model reasons | 3 |
| 6 | **New models** | The 4-hourly check, and "New · … [Add] [Not now]" in the composer and on the Providers page | 3 |
| 7 | **Usage and expiry** | Gauges on account cards (Claude, Codex, Z.ai), expiry warnings, the notifications, the failed state. Starts with the Claude-token research | 2 |
| 8 | **OpenRouter and the model browser** | Add OpenRouter; browse its catalog (filters, sort, tray); credit and expiry on its card; any OpenRouter model runs in pi | 3, 7 |
| 9 | **OpenCode and MiniMax** | Add OpenCode Go/Zen and MiniMax (both kinds), run them in pi, with their usage where reported | 3, 7 |

What lies under each (the spec gives each its exact list):

- **0**: the pure rename (code, contract, CLI, protocol, docs); `instanceId` becomes optional in
  Android's `Session` and `Assistant` wire models, so the app works before and after ticket 1.
- **1**: the Provider contribution with today's three kinds only (Anthropic per-machine, OpenAI
  per-machine, Z.ai key); the Provider Account model and the migration (every instance kept,
  references and `session.spec` JSON rewritten, secrets re-encrypted, `legacyHomeFolder`); the
  controller sending the home folder in every frame (start, resume, fork, probe, sign-in, Text
  Generation); the protocol bump; the `harness`, `provider` and `provider-account` contract and CLI
  rows with grants, audit kinds and the live topic; `--account` flags and the skill and help text;
  `signIn` and `submitSignInCode`; the deletion rules (#163, #591). Runner checks and catalogs keep
  today's shape (per account per runner), and Text Generation "automatic" keeps today's rule. The
  composer keeps its shape, listing accounts. The upgrade-test fixture of section 1.12.
- **2**: the shared setup-step rendering and the `harness-login` step; the runner checks split per
  harness and per account (absorbs #209, #470, #589); derived Harness Homes; pi's translation for
  Anthropic and OpenAI keys; the identity check; Text Generation "automatic" on accounts. Closes
  #585, #586.
- **3**: catalogs stored per account (union of the latest probes, last good list kept, options per
  harness, first-seen dates, refresh every 4 hours, the count); the Model Profile model and the
  `model-profile` contract with revisions; the migration that creates "Main"; Settings › Threads on
  the web.
- **7**: the usage domain, its sources for the providers that exist by then, the 15-minute rule,
  expiry and warnings. Tickets 8 and 9 add their providers' usage reads to it.
- Every desktop ticket states its ADR 0037 cost before it is built.

Later, `needs-triage`: Hercule-held ChatGPT sign-in for Codex and pi; the OpenCode harness.

## 4. Names sheet (every spec section uses these spellings)

Amendment marker for every spec change: `*(Amended 2026-10-30, [#406](https://github.com/theagenticage/hercule/issues/406).)*`,
with replaced text struck through (`~~old~~`) where a sentence changes. The new ADR is
[ADR 0048](../../adr/0048-harnesses-and-provider-accounts-are-separate.md),
`docs/adr/0048-harnesses-and-provider-accounts-are-separate.md`. Specs describe the end state;
the build order lives in the tickets. Spec text and code written before ADR 0048 say "provider"
for the harness until ticket 0 renames them; new text uses the new words only.

**Terms (GLOSSARY):** Harness, Harness Definition (was Provider Definition), Harness Adapter (was
provider adapter), Provider, Account Kind, Provider Account, Harness Home, Capability Snapshot
(re-scoped: what one runner found out about one Provider Account in one harness: signed in or not,
as whom, and the models it lists), Model Catalog, Default Selection, Model Profile, Account Usage.
Provider Instance is retired. Project gains its one exception.

**Plugins:** each provider is its own small plugin (`plugins/anthropic`, `plugins/openai`,
`plugins/zai`, `plugins/openrouter`, `plugins/opencode`, `plugins/minimax`) contributing one
`ProviderDefinition`. Harness plugins (`plugins/claude-code`, `plugins/codex`, `plugins/pi`)
contribute one `HarnessDefinition` each, which declares the providers and account kinds it runs and
how (environment, model argument; pi also `models.json`). Ids are qualified (ADR 0034):
`<pluginId>/<word>`, e.g. `anthropic/anthropic`, `pi/pi`.

**Plugin host:** `HarnessDefinition`, `HarnessAdapter`, `ProviderDefinition`,
`AccountKind { id, title, description, setup: SetupStep[], harnesses }` (harnesses the provider
allows this kind in), `SetupStep` gains `{ kind: "harness-login" }` beside `credentials`, `oauth`,
`device`, `checklist`. Account kind ids: Anthropic `api-key`, `subscription-token` (Hercule runs
`claude setup-token`), `subscription-per-machine`; OpenAI `api-key`, `subscription-per-machine`;
Z.ai, OpenRouter `api-key`; OpenCode `go-key`, `zen-key`; MiniMax `pay-as-you-go-key`, `plan-key`.

**Contract types and fields:** `Harness`, `Provider`, `AccountKind`, `ProviderAccount`
(`id`, `providerId`, `kind`, `label: string | null`, `identity`, `planLabel`, `defaultHarnessId`,
`status`, `modelCount`, `catalogReadAt`, `catalogError`, `usage`, `expiresAt`, `createdAt`,
`updatedAt`), `ModelCatalog` (items are the existing `ModelDescriptor`, plus `firstSeenAt`),
`AccountUsage`, `ModelProfile` (`id`, `name`, `revision`, `accounts: ModelProfileAccount[]`,
`defaultEntry: ModelProfileEntry | null`, `dismissedNewModels`), `ModelProfileAccount`
(`providerAccountId`, `harnessId: string | null` = same as the account, `entries`),
`ModelProfileEntry` (`providerAccountId`, `model`, `harnessId: string | null` = same as above).
Everywhere `instanceId` was: `providerAccountId` + `harnessId` (optional where "the account's
default harness" is meant). Settings: `thread.providerAccountId`, `thread.harnessId`,
`thread.model`; `textGeneration.model` is `"automatic" | "off" | { providerAccountId, harnessId?, model }`.
Project gains `modelProfileId: Id | null`.

**Operations** (grant family `infra`, as `provider.*` today: reads `infra.read`, writes
`infra.write`; no Permission Profile changes):

| Group | Operations | HTTP |
|---|---|---|
| `harness` | `list`, `read` | `/harnesses[/{id}]` |
| `provider` | `list`, `read` | `/providers[/{id}]` |
| `providerAccount` | `list`, `read`, `readCatalog`, `create`, `update`, `delete`, `signIn`, `submitSignInCode`, `refresh` | `/provider-accounts[/{id}]`, `/{id}/catalog`, `/{id}/sign-in`, `/{id}/sign-in-code`, `/{id}/refresh` |
| `modelProfile` | `list`, `read`, `create`, `update`, `delete` | `/model-profiles[/{id}]` |

CLI: `hercule harness …`, `hercule provider …`, `hercule provider-account list|read|read-catalog|create|update|delete|sign-in|submit-sign-in-code|refresh`,
`hercule model-profile …`. Flags `--account` and `--harness` replace `--instance`.
Audit kinds: `providerAccount.created|updated|deleted|signedIn`, `modelProfile.created|updated|deleted`.
Live topic: `provider`, one topic for harnesses, providers, accounts, catalogs, usage and profiles.

**Secrets:** owner kind `provider-account`; secret names `apiKey`, `token`.

**Database:** `provider_accounts` (with `legacy_home_folder`), `model_profiles` (`revision`, body
as JSON), `model_catalogs` (per account: models with first-seen dates, `read_at`, `error`),
`account_usage`, `capability_snapshots` keyed by (provider account, harness, runner).

**Runner protocol:** every frame that runs a harness for an account (session start, resume, fork,
probe, sign-in, Text Generation) carries `providerAccountId`, `harnessId`, `harnessHome` (the
folder name under the runner's `providers/` folder, resolved by the controller) and the secrets.
