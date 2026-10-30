# How tools read usage per model account

Research for one central place in the controller that tracks usage per model account.
Date: 2026-10-30.

## How to read "verified"

- **Docs**: stated in the vendor's official documentation.
- **Vendor code**: read in the vendor's own client code (Claude Code CLI, Codex, opencode, z.ai plugins, MiniMax CLI). Not in public docs, so it can change without notice.
- **Secondary**: read only in a third-party tool's code (t3code, CodexBar, ccusage).
- **Unverified**: not confirmed by any of the above.

Nothing here was tested live with real credentials. Every row is from reading code or docs.

## Sources read

| Source | Version |
|---|---|
| t3code (`pingdotgg/t3code`) | `6575ce32`, 2026-10-30 |
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | 0.3.314, `sdk.d.ts` (bundles CLI 2.1.314) |
| Claude Code CLI | 2.1.312, the minified JS inside the installed binary. Short names like `Uf` or `kt` below are minifier output |
| metrona `src/main/accounts/health.ts` | `846a95d1` |
| CodexBar (`steipete/CodexBar`) | `d253dd11` |
| ccusage (`ccusage/ccusage`, formerly `ryoppippi/ccusage`) | `71e022a8` |
| Codex (`openai/codex`) | tag `rust-v0.154.0` (`6b9826e3`), the release Hercule pins in `scripts/gen-version.ts:25` |
| pi (`earendil-works/pi`) | `50af8c16` |
| opencode (`anomalyco/opencode`) | `4e7d3690` (dev) |
| z.ai (`zai-org/zai-coding-plugins`, `zai-org/ZCode`) | `0446d0bb`, `a60ba6a7` |
| MiniMax CLI (`MiniMax-AI/cli`) | `38aba5f2` |

## Summary table

| Provider / account kind | Method | Needs | Returns | Verified |
|---|---|---|---|---|
| Claude subscription | `GET https://api.anthropic.com/api/oauth/usage` | OAuth access token **with `user:profile` scope**. Headers: `Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`, a Claude Code User-Agent | `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`, `extra_usage`, `limits[]`, `cedar_ember` (reset credits). Utilization 0-100, `resets_at` ISO | Vendor code. Also used by t3code and CodexBar. Not documented |
| Claude subscription | Agent SDK `query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` (control request `get_usage`) | A started query. **No turn needed.** Same scope rule as the row above, because the CLI calls that endpoint | Same windows, 0-100, plus `subscription_type` | SDK types and CLI code. t3code ships it |
| Claude subscription | Agent SDK `rate_limit_event` messages | A turn that reaches the API | One window per event: `rateLimitType`, `utilization` 0-1, `resetsAt` (epoch seconds), `status`, overage fields | SDK types |
| Claude subscription | `anthropic-ratelimit-unified-*` headers on `POST /v1/messages` | Any subscription OAuth token (setup-token included, unverified). Costs one tiny request | 5h, 7d, 7d_oi and overage windows: utilization 0-1, reset (epoch seconds), status | Vendor code (header names). Not documented |
| Claude subscription | Status line JSON `rate_limits` | Interactive Claude Code, after the first API response | `five_hour` / `seven_day`: `used_percentage`, `resets_at` | Docs |
| Claude subscription | `GET https://claude.ai/api/organizations/{org}/usage` | Browser `sessionKey` cookie | Same windows | Secondary (CodexBar) |
| Claude subscription | Run `claude` in a PTY, send `/usage`, scrape the text | The CLI, signed in | Text | Secondary (CodexBar) |
| Claude subscription | Local `~/.claude/projects/**/*.jsonl` | File access | Tokens and estimated cost only, no limits | Secondary (ccusage, t3code, CodexBar) |
| Anthropic API (Console org) | `GET /v1/organizations/usage_report/messages`, `/v1/organizations/cost_report` | Admin key `sk-ant-admin01-...`. Not available for individual accounts | Historical tokens and cost, about 5 min behind. No balance | Docs |
| Codex, ChatGPT sign-in | app-server `account/rateLimits/read` | Auth backed by Codex services (ChatGPT, external ChatGPT tokens, agent identity, PAT). **API key fails** | `primary` / `secondary` windows (`usedPercent`, `windowDurationMins`, `resetsAt`), `credits`, `individualLimit`, `planType`, reset credits | Vendor code and docs |
| Codex, ChatGPT sign-in | app-server `account/rateLimits/updated` notification | A running turn | Sparse snapshot, same shape | Vendor code and docs |
| Codex, ChatGPT sign-in | app-server `account/usage/read` | Same as `rateLimits/read`. **API key fails** | Lifetime tokens, streaks, daily token buckets. Optional per-thread cost estimate. No limits | Vendor code and docs |
| Codex, ChatGPT sign-in | `GET https://chatgpt.com/backend-api/wham/usage` | ChatGPT access token from `~/.codex/auth.json`, `ChatGPT-Account-Id` | What `rateLimits/read` wraps, in snake_case | Vendor code (path). Headers from secondary sources |
| Codex, API key | None | - | - | Vendor code rejects it |
| OpenRouter | `GET https://openrouter.ai/api/v1/key` | Any API key | `limit`, `limit_remaining`, `limit_reset`, `usage`, `usage_daily/weekly/monthly`, `expires_at`, `is_free_tier`, budgets | Docs |
| OpenRouter | `GET https://openrouter.ai/api/v1/credits` | **Management key** | `total_credits`, `total_usage` | Docs |
| Z.ai GLM Coding Plan | `GET https://api.z.ai/api/monitor/usage/quota/limit` (CN: `https://open.bigmodel.cn/...`) | The raw key in `Authorization`, **no `Bearer`** | `limits[]`: 5-hour and weekly `TOKENS_LIMIT`, monthly MCP `TIME_LIMIT`, `percentage` used, `nextResetTime` | Vendor code. Docs only point to a plugin |
| Z.ai pay-as-you-go | None found for z.ai global. A CN balance endpoint exists | - | - | Secondary |
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | `Bearer` Go key, or a console token plus `x-opencode-org-id` | `usage.{rolling,weekly,monthly}.{percent,resetsAt}`. 403 means no Go subscription | Vendor code. Also t3code |
| OpenCode Zen | No balance API. Each response carries `usage.cost`. Budgets via `GET https://opencode.ai/console/api/policies/current-budgets` | Console token plus `x-org-id` | Budget rows | Docs (per-response cost), vendor code (budgets) |
| MiniMax M Plan | `GET https://www.minimax.io/v1/token_plan/remains` | `Bearer` M Plan key | `model_remains[]`: interval and weekly counts and percents | Docs (endpoint), vendor code (fields) |
| MiniMax pay-as-you-go | `GET https://api.minimax.io/account/query_balance` | `Bearer` `sk-api-...` key | `available_amount`, `cash_balance`, `voucher_balance`, ... | Vendor code only |

