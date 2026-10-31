# What a Claude long-lived token can read about its usage and identity

Research for ticket #939. Date: 2026-10-31.

Question: a token made by `claude setup-token` (scope `user:inference` only, passed as
`CLAUDE_CODE_OAUTH_TOKEN`). Can anything read its five-hour and weekly windows, or who it
belongs to, without breaking Anthropic's terms?

## Short answer

- **Usage: yes, through the running Claude Code only.** The CLI turns the
  `anthropic-ratelimit-unified-*` response headers into `rate_limit_event`s. The gate for
  that is `user:inference`, which the token has. It does not need `user:profile`.
- In CLI 2.1.314 the event also carries both windows (`unifiedWindows.five_hour` and
  `.seven_day`: used fraction and reset time). That field is marked `@internal`.
- **Identity: no.** Every identity surface in the unmodified CLI is gated on a claude.ai
  login (or on `user:profile`). A token session reports `tokenSource` and nothing else.
- Anything where Hercule itself calls Anthropic with the token is outside the terms and
  outside Hercule's own rule. Nothing found needs it.

## How to read "verified"

- **Vendor code**: read in the installed Claude Code CLI 2.1.314 (the JS inside the binary).
  Not public API, can change without notice.
- **Docs**: stated on code.claude.com.
- **Unverified**: inferred, or needs a live run with a real token. I had no token, and I did
  not touch any real login. Nothing here was run against Anthropic's servers.

Minified names (`kt`, `Pgn`, `MUe`) change per release. Search for the quoted strings.

## 1. Does `rate_limit_event` fire for an env token?

**Yes. The only gate is `user:inference`. Verified (vendor code).**

The chain, each step read in the code:

1. **The env token gets scopes.** `CLAUDE_CODE_OAUTH_TOKEN` becomes
   `{accessToken, refreshToken: null, scopes: mT()}`. `mT(e=["user:inference"])` returns
   `CLAUDE_CODE_OAUTH_SCOPES` split on spaces, else `["user:inference"]`.
2. **`kt()` checks the scope.** `function kt(){if(!ml())return!1;return LB(Hn()?.scopes)}`.
   `LB` is `scopes.includes("user:inference")`. `ml()` is true unless an API key, an
   `apiKeyHelper`, `ANTHROPIC_AUTH_TOKEN`, a profile or bare mode takes over the session
   (I did not trace every branch; the docs' precedence list says the first three outrank
   `CLAUDE_CODE_OAUTH_TOKEN`).
3. **The header reader uses `kt()`, not the profile scope.**
   `extractQuotaStatusFromHeaders(...){...let p=kt();if(!Pgn(p)){...reset...;return null}`
   with `function Pgn(e){return e||Te()==="gateway"||oxt()}`. Otherwise it reads the
   headers (`anthropic-ratelimit-unified-5h-utilization`, `-7d-utilization`, `-reset`,
   `-status`, `-surpassed-threshold`, `-representative-claim`, `-overage-*`).
4. **A change in the readings emits a status.** It calls `emitStatusChange` when the
   status differs, or when a window reading differs from `lastEmittedWindowParts` (empty at
   start, so the first reading emits).
5. **The SDK frame is built from that status.** The listener `bpe(w)` (subscribes to
   `statusChanged`) calls `iHt` -> `E$s`, which returns
   `{type:"rate_limit_event", rate_limit_info, uuid, session_id}`. `iHt` adds
   `unifiedWindows: ii(_X(), HYs())`, built from the raw header readings.

Compare the usage read, which does need the profile scope: `rate_limits_available:
kt()&&Uf()`, `Uf()` = scopes include `user:profile` (prior research, section 2a).

**What the event carries in 2.1.314.** The zod schema of `rate_limit_info` has, besides
the fields in the public `sdk.d.ts`, an `@internal` field:

    unifiedWindows: { five_hour?, seven_day?, seven_day_overage_included? }
      each { utilization (fraction, can exceed 1), resetsAt (epoch s), status?, surpassedThreshold? }

