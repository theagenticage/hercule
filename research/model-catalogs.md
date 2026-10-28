# Research: model catalogs for an "Add models" search (OpenRouter, models.dev, pi)

The question: can Hercule's desktop app offer a fast "Add models" search over the model libraries of OpenRouter, opencode (whose catalog is models.dev) and pi, and how? The use case: Rogier types "glm" and sees every GLM model each of his accounts offers, then ticks the ones he wants in the composer's model menu.

Researched 2026-10-28 against primary sources: live API responses, vendor docs, and vendor source at pinned release tags. It builds on `research/desktop-settings-providers.md` section 2 (branch `research/desktop-settings-providers`, counts taken 2026-10-04) and does not repeat it. Facts only, except the last section, which lists options and says so.

Conventions:

- Every live measurement was taken 2026-10-28 between 01:43Z and 01:56Z from one machine in the Netherlands (Cloudflare answered from AMS). Times are wall-clock for one request and will differ elsewhere.
- Every web page was retrieved 2026-10-28. "No date on page" means the page shows none.
- "gzip on wire" is what the server sent for `Accept-Encoding: gzip`. "gzip -9" is a local recompression, used where the server sent no compressed copy.
- "Secondary" marks a fact relayed by someone other than the vendor. This file uses none.
- Scripts used for the counts are described inline; the downloads and scripts lived in a scratch directory and are not committed.

## Versions read

| Thing | Version or commit |
|---|---|
| OpenRouter | Live API. OpenAPI document `https://openrouter.ai/openapi.json` (`info.version` 1.0.0). Docs as Markdown under `openrouter.ai/docs/...md` (no dates on pages). Terms "Last Updated: August 31, 2026" |
| models.dev | Repo `anomalyco/models.dev` (`sst/models.dev` redirects there), branch `dev` at `292cd702088b1141be104b81077ab4d67aaedfba` (2026-10-28T01:23:28Z). Live `api.json` with ETag `"c631ace2b31fce48a439b72a4d2caf10"` |
| opencode | Two release lines. **v1.19.4** at `148842ef7cb1bc34192b3fff57d0f9721ab9c801` (2026-10-22): GitHub's "latest" release and npm `opencode-ai` `latest`. **v2.2.0** at `1097e2668b1e08ad63bdf0b1c4860b9bc01e420c` (2026-10-27): the newest release by date, a separate major line. Both read |
| pi | `earendil-works/pi` tag **v1.4.0** at `4a080252f06caf63a525d7873c5d94d3c23887e0` (2026-10-21T22:49Z), the latest release. npm `@earendil-works/pi-ai` 1.4.0 and `@earendil-works/pi-coding-agent` 1.4.0. Bundled catalog `generatedAt` 2026-10-21T22:33:24.994Z |
| pi.dev | Live API; per-provider `last-modified` 2026-10-27 13:50Z to 13:51Z |
| Hercule | this repository at `4bea0e92` (main), for how the runner starts pi |