## 1. t3code

t3code reads usage in four ways. It does not parse local files for limits.

1. **The provider's own agent protocol.** This is the main path for Claude and Codex.
2. **A direct HTTP call to the vendor.** Used for Claude reset credits, OpenCode Go, Cursor, Antigravity and Grok.
3. **A CLIProxyAPI "hub".** It proxies OAuth calls for accounts that the hub holds.
4. **Local transcripts.** Used for token and cost history only.

It probes every provider again every 5 minutes by default (`packages/contracts/src/settings.ts:942`, `DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL = Duration.minutes(5)`).

### Claude (Agent SDK, `^0.3.276`, `apps/server/package.json:36`)

- **Snapshot via `get_usage`, on a fresh query with no prompt** (`apps/server/src/provider/ClaudeProvider.ts:323-404`):
  - The prompt is an async generator that never yields: "A never-yielding prompt allows local initialization IPC without sending an Anthropic request" (`:323`, `:339-343`).
  - It awaits `q.initializationResult()` (`:352`).
  - Then it calls `q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` (`:363-367`).
  - It also reads `account.email`, `subscriptionType`, `tokenSource` and `apiKeySource` from the init result (`:375-390`).
  - So no turn and no quota are spent.
- **Conversion** (`apps/server/src/provider/claudeUsageLimits.ts:175-217`):
  - `rate_limits_available: false` becomes "unsupported", for example API keys (`:180-187`).
  - It reads `five_hour`, `seven_day`, `model_scoped` (per-model weekly) and spend. The spend is `rate_limits.spend`, which the SDK does not type yet, or `extra_usage` (`:84-105`).
  - Values are already 0-100 (`:174`).
- **Live updates from `rate_limit_event`**:
  - `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:8061-8074` passes `message.rate_limit_info` to `claudeRateLimitEventToUpdate`.
  - That function maps `five_hour` and `seven_day` windows and multiplies `utilization` by 100, because the stream reports 0-1 (`claudeUsageLimits.ts:154-172`).
- **Reset credits by direct HTTP** (`apps/server/src/provider/claudeResetCredits.ts`):
  - Reads `claudeAiOauth.accessToken` from `<configDir>/.credentials.json`, on Linux only. On macOS it returns nothing, because the token lives in the Keychain (`:137-144`).
  - Calls `GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1` (`:153-173`).
  - Headers (`:146-151`):
    - `authorization: Bearer <token>`
    - `anthropic-beta: oauth-2025-04-20`
    - `user-agent: claude-cli/<version> (external, cli)`
  - Redeems a credit with `POST https://api.anthropic.com/api/organizations/{orgUuid}/reset_rate_limits` and body `{program: "cedar_ember", grant_id, request_id}`. The org UUID comes from `~/.claude.json` `oauthAccount.organizationUuid` (`:198-258`).

### Codex (app-server JSON-RPC)

- **Snapshot** (`apps/server/src/provider/CodexProvider.ts:525-595`):
  - Calls `account/read` first.
  - Then calls `client.request("account/rateLimits/read", null)` in parallel with model and skill discovery, with its own timeout (`:557-582`).
  - Keeps `rateLimits`, `rateLimitsByLimitId`, `rateLimitResetCredits` and `accountId`.
- **API key accounts** are marked "unsupported" without asking (`:784-786`): `snapshot.account.account?.type === "apiKey" ? makeUnavailableUsageLimits({ reason: "unsupported" })`.
- **Live updates**:
  - `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:4319-4347` handles `account/rateLimits/updated`.
  - Updates are partial and get merged into the last snapshot (`codexUsageLimits.ts:168-187`).
- **Window mapping** (`apps/server/src/provider/codexUsageLimits.ts:59-98`):
  - Only `limitId === "codex"` counts. Model-specific buckets are ignored (`:64`).
  - `primary` falls back to 5 hours, or to monthly on the `free` and `go` plans. `secondary` falls back to weekly.
  - `individualLimit.remainingPercent` becomes a "Monthly credit limit" row.
- **`account/usage/read`**: generated (`packages/effect-codex-app-server/scripts/generate.ts:434`) but never called.

