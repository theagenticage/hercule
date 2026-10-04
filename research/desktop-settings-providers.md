# Research: harnesses, model sources, subscriptions, and how other apps set them up

Resolves #403 (child of map #401, "Desktop Settings: a quick port, and a new model for providers"). Researched 2026-10-04 against primary sources: vendor docs and terms, vendor source at pinned commits, live API responses. Facts only; this file makes no recommendation on Hercule's model.

Every source was retrieved 2026-10-04 unless another date is given. "No date on page" means the page shows none. "Secondary" marks a fact relayed by someone other than the vendor. Quotes that contained an em dash show it as " - " with the mark [dash].

## Versions read

| Thing | Version or commit |
|---|---|
| Claude Code | docs at code.claude.com (no versions on pages); npm `@anthropic-ai/claude-code` 2.1.289; Agent SDK `@anthropic-ai/claude-agent-sdk@0.3.289` (`sdk.d.ts`) |
| Codex | `openai/codex` main at `de3721a7be07054c8c2a41102b5a501f34155361`. Latest stable release `rust-v0.160.0` (2026-10-01); latest prerelease `rust-v0.162.0-alpha.13` (2026-10-04). Docs at learn.chatgpt.com/docs (developers.openai.com/codex now redirects there with a 308) |
| pi | `earendil-works/pi` (formerly `badlogic/pi-mono`, which 301-redirects): main at `f5d20047b3ad43d068a8eb61bd4e1f193bedbce6` and tag `v1.0.2` at `cd32f7725fdbddbaecdff5b1e68491563394e0ca`. npm `@earendil-works/pi-coding-agent` 1.0.2 |
| opencode | `anomalyco/opencode` (formerly `sst/opencode`) at `907b3bc518fa48e90e8ec24dd327d13eee71c36c` (2026-10-02), v1.18.34 |
| Zed | `zed-industries/zed` main at `a84689073d296dfd39987bc7dd478e43ef76d83a` (2026-10-03), not a release tag |
| T3 Code | `pingdotgg/t3code` at `4ee6bfd50ef4a089440d5c3662db2298da9cc50e` (2026-10-04), app 0.0.45 |
| Conductor | 0.90.0 (2026-10-02), closed source; docs and changelog only |
| Cursor, Codex app, Claude desktop, Warp, VS Code | docs as published on 2026-10-04 (VS Code pages show "last updated 9/30/2026") |

## TL;DR

- **Subscriptions are tied to harnesses by policy, not by protocol.**
  - Anthropic: a Claude subscription is for Claude Code and Anthropic's own apps. The unmodified Claude Code binary may be hosted by a platform when each user signs in with their own plan. opencode removed Claude Pro/Max login at Anthropic's legal request; pi still ships it. Anthropic's current texts disagree on whether third-party use bills plan limits or extra usage (see Conflicts).
  - OpenAI: "Sign in with ChatGPT" (late Sept 2026) lets Plus and Pro plans pay for named apps, including opencode, pi and T3 as open-source integrations. Claude Code is not on the list.
  - opencode Zen and Go, OpenRouter and Z.ai all document use from Claude Code and Codex. Z.ai limits its plan to a named tool list that includes all four harnesses. GitHub Copilot officially supports only opencode of the four.
