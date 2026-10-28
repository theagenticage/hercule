# Research: sign in once, use it on every runner

The question: can a Hercule user sign in once per subscription account and use that sign-in on every runner, instead of once per account per runner? And what does each kind of credential mean for expiry, renewal and failure?

Researched 2026-10-28 against primary sources: vendor docs and terms, vendor source at pinned commits, the Claude Code binary's strings, live public API responses. Builds on `research/provider-portability.md` (branch `research/provider-portability`, 2026-08-20) and `research/desktop-settings-providers.md` (branch `research/desktop-settings-providers`, 2026-10-04), and corrects them where they are now wrong (see Conflicts and gaps). Facts only; the last section lists options, not decisions.

Conventions:

- Every source was retrieved 2026-10-28 unless another date is given. "No date on page" means the page shows none; code.claude.com, developers.openai.com/siwc, learn.chatgpt.com, docs.z.ai and opencode.ai pages show none unless noted.
- "Secondary" marks a fact relayed by someone other than the vendor. A user's issue in a vendor's repository is secondary.
- "Binary" marks a string read out of the Claude Code 2.1.312 binary without running it.
- "Inference" marks a conclusion of this note that no source states.
- Quotes that contained an em dash show it as " - " with the mark [dash].

Hercule today, for orientation: spec 06 §11, spec 15 §12 and spec 13 §8 make login per runner and say "Hercule never holds, extracts, proxies, or distributes provider (Claude Code, Codex, pi) login tokens". API keys are already different: they are Secret Fields of a Provider Instance, which the controller decrypts and sends inline with each probe or session request, never written to runner disk (spec 06 §2.1, spec 13). Spec 06 Post-v1 lists "`claude setup-token` (one year, no rotation to race) as the Claude path, and Hercule shuffling tokens so a new runner needs no login at all" as strongly wanted.

## Versions read