### The CLIProxyAPI hub (`apps/server/src/usage/cliproxyApi.ts`, `UsageLimitSources.ts`)

An optional external proxy that holds many OAuth accounts. t3code calls its management API with `Authorization: Bearer <managementKey>`:

- `GET {hub}/v0/management/auth-files` lists the accounts.
- `POST {hub}/v0/management/api-call` makes the hub forward a request with the account's token put in place of `$TOKEN$` (`:164-235`).

What it forwards:

- **Claude**:
  - `GET https://api.anthropic.com/api/oauth/usage` (`:269`).
  - Headers: `anthropic-beta: oauth-2025-04-20` and `User-Agent: claude-code/2.1.273`.
  - The comment at `:218` says: "The OAuth usage endpoint can return 429 without a Claude Code user agent."
  - It parses `five_hour`, `seven_day`, and `limits[]` rows of `kind: "weekly_scoped"` (`:51-74`, `:270-281`).
- **Codex**:
  - `GET https://chatgpt.com/backend-api/wham/usage` (`:136`, `:298`).
  - Headers: `OpenAI-Beta: codex-1`, `Originator: Codex Desktop`, `Chatgpt-Account-Id` (`:205-214`).
  - It parses `rate_limit.primary_window` and `secondary_window` {`used_percent`, `reset_at`, `limit_window_seconds`} and `plan_type` (`:37-50`).
  - Reset credits come from `GET .../wham/rate-limit-reset-credits` (`:137`, `:237-252`).

### Other providers in t3code

- **OpenCode Go**: `GET https://opencode.ai/zen/go/v1/usage` with `Bearer <key>`.
  - The key comes from `~/.local/share/opencode/auth.json` entry `opencode-go`, from `OPENCODE_API_KEY`, or from the opencode console credential in `opencode.db`.
  - The response is `{usage:{rolling,weekly,monthly:{percent,resetsAt}}}`. A 403 means "A valid Zen key can exist without a Go subscription".
  - Source: `packages/provider-opencode/src/server/usageLimits.ts:75-178`.
- **Cursor**: `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, with `CURSOR_AUTH_TOKEN` or the Keychain login (`packages/provider-cursor/src/server/usageLimits.ts:22`, `:74-131`).
- **Antigravity**: refreshes a Google OAuth token, then calls `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` or `:fetchAvailableModels` (`apps/server/src/provider/antigravityUsageLimits.ts:18-21`, `:215-284`).
- **Grok**: `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`, using the token in Grok's `auth.json` (`packages/provider-grok/src/server/usageLimits.ts:146-181`).
- **Muse (Meta)**: subscription windows come from its agent protocol (`packages/provider-muse/src/server/protocol.ts:169-183`).
- **Pi**: no limits. Token history only.

### Local transcripts in t3code (history, not limits)

- Claude: `$CLAUDE_CONFIG_DIR` or `~/.claude`, then `projects/` (`apps/server/src/provider/Drivers/claudeUsage.ts:137-138`).
- Codex: `$CODEX_HOME/sessions`, reading `token_count` lines (`Drivers/codexUsage.ts:326`, `:372-381`).
- Prices come from a LiteLLM table (`apps/server/src/usage/usagePricing.ts:17`).

## 2. Claude subscription usage

### 2a. Claude Code `/usage` and `GET /api/oauth/usage`

Source: CLI 2.1.312, the embedded JS.

- **Endpoint variants**:

  ```js
  case"plain":return"/api/oauth/usage";
  case"cedar_ember":return"/api/oauth/usage?cedar_ember=1&skip_spend=1";
  case"at_wall":return ... "/api/oauth/usage?at_wall=1&skip_spend=1";
  ```

  `cedar_ember` adds the reset-credit inventory. `skip_spend` leaves out spend.
- **Request**:
  - The base is `https://api.anthropic.com`.
  - The call is `Gt.get(r,{timeout:5000,headers:{"Content-Type":"application/json"},refreshOAuth:!0,credentials:e})`.
  - Bearer and beta headers: the CLI's OAuth calls attach `Authorization: Bearer <token>` and `"anthropic-beta":_u`, where `_u="oauth-2025-04-20"`. I did not trace the `Gt` wrapper line by line. t3code (`claudeResetCredits.ts:146-151`) and CodexBar (`ClaudeOAuthUsageFetcher.swift:88-98`) send exactly these headers.
  - User-Agent: CodexBar sends `claude-cli/<ver> (external, cli)`. t3code's hub code says the endpoint can return 429 without a Claude Code user agent.
- **Scope gate in the CLI**: `let f=async()=>{if(!kt()||!Uf())return{}; ...`. The endpoint is called only when both checks pass:
  - `kt()` checks that the token scopes include `user:inference` (`Rk="user:inference"`).
  - `Uf()` is `$n()?.scopes ... .includes(iK)`, with `iK="user:profile"`.
- **Backoff on 429 and 403**:
  - The CLI remembers the answer per bearer token: "fetchUtilization: ${d} remembered for this bearer; not asking again for ${..}s".
  - It waits for `Retry-After`, or 5 minutes by default (`xt=300000`), and never more than 1 hour (`$e=3600000`).
  - A 401 that the server rejects is remembered for 1 hour.
  - Treat this endpoint as rate limited, and poll it gently.