opencode's two lines: v1.19.2's notes say "OpenCode 1 now stays on the 1.x release line" and "Upgrading to OpenCode 2 remains a separate, explicit choice through the 2.0 offer in `/update` or `opencode upgrade --major`", and that Homebrew Core installs "now track OpenCode 2" ([v1.19.2](https://github.com/anomalyco/opencode/releases/tag/v1.19.2)). Hercule has not integrated opencode yet, so both lines matter.

## TL;DR

- **Yes, a fast search is easy: all three lists are public, need no key, and are small enough to download whole and filter locally.** A "glm" substring filter over the largest one, models.dev with 8,940 models, took 1.9 ms in Python. Only OpenRouter also searches server-side (`?q=`).
- **Sizes today:**
  - OpenRouter: 464 models, 787 KB raw, 81 KB gzip.
  - models.dev: 232 providers and 8,940 models, 5.95 MB raw, 611 KB gzip, 422 KB brotli.
  - pi.dev: 42 providers and 1,717 entries (1,602 chat). That is 944 KB over 42 requests, or 941 KB raw and 48 KB gzip in one request to an undocumented endpoint.
  - Trimmed to what a picker shows (provider, id, name, context, prices, tools, reasoning, images, date), the three come to 82 KB, 1.44 MB and 250 KB raw, or 11 KB, 164 KB and 23 KB gzip.
- **No public list knows what "his accounts" offer.**
  - Per account, OpenRouter has `GET /api/v1/models/user` with the account's key, and pi uses it to narrow its OpenRouter list.
  - opencode and pi list only providers that have a credential: `opencode models`, `GET /provider` `connected`, opencode 2's `GET /api/model`, pi's RPC `get_available_models` and `pi --list-models`.
  - For plans such as `zai-coding-plan` and `opencode-go`, the only list found is the catalog's entry for that provider.
- **The harness only runs what its own catalog or its config knows.**
  - opencode takes any extra model id from config: `provider.<id>.models` in 1.x, `providers.<id>.models` in 2.x. Unknown fields get defaults. In 1.x that means context 0, which turns off auto-compaction, plus cost 0 and no reasoning. In 2.x it means 200K context and 32K output, with tools and images on.
  - pi's CLI `--model` accepts an unknown id. It warns "Using custom model id" and copies the provider's default model's metadata.
  - pi's RPC `set_model`, the path Hercule uses, refuses ids it does not know with "Model not found". An entry in `models.json` adds them, with defaults of 128,000 context and 16,384 output.
- **Freshness differs a lot.**
  - OpenRouter is live, edge-cached for 120 s.
  - models.dev is rebuilt on every push: 942 commits in the 7 days before this check, with an hourly sync bot.
  - pi.dev publishes on weekdays between 10:00 and 15:00 Vienna time.
  - pi's bundled catalog is as old as the release; for 1.4.0 that is 2026-10-21.
  - **Hercule starts pi with `--offline`, which turns off pi's catalog refresh.** Today that hides 8 tool-capable OpenRouter models from Hercule's pi, including `openai/gpt-6.1-terra` (added 2026-10-26).
- **The catalogs disagree on details that matter in a picker.**
  - models.dev drops OpenRouter's 71 `:batch` variants.
  - models.dev marks 4 of the 7 `zai-coding-plan` models deprecated. opencode hides them; pi still lists all 7 under its `zai`.
  - OpenRouter's server-side `supported_parameters=tools` filter drops the `~…-latest` aliases.
- **Search rules differ.** OpenRouter's `q` ignores separators ("zai" finds "z-ai") and has no typo tolerance. `pi --list-models glm` is a subsequence match: with dummy keys it printed 75 rows, of which only 36 were GLM; the other 39 were Gemini, Gemma and "glimpse".
- **Licence.**
  - models.dev is MIT. pi is MIT, and pi.dev has no terms page.
  - OpenRouter publishes no licence for the list itself. Its Terms forbid scripts that "scrape or copy any information on the Site or the Services", while its docs say the Models API "makes the most important information about all LLMs freely available". This is unresolved (Conflicts 1).

## 1. OpenRouter

### 1.1 Endpoint, auth, size

- `GET https://openrouter.ai/api/v1/models`, no key. The OpenAPI document gives `getModels` `"security": null`, while the document's default is a bearer `apiKey` ([openapi.json](https://openrouter.ai/openapi.json)).
- Measured: HTTP 200, 787,030 bytes raw in 0.16 s; 81,126 bytes gzip on wire in 0.08 s. 464 models. `total_count` 464 and `links.next` `null`.
- By default only text-output models are returned. `output_modalities=all` gives 694 models in 1,033,677 bytes. The [models guide](https://openrouter.ai/docs/guides/overview/models.md) says "When the parameter is omitted, the endpoint returns text-output models only."
- Pagination is opt-in: "when both are omitted, the full list is returned and `links.next` is `null`. When you paginate, `limit` defaults to 500 (max 1000)" ([models guide](https://openrouter.ai/docs/guides/overview/models.md)). Verified: `limit=10` gave `next: "/api/v1/models?offset=10&limit=10"`.
- `GET /api/v1/models/count` answered `{"data":{"count":464}}`.
- `GET /api/v1/model/{author}/{slug}` returns one model and "resolves aliases automatically" (same guide). `z-ai/glm-5.3` gave 2,367 bytes.
- An RSS feed of new models exists at `?use_rss=true` (same guide); it answered 200 with `application/rss+xml`.

### 1.2 Fields per model

Union of keys over the 464 models: `id`, `canonical_slug`, `hugging_face_id`, `name`, `created`, `description`, `context_length`, `architecture`, `pricing`, `top_provider`, `per_request_limits`, `supported_parameters`, `default_parameters`, `supported_voices`, `knowledge_cutoff`, `expiration_date`, `links`, `reasoning`, `benchmarks`, `alias_target`.

The ones a picker would show, with how often they are set today:

| Field | Meaning (from the [models guide](https://openrouter.ai/docs/guides/overview/models.md) unless noted) | Set on |
|---|---|---|
| `id` | "Unique model identifier used in API requests" | 464 |
| `name` | "Human-readable display name", prefixed with the lab, such as "Z.ai: GLM 5.3" | 464 |
| `created` | "Unix timestamp of when the model was added to OpenRouter" | 464 |
| `context_length` | "Maximum context window size in tokens" | 464 |
| `pricing.prompt`, `pricing.completion` | USD per token, as strings; "Pricing from the top provider for this model". Conditional prices sit in `pricing.overrides` | 464 |
| `supported_parameters` | "Array of supported API parameters"; `tools` means tool calling | 464; 397 include `tools` |
| `architecture.input_modalities` | such as `["file","image","text"]` | 464; 309 include `image` |
| `reasoning` | observed object `{mandatory, default_enabled, supported_efforts, default_effort}`; not in the guide's table | 340 |
| `top_provider.max_completion_tokens` | maximum output tokens | most |
| `expiration_date` | "Deprecation date for the model endpoint (null if not deprecated)" | 14 |
| `knowledge_cutoff` | observed | 160 |
| `description` | prose, 206 characters on average | 464 |

Special ids a picker meets:

- 19 ids start with `~`, such as `~z-ai/glm-latest`. They are aliases that "always resolve to the newest concrete model in a given family" ([latest resolution](https://openrouter.ai/docs/guides/routing/routers/latest-resolution.md)). Their `alias_target` names the target.
- 71 ids end in `:batch`, and 16 end in `:free`.
- Router entries also appear in the list: `openrouter/auto`, `openrouter/free`, `openrouter/pareto-code`, `typesafe/jev-router`.

### 1.3 Server-side filtering and search

The OpenAPI operation `getModels` lists these query parameters ([openapi.json](https://openrouter.ai/openapi.json)):

- Paging and sorting:
  - `offset` and `limit`.
  - `sort`, with 12 values such as `newest`, `most-popular` and `coding-high-to-low`.
- Text search:
  - **`q`: "Free-text search by model name or slug."**
- Filters by capability:
  - `category`, such as `programming`.
  - `supported_parameters`, comma-separated.
  - `input_modalities` and `output_modalities`.
  - `context`, a minimum context length.
  - `distillable`, `zdr` and `region`.
- Filters by price:
  - `min_price`, `max_price`, `min_output_price` and `max_output_price`, in "$/M tokens".
- Filters by origin:
  - `arch`, the model family.
  - `model_authors`.
  - `providers`, the hosting provider.
- Filters by age and score:
  - `min_age_days` and `max_age_days`.
  - Minimum and maximum `intelligence_index`, `coding_index` and `agentic_index`.
  - Minimum and maximum `tool_success_rate`.

The guide page documents only `output_modalities`, `supported_parameters` and `sort`; `q` appears only in the OpenAPI document and the [API reference page](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md).

Live probes:

| Query | Models | Bytes | First request |
|---|---|---|---|
| `q=glm` | 20 | 41,068 | 0.58 s (later repeats 0.06 to 0.08 s from the edge cache) |
| `q=GLM` | 20 | 41,068 | |
| `q=zai`, `q=z.ai`, `q=z-ai`, `model_authors=z-ai` | 20 each | | |
| `q=glm5` | 11 | | |
| `q=glm%205.3`, `q=GLM-5.3` | 6 each | | |
| `q=gml` | 0 | | |
| `supported_parameters=tools` | 373 | 674,241 | 0.13 s |
| `supported_parameters=tools&q=glm` | 18 | 38,431 | |

What the probes show about `q`:

- It is case-insensitive and treats `-`, `.` and space alike: "zai" finds "z-ai", and "glm5" finds "glm-5.x".
- It does not tolerate typos: "gml" finds nothing.
- These are observations; the docs give `q` one line.

The `supported_parameters=tools` filter returns 373 models, but 397 models list `tools` in `supported_parameters`. The 24 missing are all 19 `~` aliases plus `openrouter/auto`, `openrouter/auto-beta`, `openrouter/free`, `openrouter/pareto-code` and `typesafe/jev-router`. That is why `tools&q=glm` gives 18, not 20: `~z-ai/glm-latest` and `~z-ai/glm-flash-latest` drop out.

### 1.4 Per-key list

- `GET /api/v1/models/user`: "List models filtered by user provider preferences, privacy settings, and guardrails". `security: bearer`. Query: `offset`, `limit`, `output_modalities`, `sort`; no `q` ([openapi.json](https://openrouter.ai/openapi.json), [reference page](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails.md)). "If requesting through a regional hostname, the results will be filtered to models that satisfy in-region routing for that region."
- Observed without any key: HTTP 200, the same 464 ids as the public list, `cache-control: private, no-store`. With the made-up key `sk-or-v1-invalid`: also 200. No real key was used, so per-key filtering was not observed (Gaps).
- pi uses this endpoint: `personalizeOpenRouterCatalog` "Restrict[s] an OpenRouter catalog to the chat models the key may use, with the key's limits and prices from `GET /models/user`"; on 401, 403 or 404 it returns the catalog unchanged ([openrouter.ts#L16-L58](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/src/providers/openrouter.ts#L16-L58)).

### 1.5 Rate limits and caching

- Public list headers: `cache-control: public, max-age=120, stale-while-revalidate=3600, stale-if-error=3600`, `cf-cache-status: HIT`, `access-control-allow-origin: *`. No `ETag` and no `Last-Modified`, so no conditional request is possible.
- The guide: "This schema is cached at the edge" ([models guide](https://openrouter.ai/docs/guides/overview/models.md)).
- [Limits](https://openrouter.ai/docs/api_reference/limits.md) names only free-model request caps and "Cloudflare's DDoS protection will block requests that dramatically exceed reasonable usage." It names no limit for the models endpoints. "Successful inference responses do not include `X-RateLimit-*` headers"; the models responses had none either.

### 1.6 "glm" results

Local filter (case-insensitive substring of "glm" in id or name) over the 464: 20 models, all from the author `z-ai`. The set is identical to the server's `q=glm`. Prices are per million tokens, converted from the per-token strings.

| id | name | context | in / out USD | tools | created |
|---|---|---|---|---|---|
| `z-ai/glm-5.3-prime` | Z.ai: GLM 5.3 Prime | 1,000,000 | 2.80 / 8.80 | yes | 2026-09-23 |
| `z-ai/glm-5.3-flashx` | Z.ai: GLM 5.3 FlashX | 1,048,576 | 0.37 / 1.25 | yes | 2026-09-18 |
| `~z-ai/glm-flash-latest` | Z.ai: GLM Flash Latest | 1,048,576 | 0.0345 / 0.0823 | yes | 2026-08-27 |
| `z-ai/glm-5.3-flash` | Z.ai: GLM 5.3 Flash | 1,048,576 | 0.15 / 0.50 | yes | 2026-08-26 |
| `z-ai/glm-5.3-flash:batch` | Z.ai: GLM 5.3 Flash (batch) | 1,048,576 | 0.05 / 0.18 | yes | 2026-08-26 |
| `~z-ai/glm-latest` | Z.ai: GLM Latest | 1,048,576 | 0.0699 / 1.40 | yes | 2026-08-19 |
| `z-ai/glm-5.3` | Z.ai: GLM 5.3 | 1,048,576 | 0.0699 / 1.40 | yes | 2026-08-18 |
| `z-ai/glm-5.3:batch` | Z.ai: GLM 5.3 (batch) | 1,048,576 | 0.45 / 2.00 | yes | 2026-08-18 |
| `z-ai/glm-5.2` | Z.ai: GLM 5.2 | 1,048,576 | 0.0341 / 7.00 | yes | 2026-06-16 |
| `z-ai/glm-5.1` | Z.ai: GLM 5.1 | 204,800 | 1.40 / 4.40 | yes | 2026-04-07 |
| `z-ai/glm-5v-turbo` | Z.ai: GLM 5V Turbo | 202,752 | 1.20 / 4.00 | yes | 2026-04-01 |
| `z-ai/glm-5-turbo` | Z.ai: GLM 5 Turbo | 202,752 | 1.20 / 4.00 | yes | 2026-03-15 |
| `z-ai/glm-5` | Z.ai: GLM 5 | 204,800 | 1.00 / 3.20 | yes | 2026-02-11 |
| `z-ai/glm-4.7-flash` | Z.ai: GLM 4.7 Flash | 200,000 | 0.0605 / 0.40 | yes | 2026-01-19 |
| `z-ai/glm-4.7` | Z.ai: GLM 4.7 | 204,800 | 0.54 / 1.98 | yes | 2025-12-22 |
| `z-ai/glm-4.6v` | Z.ai: GLM 4.6V | 131,072 | 0.30 / 0.90 | yes | 2025-12-08 |
| `z-ai/glm-4.6` | Z.ai: GLM 4.6 | 204,800 | 0.55 / 2.20 | yes | 2025-09-30 |
| `z-ai/glm-4.5v` | Z.ai: GLM 4.5V | 65,536 | 0.60 / 1.80 | yes | 2025-08-11 |
| `z-ai/glm-4.5` | Z.ai: GLM 4.5 | 131,072 | 0.60 / 2.20 | yes | 2025-07-25 |
| `z-ai/glm-4.5-air` | Z.ai: GLM 4.5 Air | 131,072 | 0.13 / 0.85 | yes | 2025-07-25 |

Filter time over 464 rows: 0.06 ms.

## 2. models.dev and opencode

### 2.1 `api.json`: size and shape

- `GET https://models.dev/api.json`, no key. Measured: HTTP 200, 5,953,079 bytes raw in 0.31 s (0.28 s on a repeat); 611,122 bytes gzip on wire; 422,145 bytes brotli on wire.
- `https://models.opencode.ai/api.json` returned a byte-identical body.
- Headers: `cache-control: public, max-age=0, must-revalidate`, an `etag`, `access-control-allow-origin: *`. A repeat with `If-None-Match` returned **304 with 0 bytes**.
- Shape: one object keyed by provider id. Each provider has `id`, `name`, `env` (credential variable names), `npm` (AI SDK package), `api` (base URL, optional), `doc`, and `models`, an object keyed by model id.
- Today: **232 providers, 8,940 models.** The largest providers are `nano-gpt` 652, `llmgateway-providers` 422, `vercel` 418, `kilo` 397, `openrouter` 390 and `edenai` 371.

Fields per model, with how many of the 8,940 have them:

| Field | Set on | Notes |
|---|---|---|
| `id`, `name`, `description` | 8,940 | |
| `tool_call` | 8,940 | `true` on 7,863 |
| `reasoning` | 8,940 | `true` on 6,823; `reasoning_options` (effort levels) on 6,823 |
| `attachment` | 8,940 | `true` on 5,729; "Supports file attachments" |
| `modalities.input`, `modalities.output` | 8,940 | |
| `limit.context`, `limit.output` (`limit.input` optional) | 8,940 | |
| `release_date`, `last_updated` | 8,940 | `YYYY-MM` or `YYYY-MM-DD`. The newest `last_updated` is 2026-10-27 |
| `open_weights` | 8,940 | |
| `cost.input`, `cost.output`, `cost.cache_read`, `cost.cache_write` | 8,540 | "Cost per million input tokens (USD)" |
| `family` | 8,500 | such as `glm` |
| `canonical_model_id` | 7,615 | the lab's id, such as `zhipuai/glm-5.3` |
| `knowledge` | 5,222 | |
| `status` | 979 | `deprecated` 905, `beta` 73, `alpha` 1 |
| `type` | 455 | `image` 182, `embedding` 82, `video` 69, `speech` 43, `transcription` 38, `reranking` 17, `realtime` 16, `chat` 8 |
| `provider` | 785 | a per-model `api`, `npm` or `shape` override |

The field meanings are from the README's "API Reference" ([README at 292cd70](https://github.com/anomalyco/models.dev/blob/292cd702088b1141be104b81077ab4d67aaedfba/README.md)). For a chat picker, the useful subset is the models with no `type` (or `chat`) and no `deprecated` status: 7,615 models. Of those, 6,984 have `tool_call: true`.

### 2.2 Other endpoints

There is no per-provider endpoint. `https://models.dev/api/zai.json` and `https://models.dev/zai.json` both answer 302 to `https://models.dev/`, and `?provider=zai` is ignored: it returns the full 5,953,079 bytes. The README documents ([README](https://github.com/anomalyco/models.dev/blob/292cd702088b1141be104b81077ab4d67aaedfba/README.md)):

| URL | Bytes | What |
|---|---|---|
| `api.json?type=decision` | 41,588 | only `decision` models |
| `api.json?type=all` | 5,992,509 | adds the 65 `decision` models (9,005 total) |
| `models.json` | 506,159 | "Provider-agnostic model metadata" |
| `catalog.json` | 6,459,262 | providers and model-only metadata in one |
| `model-schema.json` | 382,146 | schema |
| `logos/{provider}.svg` | | provider logos; "a default logo is served" when missing |

There is also an undocumented `GET /experimental/v2.0/api.json?type=chat,decision,image`. opencode 2.2.0 reads it (section 2.5). It returned 9,947,093 bytes raw, 735,576 gzip, 230 providers and 8,783 models, with `Cache-Control: public, max-age=3600` and a type-qualified ETag. Each model there has nested `capabilities`, `cost.text.input.price`, and `api.<protocol>.base_url` and `sdk`.

### 2.3 Provider coverage

| Provider id | Present | Models | Notes |
|---|---|---|---|
| `opencode-go` | yes | 37 | name "OpenCode Go", `api` `https://opencode.ai/inference/go/openai/v1`, env `OPENCODE_API_KEY` |
| `zai-coding-plan` | yes | 7 | name "Z.AI Coding Plan", `api` `https://api.z.ai/api/coding/paas/v4`, env `ZHIPU_API_KEY`, every `cost.input` 0 |
| `openrouter` | yes | 390 | `npm` `@openrouter/ai-sdk-provider`, env `OPENROUTER_API_KEY` |
| `opencode` (Zen) | yes | 130 | `api` `https://opencode.ai/inference/openai/v1` |
| `zai`, `zhipuai`, `zhipuai-coding-plan` | yes | 18, 17, 4 | pay-as-you-go Z.ai, and the China endpoints |

In `zai-coding-plan`, 4 of the 7 models carry `status: "deprecated"`: `glm-4.7`, `glm-5-turbo`, `glm-5.2-highspeed` and `glm-5.2`. The 3 active ones are `glm-5.3`, `glm-5.3-highspeed` and `glm-5.3-flash`.

### 2.4 Licence and update cadence

- Licence: MIT, "Copyright (c) 2025 models.dev" ([LICENSE](https://github.com/anomalyco/models.dev/blob/292cd702088b1141be104b81077ab4d67aaedfba/LICENSE)). The README states "The data is stored in the repo as TOML files", so the data is in the MIT-licensed repository.
- The site is rebuilt on every push to `dev`: [deploy.yml](https://github.com/anomalyco/models.dev/blob/292cd702088b1141be104b81077ab4d67aaedfba/.github/workflows/deploy.yml) runs on `push: branches: [dev]`.
- A sync job runs hourly at minute 17 (`cron: "17 * * * *"`, [sync-models.yml](https://github.com/anomalyco/models.dev/blob/292cd702088b1141be104b81077ab4d67aaedfba/.github/workflows/sync-models.yml)). The latest commit, "chore(sync): update NanoGPT model catalog", is by `opencode-agent[bot]`.
- Measured cadence: **942 commits** on `dev` from 2026-10-21T00:00Z to 2026-10-28T01:23Z, 104 of them on 2026-10-27.

### 2.5 How opencode reads the catalog

opencode 1.19.4 ([models-dev.ts at v1.19.4](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/core/src/models-dev.ts)):

- Fetches `${OPENCODE_MODELS_URL || "https://models.opencode.ai"}/api.json` with a 10-second timeout (L160, L175-L182). The fetched file is cached as `models.json` in opencode's cache directory.
- Release builds embed a snapshot of the catalog: `OPENCODE_MODELS_DEV: modelsData` ([build.ts#L88](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/cli/script/build.ts#L88)), fetched at build time ([generate.ts](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/cli/script/generate.ts)).
- Load order: the cached file, then the embedded snapshot, then a fetch.
- `refresh()` skips the fetch while the cache is younger than 5 minutes (L165). A background loop calls it every 60 minutes (L257).
- `OPENCODE_DISABLE_MODELS_FETCH` turns the fetch off, and `OPENCODE_MODELS_PATH` reads a file instead.

opencode 2.2.0 ([models-dev.ts at v2.2.0](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/core/src/models-dev.ts)):

- Fetches `/experimental/v2.0/api.json?type=chat,decision,image` (L129, L497), with `If-None-Match`. If a custom mirror answers 404, it falls back to `/api.json`.
- Stores the catalog in its key-value store, and refreshes every 5 minutes (`ttl` L553, `Schedule.spaced(ttl)` L692).
- A bundled `snapshot.txt` is "the boot-time floor for the catalog".

### 2.6 How opencode lists models

opencode 1.19.4:

- `opencode models [provider]` with `--verbose` and `--refresh` prints `provider/model` for every model of `provider.list()` ([models.ts at v1.19.4](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/cli/cmd/models.ts)). The docs say: "displays all models available across your configured providers" ([CLI docs](https://opencode.ai/docs/cli.md), no date on page). It has no search argument, only a provider filter.
- `provider.list()` returns only providers that something activated. In [provider.ts](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/provider/provider.ts), the sources are:
  - an environment variable, from L1636;
  - a stored API key, from L1649;
  - a plugin's auth;
  - a custom loader;
  - config.
- Inside the list, `provider.list()` also:
  - drops `deprecated` models (L1748);
  - drops `alpha` models unless experimental models are on;
  - applies the provider's `whitelist` and `blacklist`;
  - honours `enabled_providers` and `disabled_providers` (L1496).
- **Server `GET /provider`** ([handler L42-L62](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts#L42-L62)) returns three keys:
  - `all`: every models.dev provider not disabled, merged with the active ones.
  - `default`: the default model per provider.
  - `connected`: the ids that are active or have a stored credential.
  - **So `all` is not filtered to connected providers; `connected` is the filter.**
- `GET /config/providers` returns only the active providers with their defaults ("Get a list of all configured AI providers").

opencode 2.2.0:

- `opencode models` takes no provider argument. It calls the server's `model.list` and prints `providerID/id` sorted ([handlers/models.ts#L17](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/cli/src/commands/handlers/models.ts#L17)).
- `GET /api/model?types=` returns "the current snapshot of available models of the requested types, chat by default, ordered by release date within each type" ([protocol model.ts](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/protocol/src/groups/model.ts)). The list holds only enabled models of available providers ([core model.ts#L249](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/core/src/model.ts#L249)).
- A provider is available when it has a connection, is enabled in config, or needs no integration ([core provider.ts#L493-L505](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/core/src/provider.ts#L493-L505)). The comment there reads: "Connection presence decides availability".
- `GET /api/provider` lists "active AI providers". No 2.2.0 endpoint was found that returns the whole catalog as 1.x's `all` did. `GET /api/integration` lists connectable integrations and their auth methods, not models.
- The v2 docs agree: "The selector only shows enabled models whose provider is available in the current project" ([v2 Models](https://opencode.ai/v2/docs/models/), no date on page).

### 2.7 "glm" results

Local filter (case-insensitive substring of "glm" in provider, id or name) over all 8,940: **752 matches across 138 providers** in 1.85 ms. Restricted to chat models with `tool_call` that are not deprecated: 666 across 133 providers. The biggest groups are `llmgateway-providers` 63, `nano-gpt` 55, and 20 each in `llmgateway` and `tempr`.

For the accounts in question:

- **`zai-coding-plan` (7):**
  - Active: `glm-5.3` "GLM-5.3", `glm-5.3-highspeed` "GLM-5.3 Highspeed", `glm-5.3-flash` "GLM-5.3-Flash".
  - Deprecated: `glm-4.7`, `glm-5-turbo`, `glm-5.2-highspeed`, `glm-5.2`.
- **`opencode-go` (3):** `glm-5.3`, `glm-5.3-flash`, `glm-5.2`.
- **`openrouter` (18):**
  - `~z-ai/glm-flash-latest`, `~z-ai/glm-latest`.
  - `z-ai/glm-5.3`, `z-ai/glm-5.3-prime`, `z-ai/glm-5.3-flashx`, `z-ai/glm-5.3-flash`.
  - `z-ai/glm-5.2`, `z-ai/glm-5.1`, `z-ai/glm-5`, `z-ai/glm-5-turbo`, `z-ai/glm-5v-turbo`.
  - `z-ai/glm-4.7`, `z-ai/glm-4.7-flash`, `z-ai/glm-4.6`, `z-ai/glm-4.6v`, `z-ai/glm-4.5`, `z-ai/glm-4.5v`, `z-ai/glm-4.5-air`.
  - These are OpenRouter's 20 without the two `:batch` ids.
- **`opencode` (Zen, 10):**
  - Active: `glm-5.3`, `glm-5.3-flash`, `glm-5.3-flash-free`, `glm-5.2`, `glm-5.1`, `glm-5`.
  - Deprecated: `glm-4.7`, `glm-4.7-free`, `glm-5-free`, `glm-4.6`.

## 3. pi

### 3.1 Bundled catalog

- npm `@earendil-works/pi-ai` 1.4.0 ships `dist/providers/data/`: 42 provider files (986,328 bytes together; 51,225 bytes gzip -9) and a hidden `.manifest.json` with `schemaVersion` 6, `generatedAt` `2026-10-21T22:33:24.994Z` and a hash per file.
- Shape: per provider file, an object keyed by API name (such as `openai-completions` or `anthropic-messages`), then by `"<type>:<id>"`. An example key is `"chat:glm-5.3"`.
- **1,713 entries: 1,599 chat, 63 image, 51 classifier.** The largest providers are `openrouter` 492, `vercel-ai-gateway` 319 and `amazon-bedrock` 193.
- Fields per model: `id`, `name`, `api`, `provider`, `baseUrl`, `reasoning`, `thinkingLevelMap`, `input` (`text`, `image`), `cost` (`input`, `output`, `cacheRead`, `cacheWrite`, per million), `contextWindow`, `maxTokens`, `inputLimits`, `compat`, `type`.
  - No tool-support field exists, because the generator keeps only tool-capable models: `if (m.tool_call !== true) continue` for models.dev sources, and `supported_parameters?.includes("tools")` for OpenRouter ([generate-models.ts](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/scripts/generate-models.ts), [openrouter-catalog.ts#L40](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/scripts/openrouter-catalog.ts#L40)).
  - No release date exists either.
- Sources: the generator fetches `https://models.dev/api.json` (L1817) and OpenRouter's `/api/v1/models` (L1336), plus each vendor's own model list.
- **pi's `zai` provider is models.dev's `zai-coding-plan`** (source `"zai-coding-plan"`, base URL `https://api.z.ai/api/coding/paas/v4`; [generate-models.ts#L1458-L1470](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/scripts/generate-models.ts#L1458-L1470)). That loop does not skip `deprecated` models, while other loops in the same file do (L1566, L2204). Its prices come from models.dev's pay-as-you-go `zai` entry (`data.zai?.models[modelId]?.cost`).
- Licence: MIT (`package.json` and [LICENSE](https://github.com/earendil-works/pi/blob/v1.4.0/LICENSE)).

### 3.2 The pi.dev overlay API

- `GET https://pi.dev/api/models/providers/<id>?types=chat,image,classifier`, no key. It returns a JSON array of models with the same fields as the bundled files.
- **42 providers**, the same set as the bundled files. `GET https://pi.dev/api/models/providers` answered the list (586 bytes); pi's source does not call that index.
- An unknown id answers 404 (48 bytes).
- Without `types`, the server returns an object keyed by id, chat only. pi's source says that shape is for "clients that predate model types" ([remote-catalog-provider.ts#L17-L23](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/remote-catalog-provider.ts#L17-L23)).
- Measured over all 42 with `types=chat,image,classifier`: **1,717 entries (1,602 chat, 63 image, 52 classifier)**, 943,608 bytes raw. The 42 requests took 4.56 s one after another; the per-file gzip -9 sizes sum to 63,409 bytes. The largest providers are `openrouter` 490, `vercel-ai-gateway` 317 and `amazon-bedrock` 194.
- Undocumented: `GET https://pi.dev/api/models` returned all 42 providers in one object (1,602 chat models), 941,277 bytes raw, 48,186 bytes gzip on wire, 46,783 bytes brotli, in 0.14 s. pi's source does not use this endpoint either.
- Headers: `cache-control: public, max-age=60, s-maxage=60`, `etag`, `last-modified` (2026-10-27 13:50Z to 13:51Z on each provider). `If-None-Match` returned **304**.
- Licence and terms: `https://pi.dev/terms` and `https://pi.dev/legal` are 404. No terms for the API were found.
- Publication: [publish-model-catalog.yml](https://github.com/earendil-works/pi/blob/v1.4.0/.github/workflows/publish-model-catalog.yml) runs `cron: '17 8-13 * * 1-5'` and after CI on `main`. It uploads only "Monday-Friday 10:00-15:00 Europe/Vienna": scheduled runs at 10:17, 12:17 and 14:17, any CI run inside the window, or a manual run.

### 3.3 How pi refreshes and narrows

- Every built-in provider except `radius` is wrapped in `withRemoteCatalog` ([model-runtime.ts#L229-L241](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/model-runtime.ts#L229-L241)).
  - It merges the bundled models with the pi.dev ones, but only when pi.dev's `last-modified` is newer than the bundled `generatedAt`.
  - It skips the request when it checked less than 4 hours ago (`REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000`, [remote-catalog-provider.ts#L16](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/remote-catalog-provider.ts#L16)).
  - It revalidates with the ETag, and saves the result in `models-store.json` next to `models.json`.
- `openrouter` uses `withPersonalizedCatalog` instead: the merged catalog goes through `/models/user` with the account's key (section 1.4). The result keeps only models that are in both lists, with the key's context, output limit and prices.
- A refresh touches the network only for providers with a credential: `if (!credential) return;` ([models.ts#L595](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/src/models.ts#L595)).
- `--offline` sets `PI_OFFLINE=1` ([main.ts#L579-L583](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/main.ts#L579-L583)), which turns off the model network ([model-runtime.ts#L248](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/model-runtime.ts#L248)) and the RPC-mode background refresh (L940). A `models-store.json` saved earlier is still read.
- The docs say: "Pi starts with its bundled catalog and can overlay newer catalog data from pi.dev. Cached catalog data remains available offline; run `pi update --models` to force a refresh" ([models.md#L15](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models.md)).
- **Hercule starts every pi session and every pi probe with `--offline`** ([adapter.ts L611](../apps/runner/src/providers/pi/adapter.ts), [probe.ts L156](../apps/runner/src/providers/pi/probe.ts)). The probe then asks `get_available_models`. So the model list Hercule gets from pi is the bundled catalog, plus whatever the instance home's `models-store.json` already holds.

### 3.4 Listing: RPC, `--list-models`, `update --models`

- **RPC `get_available_models`** returns `session.modelRuntime.getAvailableSnapshot()` ([rpc-mode.ts#L488-L491](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L488-L491)). The method is documented as "Return chat models whose providers have complete auth configuration" ([models.ts#L293](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/src/models.ts#L293)). **Only configured providers.**
- **`pi --list-models [search]`**: "Lists available models, optionally filtered by a fuzzy search, then exits" ([cli.md](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/cli.md)).
  - It uses `` fuzzyFilter(models, searchPattern, (m) => `${m.provider} ${m.id}`) `` ([list-models.ts#L49](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/cli/list-models.ts#L49)). The rule: "Matches if all query characters appear in order (not necessarily consecutive)" ([fuzzy.ts#L3](https://github.com/earendil-works/pi/blob/v1.4.0/packages/tui/src/fuzzy.ts#L3)).
  - It then sorts by provider and id (L58), which throws away the match score.
  - Columns: provider, model, context, max-out, thinking, images. **So yes, it is a fuzzy search, and a loose one.**
- **`pi update --models`**: "Refresh model catalogs only". It runs `refresh({ allowNetwork: true, force: true })` against the agent directory ([package-manager-cli.ts#L606](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/package-manager-cli.ts#L606)). By the rule in 3.3, that covers only providers with a credential.

Run for this research: pi 1.4.0 was installed into a scratch directory with `--ignore-scripts` and run with `env -i`, `PI_CODING_AGENT_DIR=<scratch>` and `PI_OFFLINE=1`. No login was made and no request was sent to any model provider.

- `pi --version` printed `1.4.0`.
- With no credentials, `pi --list-models glm` printed "No models available. Use /login to log into a provider via OAuth or API key."
- With dummy values for `ZAI_API_KEY`, `OPENCODE_API_KEY` and `OPENROUTER_API_KEY`, it printed **75 rows**: `zai` 7, `opencode` 6, `opencode-go` 3, `openrouter` 59. Only 36 rows contain "glm". The other 39 are OpenRouter models such as `google/gemini-3.8-flash`, `google/gemma-4-26b-a4b-it` and `elorian/glimpse`, where g, l and m appear in order.

### 3.5 "glm" results

Substring filter on chat models (provider, id or name):

| List | Matches | Providers | Time |
|---|---|---|---|
| pi bundled 1.4.0 (1,599 chat) | 112 | 19 | 0.21 ms |
| pi.dev overlay (1,602 chat) | 113 | 19 | 0.21 ms |
| pi's own subsequence rule, bundled | 270 | | 0.41 ms |

For the accounts in question (bundled and pi.dev agree):

- **`zai` (Z.ai Coding Plan, 7):** `glm-4.7`, `glm-5-turbo`, `glm-5.2`, `glm-5.2-highspeed`, `glm-5.3`, `glm-5.3-flash`, `glm-5.3-highspeed`. These are all 7 of models.dev's `zai-coding-plan`, including the 4 that models.dev marks deprecated.
- **`opencode-go` (3):** `glm-5.2`, `glm-5.3`, `glm-5.3-flash`.
- **`opencode` (6):** `glm-5`, `glm-5.1`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`, `glm-5.3-flash-free`. These are models.dev's 6 active ones; the 4 deprecated are left out.
- **`openrouter` (20):** the same 20 ids as OpenRouter's live list in 1.6.

## 4. Agreement with the harness

### 4.1 Coverage measured today

The OpenRouter live list compared with its three copies, counting only the 397 live models that support tools:

| Copy | Size | Live tool-capable ids missing | Ids no longer live |
|---|---|---|---|
| models.dev `openrouter` | 390 | 73: all 71 `:batch` ids, plus `openrouter/pareto-code` and `typesafe/jev-router` | 0 |
| pi bundled 1.4.0 `openrouter` (chat) | 401 | 8, such as `openai/gpt-6.1-terra` and `openai/gpt-6.1-terra-pro` (added 2026-10-26), `moonshotai/kimi-k3.1-pro` (2026-10-23), `minimax/minimax-m3.1-flash` (2026-10-19) | 11, such as `arcee-ai/trinity-large-thinking`, `minimax/minimax-m3.1-flash:free` and three `mistralai/...:batch` |
| pi.dev `openrouter` (chat) | 398 | 1: `prism-ml/ternary-bonsai-2-9b` (2026-10-16) | 1: `auto` |

Six models were added to OpenRouter since 2026-10-21:

- models.dev had 4 of them; it lacks the two `:batch` ids.
- pi.dev had all 6.
- pi 1.4.0's bundled catalog had 1.

### 4.2 opencode: a model that is not in its catalog

- 1.x: "You can also add additional models through your opencode config", shown as `"provider": { "openrouter": { "models": { "somecoolnewmodel": {} } } }` ([providers docs, OpenRouter](https://opencode.ai/docs/providers.md), no date on page).
- 1.x defaults for a config model whose fields are not given ([provider.ts#L1544-L1633](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/provider/provider.ts#L1544-L1633)):
  - `toolcall` true;
  - `reasoning`, `attachment` and `temperature` false;
  - `limit.context` 0 and `limit.output` 0;
  - `cost` 0;
  - npm package from the provider, falling back to `@ai-sdk/openai-compatible`.
- A context of 0 turns off auto-compaction: `if (input.model.limit.context === 0) return false` ([overflow.ts#L29](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/overflow.ts#L29)).
- 2.x: config is `providers.<id>.models.<id>`, optionally with `modelID` for the upstream id ([v2 Providers](https://opencode.ai/v2/docs/providers/), no date on page). A model the catalog lacks starts from `Model.Info.default` ([schema model.ts#L135-L150](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/schema/src/model.ts#L135-L150)):
  - tools on, input text and image;
  - context 200,000 and output 32,000;
  - no cost, no variants, released 0, enabled.

### 4.3 pi: a model that is not in its catalog

- **`models.json`**: "A `models` entry adds or replaces a model with the same ID on that provider" ([models.md](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models.md)). Defaults: `reasoning` false, `input` `["text"]`, `contextWindow` 128000 and `maxTokens` 16384 ([models-configuration.md#L36-L53](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models-configuration.md)). `modelOverrides` changes metadata of an existing model.
- **CLI `--model provider/unknown-id`**: the model is not refused. `buildFallbackModel` copies the provider's default model, or else its first model, and sets the new `id` and `name`. pi then warns `Model "<id>" not found for provider "<p>". Using custom model id.` ([model-resolver.ts#L296-L307, L515-L528](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/model-resolver.ts#L296-L307)).
- **RPC `set_model`**: refused. It looks the id up in `getAvailableSnapshot()` and otherwise answers `Model not found: <provider>/<id>` ([rpc-mode.ts#L470-L478](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L470-L478)).
- Hercule passes the start model with `--model` and switches models with RPC `set_model` ([adapter.ts L624, L1474](../apps/runner/src/providers/pi/adapter.ts)).

### 4.4 What breaks

| Situation | opencode 1.19.4 | opencode 2.2.0 | pi 1.4.0 |
|---|---|---|---|
| Id in the catalog, provider connected | runs | runs | runs |
| Id in models.dev or OpenRouter but not in the harness's catalog, no config | `opencode models` and `/provider` do not list it | `/api/model` does not list it | `--model` starts it with the provider's default model's limits and prices, plus a warning; RPC `set_model` fails; `get_available_models` does not list it |
| Same id added through config | runs; context 0 means no auto-compaction; cost shows 0; no reasoning variants; no image input | runs; 200K/32K assumed, tools and images assumed on; no cost; no variants | runs; 128K/16K assumed; reasoning off unless `reasoning: true`; no cost unless given |
| Id that models.dev marks deprecated | hidden (dropped by `provider.list()`) | not checked in source | still listed for `zai` (Coding Plan) |
| OpenRouter `:batch` id | not in models.dev, so config is needed | same | in pi's list (bundled and pi.dev) |
| Model newer than the pi release, with Hercule's `--offline` | | | not listed until `models-store.json` holds it |

## 5. Measurements

| List | Request | Raw bytes | gzip on wire | Other | Count | Time |
|---|---|---|---|---|---|---|
| OpenRouter | `/api/v1/models` | 787,030 | 81,126 | gzip -9 79,462 | 464 | 0.16 s (0.13 s repeat) |
| OpenRouter | `?output_modalities=all` | 1,033,677 | | | 694 | 0.14 s |
| OpenRouter | `?q=glm` | 41,068 | | | 20 | 0.58 s cold, 0.07 s warm |
| models.dev | `/api.json` | 5,953,079 | 611,122 | brotli 422,145; `--compressed` 495,436 | 232 / 8,940 | 0.31 s (0.28 s repeat; 0.16 s compressed) |
| models.dev | `/experimental/v2.0/api.json?type=chat,decision,image` | 9,947,093 | 735,576 | | 230 / 8,783 | 0.60 s |
| pi bundled | npm `dist/providers/data/*.json` | 986,328 | | gzip -9 51,225 | 42 / 1,713 | in the package |
| pi.dev | 42 × `/api/models/providers/<id>?types=...` | 943,608 | | gzip -9 summed 63,409 | 42 / 1,717 | 4.56 s sequential |
| pi.dev | `/api/models` (undocumented) | 941,277 | 48,186 | brotli 46,783 | 42 / 1,602 chat | 0.14 s to 0.16 s |

Trimmed to picker fields: provider, id, name, context, input and output price, tools, reasoning, image input, and date.

| List | Rows | JSON bytes | gzip -9 |
|---|---|---|---|
| OpenRouter | 464 | 81,810 | 11,207 |
| models.dev | 8,940 | 1,435,206 | 163,586 |
| pi.dev chat | 1,602 | 250,444 | 22,596 |

Local "glm" filter, substring on provider, id and name, in Python 3.12:

| List | Rows | Matches | Time |
|---|---|---|---|
| OpenRouter | 464 | 20 | 0.06 ms |
| models.dev | 8,940 | 752 | 1.85 ms |
| pi bundled | 1,599 | 112 | 0.21 ms |
| pi.dev | 1,602 | 113 | 0.21 ms |

## Summary table

| Library | Endpoint | Auth | Size (raw / gzip) | Count | Freshness | Server-side filtering | Fields useful to a picker | Licence |
|---|---|---|---|---|---|---|---|---|
| OpenRouter | `GET https://openrouter.ai/api/v1/models`; per key `GET /api/v1/models/user` | none; `/models/user` is documented as bearer | 787 KB / 81 KB | 464 text models (694 with `output_modalities=all`) | live; edge `max-age=120`; no ETag | yes: `q` (name or slug), `supported_parameters`, modalities, `context`, prices, `model_authors`, `providers`, `sort`, paging | `id`, `name`, `created`, `context_length`, `pricing.prompt/completion`, `supported_parameters` (`tools`), `reasoning.supported_efforts`, `architecture.input_modalities`, `top_provider.max_completion_tokens`, `expiration_date`, `knowledge_cutoff` | none stated for the list; Terms forbid scraping or copying (Conflicts 1); OpenAPI document MIT |
| models.dev (opencode's catalog) | `GET https://models.dev/api.json` (same body at `models.opencode.ai`); opencode 2 reads `/experimental/v2.0/api.json` | none | 5.95 MB / 611 KB (brotli 422 KB) | 232 providers, 8,940 models; 7,615 chat and not deprecated | rebuilt on each push (942 commits in 7 days, hourly sync bot); `max-age=0` and ETag, 304 works | only `?type=`; no per-provider URL | provider `id`, `name`, `env`, `api`; model `id`, `name`, `family`, `tool_call`, `reasoning`, `attachment`, `modalities`, `limit.context/output`, `cost.input/output`, `release_date`, `last_updated`, `status`, `open_weights` | MIT |
| pi | bundled in npm `@earendil-works/pi-ai` `dist/providers/data/*.json`; overlay `GET https://pi.dev/api/models/providers/<id>?types=chat,image,classifier` | none | bundled 986 KB; pi.dev 944 KB over 42 requests, or 941 KB / 48 KB through the undocumented `/api/models` | 42 providers; 1,599 chat bundled, 1,602 on pi.dev | bundled: release date (2026-10-21); pi.dev: weekdays 10:00-15:00 Vienna; client re-checks after 4 h, never under `--offline`; ETag, 304 works | by provider (path) only | `id`, `name`, `provider`, `reasoning`, `thinkingLevelMap`, `input`, `cost`, `contextWindow`, `maxTokens`, `type`; tools implied (only tool-capable kept); no date | MIT (repo); pi.dev has no terms page |

## Conflicts and gaps

Conflicts, recorded and not resolved:

1. **OpenRouter, reuse of the list.**
   - The [Terms](https://openrouter.ai/terms) (Last Updated Aug 31 2026), section 7: "BY USING THE SERVICE, YOU AGREE NOT TO: ... develop, support or use software, devices, scripts, robots or any other means or processes (such as crawlers, browser plugins, add-ons or any other automated technology) to scrape or copy any information on the Site or the Services".
   - The [models guide](https://openrouter.ai/docs/guides/overview/models.md): "Our Models API makes the most important information about all LLMs freely available as soon as we confirm it", and it offers an RSS feed. pi's generator and models.dev's `openrouter` entry both copy the list.
   - No licence for the list data was found. The OpenAPI document's `info.license` is MIT, which covers the document.
2. **models.dev README and the live default.** The README says "Specialized model types are omitted by default" and "The currently supported model type is `decision`". The default `api.json` leaves out only `decision`: it still contains 455 models typed `image`, `embedding`, `video`, `speech`, `transcription`, `reranking`, `realtime` or `chat`.
3. **Deprecated Z.ai Coding Plan models.**
   - models.dev marks `glm-4.7`, `glm-5-turbo`, `glm-5.2` and `glm-5.2-highspeed` in `zai-coding-plan` as `deprecated`, which the README defines as "no longer served by the provider's public API".
   - opencode 1.19.4 hides them.
   - pi 1.4.0 still offers all four under `zai`, because its Z.ai loop does not skip `deprecated`.
   - Whether Z.ai still serves them on the Coding Plan was not checked.
4. **OpenRouter tool filter and tool field.** `?supported_parameters=tools` returns 373 models; 397 models list `tools`. The server filter drops the `~` aliases and the router models.
5. **OpenRouter `/models/user` auth.** It is documented with `security: bearer` and a 401 response. Without a key, and with an invalid key, it answered 200 with the public list.
6. **opencode's "latest".** GitHub's latest release and npm `latest` are v1.19.4. The newest release is v2.2.0 (2026-10-27), on the 2.x line that Homebrew Core now tracks. The two differ in this area:
   - catalog URL: `/api.json` in 1.x, `/experimental/v2.0/api.json` in 2.x;
   - refresh: every 60 minutes in 1.x, every 5 minutes in 2.x;
   - `opencode models [provider]` in 1.x, `opencode models` without an argument in 2.x;
   - `GET /provider` with `all` and `connected` in 1.x, `GET /api/model` and `GET /api/provider` in 2.x.
7. **Prior file, opencode cache.** The 2026-10-04 file says "a 5-minute cache". In 1.19.4 that is a 5-minute freshness check inside an hourly refresh loop, with a catalog snapshot built into the binary. In 2.2.0 the refresh runs every 5 minutes.

Drift since 2026-10-04, not conflicts:

- OpenRouter went from 466 to 464 models.
- models.dev went from 226 providers and 8,388 models to 232 and 8,940.
- pi's bundled catalog went from 1,537 chat models (v1.0.2) to 1,599 (v1.4.0). Both have 42 providers.

Gaps:

- No OpenRouter key was used, so per-key narrowing by `/models/user` was not observed.
- No live per-account model list was checked for Z.ai's Coding Plan or opencode Go. Their own `/models` endpoints need keys. For them, the catalog entry is the only list found.
- opencode was not run. Its behaviour here comes from source at v1.19.4 and v2.2.0 and from its docs.
- pi was run only for `--version` and `--list-models glm`, offline and with dummy keys. A network refresh and `pi update --models` were not observed.
- The pi.dev endpoints `/api/models` and `/api/models/providers`, and models.dev's `/experimental/v2.0/api.json`, are undocumented. pi's own client does not use the first two.
- What OpenRouter's `q` does comes from ten probes, not from docs.
- All timings are from one machine on one night.

## What this allows Hercule to design

These are options, not recommendations. Words follow GLOSSARY.md: provider instance, Capability Snapshot, model catalog.

1. **The controller holds one search index built from the public lists.**
   - The controller downloads OpenRouter, models.dev and pi.dev on a schedule, using their ETags where they have them. It normalizes the entries to one row per (source, provider, model id) and keeps only the picker fields.
   - The desktop app receives the trimmed rows (about 11 KB, 164 KB and 23 KB gzip) and filters as the user types, or the controller answers a search.
   - On cost: the full models.dev list is 6 MB raw, while its rows for the providers a user has connected are a small fraction of that.
2. **The search uses what the provider instance's harness reports.**
   - The runner's probe already asks pi `get_available_models` into the Capability Snapshot's model catalog. The opencode equivalents are `GET /provider` `connected` in 1.x and `GET /api/model` in 2.x.
   - Searching that list shows only ids the harness accepts with real metadata, and only for connected providers, which answers "what his accounts offer".
   - For pi it is as stale as the release while sessions and probes run with `--offline`. Running `pi update --models` against the instance home, or dropping `--offline` from the probe alone, would refresh it, at the cost of network calls made from inside the harness.
3. **Mix the two.**
   - The search shows the catalog rows and marks the ones the instance's harness does not list.
   - Ticking such a row would need a config entry the controller writes into the instance home: pi's `models.json`, or opencode's `provider`/`providers` models.
   - That entry needs real limits and prices copied from the catalog row. Otherwise the defaults in 4.4 apply, such as no auto-compaction in opencode 1.x.
4. **OpenRouter per account.** Call `/api/v1/models/user` with the account's key, as pi does, and intersect the result with the catalog.
5. **Search rule.** A case-insensitive substring match over provider, id and name, with `-`, `.` and spaces treated alike, behaves like OpenRouter's `q`: "zai" finds "z-ai" and "glm5" finds "glm-5.3". A subsequence match like pi's returns Gemini and Gemma for "glm".
6. **Deprecated and alias rows.**
   - Decide per source whether to show models.dev `deprecated` rows (opencode hides them, pi does not for Z.ai).
   - Decide whether to show OpenRouter `~…-latest` aliases (a moving target) and `:batch` variants (missing from models.dev).

## Sources

OpenRouter (retrieved 2026-10-28):

- Live: [`/api/v1/models`](https://openrouter.ai/api/v1/models), [`/api/v1/models/count`](https://openrouter.ai/api/v1/models/count), [`/api/v1/models/user`](https://openrouter.ai/api/v1/models/user), [`/api/v1/model/z-ai/glm-5.3`](https://openrouter.ai/api/v1/model/z-ai/glm-5.3), [RSS](https://openrouter.ai/api/v1/models?use_rss=true)
- [OpenAPI document](https://openrouter.ai/openapi.json) (version 1.0.0)
- Docs (no dates on pages): [Models guide](https://openrouter.ai/docs/guides/overview/models.md), [List all models](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md), [List models filtered by user](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails.md), [Latest model resolution](https://openrouter.ai/docs/guides/routing/routers/latest-resolution.md), [Limits](https://openrouter.ai/docs/api_reference/limits.md), [docs index](https://openrouter.ai/docs/llms.txt)
- [Terms of Service](https://openrouter.ai/terms) (Last Updated August 31, 2026)

models.dev (retrieved 2026-10-28):

- Live: [`api.json`](https://models.dev/api.json), [`api.json?type=all`](https://models.dev/api.json?type=all), [`models.json`](https://models.dev/models.json), [`catalog.json`](https://models.dev/catalog.json), [`model-schema.json`](https://models.dev/model-schema.json), [`models.opencode.ai/api.json`](https://models.opencode.ai/api.json), [experimental v2](https://models.opencode.ai/experimental/v2.0/api.json?type=chat,decision,image)
- Repo at [`292cd70`](https://github.com/anomalyco/models.dev/tree/292cd702088b1141be104b81077ab4d67aaedfba): [README](https://github.com/anomalyco/models.dev/blob/292cd702088b1141be104b81077ab4d67aaedfba/README.md), [LICENSE](https://github.com/anomalyco/models.dev/blob/292cd702088b1141be104b81077ab4d67aaedfba/LICENSE), [deploy.yml](https://github.com/anomalyco/models.dev/blob/292cd702088b1141be104b81077ab4d67aaedfba/.github/workflows/deploy.yml), [sync-models.yml](https://github.com/anomalyco/models.dev/blob/292cd702088b1141be104b81077ab4d67aaedfba/.github/workflows/sync-models.yml); commit list through the GitHub API

opencode:

- Releases: [v1.19.4](https://github.com/anomalyco/opencode/releases/tag/v1.19.4), [v1.19.2](https://github.com/anomalyco/opencode/releases/tag/v1.19.2), [v2.2.0](https://github.com/anomalyco/opencode/releases/tag/v2.2.0); npm [`opencode-ai`](https://www.npmjs.com/package/opencode-ai) dist-tags
- v1.19.4 source: [core/src/models-dev.ts](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/core/src/models-dev.ts), [cli/script/build.ts](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/cli/script/build.ts), [cli/script/generate.ts](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/cli/script/generate.ts), [cli/cmd/models.ts](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/cli/cmd/models.ts), [provider/provider.ts](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/provider/provider.ts), [handlers/provider.ts](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts), [groups/provider.ts](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/server/routes/instance/httpapi/groups/provider.ts), [handlers/config.ts](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts), [session/overflow.ts](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/overflow.ts)
- v2.2.0 source: [core/src/models-dev.ts](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/core/src/models-dev.ts), [core/src/model.ts](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/core/src/model.ts), [core/src/provider.ts](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/core/src/provider.ts), [schema/src/model.ts](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/schema/src/model.ts), [protocol groups/model.ts](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/protocol/src/groups/model.ts), [protocol groups/provider.ts](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/protocol/src/groups/provider.ts), [protocol groups/integration.ts](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/protocol/src/groups/integration.ts), [cli handlers/models.ts](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/cli/src/commands/handlers/models.ts)
- Docs (no dates on pages): [Models](https://opencode.ai/docs/models.md), [Providers](https://opencode.ai/docs/providers.md), [CLI](https://opencode.ai/docs/cli.md), [v2 Models](https://opencode.ai/v2/docs/models/), [v2 Providers](https://opencode.ai/v2/docs/providers/)

pi:

- Release [v1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0); npm [`@earendil-works/pi-ai` 1.4.0](https://www.npmjs.com/package/@earendil-works/pi-ai/v/1.4.0) (`dist/providers/data/`) and [`@earendil-works/pi-coding-agent` 1.4.0](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/1.4.0)
- Source at v1.4.0: [remote-catalog-provider.ts](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/remote-catalog-provider.ts), [model-runtime.ts](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/model-runtime.ts), [ai/src/providers/openrouter.ts](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/src/providers/openrouter.ts), [ai/src/models.ts](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/src/models.ts), [rpc-mode.ts](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/modes/rpc/rpc-mode.ts), [rpc-types.ts](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/modes/rpc/rpc-types.ts), [list-models.ts](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/cli/list-models.ts), [tui/src/fuzzy.ts](https://github.com/earendil-works/pi/blob/v1.4.0/packages/tui/src/fuzzy.ts), [main.ts](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/main.ts), [package-manager-cli.ts](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/package-manager-cli.ts), [model-resolver.ts](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/model-resolver.ts), [generate-models.ts](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/scripts/generate-models.ts), [openrouter-catalog.ts](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/scripts/openrouter-catalog.ts), [publish-model-catalog.yml](https://github.com/earendil-works/pi/blob/v1.4.0/.github/workflows/publish-model-catalog.yml), [LICENSE](https://github.com/earendil-works/pi/blob/v1.4.0/LICENSE)
- Docs at v1.4.0: [models.md](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models.md), [models-configuration.md](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models-configuration.md), [cli.md](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/cli.md), [environment-variables.md](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/environment-variables.md)
- pi.dev live (retrieved 2026-10-28): [`/api/models/providers`](https://pi.dev/api/models/providers), [`/api/models/providers/zai?types=chat,image,classifier`](https://pi.dev/api/models/providers/zai?types=chat,image,classifier), [`/api/models/providers/openrouter?types=chat,image,classifier`](https://pi.dev/api/models/providers/openrouter?types=chat,image,classifier), [`/api/models`](https://pi.dev/api/models), [model catalog page](https://pi.dev/models)

Hercule (this repository at `4bea0e92`):

- [apps/runner/src/providers/pi/adapter.ts](../apps/runner/src/providers/pi/adapter.ts) (`--offline` at L611 and L698, `--model` at L624, `set_model` at L1474)
- [apps/runner/src/providers/pi/probe.ts](../apps/runner/src/providers/pi/probe.ts) (`--offline` at L156, `get_available_models` at L172)
- Prior research: `research/desktop-settings-providers.md` on branch `research/desktop-settings-providers`
