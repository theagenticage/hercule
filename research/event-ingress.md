# Event ingress options for a self-hosted controller

Resolves [#5](https://github.com/rogierpennink/hydra/issues/5). Question: how can a self-hosted, possibly not-publicly-reachable, single-user controller receive GitHub events and Gmail messages, and what are the tradeoffs? Chat channels (Discord gateway, Slack Socket Mode) already connect outbound-only; the interesting question is whether GitHub and Gmail can too.

## GitHub events

GitHub has no official outbound event stream (no websocket firehose). The only official mechanisms are webhooks (GitHub calls you) and REST polling (you call GitHub). Everything else is a relay that turns a webhook into an outbound connection.

| Option | Outbound-only? | Latency | Notes |
|---|---|---|---|
| Webhook (repo/org/App) | No - needs public HTTPS endpoint | Near real-time | No automatic retry on failure |
| Events API polling | Yes | 30s - 6h (!) | Explicitly not for real-time |
| Notifications API polling | Yes | ~60s poll interval | Only covers *your* notifications (mentions, review requests, ...) |
| smee.io relay | Yes (SSE client) | Near real-time | Dev-only service, no delivery guarantees, unauthenticated channel |
| `gh webhook forward` | Yes | Near real-time | Officially "testing and development" only |
| Cloudflare Tunnel + webhook | Yes (cloudflared outbound) | Near real-time | Needs Cloudflare account + domain; free |
| Tailscale Funnel + webhook | Yes (Tailscale outbound) | Near real-time | Ports 443/8443/10000, TLS only, `*.ts.net` name, bandwidth-limited |

### Webhooks

- Can be created on a repository, organization, or GitHub App ([About webhooks](https://docs.github.com/en/webhooks/about-webhooks)). GitHub recommends them over polling: near real-time, cheaper, scale better.
- Delivery is a plain HTTPS POST to a URL you host, so the receiver must be publicly reachable. Responses slower than 10 seconds count as failed, and "GitHub does not automatically redeliver failed deliveries" - you must redeliver manually or script it via the deliveries REST API ([Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)). So even with a public endpoint, a robust consumer needs a reconciliation sweep (list deliveries, redeliver failures).

### Polling

- Events API: supports ETag conditional requests (304s don't count against rate limit) and a server-set `X-Poll-Interval`. But: max 300 events / 30 days per timeline, and events are delayed "30 seconds to 6 hours depending on the time of day" - GitHub says outright it is not for real-time use ([Events API](https://docs.github.com/en/rest/activity/events?apiVersion=2022-11-28)). Disqualifying as a primary trigger source.
- Notifications API: `If-Modified-Since` + `X-Poll-Interval` (default 60s), free 304s ([Notifications API](https://docs.github.com/en/rest/activity/notifications?apiVersion=2022-11-28)). Good latency and cheap, but only covers things that notify *you* (assigned, mentioned, review requested, Actions runs, security alerts, state changes on subscribed threads) - not arbitrary repo events like pushes by others to arbitrary branches.
- Rate limits ([Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28)): PAT 5,000 req/h; OAuth app tokens 5,000 req/h (15,000 if Enterprise Cloud-owned); GitHub App installation tokens 5,000 req/h base, scaling with repo count up to 12,500 (15,000 on Enterprise Cloud). For a single user, 5,000/h is ample: 60s polling of a handful of endpoints uses a few hundred requests/h, and 304s are free.

### Relays (webhook without a public origin)

- **smee.io**: GitHub's own webhook-testing relay pattern. Public channel URL receives the webhook, an SSE client forwards it to localhost ([smee.io](https://smee.io/)). Outbound-only, but a development tool: no delivery guarantees or persistence, and anyone with the channel URL can read/inject payloads (signature verification of `X-Hub-Signature-256` is then mandatory). Not production-grade.
- **`gh webhook forward`**: official CLI forwarding of repo/org webhooks to localhost with no public endpoint ([docs](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing)). Explicitly "only designed for use during testing and development", one forwarder per repo/org.
- **Cloudflare Tunnel**: `cloudflared` daemon makes an outbound connection to Cloudflare's edge; no inbound firewall ports; you point a hostname (domain on Cloudflare) at the tunnel ([Cloudflare Tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)). Production-grade and free; setup burden is a Cloudflare account, a domain, and running the daemon.
- **Tailscale Funnel**: routes public internet traffic to a node via Tailscale's relay; the node needs no open inbound ports. Constraints: listens only on ports 443/8443/10000, TLS-only, name must be under your `tailnet.ts.net` domain, "non-configurable bandwidth limits", available on all plans ([Funnel docs](https://tailscale.com/kb/1223/funnel)). Fine for low-volume webhooks, especially if Tailscale is already in the stack.

### Auth model

- **GitHub App** is the natural fit for webhook ingress: the App owns one webhook config covering all installed repos, gets installation tokens, and its rate limit scales with repos. Setup is heavier (create App, install it).
- **PAT** is the natural fit for polling: trivial setup, 5,000 req/h, no webhook ownership.
- **OAuth app** buys nothing for a single user: same 5,000 req/h, OAuth apps do not receive event webhooks for repos (only apps/repos/orgs own event webhooks), and the consent dance is pointless when you are the only user.

## Gmail messages

| Option | Outbound-only? | Latency | Notes |
|---|---|---|---|
| Push -> Pub/Sub **pull** subscription | Yes (StreamingPull is client-initiated) | Seconds | GCP setup burden; watch renewal; not 100% reliable |
| Push -> Pub/Sub **push** subscription | No - needs public HTTPS endpoint | Seconds | Same setup burden plus an endpoint |
| IMAP IDLE | Yes | Seconds | Per-folder, needs XOAUTH2 or app password, connection babysitting |
| history.list polling | Yes | = poll interval (30-60s realistic) | Simplest; quota is a non-issue for one user |

### Push via Cloud Pub/Sub

Setup ([Gmail push guide](https://developers.google.com/workspace/gmail/api/guides/push)): GCP project with Pub/Sub enabled, create a topic, grant publish on it to `gmail-api-push@system.gserviceaccount.com`, call `users.watch`, and re-call watch at least every 7 days (Google recommends daily). Notifications carry only a `historyId`; you then call `history.list` to get actual changes.

Key facts:
- Delivery is via a Pub/Sub subscription, which can be **pull** instead of push. Pull/StreamingPull is client-initiated - the subscriber opens an outbound (persistent, bidirectional for StreamingPull) connection to Google; no public endpoint needed ([Pub/Sub pull docs](https://docs.cloud.google.com/pubsub/docs/pull)). This is the outbound-only path to near-real-time Gmail.
- Max one notification event per second per watched user; delivery is not guaranteed ("messages may be delayed or dropped occasionally") - Google itself recommends fallback `history.list` polling if notifications go quiet.
- Setup burden is the highest of the three options: GCP project + Pub/Sub + IAM grant + watch-renewal cron, on top of the OAuth setup every option needs.

### IMAP IDLE

- `imap.gmail.com:993`, SSL; auth via SASL XOAUTH2 with an OAuth access token; sessions capped at ~24h and, with OAuth, at roughly the access-token lifetime (~1h), forcing periodic re-auth ([Gmail IMAP/SMTP](https://developers.google.com/workspace/gmail/imap/imap-smtp)). App passwords work only with 2-Step Verification and Google calls them "not recommended" ([Google support](https://support.google.com/mail/answer/7126229)), which also documents a limit of 15 simultaneous IMAP clients per account.
- IDLE watches one selected mailbox (folder) per connection, and per [RFC 2177](https://datatracker.ietf.org/doc/html/rfc2177) clients should re-issue IDLE at least every 29 minutes. Outbound-only and low-latency, but it is connection-babysitting (re-auth, re-IDLE, reconnect) and it yields raw RFC822 messages rather than Gmail API objects - awkward if the rest of the integration uses the Gmail API.

### History polling

- Poll `users.history.list` from a stored `historyId` baseline. Quota ([Gmail API quota](https://developers.google.com/workspace/gmail/api/reference/quota)): per-user limit 6,000 quota units/min/project; `history.list` costs 2 units, `messages.get` 20, `watch` 100. Polling every 30s costs ~4 units/min plus 20 per new message - orders of magnitude under quota for one user. Latency equals the poll interval.

### OAuth consent burden (applies to all Gmail API options)

A personal app with an **external** user type in **Testing** publishing status gets refresh tokens that expire after 7 days when requesting sensitive scopes like Gmail ([Google OAuth docs](https://developers.google.com/identity/protocols/oauth2)) - unusable for an always-on controller. Escapes: publish to production (Gmail scopes are restricted and normally trigger verification, though an app used only by its owner can remain unverified with an "unverified app" warning at consent time), or use a Workspace account with an **internal** user type. This one-time consent hassle exists for push, polling, and XOAUTH2 IMAP alike.

## Summary

| Option | Outbound-only | Latency | Setup burden | Quota/reliability risk |
|---|---|---|---|---|
| GitHub webhook (direct) | No | seconds | Low | No auto-retry on failure |
| GitHub webhook + Cloudflare Tunnel | Yes | seconds | Medium (account, domain, daemon) | Low |
| GitHub webhook + Tailscale Funnel | Yes | seconds | Low-medium (if tailnet exists) | Bandwidth-capped |
| GitHub webhook + smee.io / `gh webhook forward` | Yes | seconds | Trivial | Dev-only, lossy |
| GitHub Events API polling | Yes | 30s-6h | Trivial | Disqualifying latency |
| GitHub Notifications polling | Yes | ~60s | Trivial | Covers notifications only |
| Gmail push + Pub/Sub pull | Yes | seconds | High (GCP, IAM, watch cron) | Occasional drops - poll fallback needed |
| Gmail push + Pub/Sub push | No | seconds | High + endpoint | Same |
| Gmail IMAP IDLE | Yes | seconds | Medium (XOAUTH2, reconnect logic) | Connection churn, raw MIME |
| Gmail history.list polling | Yes | poll interval | Low | Negligible for 1 user |

## Recommendation for hydra

Everything the controller needs can work outbound-only, matching Discord gateway and Slack Socket Mode - no public endpoint is required for v1:

- **GitHub**: the honest outbound-only options are Notifications-API polling (60s, covers mention/review/assignment-style triggers) or a webhook relayed through Cloudflare Tunnel or Tailscale Funnel (seconds, covers all event types). Direct polling of the Events API is not viable (up to 6h delay). Suggested shape: make the ingress a plugin concern - ship a poller (zero infrastructure) and a webhook receiver that users can expose however they like (tunnel, funnel, or a real public endpoint), with a GitHub App as the auth model for the webhook path and a PAT for the polling path. Any webhook path needs a redelivery sweep since GitHub never retries on its own.
- **Gmail**: history.list polling is the pragmatic default - lowest setup, outbound-only, quota-irrelevant for one user, latency bounded by the poll interval. Gmail push with a Pub/Sub *pull* subscription is the outbound-only upgrade to second-level latency, at the cost of a GCP project, an IAM grant, watch renewal, and still needing the poller as fallback. IMAP IDLE is not worth the babysitting given the API-based options. The OAuth consent-screen/testing-status trap (7-day refresh tokens) must be addressed in setup docs regardless of option.