- **Response fields**:
  - Per-window `utilization` (0-100) and `resets_at` (ISO): `five_hour`, `seven_day`, `seven_day_oauth_apps`, `seven_day_opus`, `seven_day_sonnet`.
  - `extra_usage` {`is_enabled`, `monthly_limit`, `used_credits`, `utilization`, `currency`}.
  - A newer `limits[]` list of {`kind` (`session`, `weekly_all`, `weekly_scoped`), `group`, `percent`, `resets_at`, `scope.model.display_name`}.
  - The SDK says to "Classify a row on this [kind], never on a label" (`sdk.d.ts:6510-6530`).
  - CodexBar also parses `cedar_ember` and `iguana_necktie` (`ClaudeOAuthUsageFetcher.swift:284-397`).
- **Docs**: this endpoint is not in Anthropic's public docs. Treat it as unstable.

**Does a `claude setup-token` token work? No.**

- **What setup-token asks for** (CLI 2.1.312):
  - `startOAuthFlow(..., {loginWithClaudeAi:!0, inferenceOnly:!0, expiresIn:vae})`, with `vae=31536000` (1 year).
  - The authorize URL then asks for `scope = inferenceOnly ? [Rk] : ...`, which is only `user:inference`.
- **What an env token gets**:
  - A token passed as `CLAUDE_CODE_OAUTH_TOKEN` gets `scopes:FA()`.
  - `FA(e=["user:inference"])` returns `CLAUDE_CODE_OAUTH_SCOPES`, or `["user:inference"]` when that is unset.
- **What the CLI says about it**: "env-var and setup-token sessions default to user:inference only".
- **Result:** `Uf()` is false, so the CLI never calls `/api/oauth/usage`. `get_usage` answers `rate_limits_available: false` and `rate_limits: null`. The SDK type says so: "False when plan rate limits do not apply (API key, Bedrock, Vertex, or missing profile scope)" (`sdk.d.ts:4417`).
- **CodexBar** also refuses tokens without `user:profile` (`ClaudeUsageFetcher.swift:459-466`).
- **What the server does** with an inference-only token on this endpoint: **unverified**. The CLI's bootstrap endpoint logs "403 for OAuth token without profile scope", which suggests the same.
- **Setting `CLAUDE_CODE_OAUTH_SCOPES`** to claim `user:profile` would only make the CLI try. The token still lacks the scope.

### 2b. `anthropic-ratelimit-unified-*` headers on `POST /v1/messages`

- **Header names** (CLI 2.1.312):
  - Window map: `M=[["five_hour","5h"],["seven_day","7d"],["seven_day_overage_included","7d_oi"],["overage","overage"]]`.
  - Per window: `anthropic-ratelimit-unified-${s}-utilization`, `-reset`, `-surpassed-threshold` and `-status`.
  - Top level: `anthropic-ratelimit-unified-status`, `-reset`, `-representative-claim`, `-overage-status`.
  - Grace windows: `-grace-5h-utilization` and `-grace-7d-utilization`.
- **Values**: utilization is a fraction (0-1, and can go above 1). Reset is in epoch seconds.
- **Claude Code's own probe**: it reads these headers through a dedicated `quota_check` request:

  ```js
  s.beta.messages.create({model:hA(e),max_tokens:1,messages:[{role:"user",content:"quota"}],metadata:Qze(),...})
  .asResponse()
  ```

  `probeQuotaStatus` then runs `extractQuotaStatusFromHeaders`. So Anthropic's own client uses `max_tokens: 1`, not 0.
- **metrona** (`src/main/accounts/health.ts:73-84`):
  - Sends `POST https://api.anthropic.com/v1/messages`.
  - Headers: `authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`, `anthropic-version: 2023-06-01`.
  - Body: `{model: "claude-haiku-4-5", max_tokens: 0, messages: [{role: "user", content: "ok"}]}`.
  - It reads `-5h-` and `-7d-utilization` and `-reset` (`:88-101`).
  - It accepts a 2xx, or a 429 that carries the headers.
  - On any other answer it falls back to an SDK turn that costs quota (`:86`, `:20-71`).
- **Does `max_tokens: 0` fail? No, it is documented.** The prompt caching docs, section "Pre-warming the cache" (https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pre-warming-the-cache), say:
  - "Set `max_tokens: 0` in your request. The API reads your prompt into the model and writes the cache at any `cache_control` breakpoint, then returns immediately without generating any output. The response has an empty `content` array, `stop_reason: "max_tokens"`, and a fully populated `usage` block."
  - "Zero output tokens are billed."
  - It is rejected with `stream: true`, extended thinking, structured outputs, a forced `tool_choice`, or inside a Message Batch. metrona sets none of these.
- **Does it consume subscription quota? Unverified.**
  - Input tokens are processed and reported in `usage`. So it most likely moves utilization by a few input tokens.
  - Anthropic does not document how subscription utilization is computed.
  - Whether the limiter sends the unified headers on a `max_tokens: 0` answer is also unverified. Claude Code's probe uses `max_tokens: 1`.