- **Each harness has its own auth surface.** Claude Code speaks Anthropic Messages only, one credential per process. Codex speaks OpenAI Responses only (Chat Completions was removed). pi and opencode hold many providers at once, one credential per provider. All four can reach Bedrock; Vertex is missing only in Codex.
- **Model lists range from 11 to 466.** Codex bundles 11 models (8 visible). OpenRouter's live list has 466 (398 with tool support). pi's catalog has 1,537 chat models across 42 providers. models.dev (opencode's catalog) has 8,388 models across 226 providers.
- **Only Claude Code and Codex report plan windows to a program**, and only on subscription auth. Claude's call is named `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. Codex has `account/rateLimits/read`. pi and opencode report tokens and cost only.
- **Setup screens split two ways.** Products wrapping one harness (opencode, pi, Cursor, Zed's own agent) list model providers with a connect or key state per provider. Products wrapping several harnesses (Conductor, T3 Code, Warp's cloud, VS Code) put the harness first, then the login and env for each.
- **Names:** almost every product says "provider" for where models come from. Hercule's CONTEXT.md uses "Provider" for the harness adapter and avoids "harness", while Zed, Conductor, Warp, VS Code and T3 Code's marketing say "harness". T3 Code's product UI uses "Provider" and "provider instance" in Hercule's sense.

## 1. Which subscriptions may be used in which harnesses

### 1.1 Anthropic plans (Claude Free, Pro, Max, Team, Enterprise)

What it is:

- Free, Pro and Max fall under the [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (effective Oct 8 2025). Team, Enterprise and API fall under the Commercial Terms (effective Jun 17 2025), per [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) (no date on page).
- "Usage credits" (formerly "extra usage") are pay-as-you-go on top of Pro, Max 5x and Max 20x, "at standard API rates" ([Manage extra usage](https://support.claude.com/en/articles/12429409-manage-extra-usage-for-paid-claude-plans)).
- In Claude Code a plan signs in through `/login`, or through `CLAUDE_CODE_OAUTH_TOKEN`, a one-year token made by `claude setup-token`. That token "can only make model requests, so it can't establish Remote Control sessions or fetch claude.ai connectors" ([Authentication](https://code.claude.com/docs/en/authentication), no date on page).

The Agent SDK note, unchanged in substance ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), no date on page):

> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."

The [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page (no date on page; secondary sources say Feb 2026) adds:

- An exception: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under Can customers offer Claude Code in their products? above."
- Conditions on that hosting: "The Claude Code binary must not be modified." and "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential".
- A credential rule: "developers may not collect, store, or intermediate Claude.ai credentials or session tokens [dash] sign-in to a Claude account must complete through Anthropic's own flow."
- Scope: "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
- Enforcement: "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

Third-party harnesses on a Claude plan, in date order:

1. **Jan 9 2026**: server-side block of third-party OAuth. Secondary only; no primary source found on anthropic.com or support.claude.com.
2. **2026-03-19**: opencode merges [PR #18186](https://github.com/anomalyco/opencode/pull/18186), "anthropic legal requests", removing the bundled Anthropic auth plugin, the Claude Pro/Max login option and the Anthropic prompt file. Released in [v1.3.0](https://github.com/anomalyco/opencode/releases/tag/v1.3.0) on 2026-03-22.
3. **April 4 2026**: an Anthropic email to subscribers, relayed on [HN](https://news.ycombinator.com/item?id=47633396) (secondary; no primary found): "you'll no longer be able to use your Claude subscription limits for third-party harnesses including OpenClaw. ... they will require extra usage, a pay-as-you-go option billed separately from your subscription."
4. **2026-05-19** (page date), [Log in to your Claude account](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account): "Anthropic may at its discretion allow paid subscribers who have enabled usage credits to use certain third-party tools ... but reserves the right to draw use of such third-party tools from usage credits rather than subscription limits." and "Use of third-party tools that misrepresent their identity to Anthropic's servers, attempt to route third-party traffic against subscription limits, or otherwise violate applicable terms or policies is prohibited".
5. **2026-06-16** (page date), [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan): "Update June 15: We're pausing the changes to Claude Agent SDK usage described below. For now, nothing has changed: Claude Agent SDK, claude -p, and third-party app usage still draw from your subscription's usage limits."

Other terms: the [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) bar automated access "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it", and bar sharing "Account login information, Anthropic API key, or Account credentials with anyone else". The [Usage Policy](https://www.anthropic.com/legal/aup) (effective Sep 15 2025) says nothing on harnesses.

Per harness:

- **opencode** ([providers docs](https://opencode.ai/docs/providers), last commit 2026-09-03): "There are plugins that allow you to use your Claude Pro/Max models with OpenCode. Anthropic explicitly prohibits this. Previous versions of OpenCode came bundled with these plugins but that is no longer the case as of 1.3.0."
- **pi** still ships "Anthropic (Claude Pro/Max)" login (`packages/ai/src/auth/oauth/anthropic.ts`). It uses the Claude Code OAuth client ID and the scope `user:sessions:claude_code`. Since 0.66.0 it shows ([interactive-mode.ts#L318](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L318)): "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits." Its `docs/containerization.md` passes a `claude setup-token` token as `ANTHROPIC_OAUTH_TOKEN`.
- **Codex CLI**: no mechanism or policy for a Claude plan found.

### 1.2 OpenAI ChatGPT plans

- "Codex is included across ChatGPT plans, including Free and Go. Usage limits vary by plan." ([help article 11369540](https://help.openai.com/en/articles/11369540), Wayback snapshot 2026-09-22; the live page returned 403.)
- [Auth](https://learn.chatgpt.com/docs/auth): ChatGPT sign-in or API key; `codex login --device-auth`; `~/.codex/auth.json` may be copied to trusted CI and is to be treated "like a password"; an API key is recommended for CI.
- **Sign in with ChatGPT (SIWC)**, launched around DevDay 2026-09-29 (date from The New Stack, secondary). [SIWC page](https://learn.chatgpt.com/docs/sign-in-with-chatgpt) (no date on page): "In supported apps, eligible ChatGPT Plus and Pro subscribers can also choose to use their ChatGPT plan for AI requests." and "App usage counts toward your existing plan limits."
  - Open-source integrations: OpenClaw, OpenCode, Pi, T3.
  - Plan-usage partners: Amp Code, Conductor, Dactyl, Devin, Hermes Agent, Hyperagent, Kilo Code, Lovable (coming soon), Notion, Vercel, Vorflux, Warp.
  - Sign-in only: Airtable, Canva, GitLab, HubSpot, Supabase.
  - Weekly limits apply per app; ChatGPT Settings > Usage > "App limits" caps an app's share of the weekly plan.
- [Help article 20001542](https://help.openai.com/en/articles/20001542) (Wayback 2026-09-29): "the option to use your ChatGPT plan is only available with Plus and Pro." and "All users can connect their account with supported open source tools."
- [Token sharing for open source](https://developers.openai.com/siwc/token-sharing-open-source): "If you're interested in offering it in a paid or remotely hosted app, complete the interest form." Each host needs its own `ext_agent_host_id`. The [Codex app-server page](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) runs `codex app-server --listen stdio://` with `model_provider="openai_chatgpt_plan"`, `env_key="ACCESS_TOKEN"`, `wire_api="responses"`: "No separate Codex sign-in is required." The self-hosted VM page: "Host-specific usage attribution and revocation of ChatGPT plan access for transferred sessions are not yet available."
- Earlier, secondary: OpenAI's Tibo on 2026-01-09 ([post](https://x.com/thsottiaux/status/2009742187484065881)): "We are working with OpenCode to allow Codex users to use their Codex subscriptions and usage limits in OpenCode directly."
- [Terms of Use](https://openai.com/policies/row-terms-of-use/) (rest of world, effective Jan 1 2026): "You may not share your account credentials or make your account available to anyone else"; no circumventing "any rate limits or restrictions". The EU version was not checked.
- Per harness:
  - pi has `openai-chatgpt.ts` (SIWC: client `dynamic_agent_client`, agent name "Pi", scope `chatgpt.tokens.use.direct`) and `openai-codex.ts` (Codex CLI client ID `app_EMoamEEZ73f0CkXaXp7hrann`).
  - opencode has two plugins, both labelled "ChatGPT Pro/Plus (browser)" and "(headless)": one on SIWC `dynamic_agent_client`, one on the Codex CLI client ID with `originator: "opencode"`. Which one is the default was not verified.
  - Claude Code: not on the SIWC lists; no documented way found.

### 1.3 opencode Zen and Go

- **Zen** ([docs](https://opencode.ai/docs/zen), last commit 2026-10-03): "OpenCode Zen is an AI gateway", pay-as-you-go, optional auto-reload of $20 below $5, card fee 4.4% + $0.30, own OpenAI or Anthropic key supported. Endpoints `https://opencode.ai/zen/v1/responses`, `/zen/v1/messages`, `/zen/v1/chat/completions`, `/zen/v1/models/<id>`. Stated goal: "Have **no lock-in** by allowing you to use it with any other coding agent."
- **Go** ([docs](https://opencode.ai/docs/go), last commit 2026-09-28): Go $10/month, Go Plus $40/month; "Only one member per workspace can subscribe"; monthly dollar limits per model with a 5-hour cap of 20% and a weekly cap of 50%. Endpoints under `/zen/go/v1/`. "OpenCode Go is designed for OpenCode and other coding agents that produce similar types of requests. Traffic is monitored for abuse". "Validated Clients": Claude Code, Codex, Pi, Hermes, ZCode, jcode, Kilo Code CLI, with "we do not guarantee that they will continue to work in the future."
- [Terms of Service](https://opencode.ai/legal/terms-of-service) (effective Aug 15 2026): "You will only use the Services for your own internal use, and not on behalf of or for the benefit of any third party"; bans processes that "run or are activated while you are not logged into the Services".

### 1.4 OpenRouter

- [Terms](https://openrouter.ai/terms) (last updated Aug 31 2026): prepaid Credits, refunds within 24 hours, credits may expire 365 days after purchase, no reselling API access. No clause on coding agents.
- [BYOK](https://openrouter.ai/docs/guides/overview/auth/byok): fee is 5% of the normal OpenRouter cost, with $25,000 per month free.
- [Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration): `ANTHROPIC_BASE_URL="https://openrouter.ai/api"`, `ANTHROPIC_AUTH_TOKEN` set to the OpenRouter key, `ANTHROPIC_API_KEY=""` ("Must be explicitly empty"). "Claude Code with OpenRouter is only guaranteed to work with the Anthropic first-party provider."
- [Codex guide](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli): `model_provider="openrouter"`, `base_url="https://openrouter.ai/api/v1"`.
- [Ori Harness](https://openrouter.ai/blog/announcements/ori-harness/) (2026-08-04): supports Claude Code, Codex, OpenCode and Hermes; pi named as a future addition.
- Anthropic's [LLM gateway](https://code.claude.com/docs/en/llm-gateway) page: "Anthropic doesn't endorse, maintain, or audit third-party gateway products, and doesn't support routing Claude Code to non-Claude models through any gateway." The page uses no prohibition wording.

### 1.5 Z.ai GLM Coding Plan

- [Overview](https://docs.z.ai/devpack/overview): Lite, Pro, Max from $18/month. Credits per 5 hours / per week: Lite 2,000 / 10,000; Pro 12,000 / 60,000; Max 28,000 / 140,000. Models GLM-5.3 and GLM-5.3-Flash.
- [Tool Integration](https://docs.z.ai/devpack/tool/others): "The GLM Coding Plan is limited to use within the following officially supported tools and product environments". The list includes Claude Code, Codex, OpenCode and Pi, plus ZCode, Cursor, Cline, Kilo Code, Roo Code, Crush, Goose and others. Endpoints: `https://api.z.ai/api/anthropic` (Messages), `https://api.z.ai/api/coding/paas/v4` (Chat Completions), `https://api.z.ai/api/v1` (Responses).
- [Usage Policy](https://docs.z.ai/devpack/usage-policy): "Account sharing or multi-user access is prohibited." [Subscription terms §4](https://docs.z.ai/legal-agreement/subscription-terms): no "general-purpose API access ... including but not limited to directly invoking model APIs from your own applications, bots, websites, SaaS products or other systems"; "Personal-Use Only".

### 1.6 GitHub Copilot

- [Plans](https://docs.github.com/en/copilot/get-started/plans): Free, Student, Pro $10 (1,500 AI Credits), Pro+ $39 (7,000), Max $100 (20,000), Business $19/seat (1,900), Enterprise $39/seat (3,900). Billed in AI Credits since [2026-06-01](https://github.blog/changelog/2026-06-01-updates-to-github-copilot-billing-and-plans/); new signups for Student, Pro, Pro+ and Max paused.
- [Changelog 2026-01-16](https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/): "All developers with paid GitHub Copilot subscriptions (Pro, Pro+, Business, or Enterprise) can now authenticate into OpenCode using their Copilot credentials [dash] no additional AI license needed."
- The Copilot Product Specific Terms were retired 2026-03-05 and replaced by the [Generative AI Services Terms](https://github.com/customer-terms/github-generative-ai-services-terms), which have no clause on third-party clients. [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) (effective 2026-04-27): "Your login may only be used by one person"; "You may not share API tokens to exceed GitHub's rate limitations."
- pi's `github-copilot.ts` sends VS Code Copilot Chat headers (`User-Agent: GitHubCopilotChat/0.35.0`, `Copilot-Integration-Id: vscode-chat`). No GitHub statement found for pi, Claude Code or Codex.

### 1.7 Local servers

No usage policy applies. API formats:

| Server | OpenAI-compatible | Anthropic Messages |
|---|---|---|
| [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) | `/v1/chat/completions`, `/v1/responses` | `/v1/messages` |
| [Ollama](https://docs.ollama.com/api/anthropic-compatibility) | `http://localhost:11434/v1/` | `/v1/messages`; for Claude Code `ANTHROPIC_BASE_URL=http://localhost:11434`, `ANTHROPIC_AUTH_TOKEN=ollama` ([guide](https://docs.ollama.com/integrations/claude-code)) |
| [LM Studio](https://lmstudio.ai/docs/developer/anthropic-compat) | `:1234/v1/chat/completions`, `/v1/responses`, `/v1/models` | `:1234/v1/messages` |

### 1.8 Policy table

- **official**: the model source's vendor owns the harness or names it as official, supported or partner.
- **permitted**: the model source's vendor documents the use as allowed.
- **works technically**: only the harness documents it; the model source's policy is silent.

| Model source | Claude Code | Codex CLI | pi | opencode |
|---|---|---|---|---|
| Anthropic subscription | official [1] | unclear [2] | unclear [3] | prohibited [4] |
| ChatGPT plan | unclear [5] | official [6] | official [7] | official [7] |
| opencode Zen | permitted [8] | permitted [8] | permitted [8] | official [8] |
| opencode Go | permitted [9] | permitted [9] | permitted [9] | official [9] |
| OpenRouter | permitted [10] | permitted [11] | works technically [12] | permitted [12] |
| Z.ai GLM Coding Plan | official [13] | official [13] | official [13] | official [13] |
| GitHub Copilot | unclear [14] | unclear [14] | works technically [15] | official [16] |
| Local (llama.cpp, Ollama, LM Studio) | works technically [17] | works technically [17] | works technically [17] | works technically [17] |

1. Legal and compliance and Authentication pages. The hosting exception requires the unmodified binary and each end user's own credentials.
2. No mechanism or policy found.
3. Support article 13189465 allows "certain third-party tools" at Anthropic's discretion, billed from usage credits, and pi is not named. Article 15036540 says third-party use draws from plan limits. pi uses the Claude Code client ID and scope next to a ban on tools that "misrepresent their identity". With usage credits on, a reading of "permitted" is also possible.
4. opencode's providers docs and PR #18186. The Anthropic text is the same one as in [3]; opencode removed the feature at Anthropic's legal request.
5. Not on the SIWC lists; no documented way found.
6. Help article 11369540.
7. SIWC names "OpenCode, Pi" as open-source integrations; plan usage needs Plus or Pro (help article 20001542).
8. Zen docs: "no lock-in ... any other coding agent".
9. Go docs: "Validated Clients", no guarantee.
10. OpenRouter's Claude Code guide; guaranteed only with the Anthropic first-party provider. Anthropic "doesn't support" non-Claude models through gateways, which is unsupported, not prohibited.
11. OpenRouter's Codex guide.
12. Ori lists opencode as supported and pi as future; pi documents OpenRouter on its side.
13. Z.ai Tool Integration list. For Claude Code on GLM, see the gateway statement in [10].
14. No GitHub statement and no documented mechanism found.
15. pi sends VS Code Copilot Chat headers; the Generative AI Services Terms have no clause on this.
16. GitHub changelog 2026-01-16.
17. Endpoint formats in 1.7. For Claude Code on non-Claude models, see [10].

### 1.9 Auth surfaces per harness

| | Claude Code | Codex CLI | pi | opencode |
|---|---|---|---|---|
| Subscription OAuth | Claude plan via `/login`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | ChatGPT via `codex login` (browser or `--device-auth`), or `--with-access-token` | Anthropic, ChatGPT (two flows), GitHub Copilot, Kimi Code, Meta Muse, xAI, OpenRouter, Radius (Gemini CLI and Antigravity removed in 0.71.0) | ChatGPT Plus/Pro, GitHub Copilot, GitLab Duo, SuperGrok, DigitalOcean, Snowflake |
| API key | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` (bearer), `apiKeyHelper` | `OPENAI_API_KEY`, `CODEX_API_KEY`, `codex login --with-api-key` | about 33 env vars, `--api-key`, `auth.json` (`!command` allowed) | `/connect` or `opencode auth login` into `auth.json` (types `oauth`, `api`, `wellknown`), or env |
| Base URL | `ANTHROPIC_BASE_URL`, Anthropic Messages only ([gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)) | `[model_providers.<id>]` with `base_url`, `env_key`; `wire_api = "responses"` only ("chat" removed; the error links [discussion #7782](https://github.com/openai/codex/discussions/7782)) | `models.json` providers with `baseUrl` and `api` (ten wire APIs, `openai-completions` to `anthropic-messages`) | `options.baseURL` with `@ai-sdk/openai-compatible` (chat) or `@ai-sdk/openai` (responses) |
| Bedrock | yes: Invoke API and Mantle; wizard `/setup-bedrock` ([docs](https://code.claude.com/docs/en/amazon-bedrock)) | yes: built-in `amazon-bedrock` provider (Mantle, OpenAI models) | yes | yes |
| Vertex | yes, named "Google Cloud's Agent Platform"; wizard `/setup-vertex` ([docs](https://code.claude.com/docs/en/google-vertex-ai)) | no | yes | yes |
| Other | Microsoft Foundry ([docs](https://code.claude.com/docs/en/microsoft-foundry)); managed `forceLoginMethod`, `allowedProviders` (v2.1.285+) | Azure detected by URL; built-ins `ollama`, `lmstudio` | Azure; `/llama` for llama.cpp | Azure; local servers via openai-compatible |
| Credentials at once | one per process; one `CLAUDE_CONFIG_DIR` per account | one stored login; `--profile` loads `~/.codex/<name>.config.toml` | all providers active, one credential per provider ID | all providers with credentials load |
| Precedence | gateway session > cloud provider > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `apiKeyHelper` > `CLAUDE_CODE_OAUTH_TOKEN` > profile > `/login` | as configured per `model_provider` | `--api-key` > `auth.json` > `models.json` > env | model: `--model` > config > last used > built-in priority |

Sources: Claude Code [authentication](https://code.claude.com/docs/en/authentication), [model-config](https://code.claude.com/docs/en/model-config); Codex [auth](https://learn.chatgpt.com/docs/auth), [config-advanced](https://learn.chatgpt.com/docs/config-file/config-advanced), [config-reference](https://learn.chatgpt.com/docs/config-file/config-reference), [model-provider-info/src/lib.rs](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/model-provider-info/src/lib.rs); pi [providers.md](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/coding-agent/docs/providers.md), [models.md](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/coding-agent/docs/models.md); opencode [providers.mdx](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/web/src/content/docs/providers.mdx), [provider.ts](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/provider/provider.ts).

A comment in Codex's provider list: "We do not want to be in the business of adjucating which third-party providers are bundled" ([lib.rs](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/model-provider-info/src/lib.rs)).

## 2. How harnesses report models, and how many there are

Live counts, taken 2026-10-04 20:23Z:

| List | Count |
|---|---|
| OpenRouter [`/api/v1/models`](https://openrouter.ai/api/v1/models) | 466 models, 398 with tool support |
| [models.dev](https://models.dev/api.json) (opencode's catalog; [models.opencode.ai](https://models.opencode.ai/api.json) is identical) | 226 providers, 8,388 models. Per provider: openrouter 390, amazon-bedrock 191, opencode 116, google-vertex 54, openai 53, github-copilot 34, anthropic 16 |
| [pi.dev OpenRouter overlay](https://pi.dev/api/models/providers/openrouter?types=chat,image,classifier) | 469 (400 chat, 59 image, 10 classifier) |
| pi bundled catalog | 42 providers, 1,537 chat models (openrouter 400, vercel 253, amazon-bedrock 183, ...) |
| Codex bundled catalog | 11 models, 8 visible |

Per harness:

- **Claude Code** (Agent SDK [0.3.289](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.289)): `supportedModels(): ModelInfo[]` with `value`, `resolvedModel`, `displayName`, `description`, `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode`. Aliases resolve per provider (on Foundry, `opus` is Opus 4.6). `AccountInfo.apiProvider` names the active backend. Behind a gateway, model discovery is opt-in and filtered to claude or anthropic IDs ([gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery)).
- **Codex** app-server: `model/list {cursor, limit, includeHidden}`, with no provider parameter ([model.rs](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/app-server-protocol/src/protocol/v2/model.rs)). The remote catalog refreshes only on ChatGPT auth or with `model_catalog_url` set; other providers get the bundled list.
- **pi**: RPC `get_available_models` ([rpc-types.ts](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/coding-agent/src/modes/rpc/rpc-types.ts)) and `pi --list-models [search]`. Catalog is generated into the package and overlaid from pi.dev every 4 hours; `pi update --models` forces it. `/model` shows only models from configured providers.
- **opencode**: `opencode models` ([models.ts](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/cli/cmd/models.ts)) and server `GET /provider` returning `{all, default, connected}`. Catalog from models.opencode.ai with a 5-minute cache ([models-dev.ts](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/core/src/models-dev.ts)). Only the Copilot and Modal plugins fetch a live `/models`.

## 3. How harnesses report usage and plan windows

| Harness | Programmatic plan windows | When available |
|---|---|---|
| Claude Code | `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` returns `rate_limits` with `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps` (each `{utilization 0-100, resets_at ISO}`), `model_scoped`, `extra_usage`, plus `rate_limits_available`. Stream events `SDKRateLimitEvent` and `SDKUsageReport` (limits `{kind: session \| weekly_all \| weekly_scoped, percent, resets_at}`). [Statusline](https://code.claude.com/docs/en/statusline) JSON has `rate_limits.*.used_percentage` and `resets_at` (epoch seconds), plus `spend_limit`. Source: `anthropic-ratelimit-unified-*` response headers | Pro or Max subscription, or behind a gateway with a spend limit |
| Codex | `account/rateLimits/read` returns `RateLimitSnapshot {limit_id, limit_name, primary, secondary: {used_percent, window_duration_mins, resets_at}, credits {has_credits, unlimited, balance}, individual_limit, plan_type, rate_limit_reached_type}`; notification `account/rateLimits/updated` (sparse) ([account.rs](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/app-server-protocol/src/protocol/v2/account.rs)). Source: `x-codex-*` headers | ChatGPT auth only; otherwise the error "chatgpt authentication required to read rate limits" |
| pi | none; `get_session_stats` gives tokens and cost | n/a |
| opencode | none; `opencode stats` ([stats.ts](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/cli/cmd/stats.ts)) gives tokens and cost; Zen and Go limits appear only in 429 messages; no Zen balance endpoint | n/a |

Vendor APIs, outside any harness:

- Anthropic API: `anthropic-ratelimit-*` headers ([rate limits](https://platform.claude.com/docs/en/api/rate-limits)).
- OpenAI API: `x-ratelimit-*` headers ([rate limits](https://developers.openai.com/api/docs/guides/rate-limits)).
- OpenRouter: `GET /api/v1/key` for the key's limit and usage ([limits](https://openrouter.ai/docs/api-reference/limits)); `GET /api/v1/credits` needs a management key ([credits](https://openrouter.ai/docs/api-reference/get-credits)).

## 4. Prior art in setup screens

### 4.1 opencode (open source, v1.18.34)

- Desktop app on Electron 42.3.3. Settings v2 has two tab groups: Desktop (General, Shortcuts) and Server (Servers, Providers, Models).
- **Providers tab**: "Connected providers" rows, each with a source tag (Environment, API key, Config, Custom) and Disconnect; "Popular providers" with "+ Connect"; a "Custom provider" form with Provider ID, Display name, Base URL, API key, Models, Headers.
- **Models tab**: a visibility switch per model.
- TUI: `/connect` opens "Connect a provider"; `/models` groups by Favorites, Recent, then per provider; models carry variants.
- Names: agent (the loop), provider (model source), credential, "Connect".
- Screenshots (none shows the settings pages):
  - https://raw.githubusercontent.com/anomalyco/opencode/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/web/src/assets/lander/screenshot.png
  - https://raw.githubusercontent.com/anomalyco/opencode/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/web/src/assets/web/web-homepage-new-session.png
  - https://raw.githubusercontent.com/anomalyco/opencode/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/web/src/assets/web/web-homepage-active-session.png
  - https://raw.githubusercontent.com/anomalyco/opencode/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/web/src/assets/web/web-homepage-see-servers.png

### 4.2 pi (open source, v1.0.2)

- Terminal UI only. `/login` ("Add provider authentication") opens "Select provider to configure:", a fuzzy list where each row has a badge `[subscription]`, `[API key]` or `[account]` and a state ` ✓ configured`, ` • not configured` or ` ✓ env: ANTHROPIC_API_KEY` ([oauth-selector.ts](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/modes/interactive/components/oauth-selector.ts)). `/logout` "does not unset environment variables ... or revoke the credential at the provider".
- `/model` (Ctrl+L): "Scope: all | scoped" (Tab), rows `→ ✓ <id> [provider] · default`, hint "Only showing models from configured providers. Use /login to add providers.", Ctrl+S saves the default ([model-selector.ts](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/modes/interactive/components/model-selector.ts)).
- `/scoped-models`: "Model Configuration", "Session-only. Ctrl+S to save to settings.", missing models struck through with `[unavailable]`; enable all, clear all, toggle a provider, reorder.
- `/thinking`: seven levels `off | minimal | low | medium | high | xhigh | max`.
- `settings.json`: `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`, `modelThinkingLevels` (keyed by `provider/modelId`). `/settings` has no item for providers, accounts or the default model.
- Names: "agent harness" (README), provider, credential, "provider authentication", scoped models, default model.
- Screenshots (none shows `/login`, `/model` or `/settings`):
  - https://raw.githubusercontent.com/earendil-works/pi/v1.0.2/packages/coding-agent/docs/images/interactive-mode.png (pi 0.85.1; footer `(openai-codex) gpt-5.6-sol • high`, `$0.076 (sub)`)
  - https://raw.githubusercontent.com/earendil-works/pi/v1.0.2/packages/coding-agent/docs/images/tree-view.png

### 4.3 Zed (open source, main at a846890)

- Keeps two things apart ([agents.md](https://github.com/zed-industries/zed/blob/a84689073d296dfd39987bc7dd478e43ef76d83a/docs/src/ai/agents.md)): three "agent paths" (Zed Agent, External Agents over ACP, Terminal Threads; "An agent path is sometimes called a harness.") and "LLM Providers", which "do not configure External Agents or Terminal Threads".
- **Settings > AI > LLM Providers**: one block per provider. Key states "API Key Configured" and "API Key Set in Environment Variable", with "Reset Key" (disabled for env keys, tooltip "To reset your API key, unset the {ENV} environment variable."). Keys live in the system keychain; env wins over keychain.
- **Add Provider** form: "Add {OpenAI|Anthropic}-Compatible Provider" with Provider Name, API URL, API Key, and a Models list with capability checkboxes.
- Subscription sign-ins: "ChatGPT Subscription" ("Signed in as {email}"), "SuperGrok", "GitHub Copilot Chat" (device code). Claude Pro/Max: "No direct Zed LLM provider path"; used through the Claude agent or Claude Code instead ([use-an-existing-subscription.md](https://github.com/zed-industries/zed/blob/a84689073d296dfd39987bc7dd478e43ef76d83a/docs/src/ai/use-an-existing-subscription.md)).
- **External Agents**: "Add Agent" > "Install from Registry" / "Add Custom Agent" (Agent Name, Command, Arguments, Environment Variables). The agent owns its own login: "Authenticate to {agent}", "Reauthenticate", "Log Out".
- Model selector: sections "Favorite", "Recommended", then per provider. Defaults are `LanguageModelSelection {provider, model, enable_thinking, effort, speed}` under `agent.default_model`, plus per-feature keys (`subagent_model`, `commit_message_model`, `thread_summary_model`, ...). The Settings UI has no default-model field; picking a model writes it.
- Usage: plan chip in the title bar and "Subscribed to Pro"; usage detail lives on dashboard.zed.dev. No in-app usage meter found.
- Screenshots (no official image of LLM Providers or the model picker):
  - https://images.zed.dev/blog/acp-registry/in-zed.webp
  - https://zed.dev/img/agentic/api-keys.webp
  - https://images.zed.dev/blog/parallel-agents/layout.webp
  - https://images.zed.dev/blog/anthropic-subscription-changes/terminal-threads.webp

### 4.4 T3 Code (open source, 4ee6bfd, app 0.0.45)

- Drivers: Codex, Claude, Cursor, Grok, OpenCode, Antigravity, Pi, plus agents from the ACP Registry.
- **Settings > Providers**: pick the environment (machine) first, then enable a provider; install, login and config happen on that machine.
- **Instance card**: Display name, accent color, Binary path, Launch arguments, "Variables" ("API keys, base URLs, and other per-instance CLI settings."; sensitive values show "Stored secret - enter a new value to replace"), account email (hideable), "Update now", and a version warning from the model manifest's compatibility ranges.
- **Add provider** dialog ends in "Continue to sign-in". A second Claude account is a new instance with its own `CLAUDE_CONFIG_DIR`. OpenRouter is a Claude instance with env variables plus "Add custom model".
- **Codex**: "Connect with ChatGPT" (T3 installs Codex; consent text "allow sharing of your ChatGPT plan"; "Manage usage"). Several ChatGPT accounts can be picked in the model picker; CLI logins sharing `CODEX_HOME` get a "Shadow home path" per account.
- **Pi**: uses pi's own auth and model list; model "default".
- Config shapes: `ProviderInstanceConfig {driver, displayName?, accentColor?, environment?, enabled?, config?}`; `ModelSelection {instanceId, model, options?: [{id, value}]}`, where `instanceId` is "the routing key".
- **Models section**: Favorites, All, "Hidden from picker"; reorder; "Enable all" / "Disable all"; chips "Fast mode", "Thinking", "Reasoning"; a custom model editor. Picker: "Search models...", sidebar "Providers" / "Favorites", states "Unavailable", "Limited", "Not ready". Traits "Effort", "Reasoning", "Fast", "Ultrafast", "Ultrathink". Separate "Text generation model" setting and a project "Default model".
- **Usage > Limits**: accounts pooled per provider, one card per window with a segment per account and reset times, "Use reset", `/usage-limits`. "API-key accounts may not report subscription limits". OpenCode Go, Cursor and Grok also report limits. A mobile "Subscription usage" widget.
- Welcome wizard step "Check your agents" (Claude Code and Codex).
- Names: marketing says "harnesses" ("Orchestrate Claude Code, Codex, Antigravity, OpenCode, Cursor, and Grok from one surface", "Bring your own sub"); the product says "Providers", "provider instance", "account".
- Docs: [install.md#providers](https://github.com/pingdotgg/t3code/blob/4ee6bfd50ef4a089440d5c3662db2298da9cc50e/docs/user/install.md#providers), [providers-claude.md](https://github.com/pingdotgg/t3code/blob/4ee6bfd50ef4a089440d5c3662db2298da9cc50e/docs/user/providers-claude.md), [providers-codex.md](https://github.com/pingdotgg/t3code/blob/4ee6bfd50ef4a089440d5c3662db2298da9cc50e/docs/user/providers-codex.md), [providers-pi.md](https://github.com/pingdotgg/t3code/blob/4ee6bfd50ef4a089440d5c3662db2298da9cc50e/docs/user/providers-pi.md), [usage.md](https://github.com/pingdotgg/t3code/blob/4ee6bfd50ef4a089440d5c3662db2298da9cc50e/docs/user/usage.md), [welcome-wizard.md](https://github.com/pingdotgg/t3code/blob/4ee6bfd50ef4a089440d5c3662db2298da9cc50e/docs/user/welcome-wizard.md), [composer.md](https://github.com/pingdotgg/t3code/blob/4ee6bfd50ef4a089440d5c3662db2298da9cc50e/docs/user/composer.md).
- Screenshot (no official image of the settings pages): https://raw.githubusercontent.com/pingdotgg/t3code/4ee6bfd50ef4a089440d5c3662db2298da9cc50e/apps/marketing/src/assets/app-desktop.webp

### 4.5 Conductor (closed source, 0.90.0)

- "A harness is the agent runtime that writes code; Conductor is the workspace layer around it." Harnesses: Claude Code, Codex, OpenCode (bundled) and Cursor (through its API) ([harnesses](https://www.conductor.build/docs/reference/harnesses)). "Each chat tab uses one harness and one selected model." Conductor "does not bill or resell model usage".
- Default auth: "Conductor uses the auth tokens already saved on your machine", with "API key mode in Settings → Harnesses" as the override ([FAQ](https://www.conductor.build/docs/faq)). Claude login runs an embedded `claude /login` terminal. "Continue with ChatGPT" under Settings → Agents → Codex ([0.89.0](https://www.conductor.build/changelog/0.89.0-sign-in-with-chatgpt)); since [0.90.0](https://www.conductor.build/changelog/0.90.0-conductor-for-ios) a ChatGPT login and a Codex login coexist.
- Model sources for Claude Code are env variables in Settings → Environment (OpenRouter, Vercel AI Gateway, GLM, Bedrock recipes) ([providers](https://www.conductor.build/docs/guides/providers)). Settings keys `claude_provider`, `codex_provider`, `bedrock_region`, `vertex_project_id`.
- The model picker chooses the harness too ("choose a Claude Code, Codex, Cursor, or OpenCode model"); favorites are a "loadout", shareable with an "Equip" button. `models.default`, `models.review` and per-harness effort defaults live in `~/.conductor/settings.toml`.
- Usage: hovering the context ring shows Codex limits and reset times ([0.75.0](https://www.conductor.build/changelog/0.75.0-polish)), later Claude limits "matching Codex" ([0.86.0](https://www.conductor.build/changelog/0.86.0-share-your-loadouts)), and which ChatGPT account the chat uses (0.90.0).
- Screenshots:
  - https://www.conductor.build/changelog/model-picker-0.85.0.png
  - https://www.conductor.build/changelog/sign-in-with-chatgpt-0.89.0.png
  - https://www.conductor.build/changelog/codex-usage-0.75.0.png
  - https://conductor-marketing.t3.tigrisfiles.io/uploads/1779475000001-provider-settings-0.56.0.png
  - https://conductor-marketing.t3.tigrisfiles.io/uploads/1776198034649-image.png (Bedrock model config, 0.48.0)

### 4.6 Cursor (closed source)

- BYOK in Cursor Settings > Models: one key per provider (OpenAI, Anthropic, Google, Azure OpenAI, AWS Bedrock); chat only, Tab keeps Cursor's models; no base URL override documented ([api-keys](https://cursor.com/help/models-and-usage/api-keys)). Bedrock uses an IAM role ARN, region and test model ID ([aws-bedrock](https://cursor.com/docs/customizing/aws-bedrock)).
- Admins manage "Model Providers", defaults and BYOK in Team Settings > Models ([enterprise](https://cursor.com/docs/enterprise/model-and-integration-management)).
- Default is Auto (Cursor Router, "Optimize For" Cost / Balance / Intelligence). Variants: Fast, long context, effort (`gpt-5-high`), Max Mode.
- Usage: two monthly pools, "Cursor Models" and "Other Models", each with usage, remaining allowance, on-demand charges and reset date ([usage-limits](https://cursor.com/help/models-and-usage/usage-limits)); CLI `/usage`.
- Screenshot: https://cursor.com/docs-static/images/settings/aws-bedrock-settings.png

### 4.7 Codex app (closed source, inside the ChatGPT desktop app)

- "Sign in with ChatGPT" or "Sign in with an API key"; desktop "Continue to sign in" with "Sign in another way" ([auth](https://learn.chatgpt.com/docs/auth)). Other backends via `model_provider` in `~/.codex/config.toml`, shared by app, CLI, IDE and SDK; "Codex uses the configured model_provider to choose which models appear".
- Composer control for model and effort: Light, Medium, High, Extra High, Max, Ultra (Ultra spawns subagents); speed Standard / Fast / Ultrafast ([pricing](https://learn.chatgpt.com/docs/pricing)).
- Usage: `/status` shows rate limits; a usage dashboard shows "current limits and reset times"; Pro has no five-hour limit.
- Settings ([settings](https://learn.chatgpt.com/docs/reference/settings)) has no providers page; Configuration > Open config.toml.
- Screenshot: https://learn.chatgpt.com/images/codex/ide-review.webp

### 4.8 Claude desktop (closed source)

- Code tab runs Claude Code sessions ([desktop](https://code.claude.com/docs/en/desktop)). Third-party inference (Agent Platform, Bedrock, Foundry, a gateway) is a deployment mode configured via Developer Mode > "Configure Third-Party Inference…", with sidebar groups starting at "Connection" and an "Apply Changes" button ([in-app config](https://claude.com/docs/third-party/claude-desktop/in-app-configuration)).
- Model dropdown next to send; effort per model under `modelSettings`.
- Usage: a ring next to the model picker shows context and "plan usage for the period"; Settings > Usage has bars for the five-hour and weekly limits with reset times, and a Usage credits section ([support 9797557](https://support.claude.com/en/articles/9797557)).
- Screenshot: https://mintcdn.com/claude-ai/kVj7_7KF4fI3bEAn/images/third-party/in-app-configuration-window.png?fit=max&auto=format&n=kVj7_7KF4fI3bEAn&q=85&s=c3f15a85dea85082bc6dbc9459e6a974

### 4.9 Warp (closed source)

- Warp Agent, plus detection of third-party CLI agents (Claude Code, Codex, OpenCode, Pi and others) running in the terminal ([cli-agents](https://docs.warp.dev/agents/cli-agents/overview/)).
- Cloud runs: "You choose the harness (agent runtime)": `oz`, `claude`, `codex`, from an "Agent harness" dropdown ([harnesses](https://docs.warp.dev/platform/harnesses/)). Credentials are "auth secrets"; Codex needs an OpenAI API key: "A ChatGPT subscription ... does not include API access" ([authentication](https://docs.warp.dev/platform/harnesses/authentication/)).
- BYOK for Anthropic, OpenAI, Google in the OS keychain, reached by searching "API keys" in Settings; "Custom inference endpoint"; BYOLLM (Enterprise). "Can I sign in with a ChatGPT or Claude subscription? No." ([byok](https://docs.warp.dev/agents/inference/bring-your-own-api-key/)). SuperGrok sign-in exists.
- Effort is encoded in the model ID (`gpt-6-sol-xhigh`). Usage is one credit pool; no percentage or reset-time display found.
- Screenshots:
  - https://docs.warp.dev/_astro/model-selector-dropdown.C5X4qk_B_1dmhsq.webp
  - https://docs.warp.dev/_astro/byok-keys.CM7Y_wy4_Z1d1VpD.webp
  - https://docs.warp.dev/_astro/cloud-agent-harness-selector-warp-app.CxxG8vW2_ZX64aO.webp
  - https://docs.warp.dev/_astro/claude-code-auth-secret-setup.Xmo2OHU7_xU5O0.webp

### 4.10 VS Code with GitHub Copilot (closed service, docs updated 9/30/2026)

- Harnesses: Copilot, Claude, Codex ([third-party agents](https://code.visualstudio.com/docs/copilot/agents/third-party-agents)). "Changing harnesses is different from switching models." Claude runs on a Copilot subscription or an Anthropic key; Codex on Copilot Pro+ or ChatGPT sign-in.
- "Language Models" editor: capabilities, context size, billing, filter by provider, pin or hide. "Add Models": built-in provider, extension, or "Custom Endpoint" (Chat Completions, Responses or Messages) ([language models](https://code.visualstudio.com/docs/copilot/customization/language-models)).
- Usage: the status bar shows the percentage of monthly AI credits used.
- Screenshots (prefix https://code.visualstudio.com):
  - /assets/docs/agent-customization/language-models/language-models-editor.png
  - /assets/docs/agent-customization/language-models/model-provider-quick-pick-v2.png
  - /assets/docs/agents/agent-harnesses/agents-window-session-target.png

## 5. Names

| Product | The harness | Where models come from | The credential |
|---|---|---|---|
| Claude Code / Claude desktop | (none; "Claude Code") | "API provider" (`apiProvider`), "3rd-party platform", "inference provider" | account, API key, log in |
| Codex | (none; "Codex") | "model provider" (`model_provider`), gateway | Sign in with ChatGPT, API key |
| pi | "agent harness" | provider | credential, "provider authentication" |
| opencode | agent | provider | credential, auth, "Connect" |
| Zed | "agent path" ("sometimes called a harness"), External Agent | "LLM Providers" | API Key, Sign In, Authenticate |
| T3 Code | "harness" (marketing); "Provider", "provider instance" (product UI); driver (code) | no separate word; set as an instance's Variables | account, sign-in, Variables |
| Conductor | harness (docs), agent (UI) | provider, model provider | auth: CLI auth / API key mode |
| Cursor | Agent | provider, Model Providers | Cursor account, API key |
| Warp | harness, "Agent harness" | providers, BYOK, custom inference endpoint | API keys, auth secrets |
| VS Code Copilot | harness | model provider, language models | GitHub account, API key, ChatGPT sign-in |

Hercule's CONTEXT.md, for contrast:

- **Provider**: "An adapter wrapping an interactive coding harness (Claude Code, Codex, pi)." _Avoid_: harness (for the adapter itself), integration.
- **Provider Instance**: "One account of a provider", with its own provider home and vendor login on every runner. _Avoid_: provider account, provider config, profile.
- **Secret Field**: _Avoid_: API key field, credential field. "API Key" is reserved for Hercule user credentials.
- **Capability Snapshot**: auth state, harness version, model catalog. _Avoid_: provider status.
- **Connection**: a named link to one external account (GitHub, Slack). _Avoid_: account, instance.

Where the words meet:

- "Provider": in Hercule it is the harness adapter. In opencode, pi, Zed, Cursor, Warp, Codex, Conductor and VS Code it is the model source. In T3 Code's product UI it is the harness, as in Hercule.
- "Harness": CONTEXT.md avoids it for the adapter. Zed, Conductor, Warp, VS Code, pi's README and T3 Code's marketing use it for the agent runtime.
- "Connect": opencode's "Connect a provider" means adding a model-source credential. Hercule's Connection is an event-source or channel account.
- "Account": T3 Code and Hercule's composer (`packages/client-core/src/threads/model-menu.ts`) call an instance an account; CONTEXT.md avoids "provider account".
- No term in CONTEXT.md names the model source (Anthropic API, ChatGPT plan, OpenRouter, Bedrock) or the plan window.

Hercule today, for the reader's orientation:

- The Claude Code and Codex plugins declare an empty config schema; only pi declares a field (`zaiApiKey`). Spec 06 §2.1 puts API keys, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_USE_BEDROCK` in instance config.
- No UI calls `provider.create`, `provider.update` or `provider.delete`; a second instance is CLI-only.
- Provider setup is spread across Fleet, the Sessions empty state, the composer, Settings > Threads, Settings > Secrets and Connections. The desktop app has no Settings screen.
- Spec 16 line 72 records the accepted posture: the user's own tool drives the user's own login through the unmodified vendor CLI.

## Conflicts and gaps

Conflicts, recorded and not resolved:

1. **Anthropic, billing third-party harness use.** The April 4 email (secondary), support article 13189465 (2026-05-19) and pi's in-app warning say third-party use draws from extra usage or usage credits. Support article 15036540 (2026-06-16) says "third-party app usage still draw from your subscription's usage limits." Both Anthropic texts are live.
2. **Warp and ChatGPT plans.** OpenAI's SIWC page lists Warp as a plan-usage partner. Warp's BYOK page says "Can I sign in with a ChatGPT or Claude subscription? No." Both retrieved 2026-10-04.
3. **opencode docs**: [providers#anthropic](https://opencode.ai/docs/providers/#anthropic) still tells the user to select the "Claude Pro/Max" option, while the same page says that plugin was removed in 1.3.0 and its example shows only "Manually enter API Key". The web and desktop app still contains the string "Login with Claude Pro/Max", shown only when a plugin offers such a method (`packages/app/src/components/dialog-connect-provider.tsx`).
4. **Conductor's settings tab** is "Harnesses" in the docs and "Agents" in the newest changelog entries (0.81.0 to 0.89.0); earlier it was "Provider" and "Providers".
5. **opencode** names reasoning presets "variant" in the TUI ("Select variant", "ctrl+t variants") and "thinking effort" in the web and desktop app ("Cycle thinking effort").
6. **Claude Code's credential file** is `.credentials.json` on the authentication page and `credentials.json` on the env-vars page.
7. **Inside Hercule**: CONTEXT.md and spec 06 §9.1 say "one instance = one login = one home"; spec 06 §11 and `ProviderLoginInput { runnerId }` make login per (instance x runner).

Two version pairs that are not conflicts:

- pi: main at `f5d2004` and tag v1.0.2 at `cd32f77` were both read; they are different commits of the same release line.
- Codex: `rust-v0.160.0` is the latest stable release; `rust-v0.162.0-alpha.13` is the latest prerelease.

Gaps:

- The SIWC launch date (2026-09-29) and Anthropic's Jan 9 and April 4 events come from secondary sources only.
- The help.openai.com pages were read from Wayback snapshots; the live pages returned 403.
- opencode's default ChatGPT login (SIWC or Codex client ID) was not verified.
- No official screenshots exist of opencode's, pi's or T3 Code's settings pages, nor of Zed's LLM Providers page.
- VS Code UI labels were read through a summarizing fetch, not checked word for word against the pages.
- Warp: no percentage or reset-time usage display found. Codex app: no documented default model.

## Sources

Policies and plans:

- Anthropic: [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Authentication](https://code.claude.com/docs/en/authentication), [LLM gateway](https://code.claude.com/docs/en/llm-gateway), [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Usage Policy](https://www.anthropic.com/legal/aup), support [13189465](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account), [15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [12429409](https://support.claude.com/en/articles/12429409-manage-extra-usage-for-paid-claude-plans), [9797557](https://support.claude.com/en/articles/9797557), [11145838](https://support.claude.com/en/articles/11145838), [HN relay of the April email](https://news.ycombinator.com/item?id=47633396)
- OpenAI: [Sign in with ChatGPT](https://learn.chatgpt.com/docs/sign-in-with-chatgpt), [help 11369540](https://help.openai.com/en/articles/11369540), [help 20001542](https://help.openai.com/en/articles/20001542), [token sharing for open source](https://developers.openai.com/siwc/token-sharing-open-source), [quickstart](https://developers.openai.com/siwc/quickstart), [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), [pricing](https://learn.chatgpt.com/docs/pricing), [Terms of Use](https://openai.com/policies/row-terms-of-use/), [Tibo 2026-01-09](https://x.com/thsottiaux/status/2009742187484065881)
- opencode: [Zen](https://opencode.ai/docs/zen), [Go](https://opencode.ai/docs/go), [providers](https://opencode.ai/docs/providers), [Terms of Service](https://opencode.ai/legal/terms-of-service), [PR #18186](https://github.com/anomalyco/opencode/pull/18186)
- OpenRouter: [Terms](https://openrouter.ai/terms), [BYOK](https://openrouter.ai/docs/guides/overview/auth/byok), [Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration), [Codex guide](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli), [Ori Harness](https://openrouter.ai/blog/announcements/ori-harness/)
- Z.ai: [overview](https://docs.z.ai/devpack/overview), [tool integration](https://docs.z.ai/devpack/tool/others), [usage policy](https://docs.z.ai/devpack/usage-policy), [subscription terms](https://docs.z.ai/legal-agreement/subscription-terms)
- GitHub: [Copilot plans](https://docs.github.com/en/copilot/get-started/plans), [billing changelog](https://github.blog/changelog/2026-06-01-updates-to-github-copilot-billing-and-plans/), [opencode changelog](https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/), [Generative AI Services Terms](https://github.com/customer-terms/github-generative-ai-services-terms), [Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
- Local: [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [Ollama Anthropic compatibility](https://docs.ollama.com/api/anthropic-compatibility), [LM Studio](https://lmstudio.ai/docs/developer/anthropic-compat)

Harnesses:

- Claude Code: [authentication](https://code.claude.com/docs/en/authentication), [gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol), [Bedrock](https://code.claude.com/docs/en/amazon-bedrock), [Vertex](https://code.claude.com/docs/en/google-vertex-ai), [Foundry](https://code.claude.com/docs/en/microsoft-foundry), [model config](https://code.claude.com/docs/en/model-config), [statusline](https://code.claude.com/docs/en/statusline), [Agent SDK 0.3.289](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.289)
- Codex: [auth](https://learn.chatgpt.com/docs/auth), [config advanced](https://learn.chatgpt.com/docs/config-file/config-advanced), [config reference](https://learn.chatgpt.com/docs/config-file/config-reference), [source at de3721a](https://github.com/openai/codex/tree/de3721a7be07054c8c2a41102b5a501f34155361)
- pi: [source at f5d2004](https://github.com/earendil-works/pi/tree/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6), [tag v1.0.2](https://github.com/earendil-works/pi/tree/v1.0.2)
- opencode: [source at 907b3bc](https://github.com/anomalyco/opencode/tree/907b3bc518fa48e90e8ec24dd327d13eee71c36c), [models.dev](https://models.dev/api.json)
- Vendor rate limits: [Anthropic](https://platform.claude.com/docs/en/api/rate-limits), [OpenAI](https://developers.openai.com/api/docs/guides/rate-limits), [OpenRouter limits](https://openrouter.ai/docs/api-reference/limits), [OpenRouter credits](https://openrouter.ai/docs/api-reference/get-credits)

Prior art: [Zed at a846890](https://github.com/zed-industries/zed/tree/a84689073d296dfd39987bc7dd478e43ef76d83a), [T3 Code at 4ee6bfd](https://github.com/pingdotgg/t3code/tree/4ee6bfd50ef4a089440d5c3662db2298da9cc50e), [Conductor docs](https://www.conductor.build/docs), [Cursor docs](https://cursor.com/docs), [Codex app docs](https://learn.chatgpt.com/docs/app), [Claude desktop docs](https://code.claude.com/docs/en/desktop), [Warp docs](https://docs.warp.dev/), [VS Code Copilot docs](https://code.visualstudio.com/docs/copilot/agents/third-party-agents). Per-product links are in section 4.