Its description says it is "read from the anthropic-ratelimit-unified-* response headers".
The top-level `utilization` and `rateLimitType` describe only the window the server calls
representative. So `unifiedWindows` is what gives both gauges. It is not in the public
types of SDK 0.3.263 (the version Hercule pins, bundling CLI 2.1.263). Whether CLI 2.1.263
emits it is **unverified**; the installed CLI is 2.1.314.

**When it arrives: before any turn, probably.** The CLI makes its own startup call:
`oEt(...)` in "Starting background startup prefetches" runs `probeQuotaStatus`, which sends
`messages.create({max_tokens:1, messages:[{role:"user",content:"quota"}], source:"quota_check"})`
and reads the headers. Gates in the probe: `St()` (non-essential traffic disabled: skip),
`Pgn(kt())`, and `_e()` (not traced). The prefetch is skipped in bare mode and when the
last one ran less than `tengu_cicada_nap_ms` ago (a server flag). **Whether this runs in
an SDK `query()` session is unverified.** If it does, a token session reports its windows
a moment after start, from a request the CLI makes itself.

**Unverified, needs a live run with a real token:**

- The server sends the unified headers for an inference-only token. (metrona and
  Anthropic's own probe read them for subscription tokens; I found no case for this scope.)
- The startup probe fires in an SDK session, and what it does to the windows.
- Whether the one-token probe counts toward the windows (Anthropic does not document it).

## 2. Does a token session expose who it is?

**No. Verified (vendor code), except one server question below.**

**SDK `accountInfo()` and the init response `account`.** The type has `email`,
`organization`, `subscriptionType`, `tokenSource`, `apiKeySource`, `apiProvider`. The CLI
fills it in `MUe()` (mapped by `FAn()`):

- source `CLAUDE_CODE_OAUTH_TOKEN`: sets only `tokenSource = "CLAUDE_CODE_OAUTH_TOKEN"`.
- `organization` is set only when the source is `claude.ai` or `/login managed key`.
- `email` is set only under the same condition.
- `subscriptionType` is set only when the session is not an env token.

So a token session gets `{tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty"}`.
This matches the spec's "the probe usually reports none".

**The profile fetch is gated.** `GET /api/oauth/profile` (account uuid, email,
organization) is called only from functions that first check the scope:

- `populateOAuthAccountInfoIfNeeded` returns early on `if(...||!kt()||!Zp())return!1`.
  `Zp()` = scopes include `user:profile`.
- `ixt()` (organization uuid): `if(s===void 0||!Zp())return null`.

**Bootstrap.** `GET /api/claude_cli/bootstrap` is still sent with the token when the
profile scope is missing (`viaScopelessOAuth`). A 403 is logged as
"Skipped: 403 for OAuth token without profile scope". Its response schema has an
`oauth_account` object (`account_email`, `organization_name`, ...). Whether the server
answers 200 for an inference-only token is **unverified**. Even if it did, `MUe()` above
would not show the email for an env token.

**`claude auth status` exists** (`--json` default, `--text`). For an env token it
reports `loggedIn: true`, `authMethod: "oauth_token"`, `apiProvider`. `email`, `orgId`,
`orgName` and `subscriptionType` are written only when `authMethod` is `claude.ai`
(or for an API key from `/login`, or a gateway). **`/status`** (`EFn`) shows
`Auth token: CLAUDE_CODE_OAUTH_TOKEN` and no email or organization for a token.

**Caller-supplied identity is not a read.** If `CLAUDE_CODE_ACCOUNT_UUID`,
`CLAUDE_CODE_USER_EMAIL` and `CLAUDE_CODE_ORGANIZATION_UUID` are all set, the CLI stores
them as `oauthAccount`. Hercule would be telling the CLI who the user is, not asking.

**`claude setup-token` itself.** The browser flow's code exchange gives the CLI an
`account` (uuid, `email_address`) and `organization`, kept in memory as `tokenAccount`.
In setup-token mode the screen prints only "Your OAuth token (valid for ...)" and the
token, and nothing is stored. So the email passes through the CLI and is never shown.
Whether the server includes `account` for an inference-only exchange is **unverified**.

## 3. Other surfaces inside the unmodified CLI

None gives a token session more than section 1 does.

| Surface | Carries windows? | Carries identity? | Notes |
|---|---|---|---|
| `rate_limit_event` (stream-json, SDK) | yes, see section 1 | no | Needs a response (or the startup probe) |
| Status line JSON `rate_limits.five_hour` / `.seven_day` (`used_percentage` 0-100, `resets_at`) | yes | no | Built from the same raw header readings (`_X()`). Docs: "appears only for claude.ai Pro, Max, and Ultra subscribers ... only after the first API response". Interactive feature; whether it runs in `-p` or SDK mode is **unverified**. Needs a `statusLine` setting. Adds nothing over the event |
| SDK `get_usage` | no: `rate_limits_available: false`, `rate_limits: null` | no | Needs `user:profile` (prior research 2a). The `session` part is local cost and tokens |
| `result` message (`usage`, `modelUsage`, `total_cost_usd`) | no | no | Local token and cost counts only |
| `system` `api_error` / `api_retry` `rate_limits {resets_at, rate_limit_type}` | one reset time | no | Only on a quota 429 |
| Hook payloads | no | no | Searched the CLI for `rate_limits:`: only the status line, `get_usage`, the api_error frame and gateway config matched. Not an exhaustive hook audit |
| `claude auth status`, `/status`, init `account` | no | no | Section 2 |

## 4. Options for Hercule

Hercule's rule (spec 06 section 18.2, 13, ADR 0048): a subscription is read only through
the vendor's harness; Hercule never calls a vendor with a subscription credential. Anthropic's
terms (prior research 2d, quoted from code.claude.com/docs/en/legal-and-compliance) allow
the user's own unmodified Claude Code, and forbid third-party code that routes requests
through plan credentials or collects, stores or intermediates Claude.ai credentials. The
token already sits on the controller; Rogier accepted that risk on 2026-10-30 (13 risk note).
The options below add no new exposure beyond that.

### (a) Only `rate_limit_event`s from running sessions (the spec's current plan)

- **In the terms:** yes. Hercule reads the output of an unmodified `claude` that the user
  runs on their own token. It makes no call itself.
- **Gives:** both windows (needs `unifiedWindows`, so CLI 2.1.314 or later; on older CLIs
  only the representative window). Free: no extra request.
- **Gap:** nothing while no session runs, so the gauge goes stale. Show the reading's age.
- **Needs checking:** that the server sends the headers for this scope (section 1).

### (b) Other ways inside the unmodified binary

- **b1. A probe session.** Start a short Claude Code session on a runner with the token
  and no prompt, take the first `rate_limit_event`, close it. This is how spec 18.2
  already reads per-machine accounts. For a token the CLI's own startup `quota_check`
  (one output token) would produce the event.
  - **In the terms:** yes, same reasoning as (a): the CLI makes the request, and one
    token per probe at most every 15 minutes is ordinary use. This is a judgement call,
    not a fact Anthropic has stated.
  - **Risk:** the startup probe may not run in SDK mode, may be skipped by the server
    flag, and is skipped in bare mode or with non-essential traffic off. If it does not
    fire, the only way to get an event is a real turn (a prompt like "ok"), which costs
    quota. Do not build b1 before the live check below.
- **b2. Identity.** Nothing in the binary reports it (section 2). Honest choices:
  - Show what Hercule itself knows: the name the user gave the account, the date the
    token was made and its expiry (one year). No vendor call.
  - Let the user type an email as a label, marked as typed by them, never as verified.
  - For a real identity, use a `subscription-per-machine` login, which has the profile
    scope.

### (c) Outside the terms

Say plainly: all of these are out. Hercule would send the stored token to Anthropic
itself, which is both "routing requests with plan credentials" and "storing and
intermediating Claude.ai credentials", and breaks Hercule's own rule.

- `GET /api/oauth/usage` or `/api/oauth/profile` with the token. Also likely to be
  refused, since the token lacks `user:profile` (server answer unverified).
- `POST /v1/messages` (`max_tokens: 0` or `1`) with the token to read the unified headers
  (the metrona method).
- Setting `CLAUDE_CODE_OAUTH_SCOPES=user:profile` to make the CLI try. It grants nothing.
- Patching, wrapping or re-hosting the binary to print what it keeps in memory (for
  example the `tokenAccount` email). Not "unmodified".

### Recommendation

1. **Build (a).** Keep the spec text as is, and add that the event's `unifiedWindows` is
   what gives both gauges and that it is `@internal`. Show the age of the last reading.
2. **Run one live check before b1**, with a real token in a throwaway Hercule Home and a
   scratch `CLAUDE_CONFIG_DIR`. Start an SDK `query()` with streaming input that never
   yields, log message types for about 30 seconds, and see whether a `rate_limit_event`
   with `unifiedWindows` appears with no turn. Repeat with `ANTHROPIC_API_KEY` set, to
   confirm that it turns the gating off. Also record the exact CLI version used.
3. **Build b1 only if the check shows the event arrives without a turn.** Otherwise a
   token account shows a gauge only while sessions run.
4. **Identity: do not try to read it.** Use the typed name, creation date and expiry
   (b2). Close the "who does it belong to" part of the open item in spec 16 as "not
   available inside the terms".
5. **Pin the CLI version** the gauge is tested against: `unifiedWindows` is internal and
   not in the SDK 0.3.263 types.

## Sources read

| Source | Version / date | Used for | Status |
|---|---|---|---|
| Claude Code CLI binary `~/.local/share/claude/versions/2.1.314` (`strings -n 8` dump of the JS inside the Bun binary) | 2.1.314, built 2026-10-29 | Sections 1-3: `kt`, `Pgn`, `extractQuotaStatusFromHeaders`, `probeQuotaStatus`, `iHt`/`E$s`, `MUe`/`FAn`, the `rate_limit_info` schema with `unifiedWindows`, profile fetch, bootstrap, `authStatus`, `/status`, setup-token screen, status line, `get_usage` schema | verified (vendor code) |
| Agent SDK `sdk.d.ts`, `@anthropic-ai/claude-agent-sdk` (copied from the repo's pnpm store; `apps/runner/package.json:11` pins it) | 0.3.263, bundling CLI 2.1.263 | `AccountInfo` (lines 23-33), `accountInfo()` (2841), `SDKControlGetUsageResponse` (3748-3790), `SDKRateLimitInfo` (4937-4958), result message fields | verified (types). The 2.1.263 binary itself was not read |
| `research/usage-sources.md` on `research/usage-sources` | 2026-10-30 | Sections 2a-2d: `get_usage` and `/api/oauth/usage` need `user:profile`, the header names, Anthropic's terms quotes | taken from that research, not re-checked, except the points above that I re-read in 2.1.314 |
| https://code.claude.com/docs/en/authentication | read 2026-10-31 | `claude setup-token` "can only make model requests, so it can't establish Remote Control sessions or fetch claude.ai connectors"; credential precedence (API key, `apiKeyHelper`, `ANTHROPIC_AUTH_TOKEN` outrank `CLAUDE_CODE_OAUTH_TOKEN`); `/status` rows | verified (docs) |
| https://code.claude.com/docs/en/statusline | read 2026-10-31 | `rate_limits` fields and "appears only for claude.ai Pro, Max, and Ultra subscribers ... only after the first API response" | verified (docs) |
| https://code.claude.com/docs/en/legal-and-compliance | quoted in the prior research, 2026-10-30; not fetched again | Terms, section 4 | verified (docs) via prior research |
| `docs/spec/06-providers.md` lines 1394, 1917-1934; `docs/spec/16-open-items.md` line 40; `docs/spec/13-security.md` line 391; ADR 0048 | main at `9422d2c01` | Hercule's rule and the open question | repo |

**Not done:** no run against Anthropic's servers, no real token; the 2.1.263 binary was not
inspected; `oxt()` and `_e()` in the probe gates were not traced.