- **Third-party check: unverified, secondary sources only.** Community reports show 400 "This credential is only authorized for use with Claude Code" for some direct subscription calls (for example https://claudeissues.com/issue/12021-bug-api-error-400-this-credential-is-only-authorized-for-use-with-claude-code-an). I did not confirm when the server applies it.

### 2c. The Claude Agent SDK

**`rate_limit_event`** (`sdk.d.ts:5906-5947`):

- Shape: `{type: "rate_limit_event", rate_limit_info, uuid, session_id}`.
- `rate_limit_info` fields:
  - `status`: `allowed`, `allowed_warning` or `rejected`
  - `resetsAt?` (epoch seconds)
  - `rateLimitType?`: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included` or `overage`
  - `utilization?` (0-1)
  - overage fields: `overageStatus`, `overageResetsAt`, `overageDisabledReason`, `isUsingOverage`, `overageInUse`, `overageEnabled`
  - `surpassedThreshold`, `limitScope`, `errorCode`
- The CLI builds these events from the response headers in 2b. So they arrive only after an API response.
- The CLI also throttles unchanged events (t3code `ClaudeAdapterV2.ts:3626-3627`).

**`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts?: {skipBehaviors?: boolean})`** (`sdk.d.ts:3122-3141`):

- The SDK sends control request `{subtype: "get_usage", skip_behaviors?: boolean}` (`:4389-4395`).
- The response is `SDKControlGetUsageResponse` (`:4400-4492`):
  - `session` (cost and tokens of this session)
  - `subscription_type`
  - `rate_limits_available`
  - `rate_limits` {`five_hour`, `seven_day`, `seven_day_oauth_apps`, `seven_day_opus`, `seven_day_sonnet`, `model_scoped[]`, `extra_usage`}, with utilization 0-100
  - `behaviors` (a scan of local transcripts; null with `skipBehaviors: true`)
- **Does it need a completed turn? No.**
  - The CLI handler checks `skip_behaviors`, then calls a function that reads the usage endpoint (or a cached "seeded" copy) and the session counters. It does not depend on a turn:

    ```js
    rate_limits_available: kt() && Uf()
    ```

  - t3code calls it after `initializationResult()` with a prompt that never yields (section 1). That is production use with no turn.
  - metrona calls it after a turn (`health.ts:54-57`). That works too, but costs a turn.
- **Fresh-query caveat**: the session part is all zeros. The rate-limit part needs the `user:profile` scope, so it is empty for setup-token accounts.

### 2d. Anthropic's published terms

From https://code.claude.com/docs/en/legal-and-compliance, "Authentication and credential use", read 2026-10-30:

> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.

> **Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens - sign-in to a Claude account must complete through Anthropic's own flow.

(Anthropic's original uses an em dash where this quote has "-".)

> Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above.

> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

The same page, "Acceptable use": "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."

From the Help Center article "Use the Claude Agent SDK with your Claude plan" (https://support.claude.com/en/articles/15036540). I only got a summary with short quotes, not the full text:

- An update dated June 15, 2026 says the Agent SDK credit change was paused. When you are signed in with your plan, the Agent SDK and `claude -p` "still draw from your subscription limits". Third-party app usage also "still draw[s] from your subscription limits".
- An update dated October 7, 2026 says Max and Team plans include monthly API credits, used through an API key from a linked Console org.

**For Hercule:**

- Running the unmodified `claude` binary or the Agent SDK with the user's own login is the case the terms describe as allowed.
- Hercule's own code calling `/api/oauth/usage` or `/v1/messages` with a stored subscription token is greyer: it "store[s] ... Claude.ai credentials".
- `get_usage` through the SDK keeps the call inside Anthropic's binary.
- This is a judgement call for Rogier, not a fact I can settle.

## 3. CodexBar and ccusage

### CodexBar (`d253dd11`)

Short names: `C/` = `Sources/CodexBarCore/Providers/Claude/`, `X/` = `.../Providers/Codex/`.

**Claude**

- **Source order** (`C/ClaudeSourcePlanner.swift:176-191`): OAuth, then CLI PTY, then web. An Admin key instead uses `/v1/organizations/cost_report` and `usage_report/messages` (`C/ClaudeAdminAPIUsageFetcher.swift:27-29`).
- **OAuth request**:
  - `GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1`.
  - Headers: `Bearer`, `anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-cli/<ver> (external, cli)`. The version is read from the local binary.
  - On 400, or on a 403 that does not mention `user:profile`, it retries once without the query.
  - It honours `Retry-After` per token.
  - It also calls `GET /api/oauth/profile`.
  - Source: `C/ClaudeOAuth/ClaudeOAuthUsageFetcher.swift:58-170`.
- **Token**, in order (`ClaudeOAuthCredentials.swift:336-490`):
  1. env `CODEXBAR_CLAUDE_OAUTH_TOKEN`
  2. its own cache
  3. `~/.claude/.credentials.json`, or under `$CLAUDE_CONFIG_DIR`
  4. the macOS Keychain service `Claude Code-credentials`
- **Token refresh**:
  - It does not refresh Claude Code's own token. It runs `claude /status` in a PTY so the CLI rotates it (`:1606-1622`).
  - For tokens it owns: `POST https://platform.claude.com/v1/oauth/token` with `grant_type=refresh_token` and `client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e` (`:26-28`, `:1384-1398`).
- **Web fallback**:
  - Uses the `sessionKey` cookie from the browser.
  - Calls `GET https://claude.ai/api/organizations`, then `/api/organizations/{org}/usage?cedar_ember=1`, then `/prepaid/credits` (`C/ClaudeWeb/ClaudeWebAPIFetcher.swift:111-113`, `:594-672`).
- **PTY fallback**:
  - Runs `claude --allowed-tools "" --strict-mcp-config ...`, sends `/usage`, and scrapes "Current session" and "Current week (...)" (`C/ClaudeCLISession.swift:310`, `:406-412`; `ClaudeStatusProbe.swift:266-309`).

**Codex**