| Thing | Version or commit |
|---|---|
| Claude Code | npm `@anthropic-ai/claude-code` 2.1.312 (2026-10-27). Binary `@anthropic-ai/claude-code-linux-x64@2.1.312` (embedded build time 2026-10-27T16:53:02Z), strings read, never run. CHANGELOG at `anthropics/claude-code` [`0e1f478`](https://github.com/anthropics/claude-code/blob/0e1f4789406477380b267a01f3ddd50b0211e5b3/CHANGELOG.md) (top entry 2.1.312). Docs at code.claude.com |
| Claude Agent SDK | npm `@anthropic-ai/claude-agent-sdk@0.3.312` (`sdk.d.ts`, `sdk.mjs`) |
| Codex | latest stable release `rust-v0.165.0` (2026-10-27) = [`360319d`](https://github.com/openai/codex/tree/360319d8dee62d87e2d59fc0c21805d79519cfed). `rust-v0.148.0` = `3ba0f71` for one comparison. Docs at learn.chatgpt.com |
| Sign in with ChatGPT (SIWC) | the 13 pages under developers.openai.com/siwc, read through their export [`llms-full.txt`](https://developers.openai.com/siwc/llms-full.txt) and checked live per page |
| pi | `earendil-works/pi` v1.4.0 (2026-10-21, latest release) = [`4a08025`](https://github.com/earendil-works/pi/tree/4a080252f06caf63a525d7873c5d94d3c23887e0). npm `@earendil-works/pi-ai@1.4.0` for the generated model catalog |
| opencode | `anomalyco/opencode` v1.19.4 (2026-10-22, the release GitHub marks "latest") = [`148842e`](https://github.com/anomalyco/opencode/tree/148842ef7cb1bc34192b3fff57d0f9721ab9c801). v2.2.0 (2026-10-27, not a prerelease, not marked latest) = [`1097e26`](https://github.com/anomalyco/opencode/tree/1097e2668b1e08ad63bdf0b1c4860b9bc01e420c), for its SIWC plugin only. npm `opencode-linux-x64@1.19.4` for its built-in catalog |
| Catalogs | [models.dev](https://models.dev/api.json) and OpenRouter [`/api/v1/models`](https://openrouter.ai/api/v1/models), live 2026-10-28 |
| Terms | Anthropic Consumer Terms (effective Oct 8 2025); OpenAI Terms of Use (effective Jan 1 2026, Wayback 2026-10-27); OpenRouter Terms (last updated Aug 31 2026); opencode Terms of Service (effective Aug 15 2026); Z.ai usage policy and subscription terms (no date on page) |

## TL;DR

- **Static credentials can be entered once and used on every runner at once. Rotating ones cannot, unless one place does all the refreshing.**
  - Static: a Claude `setup-token`, API keys (OpenRouter, Z.ai, opencode Console and Go), and ChatGPT Business or Enterprise Codex access tokens. None has a refresh token, so many runners can send the same value at the same time. The controller could hold such a credential as a Secret and send it inline, as it does for API keys today.
  - Rotating: Claude `/login` and the classic Codex `auth.json`. Their refresh tokens rotate, and reusing an old one kills the login. Anthropic now documents this: two sessions renewing "with the same token ... revoked the saved login". OpenAI documents "Use one `auth.json` per runner".
  - SIWC is built for a host that refreshes. Access tokens last 1 hour; refresh tokens last 30 days and are replaced on every refresh. The docs say to "serialize refreshes for the same session". A controller that refreshes centrally and sends only access tokens to runners keeps that rule. The docs do not describe this shape and do not forbid it.
- **Claude `setup-token`**:
  - It lasts one year, fixed in 2.1.312, and carries only `user:inference`. It has no refresh token, and nothing reports its expiry, so Hercule would have to record the date it was minted.
  - Two things revoke it: the trash icon in claude.ai Settings > Claude Code, and "Log Out" of all devices.
  - Once it has expired or been revoked, every request fails with `authentication_failed`. Claude Code keeps sending the same token, so sessions must restart with a new one. Several tokens can be live at once.
  - It loses plan-window reporting (`rate_limits_available: false`), Remote Control and claude.ai connectors.
- **For Claude, the open question is policy, not mechanics.** Anthropic's Legal and compliance page says "developers may not collect, store, or intermediate Claude.ai credentials or session tokens". The same page exempts "an end user ... signing in to the unmodified Claude Code binary with their own Claude subscription". Anthropic's own docs tell users to keep a setup-token as a Codespaces secret. Section 1.9 lists the readings.
- **A ChatGPT plan through SIWC, per harness**:
  - Codex app-server takes the access token through `env_key="ACCESS_TOKEN"`. The docs say to restart it with a new token and `thread/resume` when the hour runs out. Codex also has a provider auth command, `[model_providers.<id>.auth]`, which reruns every 5 minutes by default and could fetch a fresh token. That use is not documented for SIWC and was not tested.
  - pi takes the token as `OPENAI_API_KEY` on provider `openai`: a key that does not start with `sk-` is treated as a SIWC token. pi keeps it for the life of the process.
  - opencode gained SIWC in v2.2.0 (2026-10-27). v1.19.4 has only the Codex-client login.
- **Two refresh callbacks exist but are not for Hercule today.**
  - Codex app-server's `chatgptAuthTokens` login comes with a server-to-client `account/chatgptAuthTokens/refresh` request (10-second timeout). It is marked "FOR OPENAI INTERNAL USE ONLY - DO NOT USE".
  - The Claude Agent SDK 0.3.312 runtime accepts an undocumented `getOAuthToken` option, which answers the CLI's `oauth_token_refresh` request. It is not in the SDK's types. Anthropic documents the behaviour only for its desktop app and IDE hosts.
- **API keys are all static.**
  - OpenRouter keys can carry an `expires_at` set at creation, which `GET /api/v1/key` reports. Keys made during onboarding expire after 180 days.
  - opencode Console keys expire never, or after 1 to 365 days.
  - Z.ai documents no expiry, and since 2026-10-16 a Coding Plan key is a separate kind of key.
  - The limits are in the terms: Z.ai is for "the individual natural person"; opencode bans processes that run "while you are not logged into the Services"; Go workspaces have one member.

## 1. Claude `setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`)

### 1.1 Lifetime and scope

- One year. "generate a one-year OAuth token with `claude setup-token`". "It does not save the token anywhere; copy it and set it as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable wherever you want to authenticate" ([Authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)).
- The binary fixes the length. Binary: `LONG_LIVED_OAUTH_TOKEN_TTL_SECONDS` is 31536000 and `SETUP_TOKEN_DEFAULT_EXPIRY_DAYS` is 365. The setup-token handler accepts an `expiresInDays` value but never uses it, so 2.1.312 cannot mint any other length.
  - The setup screen reads "This will guide you through long-lived (1-year) auth token setup for your Claude account. Claude subscription required."
  - The success screen prints "Your OAuth token (valid for ...)" with the lifetime the server returned, and "Store this token securely. You won't be able to see it again."
- No CHANGELOG entry changes the lifetime. The only setup-token entries are 2.1.234 (rejects extra arguments, [L4080](https://github.com/anthropics/claude-code/blob/0e1f4789406477380b267a01f3ddd50b0211e5b3/CHANGELOG.md#L4080)) and 2.1.212 (`forceLoginMethod` enforced, [L4609](https://github.com/anthropics/claude-code/blob/0e1f4789406477380b267a01f3ddd50b0211e5b3/CHANGELOG.md#L4609)).
- Scope `user:inference` only. "A `claude setup-token` token passed as `CLAUDE_CODE_OAUTH_TOKEN` doesn't qualify by default, because it carries only the `user:inference` scope" ([Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript), on the `usage_report` field). Binary: "env-var and setup-token sessions default to user:inference only".
- What it can do: "This token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan. It can only make model requests, so it can't establish Remote Control sessions or fetch claude.ai connectors. MCP servers you configure locally still work." "Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`." ([Authentication](https://code.claude.com/docs/en/authentication))
- It is minted through the same browser flow as `/login`: "The command opens the same browser authorization flow as `/login`, and the token prints to the terminal after you approve access in the browser" (same page). Binary: token endpoint `https://platform.claude.com/v1/oauth/token`, authorize URL `https://claude.com/cai/oauth/authorize`.

### 1.2 Static, so it can run on many machines at once

- No refresh token. [Environment variables](https://code.claude.com/docs/en/env-vars), `CLAUDE_CODE_OAUTH_TOKEN`: "Unless you run `/login`, Claude Code uses the token you set for the whole session. To replace an expired token, generate a new one and restart". Binary: the credential built from the variable has `refreshToken:null,expiresAt:null`, and the error text says it "has no refresh token - [dash] it cannot self-heal and has likely expired or been revoked."
- Anthropic documents one token in several environments:
  - "To carry authentication across codespaces, store ... a `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` as a Codespaces secret" ([Development containers](https://code.claude.com/docs/en/devcontainer)).
  - [GitHub Actions](https://code.claude.com/docs/en/github-actions): "an OAuth token is tied to the subscription of the person who ran `claude setup-token`"; for "a secret shared across repositories" it recommends a Console API key.
- No concurrency limit is documented. Usage limits are per account: "These limits are shared across Claude and Claude Code" ([support 11145838](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan), modified 2026-10-27).
- Inference: nothing binds the token to a machine, so every runner can use one token at the same time, all drawing on one account's 5-hour and weekly limits.

### 1.3 Revoking it

- One token: "If they aren't listed there, manage your authorization tokens in Settings > Claude Code. To remove a token and log out of Claude Code, click the trash can icon." ([support 10310342](https://support.claude.com/en/articles/10310342-how-do-i-log-out-of-all-active-sessions), modified 2026-10-24). Secondary: users name the page `claude.ai/settings/claude-code` ([#34198](https://github.com/anthropics/claude-code/issues/34198), 2026-03-13; [#59378](https://github.com/anthropics/claude-code/issues/59378), 2026-05-15).
- Everything at once: Settings > Account > "Log Out" "will immediately sign you out of your account across all devices ... including: ... Claude Code, including tokens created with setup-token for continuous integration (CI)" (same article). The live article also contains an editing leftover, "[placeholder: public names for what the thread calls ...]".
- No CLI command or API lists or revokes tokens. Feature requests for one ([#48373](https://github.com/anthropics/claude-code/issues/48373), [#57400](https://github.com/anthropics/claude-code/issues/57400)) were closed (secondary).
- Deleting the place a token is stored does not revoke it: "If you delete a secret, the credential it held stays valid" ([GitHub Actions](https://code.claude.com/docs/en/github-actions)).

### 1.4 Learning when it expires

- `claude auth status` reports no expiry. "`authMethod` field is one of `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, or `third_party`" ([CLI reference](https://code.claude.com/docs/en/cli-reference)). Binary: its JSON fields are `loggedIn`, `authMethod`, `apiProvider`, `analyticsDisabled`, `projectsDirectory`, `configDirectory`, sometimes `forcedLoginMethod`, `allowedProviders`, `apiKeySource`, and for `claude.ai` only `email`, `orgId`, `orgName`, `subscriptionType`. Inference from the binary: `loggedIn` is computed from what is present locally, not checked with the server.
- The Agent SDK has no expiry field. `AccountInfo` is `{ email?, organization?, subscriptionType?, tokenSource?, apiKeySource?, apiProvider? }` (`sdk.d.ts` L23-L33 in [0.3.312](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.312)).
- Plan windows are lost. The SDK's usage call returns `rate_limits_available: false` when the token lacks `user:profile` (`sdk.d.ts` L4419), and a setup-token lacks it (1.1).
- Token format: the binary recognises these tokens by the prefix `sk-ant-oat`; pi's docs show the placeholder `sk-ant-oat01-{rand}` ([containerization.md](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/containerization.md#L88-L101)). Whether the string encodes its expiry was not found.
- The lifetime is shown once, at mint time (1.1). Inference: a program that wants to warn before expiry must record the mint date itself.

### 1.5 What happens when it expires or is revoked

- [Errors](https://code.claude.com/docs/en/errors#oauth-token-revoked-or-expired), "OAuth token revoked or expired":
  - Interactive: "OAuth token revoked · Please run /login" and "Please run /login · API Error: 401 OAuth token has expired ...".
  - "In non-interactive mode (`-p`) and the Agent SDK, the messages read as follows, and the structured error code is `authentication_failed`: Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator. / Failed to authenticate. API Error: 401 OAuth token has expired ..."
  - "If you authenticate with the `CLAUDE_CODE_OAUTH_TOKEN` environment variable, Claude Code keeps sending the value you set after a request fails with a 401, rather than switching to a stored login's token." Before 2.1.225 it could swap in a stored login's token ([CHANGELOG L4240](https://github.com/anthropics/claude-code/blob/0e1f4789406477380b267a01f3ddd50b0211e5b3/CHANGELOG.md#L4240)).
  - Before 2.1.287 the revoked text read "Your account does not have access to Claude..." ([CHANGELOG L1584](https://github.com/anthropics/claude-code/blob/0e1f4789406477380b267a01f3ddd50b0211e5b3/CHANGELOG.md#L1584)).
- A malformed token gives "Invalid auth token · Fix external auth token". "API Error: 401 Invalid authentication credentials" means the account or organization was rejected, "so an expired token isn't the cause" (same page).
- In the SDK: `SDKAssistantMessage.error` is one of `'authentication_failed' | 'oauth_org_not_allowed' | 'account_on_hold' | 'verification_required' | 'billing_error' | 'rate_limit' | ...` (`sdk.d.ts` L3791), and the result message carries `api_error_status`.
- Secondary: fresh setup-tokens rejected with a 400 ([#86986](https://github.com/anthropics/claude-code/issues/86986), 2026-08-15); a model gated as "Requires usage credits" under `CLAUDE_CODE_OAUTH_TOKEN` ([#81350](https://github.com/anthropics/claude-code/issues/81350), 2026-07-26).

### 1.6 Several tokens for one account

- No doc says a new token revokes older ones. Support 10310342 speaks of "authorization tokens", plural. Binary: the setup-token handler makes no revoke call.
- Secondary: tokens pile up, "hundreds of stale tokens" ([#59378](https://github.com/anthropics/claude-code/issues/59378), 2026-05-15).
- Inference: a new token can be minted before the old one expires, and both work until each expires or is removed.

### 1.7 pi and opencode

- **pi v1.4.0 accepts it** as `ANTHROPIC_OAUTH_TOKEN`. pi reads `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` ([env-api-keys.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/env-api-keys.ts#L75-L82)) and treats any key containing `sk-ant-oat` as OAuth ([anthropic-messages.ts L1011-L1013](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/api/anthropic-messages.ts#L1011-L1013)). pi's own `docs/containerization.md` passes a setup-token this way.
- How pi sends it ([anthropic-messages.ts L1048-L1068](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/api/anthropic-messages.ts#L1048-L1068), [L1227-L1233](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/api/anthropic-messages.ts#L1227-L1233)):
  - as a bearer token, with `user-agent: claude-cli/2.1.280` and `x-app: cli`;
  - with the betas `claude-code-20250219` and `oauth-2025-04-20`;
  - with a first system block "You are Claude Code, Anthropic's official CLI for Claude.";
  - with its tools renamed to Claude Code's names. A code comment says "Stealth mode: Mimic Claude Code's tool naming exactly".
- pi's warning ([interactive-mode.ts L323-L328](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L323-L328)): "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits." This is pi's claim, not Anthropic's.
- **opencode v1.19.4 does not accept it.**
  - No built-in Anthropic auth plugin ([plugin/index.ts](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/plugin/index.ts#L67-L79)).
  - The source has none of `sk-ant-oat`, `ANTHROPIC_OAUTH`, `CLAUDE_CODE_OAUTH`, `ANTHROPIC_AUTH_TOKEN`.
  - The docs say "There are plugins that allow you to use your Claude Pro/Max models with OpenCode. Anthropic explicitly prohibits this." ([providers.mdx L332-L367](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/web/src/content/docs/providers.mdx#L332-L367)).
  - The removal was [PR #18186](https://github.com/anomalyco/opencode/pull/18186), "anthropic legal requests", 2026-03-19.
  - The old plugin `opencode-anthropic-auth` is deprecated on npm (0.0.13), and its GitHub repositories return 404.

### 1.8 Billing outside interactive Claude Code

- [Support 15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) (modified 2026-10-27) now holds two updates:
  - "Update October 7, 2026: Claude Max and Team plans now include monthly API credits. ... Nothing changes for your plan: when you're signed in with your Claude plan, the Claude Agent SDK and claude -p still draw from your subscription limits."
  - "Update June 15, 2026: We've paused the previously-announced changes to Claude Agent SDK usage. For now, nothing has changed: Claude Agent SDK, claude -p, and third-party app usage still draw from your subscription limits."
- [Support 13189465](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account), "Log in to your Claude account" (modified 2026-10-15): "Anthropic may at its discretion allow paid subscribers who have enabled usage credits to use certain third-party tools ... but reserves the right to draw use of such third-party tools from usage credits rather than subscription limits." and "Use of third-party tools that misrepresent their identity to Anthropic's servers, attempt to route third-party traffic against subscription limits, or otherwise violate applicable terms or policies is prohibited".
- [Support 17154008](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans) (modified 2026-10-19): "When you're signed in with your Claude plan instead, claude -p and Agent SDK usage still draw from your plan's usage limits".
- Anthropic names Agent SDK and `claude -p` use as its own category, apart from "third-party app usage". Binary: an SDK run identifies itself with User-Agent `claude-cli/2.1.312 (external, sdk-ts, agent-sdk/0.3.312...)`, and the SDK sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts`.
- The SDK's usage type has a window `seven_day_oauth_apps` (`sdk.d.ts` L4444) that no doc explains.

### 1.9 Policy text, and the readings it allows

The texts:

- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance):
  - "**Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens - sign-in to a Claude account must complete through Anthropic's own flow." [dash]
  - "This does not restrict how customers provision and manage their own API keys or third-party inference provider credentials - for example, configuring an API key in a development environment, secrets manager, or machine image for use by the customer's own authorized users - provided the resulting usage is billed to the key owner ... Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above." [dash]
  - On platforms hosting Claude Code: "The Claude Code binary must not be modified" and "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential".
  - "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
  - "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview): "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."
- [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (effective Oct 8 2025): "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else or make your Account available to anyone else." And a ban on access "through automated or non-human means" "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it".

The case: a self-hosted tool, run by the user, that stores the user's own setup-token in its own encrypted store and passes it to the unmodified `claude` binary on the user's own machines. The readings, none chosen here:

1. **An end user signing in to the unmodified binary.** This reading is permitted. Supporting words: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". Anthropic itself tells users to keep a setup-token in Codespaces and CI secret stores (1.2).
2. **A developer storing or intermediating a token.** This reading is prohibited. Supporting words: "developers may not collect, store, or intermediate Claude.ai credentials or session tokens". The open points are whether the authors of a self-hosted tool are the "developers" meant, and whether passing a token from the controller to a runner is "intermediate".
3. **The sign-in still completes through Anthropic's flow.** The token comes from `claude setup-token` in the unmodified binary, which meets "sign-in to a Claude account must complete through Anthropic's own flow". The "store" clause remains. The carve-out for credentials customers "provision and manage" names only API keys and third-party inference credentials, which cuts against this reading.
4. **Offering claude.ai login.** A Hercule screen that accepts a subscription token could be read as offering "claude.ai login ... for their products" (Agent SDK overview, "Unless previously approved").
5. **Automated access.** Event-triggered sessions are "automated or non-human means".
   - For "explicitly permit": setup-token is documented "For CI pipelines, scripts", and support 15036540 says Agent SDK and `claude -p` "still draw from your subscription limits".
   - Against: "ordinary, individual usage".
6. **Sharing.** If other people can drive sessions, for example through an assistant bound to a shared chat channel, that may be "make your Account available to anyone else". If only the user drives them, the clause is not met.
7. **Identity.** The unmodified binary identifies as an Agent SDK run (1.8), so the "misrepresent their identity" text of support 13189465 is not met by Claude Code. pi's `claude-cli/...` headers and "You are Claude Code" system block (1.7) are the case that text describes.

## 2. Claude `/login` OAuth

- **Access token: about 8 hours.** No doc gives a number. CHANGELOG 2.1.86: "after the OAuth token refreshes (8 hours after login)" ([L7023](https://github.com/anthropics/claude-code/blob/0e1f4789406477380b267a01f3ddd50b0211e5b3/CHANGELOG.md#L7023)).
- **The login itself ends.** [Authentication](https://code.claude.com/docs/en/authentication), "Renew an expiring login":
  - "When the login you created with `/login` is within three days of expiring, Claude Code shows a warning at startup: `Your login expires in 3 days · run /login to renew`."
  - "Once the stored login expires and can't be refreshed, each model request fails with `Login expired · Please run /login` until you sign in again."
  - `/status` shows a `Login` row reading "Expired - log in again" [dash] (v2.1.210 or later).
  - The warning was added in 2.1.203 ([L4834](https://github.com/anthropics/claude-code/blob/0e1f4789406477380b267a01f3ddd50b0211e5b3/CHANGELOG.md#L4834)) and moved from 5 to 3 days in 2.1.217 ([L4462](https://github.com/anthropics/claude-code/blob/0e1f4789406477380b267a01f3ddd50b0211e5b3/CHANGELOG.md#L4462)).
- **The refresh token's lifetime is set by the server and not documented.** Binary: at login the client stores `refreshTokenExpiresAt` from `refresh_token_expires_in`. When the server sends none, it assumes `Date.now()+2592000000`, which is 30 days. On refresh it applies no fallback.
- **Refresh tokens are single use, and reuse revokes the login.**
  - [Troubleshoot install](https://code.claude.com/docs/en/troubleshoot-install#not-logged-in-or-token-expired):
    - "Parallel sessions on one machine share a saved login and coordinate its renewal so that only one process refreshes the token at a time."
    - "Before v2.1.211, waking the machine from sleep could cause two sessions to renew with the same token, which revoked the saved login and prompted every open session to log in again at once."
  - [Errors](https://code.claude.com/docs/en/errors): "Login expired" means "the OAuth service rejected the stored refresh token, so Claude Code cleared the saved credentials".
  - Binary: the refresh reads `{access_token, refresh_token, expires_in}` and keeps the old refresh token only when the response has none. For `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`: "The refresh token in CLAUDE_CODE_OAUTH_REFRESH_TOKEN was used for this attempt and cannot be used again; issue a new one to retry."
- **CHANGELOG entries on refresh races**, all fixed per machine:
  - 2.1.211: "Fixed parallel Claude Code sessions all logging out simultaneously after wake-from-sleep when many sessions share one credential store" ([L4621](https://github.com/anthropics/claude-code/blob/0e1f4789406477380b267a01f3ddd50b0211e5b3/CHANGELOG.md#L4621)).
  - 2.1.136: "a concurrent credential write could overwrite a freshly-rotated OAuth token and force re-login" ([L6035](https://github.com/anthropics/claude-code/blob/0e1f4789406477380b267a01f3ddd50b0211e5b3/CHANGELOG.md#L6035)).
  - 2.1.248: a token refresh lock held by another process ([L3653](https://github.com/anthropics/claude-code/blob/0e1f4789406477380b267a01f3ddd50b0211e5b3/CHANGELOG.md#L3653)).
- **pi's implementation** ([anthropic.ts L14-L27, L240-L276](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/auth/oauth/anthropic.ts#L240-L276)):
  - It asks for six scopes: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`.
  - The authorize URL is `https://claude.ai/oauth/authorize`.
  - A refresh writes back `{ refresh: data.refresh_token, access, expires: now + expires_in - 5 min }`.
  - pi's refresh lock exists because "the provider may already have rotated the refresh token" ([resolve.ts L105-L118](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/auth/resolve.ts#L105-L118)).
- **No OAuth server metadata is published.** `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` return 404 on claude.ai, platform.claude.com, api.anthropic.com and claude.com.
- **Secondary reports of machines logging each other out:**
  - "One Max subscription used on 3 machines ... a `/login` (or refresh) on device A appears to invalidate device B's stored refresh token" ([#80292](https://github.com/anthropics/claude-code/issues/80292), 2026-07-22).
  - "The server has already rotated the refresh token ... gets `invalid_grant`, and blanks the stored credential" ([#102265](https://github.com/anthropics/claude-code/issues/102265), 2026-10-15).
- **Hosts that hand Claude Code a token.**
  - Documented for Anthropic's own apps: "When the Claude desktop app or an IDE hosts your session, Claude Code gets its login token from that app rather than from `/login`. When claude.ai rejects that token, Claude Code asks the app for a new one." ([Errors](https://code.claude.com/docs/en/errors))
  - The Agent SDK 0.3.312 runtime (`sdk.mjs`) accepts a `getOAuthToken` option. It answers the CLI's `oauth_token_refresh` control request with `{ accessToken }` and sets `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1`. The option is not in `sdk.d.ts` and not in the docs.
- **Anthropic's own fleet shape.** In self-hosted environments, "the session authenticates with an Anthropic-issued, session-scoped OAuth token" ([Self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments)). They are a public beta for Team and Enterprise only.
- **One account on many devices, each signed in.**
  - "To use your Claude account across multiple devices, enter the same email address you use to log in on your usual device" (support 13189465).
  - Active sessions are listed per device and can be ended one at a time ([support 13124001](https://support.claude.com/en/articles/13124001-managing-your-active-sessions), modified 2026-10-23).
- Inference: the refresh lock is per machine, so one `/login` credential copied to several runners has no coordination. With single-use refresh tokens, the first runner to refresh logs out the others.

## 3. ChatGPT plan through Sign in with ChatGPT (SIWC) token sharing

### 3.1 What a host holds

- **The token response.** "The token response includes `access_token`, `refresh_token`, `id_token`, `token_type`, `expires_in`, `scope`, and `earliest_refresh_at`." ([Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)). `earliest_refresh_at` is not explained.
- **Lifetimes** (same page):
  - "Access tokens are valid for one hour (`expires_in: 3600`)."
  - "Refresh tokens are valid for 30 days. Each successful refresh returns a replacement refresh token with a fresh 30-day lifetime. Successive replacements have no fixed limit while each token remains valid."
  - The ID token's lifetime is not documented.
- **The access token.** Its `aud` is `https://api.openai.com/v1` "in this flow", and `iss` is `https://auth.openai.com` (same page).
- **Scopes**: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, with `resource=https://api.openai.com/v1` ([Sign in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)).
- **The OAuth flow** (same page):
  - Authorize at `https://auth.openai.com/api/accounts/authorize`.
  - The first sign-in registers with `client_id=dynamic_agent_client`, and the callback returns an issued `client_id`. Later sign-ins reuse it.
  - The code exchange goes to `https://auth.openai.com/api/accounts/oauth/token`. "No client secret is required."
  - The `redirect_uri` is fixed: "Use an HTTP loopback callback on `127.0.0.1` from initial registration onward ... only the port may vary."
- **Refresh** ([Profiles and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)):
  - "POST form-encoded `grant_type=refresh_token`, the issued `client_id` saved with this token set (not `dynamic_agent_client`), the saved `refresh_token`, and `resource=https://api.openai.com/v1` to `https://auth.openai.com/api/accounts/oauth/token`; omit `scope` to retain the grant."
  - "Store and use the latest replacement, and serialize refreshes for the same session so two processes do not race a rotating token."
- **Refresh errors**: "Unusable refresh token: `invalid_grant` on refresh, `invalid_refresh_token`, `token_expired`, `refresh_token_expired`, `refresh_token_invalidated`, or `refresh_token_reused`. Clear unusable tokens and repeat OAuth with the saved issued client ID." ([Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)). Whether a reuse revokes the whole token family, or has a grace window, is not documented.
- **Disconnects are not pushed**: "OpenAI does not currently notify your tool when a user disconnects the app in ChatGPT settings. When a request or refresh confirms the disconnection, stop using the invalid token set and ask the user to sign in again." (same page)
- **Revoking**: the `revocation_endpoint` (`https://auth.openai.com/api/accounts/oauth/revoke`, per the [discovery document](https://auth.openai.com/.well-known/openid-configuration)) takes the refresh token and the issued `client_id`. "Revoking this session does not delete the registered client." (Profiles and sessions)

### 3.2 Handing the plan to a harness

- **Codex app-server** ([Codex app-server page](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)):
  - Set `ACCESS_TOKEN` in the child's environment, then run `codex app-server --listen stdio://` with these `-c` overrides: `model_provider="openai_chatgpt_plan"`, `model_providers.openai_chatgpt_plan.name="ChatGPT plan"`, `.base_url="https://api.openai.com/v1"`, `.env_key="ACCESS_TOKEN"`, `.wire_api="responses"`, `.requires_openai_auth=false`, `.supports_websockets=false`.
  - "Codex sends the user's OAuth access token as `Authorization: Bearer <access_token>` on requests to `/v1/responses`. No separate Codex sign-in is required."
  - `initialize.clientInfo.name` "should match the `agent_name_hint`".
  - `openai_chatgpt_plan` is not built into Codex; the overrides define it. The string does not appear in codex-rs at `rust-v0.165.0`, whose built-in providers are listed in [model-provider-info/src/lib.rs L696-L728](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/model-provider-info/src/lib.rs#L696-L728).
- **pi v1.4.0** ([openai-chatgpt.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/auth/oauth/openai-chatgpt.ts#L15-L29)):
  - SIWC is the OAuth method of provider `openai` (base `https://api.openai.com/v1`). It uses agent name "Pi", the redirect `http://127.0.0.1:1455/auth/callback`, and the host ID `urn:uuid:<deviceId>`, where the device ID is kept in pi's global settings.
  - A refresh keeps the new refresh token ([L208-L223](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/auth/oauth/openai-chatgpt.ts#L208-L223)), under a file lock on `auth.json` ([resolve.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/auth/resolve.ts#L102-L145)).
  - A comment says "every login registers a new client with this ID", so pi does not reuse the issued `client_id`.
  - pi also accepts a SIWC access token as an API key: "OpenAI API keys start with `sk-`; a different credential sent directly to OpenAI is a Sign in with ChatGPT access token" ([openai-responses.ts L45-L56](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/api/openai-responses.ts#L45-L56)). It can come from `OPENAI_API_KEY` or `--api-key`.
  - A key given that way never refreshes. A `!command` key "caches its standard output for the process lifetime" ([providers.md L84](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/providers.md#L84)). No RPC command to replace a key at runtime was found.
  - The Codex-client login is a separate provider, `openai-codex`, "OpenAI Codex (legacy)", with base `https://chatgpt.com/backend-api`.
- **opencode**:
  - v1.19.4 has no SIWC flow. Its default ChatGPT login, `CodexAuthPlugin`, uses the Codex CLI client `app_EMoamEEZ73f0CkXaXp7hrann` and rewrites requests to `https://chatgpt.com/backend-api/codex/responses` ([plugin/openai/codex.ts](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/plugin/openai/codex.ts#L10-L12)).
  - v2.2.0 (2026-10-27) adds SIWC as method `chatgpt-token-sharing`, "Sign in with ChatGPT", on provider `openai`. It uses agent name "OpenCode", stores a host ID as `chatgpt-agent-host-id`, and reuses the issued client ID ([core/src/plugin/provider/chatgpt.ts](https://github.com/anomalyco/opencode/blob/1097e2668b1e08ad63bdf0b1c4860b9bc01e420c/packages/core/src/plugin/provider/chatgpt.ts#L20-L29)). The plugin first landed on the v2 line on 2026-09-29 ([PR #52147](https://github.com/anomalyco/opencode/pull/52147)).
  - OpenAI has no pi or opencode sub-pages (`/siwc/token-sharing-open-source/pi` returns 404). [learn.chatgpt.com](https://learn.chatgpt.com/docs/sign-in-with-chatgpt) lists "Open-source integrations: OpenClaw, OpenCode, Pi, T3".

### 3.3 Several machines, host IDs, and the interest form

- **One client, many hosts** ([Token sharing for open source](https://developers.openai.com/siwc/token-sharing-open-source)):
  - "An agent host is the environment where an instance of your tool runs, such as a laptop installation or a self-hosted VM. Your app defines what counts as one host and when its lifecycle begins and ends. Restarting the tool or signing in again does not by itself create a new host."
  - "A single client can have multiple hosts for the same user and workspace. For example, the same user's laptop and self-hosted VM can use one issued `client_id` for that workspace to share ChatGPT plan usage settings and limits, while each has its own host ID. ... An issued `client_id` can be reused across different agent hosts for the same user and workspace, but each host must have its own distinct host identifier."
- **`ext_agent_host_id`** (same page and [Sign in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)):
  - The app makes it: "Generate and persist a stable `ext_agent_host_id` for each host separately. Choose and persist the host ID before its first sign-in. Use an opaque value, not an email, user ID, or other user-identifying value. A host ID is not an authentication credential."
  - Formats: `urn:ietf:params:oauth:jwk-thumbprint:...` (recommended), `urn:uuid:<UUIDv4>`, or `did:key:`. "OpenAI does not verify possession of the private key."
  - It is sent on the authorize request only. Reauthorization with the issued `client_id` and an `id_token_hint` needs no workspace selection or consent screen, but still needs a browser redirect.
  - It does not appear in codex-rs at `rust-v0.165.0`.
- **Self-hosted VMs**, the whole procedure ([Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)):
  > 1. Create a host ID for the VM: Before importing credentials, create and persist a stable `ext_agent_host_id` for the VM.
  > 2. Complete OAuth locally: A `127.0.0.1` callback reaches the computer running the browser, not the remote VM. Complete OAuth locally with the same tool/client for the same user and workspace you will use on the VM.
  > 3. Transfer the protected credentials: Transfer the selected registration's protected credential file to the tool's documented VM path over a secure channel such as SSH. Include its issued `client_id`, `access_token`, `refresh_token`, and other saved metadata such as a retained `id_token`. Preserve the host ID assigned to the VM when importing the credentials so a copied laptop ID does not overwrite it.
  > 4. Let the VM manage token refreshes: Let the VM own later refreshes. Use its own host ID for its next authorization.
  >
  > This procedure transfers an existing credential session. Host-specific usage attribution and revocation of ChatGPT plan access for transferred sessions are not yet available.
- **A "transferred session"** is that copied token set. Inference: usage on a transferred set, or on access tokens fanned out to many runners, is attributed to the host ID the grant was authorized with.
- **Who needs the interest form**:
  - "These docs explain ChatGPT plan usage for open-source and locally hosted apps. If you're interested in offering it in a paid or remotely hosted app, complete the interest form." (overview)
  - "ChatGPT plan usage is available to all open-source partners and selected private clients." ([Quickstart](https://developers.openai.com/siwc/quickstart))
  - "Sign in with ChatGPT is currently offered to a select group of commercial partners. To join the waitlist, complete the Sign in with ChatGPT interest form." ([Request a client ID](https://developers.openai.com/siwc/request-client-id))
  - The form says: "If you're an open source developer, explore our developer docs. If you're a commercial partner interested in integrating Sign in with ChatGPT, complete the form below." ([form](https://web.archive.org/web/20261012124704/https://openai.com/form/sign-in-with-chatgpt-interest/), Wayback 2026-10-12; openai.com returns 403)
  - Dynamic registration "needs neither a client secret nor a partner API key" (Sign in).
- **Who may use a plan**:
  - Docs: "Eligible ChatGPT Plus and Pro users".
  - [Help 20001542](https://web.archive.org/web/20261014092807/https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) (Wayback 2026-10-14): "Go, Plus, or Pro".
  - "For ChatGPT Plus users, the five-hour usage limit is shared across all apps ... no app receives a separate allowance. The five-hour usage limit does not apply for Pro users." (Profiles and sessions)
- **Several devices are allowed; concurrency is not addressed.** [Account sharing policy](https://web.archive.org/web/20260406073712/https://help.openai.com/en/articles/10471989-openai-account-sharing-policy/) (Wayback 2026-04-06): "You are welcome to use your OpenAI account on multiple devices. However, please note that usage limits may apply depending on your account activity and subscription level." No limit on concurrent sessions or hosts was found in any SIWC, learn or help page.

### 3.4 A session that outlives its 1-hour access token

- **SIWC docs: restart, then resume.**
  - "Obtain a replacement access token ... Restart app-server with the updated `ACCESS_TOKEN`, initialize the new process, and resume the conversation using `thread/resume` with the saved thread ID." (Codex app-server page)
  - "Token renewal: Your app must refresh the OAuth token. With the `env_key` setup, restart app-server with the renewed `ACCESS_TOKEN`, then resume the saved thread." ([Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations))
- **What Codex does with an `env_key` token.** Codex reads the variable each time it resolves auth ([lib.rs L482-L501](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/model-provider-info/src/lib.rs#L482-L501)). A process's environment cannot be changed from outside, so the token is fixed for the life of the app-server.
- **What a stale token does.**
  - The default 401 recovery for a provider returns `NotConfigured`; only Bedrock overrides it ([provider.rs L189-L198](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/model-provider/src/provider.rs#L189-L198)).
  - The 401 surfaces as "unexpected status 401 ...", seen by clients as `HttpConnectionFailed { http_status_code: 401 }` ([error.rs L517-L521](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/protocol/src/error.rs#L517-L521)).
  - Inference: Codex retries with the same token until its retries run out, and the turn then fails.
- **An alternative to restarting: a command that prints the token.** This is a general Codex feature, not documented for SIWC and not tested.
  - `[model_providers.<id>.auth]` takes `command`, `args`, `timeout_ms` (default 5000) and `refresh_interval_ms` (default 300000): "Maximum age for the cached token before rerunning the command. Set to `0` to disable proactive refresh and only rerun after a 401 retry path." ([config_types.rs L564-L586](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/protocol/src/config_types.rs#L564-L586))
  - "The auth command receives no `stdin` and must print the token to stdout ... Don't combine `[model_providers.<id>.auth]` with `env_key`, `experimental_bearer_token`, or `requires_openai_auth`." ([config advanced](https://learn.chatgpt.com/docs/config-file/config-advanced))
- **pi**: a token given as `OPENAI_API_KEY` or `--api-key` is fixed for the process (3.2). Inference: pi must be restarted with a new token within the hour.

### 3.5 Codex's host-refresh mode, `chatgptAuthTokens`, is internal

- `account/login/start` accepts `type: "chatgptAuthTokens"` with `accessToken`, `chatgptAccountId` and `chatgptPlanType?`. It is marked "[UNSTABLE] FOR OPENAI INTERNAL USE ONLY - DO NOT USE. The access token must contain the same scopes that Codex-managed ChatGPT auth tokens have." ([account.rs L92-L94](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L92-L94)).
- "ChatGPT auth tokens are supplied by an external host app and are only stored in memory. Token refresh must be handled by the external host app." ([common.rs L26-L36](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-protocol/src/protocol/common.rs#L26-L36))
- **The refresh request.**
  - After a backend 401, the server sends the client `account/chatgptAuthTokens/refresh` with `{ reason: "unauthorized", previousAccountId? }` and expects `{ accessToken, chatgptAccountId, chatgptPlanType }` ([common.rs L1858](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-protocol/src/protocol/common.rs#L1858)).
  - It waits `EXTERNAL_AUTH_REFRESH_TIMEOUT` = 10 s, then fails with "auth refresh request timed out after 10s" ([external_auth.rs L18-L64](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server/src/external_auth.rs#L18-L64)).
- The [app-server docs](https://learn.chatgpt.com/docs/app-server) call it "experimental and intended for host apps that already own the user's ChatGPT auth lifecycle", and it needs `capabilities.experimentalApi = true`. Spec 06 §10.2 keeps `experimentalApi` off.
- Inference: this mode carries ChatGPT-backend (Codex) tokens. SIWC tokens have `aud` `https://api.openai.com/v1`, and the SIWC docs never mention this mode.

### 3.6 `codex login --with-access-token` and Codex access tokens

- **What it reads.** It reads a "Codex access token" from stdin, or from `CODEX_ACCESS_TOKEN`.
  - A value starting with `at-` is a personal access token.
  - Anything else is an agent-identity JWT.
  - Either way it stores no refresh token (`tokens: None, last_refresh: None`) ([manager.rs L1083-L1135](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/login/src/auth/manager.rs#L1083-L1135), [cli/src/login.rs L242-L296](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/cli/src/login.rs#L242-L296)).
- **Who can make one** ([Access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)):
  - "Codex access tokens are currently supported for ChatGPT Business and Enterprise workspaces."
  - Each has "a finite validity window, such as 7, 30, 60, or 90 days". The shortest is one day, and the workspace owner can cap the longest.
  - "You can't use revoked or expired tokens to start new authenticated runs."
  - "Use access tokens only on trusted runners."
  - "`codex app-server` can use the same credential through `CODEX_ACCESS_TOKEN` or a login created with `codex login --with-access-token`."
- **Renewal is by hand**: create a replacement, update the secret store, run a smoke test, revoke the old token (same page).
- It does not apply to Plus or Pro, and it is not SIWC.

## 4. Codex classic ChatGPT login (`auth.json`)

At `rust-v0.165.0`:

- **When Codex refreshes.**
  - Before every request, when the access-token JWT's `exp` is within 5 minutes (`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES = 5`).
  - Only when `exp` cannot be parsed does it fall back to `last_refresh` older than 8 days (`TOKEN_REFRESH_INTERVAL = 8`) ([manager.rs L214-L218](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/login/src/auth/manager.rs#L214-L218), [L3310-L3329](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/login/src/auth/manager.rs#L3310-L3329)).
  - Also after a 401.
  - The same rule held at `rust-v0.148.0` ([manager.rs L2868-L2890](https://github.com/openai/codex/blob/3ba0f711642a888aec92a611a3f3b2211157ff89/codex-rs/login/src/auth/manager.rs#L2868-L2890)).
  - The endpoint is `https://auth.openai.com/oauth/token`, with client `app_EMoamEEZ73f0CkXaXp7hrann`.
- **Lifetimes**: neither the access token's nor the refresh token's is in the code or the docs. Codex reads `exp` from the JWT.
- **Rotation**: a refresh writes the new `refresh_token` back and sets `last_refresh` ([manager.rs L1648-L1690](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/login/src/auth/manager.rs#L1648-L1690)).
- **Reuse detection**: `refresh_token_reused` gives "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again." ([manager.rs L218](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/login/src/auth/manager.rs#L218)). Expired, invalidated and unknown are told apart.
- **No lock across processes.** The commit guard is an in-process `Mutex` ([storage.rs L176-L182](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/login/src/auth/storage.rs#L176-L182)). Before a refresh, Codex reloads the file and uses newer tokens if another process wrote them. The file is written by truncate-and-write, not an atomic rename.
- **Storage**: the default store is still `File`; `Keyring`, `Auto` and `Ephemeral` are opt-in ([config/src/types.rs L136-L146](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/config/src/types.rs#L136-L146)).
- **Device code**: still "device code authentication (beta)", and the user must "Enable device code login in your ChatGPT security settings (personal account) or ChatGPT workspace permissions (workspace admin)" ([Auth](https://learn.chatgpt.com/docs/auth)).
- **The CI/CD guide** ([CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth)), unchanged:
  - "Use one `auth.json` per runner or per serialized workflow stream. Do not share the same file across concurrent jobs or multiple machines."
  - Reseed when "another machine or concurrent job rotated the token first."
  - It still describes the 8-day rule: "if `last_refresh` is older than about 8 days, Codex refreshes ... if a request gets a `401`, Codex also has a built-in refresh-and-retry path".
- **pi's Codex-client login** (provider `openai-codex`) and **opencode v1.19.4's ChatGPT login** use the same client and also rotate the refresh token.
  - pi: [openai-codex.ts L409-L437](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/auth/oauth/openai-codex.ts#L409-L437).
  - opencode: [codex.ts L369-L396](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/plugin/openai/codex.ts#L369-L396). It refreshes only once `expires` has passed, and removes duplicate refreshes within one process only.
  - opencode reads an undocumented `OPENCODE_AUTH_CONTENT` variable in place of `auth.json` ([auth/index.ts L57-L63](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/auth/index.ts#L57-L63)). Inference: with an OAuth entry in it, later reads would return the old refresh token after a refresh, and replaying it could trigger reuse detection.

## 5. API keys

### 5.1 OpenRouter

- **Expiry**:
  - A key can carry `expires_at`, set at creation: "Optional ISO 8601 UTC expiration timestamp". The update call cannot change it ([OpenAPI](https://openrouter.ai/docs/openapi/openapi.yaml)).
  - "Keys created for you during onboarding get a \$100 credit limit and expire after 180 days." ([Authentication](https://openrouter.ai/docs/api_reference/authentication.md))
  - An organization can "Enforce a maximum key lifetime": "OpenRouter rejects requests from keys that never expire or that exceed the maximum lifetime, including existing keys." ([Security settings](https://openrouter.ai/docs/guides/overview/auth/security-settings.md))
- **Rotation**: create a new key, move the apps, delete the old one; "Both keys remain valid during this transition period" ([API key rotation](https://openrouter.ai/docs/cookbook/administration/api-key-rotation.md)). Deleting or disabling a key needs a management key.
- **`GET /api/v1/key`** (OpenAPI):
  - It returns `label`, `limit`, `usage` (and daily, weekly, monthly), `byok_usage*`, `is_free_tier`, `is_management_key`, `is_provisioning_key`, `limit_remaining`, `limit_reset`, `include_byok_in_limit`, `budgets`, `effective_budget`, `creator_user_id`, `organization_id`, `workspace_id`, `allowed_data_regions`, `free_model_daily_requests`, and `rate_limit` (legacy, always -1).
  - It also returns `expires_at`: "ISO 8601 UTC timestamp when the API key expires, or null if no expiration".
- **Errors** ([Errors and debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging.md)):
  - "401: Invalid credentials (OAuth session expired, disabled/invalid API key)".
  - "402: Your account or API key has insufficient credits."
  - A spent budget or key limit "is rejected with a `403`". The limits page lists `openrouter_key_limit` under both 402 and 403 (see Conflicts).
- **Many machines**: no per-key or per-machine limit is documented. "Making additional accounts or API keys will not affect your rate limits, as we govern capacity globally." ([Limits](https://openrouter.ai/docs/api_reference/limits.md)). The [Terms](https://openrouter.ai/terms) (last updated Aug 31 2026) make the account holder responsible for "all activity and charges under its account or API Credentials".

### 5.2 Z.ai GLM Coding Plan

- **A Coding Plan key is its own kind of key since 2026-10-16** ([API key management notice](https://docs.z.ai/devpack/notice/api-key-management.md), published October 16, 2026):
  - "Starting October 16, 2026, API keys for the standard model API (pay-as-you-go or usage bundles) and GLM Coding Plan are managed separately."
  - "For Standard and Coding Plan keys created from October 16 onward, the key type determines how calls are billed. ... Changing the endpoint does not change the key's billing type."
  - Older keys are labelled "Compatible", and their billing depends on the endpoint. At `https://api.z.ai/api/paas/v4` such a key "may deduct from your account balance even while plan quota remains".
- **Expiry and rotation of the key**: not documented.
- **Who and how much** ([Usage policy](https://docs.z.ai/devpack/usage-policy.md)):
  - "Rate (concurrency) limits are tied to your plan tier."
  - Suggested parallel projects: Lite 1, Pro 1-2, Max 2 or more.
  - "Account sharing or multi-user access is prohibited."
  - "GLM Coding Plan may only be used within officially supported tools and products".
- **Subscription terms** ([§4](https://docs.z.ai/legal-agreement/subscription-terms.md)):
  - The plan is "licensed only to the individual natural person associated with such account".
  - No "general-purpose API access ... directly invoking model APIs from your own applications, bots, websites, SaaS products or other systems".
  - Z.ai may suspend the service on suspected "account sharing, bulk or automated usage on behalf of others, resale of access".
  - Nothing about devices or IP addresses was found.
- **Errors** ([error codes](https://docs.z.ai/api-reference/api-code.md)): HTTP 429 with codes:
  - 1308 "Usage limit reached for ... Your limit will reset at ...";
  - 1309 "Your GLM Coding Plan package has expired and is temporarily unavailable.";
  - 1310 "Weekly/Monthly Limit Exhausted.";
  - 1313 a fair-use limit.
  - The 401 codes are 1000, 1001 and 1003 ("Authentication Token expired").
- **Supported tools**: [Tool integration](https://docs.z.ai/devpack/tool/others.md) still lists Claude Code, Codex, OpenCode and Pi.

### 5.3 opencode Console (formerly Zen) and Go

- **Zen is now "OpenCode Console" pay-as-you-go**: `https://opencode.ai/docs/zen/` redirects (302) to `https://opencode.ai/v2/docs/console/models/`.
- **An API key, not an OAuth login, for model calls**: "Harnesses authenticate with a Console API key", which looks like `oc_sk_...` ([Harnesses](https://opencode.ai/v2/docs/console/harnesses/)). In opencode the key is pasted with `/connect` or `opencode auth login`.
- **One key per workspace, for either plan** ([Console API](https://opencode.ai/v2/docs/console/api/)): "Each key works in one workspace, chosen when it is created." A key from a workspace with credits pays as you go; a key from a workspace subscribed to Go uses Go. The variable is `OPENCODE_API_KEY` either way.
- **Expiry** (same page):
  - "Expiration is optional: Never, 1 day, 7 days, 30 days, or Custom (1 to 365 days). An expired key can't be renewed, so create a new one."
  - "Revoked and expired keys stop working immediately and return HTTP 401."
- **Several machines**:
  - "For shared machines or CI, owners and admins can create a service account key instead" (Harnesses).
  - "Go and Go Plus are for workspaces with a single member ... A workspace with a Go subscription cannot invite members." ([Go](https://opencode.ai/v2/docs/console/go/))
  - Whether a Go workspace can have a service account was not found.
- **Base URLs now**:
  - Pay-as-you-go `https://opencode.ai/inference` and Go `https://opencode.ai/inference/go`, plus `/openai/v1/responses`, `/openai/v1/chat/completions`, `/anthropic/v1/messages`, or `/google/v1beta/...`.
  - "Every API serves every paid and Go text model" (Harnesses).
  - The old `/zen/v1/models` and `/zen/go/v1/models` lists still answer 200.
- **Errors**:
  - 402 "Insufficient account funds" ([Billing](https://opencode.ai/v2/docs/console/billing/));
  - 429 "Policy budget exceeded" ([Budgets](https://opencode.ai/v2/docs/console/budgets/));
  - 403 for free-tier models from other harnesses.
  - When a Go limit is reached, the docs say only that free models keep working, or that Extra Usage falls back to the pay-as-you-go balance. No status code is documented.
- **[Terms of Service](https://opencode.ai/legal/terms-of-service)** (effective Aug 15 2026). In the list of things a user may not do:
  - "runs Maillist, Listserv, any form of auto-responder or "spam" on the Services, or any processes that run or are activated while you are not logged into the Services, or that otherwise interfere with the proper working of the Services (including by placing an unreasonable load on the Services' infrastructure)".
  - "You will only use the Services for your own internal use, and not on behalf of or for the benefit of any third party".

### 5.4 Keys passed only as environment variables

- **pi v1.4.0**: the variable alone is enough, but a key stored in `auth.json` wins over it.
  - "A stored credential owns the provider: ambient/env is consulted only when nothing is stored. No silent env fallback after a failed refresh ..." ([resolve.ts L27-L32](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/auth/resolve.ts#L27-L32)).
  - Order: "runtime `--api-key` first, then a stored `auth.json` credential, an `apiKey` from `models.json`, and finally the provider's environment variables" ([models.md L23](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/models.md#L23)).
  - Inference: a stale key in the instance home's `auth.json` silently overrides the key Hercule sends.
- **opencode v1.19.4**: the variable alone is enough. A key in `auth.json` is merged over it, and `provider.<id>.options.apiKey` in config wins over both ([provider.ts L1636-L1660](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/provider/provider.ts#L1636-L1660), [L1787-L1790](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/provider/provider.ts#L1787-L1790)).

## 6. Concrete routes

### 6.1 GLM 5.3

GLM-5.3 is in every catalog checked.

- OpenRouter: `z-ai/glm-5.3`, created 2026-08-18. Newer variants are `z-ai/glm-5.3-prime` (2026-09-23) and `z-ai/glm-5.3-flashx` (2026-09-18).
- models.dev: `glm-5.3` under `zai-coding-plan`, `zai`, `opencode-go`, `opencode` and `openrouter`.
- Z.ai: "All plans support **GLM-5.3**, GLM-5.3-Flash" ([overview](https://docs.z.ai/devpack/overview.md)).

| Route | Harness | Provider id | Model id | Env vars | Base URL | Source |
|---|---|---|---|---|---|---|
| Z.ai plan key | pi | `zai` ("ZAI Coding Plan (Global)"; China: `zai-coding-cn`, `ZAI_CODING_CN_API_KEY`) | `glm-5.3` | `ZAI_API_KEY` | `https://api.z.ai/api/coding/paas/v4` | [zai.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/providers/zai.ts#L6-L14) |
| Z.ai plan key | opencode | `zai-coding-plan` | `glm-5.3` | `ZHIPU_API_KEY` (the same variable also turns on `zai`, `zhipuai`, `zhipuai-coding-plan`) | `https://api.z.ai/api/coding/paas/v4` | [models.dev](https://models.dev/api.json) |
| Z.ai plan key | Claude Code | none (env) | `glm-5.3[1m]` via `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_MODEL`, `glm-5.3-flash[1m]` for Haiku | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | `https://api.z.ai/api/anthropic` | [Z.ai Claude Code](https://docs.z.ai/devpack/tool/claude.md) |
| Z.ai plan key | Codex | custom `[model_providers.ZAI]`, `wire_api = "responses"` | `glm-5.3` | `experimental_bearer_token` in the docs; `env_key` is also accepted | `https://api.z.ai/api/v1` | [Z.ai Codex](https://docs.z.ai/devpack/tool/codex.md) |
| opencode Go key | opencode | `opencode-go` | `glm-5.3` | `OPENCODE_API_KEY` | `https://opencode.ai/inference/go/openai/v1` | models.dev; v1.19.4 catalog |
| opencode Go key | pi | `opencode-go` | `glm-5.3` | `OPENCODE_API_KEY` | `https://opencode.ai/inference/go/v1` | [opencode-go.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/providers/opencode-go.ts#L12-L17); pi-ai 1.4.0 catalog |
| opencode Go key | Claude Code | none (env) | any Go model id; the example uses `minimax-m3` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | `https://opencode.ai/inference/go/anthropic` | [Console: Claude Code](https://opencode.ai/v2/docs/console/harnesses/claude-code/) |
| opencode Go key | Codex | custom `[model_providers.opencode-go]`, `wire_api = "responses"` | any Go model id; the example uses `kimi-k3` | `env_key = "OPENCODE_API_KEY"` | `https://opencode.ai/inference/go/openai/v1` | [Console: Codex](https://opencode.ai/v2/docs/console/harnesses/codex/) |
| OpenRouter key | pi | `openrouter` | `z-ai/glm-5.3` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | [openrouter.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/providers/openrouter.ts#L62-L74) |
| OpenRouter key | opencode | `openrouter` | `z-ai/glm-5.3` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | models.dev |
| OpenRouter key | Claude Code | none (env) | `z-ai/glm-5.3` via `ANTHROPIC_DEFAULT_*_MODEL`; "only guaranteed to work with the Anthropic first-party provider" | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY=""` | `https://openrouter.ai/api` | [OpenRouter: Claude Code](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration.md) |
| OpenRouter key | Codex | `openrouter` | `z-ai/glm-5.3` | an `[model_providers.openrouter.auth]` command (preferred), or `env_key = "OPENROUTER_API_KEY"`, with which "Codex won't fetch the OpenRouter model catalog" | `https://openrouter.ai/api/v1` | [OpenRouter: Codex](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli.md) |

Codex at `rust-v0.165.0` rejects `wire_api = "chat"` ([lib.rs L105](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/model-provider-info/src/lib.rs#L105)), so every Codex route above uses the Responses API.

### 6.2 A ChatGPT plan

| Route | Harness | Provider id | Credential and how it arrives | Base URL | Who refreshes |
|---|---|---|---|---|---|
| Classic login | Codex | `openai` (built in) | `codex login` or `codex login --device-auth` into `$CODEX_HOME/auth.json` | ChatGPT backend | Codex, on that machine (section 4) |
| SIWC | Codex app-server | `openai_chatgpt_plan` (defined by `-c` overrides) | `ACCESS_TOKEN` env var via `env_key`; or, untested, an `[model_providers.<id>.auth]` command | `https://api.openai.com/v1`, `wire_api = "responses"` | The host; Codex is restarted with a new token (3.4) |
| SIWC | pi | `openai` | pi's own `/login` (refreshes itself), or `OPENAI_API_KEY` / `--api-key` holding a non-`sk-` access token (never refreshed) | `https://api.openai.com/v1` | pi with its own login; the host otherwise |
| Codex client | pi | `openai-codex` ("legacy") | pi's own `/login`, browser or device code | `https://chatgpt.com/backend-api` | pi, on that machine |
| Codex client | opencode v1.19.4 | `openai` | "ChatGPT Pro/Plus (browser)" or "(headless)" into opencode's `auth.json` | `https://chatgpt.com/backend-api/codex/responses` | opencode, on that machine |
| SIWC | opencode v2.2.0 | `openai`, method `chatgpt-token-sharing` | opencode's own sign-in | `https://api.openai.com/v1` | opencode, on that machine |
| Business or Enterprise access token | Codex | `openai` | `CODEX_ACCESS_TOKEN`, or `codex login --with-access-token` | ChatGPT backend | Nobody; the token is static (3.6) |

Claude Code has no documented way to use a ChatGPT plan.

## 7. Summary

| Credential | One copy on many machines at once? | Lifetime | How it renews | What Hercule would hold | What fails, and how the user notices | How often the user acts |
|---|---|---|---|---|---|---|
| Claude `setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`) | **Yes.** Static, no refresh token. Anthropic documents it as a Codespaces and CI secret. All runners share one account's limits | 1 year, fixed | It does not. The user runs `claude setup-token` again (browser approval). Old and new coexist; sessions restart with the new value | The token (`sk-ant-oat...`) and the date it was minted, since nothing reports the expiry | Every request gets a 401: "OAuth token has expired" or "OAuth token revoked", SDK error `authentication_failed`. Claude Code keeps sending the dead token. Also revoked by the trash icon in Settings > Claude Code or by "Log Out" of all devices. Seen only when a request fails | Once a year, and after any "log out everywhere" |
| Claude `/login` | **No.** Refresh tokens are single use; reuse "revoked the saved login"; the refresh lock is per machine. A broker would need the undocumented SDK `getOAuthToken` option | Access token about 8 hours. The login ends at a time the server sets (the client assumes 30 days when the server sends none); a warning shows 3 days before | The CLI refreshes itself on each machine. When the login ends, the user runs `/login` | Nothing today: the CLI stores it on each runner | "Login expired · Please run /login". A refresh on another machine using the same chain logs this one out. The 3-day warning shows only at interactive startup | Per runner, each time a login ends (period undocumented) |
| ChatGPT via SIWC token sharing | **Only through a broker that refreshes centrally.** The docs require "serialize refreshes for the same session". Documented shapes: one token set per host, or a set transferred to a VM that then owns its refreshes | Access token 1 hour. Refresh token 30 days, replaced with a fresh 30 days on each refresh, no fixed limit | The host posts the refresh grant. Codex app-server restarts with the new `ACCESS_TOKEN` and `thread/resume`; pi restarts with the new key | Issued `client_id`, refresh token, access token, ID token, and an `ext_agent_host_id` per host | Refresh fails with `invalid_grant`, `refresh_token_reused`, `refresh_token_expired` and the like. A stale access token gives a 401 in the harness. OpenAI does not report a disconnect; the next refresh fails | Once (one browser redirect to a loopback address), then only when the chain breaks: 30 days unused, a disconnect in ChatGPT settings, or a reuse |
| ChatGPT via Codex `auth.json` | **No.** "Use one `auth.json` per runner". Refresh tokens rotate, with reuse detection, and nothing locks the file across processes | Neither lifetime is documented. Codex reads the access token's JWT `exp` | Codex refreshes 5 minutes before `exp` (8 days after the last refresh only as a fallback) and after a 401, and writes the new tokens back | Nothing: the CLI stores it on each runner | "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again." | Once per runner (device code), and again after a reuse or a revocation |
| ChatGPT Business or Enterprise Codex access token | **Yes, technically.** Static, no refresh. The docs neither allow nor forbid many machines: "Use access tokens only on trusted runners" | 1 day up to the workspace's cap (e.g. 7, 30, 60, 90 days) | It does not. Create a replacement, update the secret, revoke the old one | The token (`CODEX_ACCESS_TOKEN`) | "You can't use revoked or expired tokens to start new authenticated runs." | Every validity window |
| OpenRouter API key | **Yes.** No per-key or per-machine limit documented | None, unless `expires_at` was set at creation (it cannot be changed). Onboarding keys last 180 days. An organization's maximum-lifetime policy can reject existing keys | It does not. Make a new key; both work until the old one is deleted | The key | 401 for an invalid, disabled or expired key; 402 when credits run out; 403 (or 402) when a budget is spent. `GET /api/v1/key` reports `expires_at` and `limit_remaining` | Never, or at the expiry the user chose |
| Z.ai GLM Coding Plan key | **Yes, mechanically.** The terms license the plan to "the individual natural person" and ban "multi-user access"; concurrency is tied to the plan tier | No expiry documented; the key works while the plan is active | Not applicable. The user renews the plan | The plan key (a separate key type since 2026-10-16) | 429 with code 1308 (5-hour limit), 1310 (weekly or monthly limit) or 1309 (plan expired); 401 with code 1000, 1001 or 1003 | When the plan lapses |
| opencode Console or Go key | **Yes, mechanically.** Go workspaces have one member; service-account keys are "for shared machines or CI"; the terms ban processes that run "while you are not logged into the Services" | Chosen at creation: never, 1, 7 or 30 days, or 1 to 365 days. It cannot be renewed | It does not. Make a new key | The key (`OPENCODE_API_KEY`, `oc_sk_...`) | 401 when revoked or expired; 402 when the balance is zero; 429 when a budget is spent. No status is documented for a reached Go limit | Never, or at the expiry the user chose |

## Conflicts and gaps

### Conflicts

These are recorded, not resolved.

1. **Anthropic, billing third-party use.**
   - Support 15036540 (modified 2026-10-27): "third-party app usage still draw from your subscription limits".
   - Support 13189465 (modified 2026-10-15): Anthropic may "draw use of such third-party tools from usage credits rather than subscription limits".
   - pi's warning says third-party use "draws from extra usage".
   - Both Anthropic texts are live.
2. **Who may use a ChatGPT plan through SIWC.** The developer docs and learn.chatgpt.com say Plus and Pro. Help 20001542 (Wayback 2026-10-14) says "Go, Plus, or Pro".
3. **Codex's refresh rule.** The CI/CD guide says Codex refreshes when `last_refresh` is "older than about 8 days". The code refreshes 5 minutes before the access token expires and uses 8 days only when the expiry cannot be read.
4. **OpenRouter, a spent key limit.** The limits page lists `openrouter_key_limit` under both 402 and 403.
5. **Z.ai's Claude Code page** maps Opus and Sonnet to `glm-5.3[1m]`, and on the same page says all three defaults are "GLM-5.3-Flash".
6. **opencode's release lines.** GitHub marks v1.19.4 (2026-10-22) as "latest", while v2.2.0 (2026-10-27) is a newer full release. The docs site has moved to `/v2/docs`. The v1.19.4 repository docs still show the `/zen/...` URLs.
7. **Inside Hercule.**
   - Spec 13 §8 says "Hercule never holds, extracts, proxies, or distributes provider ... login tokens", and spec 15 §12 says the same. Spec 06 Post-v1 lists setup-token and "Hercule shuffling tokens" as strongly wanted.
   - Spec 06 §10.1 says "`claude setup-token` needs a PTY and is not usable". That is about running it on a runner; a user can run it in their own terminal.

### Corrections to the earlier research

1. **Codex refresh interval** (2026-08-20, also in spec 15 §12 by implication). "Codex refreshes tokens when `last_refresh` is older than ~8 days" was not the main rule even at `rust-v0.148.0`. The main trigger is the access token's `exp` minus 5 minutes (section 4).
2. **Claude refresh-token rotation** (2026-08-20, spec 06 §11, spec 13 §8: "undocumented for Claude").
   - Now documented: two renewals "with the same token ... revoked the saved login".
   - A `/login` login also has a hard end, with a warning 3 days before. It does not refresh forever.
3. **opencode's ChatGPT plugins** (2026-10-04: "two plugins ... one on SIWC `dynamic_agent_client`, one on the Codex CLI client ID"). At the commit read then (`907b3bc`) and at v1.19.4, both ChatGPT plugins use the Codex client ID. The SIWC plugin landed on the v2 line on 2026-09-29 and shipped in v2.2.0 (2026-10-27).
4. **`codex login --with-access-token`** (2026-10-04, listed without explanation). It is for Business and Enterprise Codex access tokens, not for ChatGPT OAuth or SIWC tokens.
5. **pi's Anthropic login** (2026-10-04: scope `user:sessions:claude_code`). pi asks for six scopes, and uses the authorize URL `claude.ai/oauth/authorize`, where Claude Code 2.1.312 uses `claude.com/cai/oauth/authorize`.
6. **SIWC pages** (2026-10-04). The set has been restructured, with new pages on token reference, errors, profiles and sessions, preview limitations, and models. There are no pi or opencode sub-pages.
7. **opencode Zen and Go endpoints** (2026-10-04: `/zen/v1/...`, `/zen/go/v1/`). Now `https://opencode.ai/inference/...` and `https://opencode.ai/inference/go/...`, and Zen is renamed OpenCode Console pay-as-you-go. The old model lists still answer.
8. **Z.ai keys** (2026-10-04). Since 2026-10-16 a Coding Plan key is a separate key type from a standard API key.
9. **OpenRouter's Codex guide** (2026-10-04: `env_key`). It now prefers a `[model_providers.openrouter.auth]` command.
10. **Support article dates** (2026-10-04).
    - 13189465 is now titled "Log in to your Claude account", modified 2026-10-15.
    - 15036540 now has an October 7 update, and its June line reads "We've paused", not "We're pausing".

### Gaps

- **Claude `/login`**: the access-token and refresh-token lifetimes are not documented. Only the "8 hours" CHANGELOG remark and the client's 30-day fallback exist.
- **Claude `setup-token`**:
  - whether the string encodes its expiry;
  - any API that lists tokens or reports an expiry;
  - any limit on concurrent use.
- **SIWC**:
  - the ID token's lifetime;
  - what `earliest_refresh_at` means;
  - whether a reused refresh token revokes the whole family;
  - any statement about one host serving several machines or a central refresher;
  - whether attribution follows the authorizing host ID.
- **Codex**: the classic access-token and refresh-token lifetimes.
- **Not tested**: whether the Codex `[model_providers.<id>.auth]` command works with a SIWC token.
- **Not checked**: whether each harness keeps `CLAUDE_CODE_OAUTH_TOKEN`, `ACCESS_TOKEN` or an API key variable out of the environment of the shell commands its agent runs. Spec 06 §10.2 notes that every shell command Codex runs inherits the app-server's environment.
- **Z.ai**: key expiry, rotation, and any device or IP limit. **opencode Go**: the status code at a reached limit, and whether a Go workspace can have a service account.
- **Hercule as "open-source"**: `theagenticage/hercule` is public on GitHub with no license file (checked 2026-10-28). Whether it counts as "open-source" for SIWC was not asked of OpenAI.
- **Read indirectly**: help.openai.com and openai.com pages through Wayback captures, because the live pages returned 403. Claude Code binary strings were read without running the binary.

## Sources

Anthropic:

- Docs (code.claude.com): [authentication](https://code.claude.com/docs/en/authentication), [env-vars](https://code.claude.com/docs/en/env-vars), [errors](https://code.claude.com/docs/en/errors), [troubleshoot-install](https://code.claude.com/docs/en/troubleshoot-install), [cli-reference](https://code.claude.com/docs/en/cli-reference), [legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance), [agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview), [agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript), [devcontainer](https://code.claude.com/docs/en/devcontainer), [github-actions](https://code.claude.com/docs/en/github-actions), [self-hosted-environments](https://code.claude.com/docs/en/self-hosted-environments).
- Support: [10310342](https://support.claude.com/en/articles/10310342-how-do-i-log-out-of-all-active-sessions), [11145838](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan), [13124001](https://support.claude.com/en/articles/13124001-managing-your-active-sessions), [13189465](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account), [15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [17154008](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans).
- Terms: [Consumer Terms](https://www.anthropic.com/legal/consumer-terms).
- Code and packages: [CHANGELOG at 0e1f478](https://github.com/anthropics/claude-code/blob/0e1f4789406477380b267a01f3ddd50b0211e5b3/CHANGELOG.md); [Agent SDK 0.3.312](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.312); the binary `@anthropic-ai/claude-code-linux-x64@2.1.312`.
- Issues (secondary): [#34198](https://github.com/anthropics/claude-code/issues/34198), [#48373](https://github.com/anthropics/claude-code/issues/48373), [#57400](https://github.com/anthropics/claude-code/issues/57400), [#59378](https://github.com/anthropics/claude-code/issues/59378), [#80292](https://github.com/anthropics/claude-code/issues/80292), [#81350](https://github.com/anthropics/claude-code/issues/81350), [#86986](https://github.com/anthropics/claude-code/issues/86986), [#102265](https://github.com/anthropics/claude-code/issues/102265).

OpenAI:

- SIWC pages: [overview](https://developers.openai.com/siwc/token-sharing-open-source), [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [token-reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference), [profiles-and-sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [errors-and-recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery), [codex-app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), [self-hosted-vms](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms), [preview-limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [models-and-inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [quickstart](https://developers.openai.com/siwc/quickstart), [request-client-id](https://developers.openai.com/siwc/request-client-id), [llms-full.txt](https://developers.openai.com/siwc/llms-full.txt).
- learn.chatgpt.com: [sign-in-with-chatgpt](https://learn.chatgpt.com/docs/sign-in-with-chatgpt), [auth](https://learn.chatgpt.com/docs/auth), [ci-cd-auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth), [enterprise/access-tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens), [app-server](https://learn.chatgpt.com/docs/app-server), [config-advanced](https://learn.chatgpt.com/docs/config-file/config-advanced).
- Other: [OpenID configuration](https://auth.openai.com/.well-known/openid-configuration).
- Wayback captures: [account sharing policy](https://web.archive.org/web/20260406073712/https://help.openai.com/en/articles/10471989-openai-account-sharing-policy/) (2026-04-06), [help 20001542](https://web.archive.org/web/20261014092807/https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) (2026-10-14), [Terms of Use](https://web.archive.org/web/20261027161214/https://openai.com/policies/terms-of-use/) (2026-10-27), [interest form](https://web.archive.org/web/20261012124704/https://openai.com/form/sign-in-with-chatgpt-interest/) (2026-10-12).
- Code: [codex at rust-v0.165.0](https://github.com/openai/codex/tree/360319d8dee62d87e2d59fc0c21805d79519cfed) (files cited inline).

Harnesses:

- pi: [source at v1.4.0](https://github.com/earendil-works/pi/tree/4a080252f06caf63a525d7873c5d94d3c23887e0) (files cited inline).
- opencode: [source at v1.19.4](https://github.com/anomalyco/opencode/tree/148842ef7cb1bc34192b3fff57d0f9721ab9c801), [v2.2.0 chatgpt.ts](https://github.com/anomalyco/opencode/blob/1097e2668b1e08ad63bdf0b1c4860b9bc01e420c/packages/core/src/plugin/provider/chatgpt.ts), [PR #18186](https://github.com/anomalyco/opencode/pull/18186), [PR #52147](https://github.com/anomalyco/opencode/pull/52147).

API-key vendors:

- OpenRouter: [OpenAPI](https://openrouter.ai/docs/openapi/openapi.yaml), [authentication](https://openrouter.ai/docs/api_reference/authentication.md), [security settings](https://openrouter.ai/docs/guides/overview/auth/security-settings.md), [key rotation](https://openrouter.ai/docs/cookbook/administration/api-key-rotation.md), [errors](https://openrouter.ai/docs/api_reference/errors-and-debugging.md), [limits](https://openrouter.ai/docs/api_reference/limits.md), [Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration.md), [Codex guide](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli.md), [Terms](https://openrouter.ai/terms), [models](https://openrouter.ai/api/v1/models).
- Z.ai: [API key management notice](https://docs.z.ai/devpack/notice/api-key-management.md), [overview](https://docs.z.ai/devpack/overview.md), [usage policy](https://docs.z.ai/devpack/usage-policy.md), [subscription terms](https://docs.z.ai/legal-agreement/subscription-terms.md), [error codes](https://docs.z.ai/api-reference/api-code.md), [tool integration](https://docs.z.ai/devpack/tool/others.md), [Claude Code](https://docs.z.ai/devpack/tool/claude.md), [Codex](https://docs.z.ai/devpack/tool/codex.md).
- opencode Console: [API keys](https://opencode.ai/v2/docs/console/api/), [harnesses](https://opencode.ai/v2/docs/console/harnesses/), [Go](https://opencode.ai/v2/docs/console/go/), [billing](https://opencode.ai/v2/docs/console/billing/), [budgets](https://opencode.ai/v2/docs/console/budgets/), [Terms of Service](https://opencode.ai/legal/terms-of-service).
- Catalog: [models.dev](https://models.dev/api.json).

## What this allows Hercule to design

These are options, not decisions. Each one that makes Hercule hold a vendor login credential contradicts spec 13 §8 and spec 15 §12 as written, and would need them changed.

1. **Static credentials as fleet Secrets.** A Provider Instance gets a Secret Field for a Claude setup-token (`CLAUDE_CODE_OAUTH_TOKEN`), a Business or Enterprise Codex access token, or an API key. The controller sends it inline at session start, as it already does for API keys. The user signs in once per account; no runner logs in.
   - Costs: Hercule records the mint date and warns before the year ends.
   - For Claude, the session loses plan windows, Remote Control and claude.ai connectors.
   - For Claude, the policy readings in 1.9 apply.
2. **The controller as a SIWC refresher.** The controller runs SIWC once and holds the refresh token. It refreshes one request at a time and sends a fresh access token with each session start.
   - The loopback-only `redirect_uri` means the browser's machine catches the callback: the user pastes the final URL, as pi does, or the desktop app listens on `127.0.0.1`.
   - A session that outlives an hour needs a restart and `thread/resume` for Codex, or, untested, a runner-side `[model_providers.<id>.auth]` command that asks the controller for the current token. pi needs a restart.
   - Open points:
     - what counts as one "host": the fleet, or each runner;
     - usage attribution, which the docs say is "not yet available" for transferred sessions;
     - whether Hercule counts as "open-source and locally hosted".
3. **One SIWC token set per runner, all held by the controller.** Each runner gets its own `ext_agent_host_id`, and every set shares one issued `client_id`. This matches the documented "multiple hosts" shape and keeps one refresher per set. A reauthorization skips consent, but each runner still needs one browser redirect.
4. **Keep per-runner vendor login** for Claude `/login` and the classic Codex `auth.json`. This is what spec 06 §11 does now. Both rotate their refresh tokens with reuse detection, and neither has a supported way for one place to refresh for many machines.
5. **Not usable as things stand**, listed so they are not rediscovered as new:
   - Codex `chatgptAuthTokens` with `account/chatgptAuthTokens/refresh` is marked "FOR OPENAI INTERNAL USE ONLY", needs `experimentalApi`, and carries ChatGPT-backend tokens.
   - The Claude Agent SDK's `getOAuthToken` option is undocumented and absent from its types.