- **Source order**: PAT, then OAuth, then CLI RPC. Web only when chosen (`X/CodexProviderDescriptor.swift:152-173`).
- **OAuth request** (`X/CodexOAuth/CodexOAuthUsageFetcher.swift:380-416`, `:568-675`):
  - `GET https://chatgpt.com/backend-api/wham/usage`, or `/api/codex/usage` when the base URL lacks `/backend-api`.
  - Headers: `Bearer <access_token>`, plus `ChatGPT-Account-Id`.
- **Fields** (`:6-333`):
  - `plan_type`
  - `rate_limit.primary_window` and `secondary_window` {`used_percent`, `reset_at`, `limit_window_seconds`}
  - `credits` {`has_credits`, `unlimited`, `balance`}
  - `additional_rate_limits[]`
  - `individual_limit`
- **Auth file**: `~/.codex/auth.json` or `$CODEX_HOME/auth.json` (`CodexOAuthCredentials.swift:97-112`).
- **Refresh**: it does not refresh shared tokens. It tells the user to run the Codex CLI.
- **CLI RPC**:
  - Spawns `codex -s read-only -a never app-server`.
  - Sends `initialize`, `initialized`, `account/rateLimits/read`, then `account/read` (`Sources/CodexBarCore/UsageFetcher.swift:968-1190`).
- **Local session logs**: the `token_count` events in `~/.codex/sessions` are read for cost only. Their `rate_limits` field is ignored.

**Other providers**: CodexBar lists 110 provider IDs (`docs/providers.md:11`, `:76-150`). They fall into these groups:

- provider OAuth: Gemini CLI, Vertex
- API keys: OpenRouter, z.ai, Warp, Copilot
- browser cookies: Cursor, OpenCode, Perplexity
- CLI commands: Kiro `/usage`, `amp usage`, Grok JSON-RPC
- local probes: Antigravity, JetBrains

### ccusage (`71e022a8`)

- **Now a Rust CLI.** The npm package only starts the binary. The TypeScript packages, `@ccusage/codex` included, were removed in `19ade3e430` (2026-05-17).
- **Local logs only. It never asks a vendor for live limits.** The only network calls fetch prices: LiteLLM `model_prices_and_context_window.json` and `models.dev/api.json` (`rust/crates/ccusage-core/src/pricing.rs:95-97`).
- **Claude**:
  - Reads `CLAUDE_CONFIG_DIR` (a comma list), otherwise `$XDG_CONFIG_HOME/claude` and `~/.claude`, then `projects/` (`rust/adapters/claude/src/paths.rs:23-50`).
  - Takes `message.usage` and the optional `costUSD`.
  - Drops duplicates by `message.id` + `requestId` (`rust/adapters/claude/src/lib.rs:170-280`).
- **Codex**:
  - Reads `CODEX_HOME` or `~/.codex`, then `sessions/` and `archived_sessions/` (`rust/adapters/codex/src/paths.rs:34-55`).
  - Uses `event_msg` lines with `payload.type == "token_count"` (`parser.rs:28-30`, `:165-185`).
- **5-hour blocks are a local estimate, Claude only** (`rust/crates/ccusage/src/blocks.rs:53-103`):
  - A block starts at the first entry, rounded down to the hour.
  - A new block starts after 5 hours.
  - The only vendor signal is the log line "Claude AI usage limit reached|<epoch>" (`rust/adapters/claude/src/lib.rs:915-945`).

## 4. Codex app-server

Hercule's generated types: `apps/runner/src/providers/codex/generated/ClientRequest.ts` and `v2/`. The Codex source is at `rust-v0.154.0`.

**`account/rateLimits/read`**

- **Params**: `GetAccountRateLimitsParams` (optional), with two flags:
  - `supportsLunaReserve?`
  - `excludeResetCreditDetails?`: "Skip the separate reset-credit detail lookup for background usage polls". Use this for background polls.
- **Response**: `GetAccountRateLimitsResponse`:
  - `ordinaryUsageAllowed: boolean | null`: "clients must not infer recovery from percentages or reset times"
  - `rateLimits: RateLimitSnapshot` (the single-bucket view)
  - `rateLimitsByLimitId` (keyed by `limit_id`, for example `codex`)
  - `rateLimitResetCredits` {`availableCount`, `credits[]`}
  - `accountId`
  - `rateLimitUpsell`
- **`RateLimitSnapshot`** (`v2/RateLimitSnapshot.ts`):
  - `limitId`, `limitName`, `normalModelSlug`
  - `primary` and `secondary`: `RateLimitWindow` {`usedPercent`, `windowDurationMins`, `resetsAt` (epoch seconds)}
  - `credits`: `CreditsSnapshot` {`hasCredits`, `unlimited`, `balance: string`}
  - `individualLimit`: {`limit`, `used`, `remainingPercent`, `resetsAt`}
  - `spendControlReached`
  - `planType`
  - `rateLimitReachedType`: `rate_limit_reached` or one of the `workspace_*_depleted` / `*_limit_reached` values
- **Server side** (`codex-rs/app-server/src/request_processors/account_processor.rs:1129-1230`):
  - It calls the ChatGPT backend `GET {chatgpt_base_url}/wham/usage`. With a non-`/backend-api` base it calls `/api/codex/usage` instead (`codex-rs/backend-client/src/client/rate_limit_resets.rs:126-127`).
  - It fails when the backend returns no snapshots.

**`account/rateLimits/updated`** (`v2/AccountRateLimitsUpdatedNotification.ts`)

- Payload: `{rateLimits: RateLimitSnapshot}`.
- It is "Sparse rolling rate-limit update. Clients should merge available values into the most recent `account/rateLimits/read` response or refetch that snapshot."
- It is emitted from each `TokenCountEvent` that carries `rate_limits`, that is during turns (`codex-rs/app-server/src/bespoke_event_handling.rs:1695-1715`).
- Hercule ignores it today: "rate limits are not shown yet; a separate piece of work (#625) decides how" (`apps/runner/src/providers/codex/normalize.ts:1231-1232`).

**`account/usage/read`**

- **Params**: `{threadId?}`.
- **Response**: `GetAccountTokenUsageResponse`:
  - `summary` {`lifetimeTokens`, `peakDailyTokens`, `longestRunningTurnSec`, `currentStreakDays`, `longestStreakDays`}
  - `dailyUsageBuckets[]` {`startDate`, `tokens`}
  - optional `threadUsage`, with estimated credits and USD micros per model group
- It is token activity, not limits.
- **Backend paths**: `/wham/profiles/me` (`backend-client/src/client.rs:351-362`) and `/wham/usage/thread_usage/query` (`client/thread_usage.rs:80`).

**API key vs ChatGPT sign-in: both methods fail with an API key.**

- `rateLimits/read` returns `invalid_request("chatgpt authentication required to read rate limits")` when `!auth.uses_codex_backend()` (`account_processor.rs:1139-1143`).
- `usage/read` returns the same error with "to read token usage" (`:1250-1254`).
- `uses_codex_backend` (`codex-rs/protocol/src/auth.rs:54-63`):
  - true for `Chatgpt`, `ChatgptAuthTokens`, `Headers`, `AgentIdentity`, `PersonalAccessToken`
  - false for `ApiKey`, `BedrockApiKey`, `BedrockAccessKeys`
- The official docs (https://learn.chatgpt.com/docs/app-server, formerly developers.openai.com/codex/app-server) agree:
  - `account/usage/read` "requires authentication backed by Codex services". API-key-only and Bedrock auth are not.
  - `account/rateLimits/read` is described as "fetch ChatGPT rate limits".
- Use `account/read` first. It returns `Account` = `{type: "apiKey"}` | `{type: "chatgpt", email, planType}` | `{type: "amazonBedrock", ...}` (`v2/Account.ts`). This is what t3code does.
- An OpenAI API key has no usage call here. OpenAI's own org usage API was out of scope and is not checked.

## 5. OpenRouter

**`GET https://openrouter.ai/api/v1/key`**

- Auth: `Authorization: Bearer <any API key>`.
- Docs: https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key.
- Response fields under `data`:
  - key: `label`, `limit`, `limit_remaining`, `limit_reset` (null means it never resets), `expires_at`, `include_byok_in_limit`
  - spend: `usage`, `usage_daily`, `usage_weekly`, `usage_monthly`, `byok_usage*`
  - flags: `is_free_tier`, `is_management_key` (`is_provisioning_key` is deprecated)
  - budgets: `budgets[]` and `effective_budget` {`limit_usd`, `spend_usd`, `remaining_usd`, `reset_interval`, `resets_at`}
  - `free_model_daily_requests` {`used`, `limit`, `remaining`}
- `rate_limit` is deprecated.
- The old path `/api/v1/auth/key` still answers.

**`GET https://openrouter.ai/api/v1/credits`**

- Needs a **management key**. Other keys get 403 "Only management keys can perform this operation."
- Fields: `data.total_credits` and `data.total_usage`.
- Docs: https://openrouter.ai/docs/api/api-reference/credits/get-credits.

**Rate-limit headers**

- Successful responses carry no `X-RateLimit-*` headers.
- 429 answers carry them.
- The docs recommend polling `/key` (https://openrouter.ai/docs/api/reference/limits).

## 6. Z.ai (GLM Coding Plan and API)

- **Docs**: not in docs.z.ai. The docs point to a plugin (https://docs.z.ai/devpack/extension/usage-query-plugin).
- **z.ai's own plugin code** (`zai-org/zai-coding-plugins` `plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs:44-53`) calls:
  - `{host}/api/monitor/usage/quota/limit`
  - `/model-usage`
  - `/tool-usage`

  The host is `https://api.z.ai` or `https://open.bigmodel.cn`.
- **Auth: the raw key, no `Bearer`** (`:119-122`). ZCode `docs/bigmodel-coding-plan-usage-quota.md:21-22` says `Bearer` makes auth fail. CodexBar uses `Bearer` (`zai.js:12`). Conflict, unverified.
- **`quota/limit` response**: `{code, msg, success, data: {limits[], level}}`.
  - `level` is `lite`, `pro` or `max`.
  - Each limit has `type`, `unit` (3 = hours, 5 = months, 6 = weeks), `number`, `percentage` (percent used), and `nextResetTime` (ms).
- **Which entry is which** (ZCode `docs/coding-plan-quota-remaining-api.md:33-37`):
  - 5-hour window: `TOKENS_LIMIT` with unit 3, number 5
  - weekly: `TOKENS_LIMIT` with unit 6
  - monthly MCP: `TIME_LIMIT` with unit 5
  - The Team plan returns `CREDIT_LIMIT`.
- **Errors**: they come back as HTTP 200 with a `code` in the body, for example `1000 "Authentication Failed"`. At inference time, quota errors are HTTP 429 with codes 1113 and 1308-1321 (https://docs.z.ai/api-reference/api-code).
- **Balance**:
  - None found for z.ai global.
  - BigModel CN: `GET https://www.bigmodel.cn/api/biz/account/query-customer-account-report`. Secondary (CodexBar), unverified.

## 7. OpenCode Go and OpenCode Zen

**Go: `GET https://opencode.ai/zen/go/v1/usage`**

- Confirmed in opencode's own code at `packages/core/src/usage-limits.ts:152-188`. Not in the public docs.
- Auth: `Bearer <console OAuth token or Go key>`, with `x-opencode-org-id` for console tokens.
- Response: `{usage: {rolling|weekly|monthly: {status: "ok"|"rate-limited", percent, resetsAt}}}`.
- 403 means the workspace has no Go subscription.
- t3code calls the same URL with just the Go key (section 1).
- The limits themselves are dollar amounts: 5-hour = 20% of the monthly limit, weekly = 50%, monthly = 100% (opencode docs `go.mdx:131-141`).

**Zen (pay-as-you-go, now "OpenCode Console")**

- There is no balance API. The balance shows only in the Console UI.
- At zero balance, requests get HTTP 402.
- Each response reports its own cost: `usage.cost` (USD) and `usage.opencode.billing_source` (`console/api/inference.mdx:102-133`).
- Budgets: `GET https://opencode.ai/console/api/policies/current-budgets` with `Bearer` and `x-org-id` (opencode `usage-limits.ts:75-113`). Fields: `limitDollars`, `spentDollars`, `resetsAt`.
- CodexBar reads `/console/api/billing/status` with a browser cookie. Secondary.

## 8. MiniMax

- **Account kinds**:
  - pay-as-you-go API keys
  - "M Plan" subscription keys (formerly Coding Plan, then Token Plan). Tiers: Go, Explore, Build.
  - The FAQ: "M Plan API keys are separate from standard pay-as-you-go API Keys and cannot be used interchangeably." (https://platform.minimax.io/docs/coding-plan/faq)
  - The official CLI treats keys starting with `sk-api-` as pay-as-you-go (`MiniMax-AI/cli` `src/client/endpoints.ts:57-59`).
- **Compatible endpoints**:
  - OpenAI-compatible: `https://api.minimax.io/v1` (https://platform.minimax.io/docs/api-reference/text-openai-api)
  - Anthropic-compatible: `https://api.minimax.io/anthropic` (https://platform.minimax.io/docs/api-reference/text-anthropic-api)
  - China host: pi uses `api.minimaxi.com`, the official CLI uses `https://api.minimax.cn` (`src/config/schema.ts:1-4`). Unresolved.
- **Models list**:
  - `GET https://api.minimax.io/v1/models` with `Bearer`. Returns `{object: "list", data: [{id, object, created, owned_by}]}`.
  - The Anthropic flavour is `/anthropic/v1/models` with `X-Api-Key`.
- **Quota (M Plan)**:
  - Docs: `curl https://www.minimax.io/v1/token_plan/remains -H 'Authorization: Bearer <M Plan API key>'` (FAQ above). The FAQ gives no response schema.
  - The CLI calls `{https://api.minimax.io}/v1/token_plan/remains` (`endpoints.ts:49-51`).
  - Response `{model_remains: [...]}`, each entry with:
    - `model_name`, `start_time`, `end_time`, `remains_time`
    - `current_interval_total_count`, `current_interval_usage_count`, `current_interval_remaining_percent`, `current_interval_status`
    - the matching `weekly_*` fields
  - Source: `src/types/api.ts:337-372`.
  - **Trap**: `*_usage_count` meant *remaining* in older responses. The CLI checks it against `remaining_percent` (`src/utils/quota.ts:8-16`).
  - The legacy path `/v1/api/openplatform/coding_plan/remains` is used only by CodexBar as a fallback.
- **Balance (pay-as-you-go)**:
  - `GET https://api.minimax.io/account/query_balance` with `Bearer` (`endpoints.ts:53-55`, `:73-82`).
  - Fields: `available_amount`, `cash_balance`, `voucher_balance`, `credit_balance`, `owed_amount`, `balance_alert_*`.
  - Vendor code only, not in the docs.
- **pi has a built-in `minimax` provider**:
  - `packages/ai/src/providers/minimax.ts:8-13`: id `minimax`, baseUrl `https://api.minimax.io/anthropic`, env `MINIMAX_API_KEY`, API `anthropic-messages`.
  - `minimax-cn.ts:8-13` adds `minimax-cn` with `https://api.minimaxi.com/anthropic` and `MINIMAX_CN_API_KEY`.
  - The same env mapping is in `packages/ai/src/env-api-keys.ts:105-106`.
  - pi reads no usage, quota or balance for any provider. It only adds up per-response tokens and cost (`packages/coding-agent/src/core/usage-totals.ts`).

## What Hercule does today

- **Claude**: `rate_limit_event` only raises a warning when a limit becomes blocked (`apps/runner/src/providers/claude-code-normalize.ts`, `emitUsageLimitWarning`).
- **Codex**: `account/rateLimits/updated` is dropped, pending #625 ("Rate limits: a step waits until the limit resets instead of failing").

## Open points (unverified)

- Whether `/api/oauth/usage` rejects an inference-only (setup-token) token on the server, and with which status.
- Whether a `max_tokens: 0` request moves subscription utilization, and whether its answer carries the `anthropic-ratelimit-unified-*` headers.
- Whether a direct `/v1/messages` call with a subscription token from non-Claude-Code code is refused, and when.
- The z.ai auth header form (raw key vs `Bearer`).
- The MiniMax China host (`api.minimaxi.com` vs `api.minimax.cn`).
- The exact text of the Help Center article on Agent SDK credits. I only got a summary.
