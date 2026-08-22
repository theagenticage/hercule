# Connection setup UX: smoothest auth path per provider

Resolves [#32](https://github.com/rogierpennink/hydra/issues/32). Question: given that Hydra is a self-hosted, single-user controller with no public endpoint - but the user's browser can always reach it, since the controller serves the web app - what is the smoothest Connection-setup path per provider? Constraints already decided: BYO OAuth client where the provider demands one, no Hydra-hosted OAuth relay, paste-a-token as universal fallback and as the primary path for Slack/Discord bot tokens. All claims below are from primary sources (Google and GitHub official docs, Tailscale KB).

## 1. Google OAuth

### Redirect-URI rules for "Web application" clients

Google's [redirect-URI validation rules](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation) validate the URI *string* at client-configuration time; nothing in the rules requires the host to be reachable from Google's servers (the redirect is executed by the user's browser). The rules that matter for Hydra:

- HTTPS required, with one exemption: "Localhost URIs (including localhost IP address URIs) are exempt from this rule." So `http://localhost:PORT` and `http://127.0.0.1:PORT` are valid redirect URIs even on a Web client.
- "Hosts cannot be raw IP addresses", localhost IPs excepted. So `http://192.168.1.10:3000/callback` is **rejected** - private-LAN IPs cannot be redirect URIs.
- "Host TLDs must belong to the public suffix list." So made-up suffixes like `.internal` or mDNS `.local` names are **rejected**; a name under a real public suffix (e.g. `*.ts.net`, whose effective TLD `.net`/`ts.net` is on the PSL) passes.
- Redirect URIs must exactly match a registered URI (scheme, case, trailing slash).

Redirect/origin URIs must be on a domain listed under the consent screen's **Authorized domains**, per the [branding page](https://support.google.com/cloud/answer/10311615): "Add your Authorized Domains before you add your redirect or origin URIs." Search Console domain-ownership verification is tied to the *app verification* process, not to configuring an unverified/testing app - per the same page, verified ownership matters "if your app requires verification". For a personal, never-verified app this is a console formality, not an ownership check.

### "Desktop app" client type and loopback

Per the [native-app doc](https://developers.google.com/identity/protocols/oauth2/native-app), the loopback IP redirect (`http://127.0.0.1:PORT`) is the *recommended* mechanism for macOS/Linux/Windows desktop clients and remains fully supported. What is dead: OOB copy/paste ("no longer supported"), custom URI schemes ("no longer supported due to the risk of app impersonation"), and loopback on Android/iOS/Chrome-app client types (deprecated). Loopback for desktop platforms is not deprecated.

Caveat for Hydra: the loopback redirect lands on the **browser's** machine, not the controller. Nothing listens there unless the user browses from the controller host itself. A workable fallback (used by several CLI tools) is: browser gets redirected to `http://127.0.0.1:PORT/?code=...`, connection refused, user copy-pastes the full URL from the address bar into Hydra. It works, but it is exactly the OOB-style ceremony Google killed, reconstructed by hand - fallback only.

### Device flow: not usable for Gmail

Google supports the OAuth 2.0 device grant only as the ["limited-input device" flow](https://developers.google.com/identity/protocols/oauth2/limited-input-device), and it is scope-capped: "The OAuth 2.0 flow for devices is supported only for the following scopes" - OpenID Connect (`openid`, `email`, `profile`), Drive `drive.appdata`/`drive.file`, and YouTube `youtube`/`youtube.readonly`. **No Gmail scopes, no Calendar, no full Drive.** Device flow is a dead end for Hydra's Google connections.

### Testing vs In production

| | Testing | In production (unverified) |
|---|---|---|
| Who can auth | Up to 100 listed test users ([audience doc](https://support.google.com/cloud/answer/15549945)) | "any user with a Google Account" |
| Refresh token life | "Authorizations by a test user will expire seven days from the time of consent. If your OAuth client requests an `offline` access type and receives a refresh token, that token will also expire." ([same doc](https://support.google.com/cloud/answer/15549945); also [token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)) | Normal long-lived refresh token; the [expiration doc](https://developers.google.com/identity/protocols/oauth2#expiration) lists the 7-day rule *only* for Testing status |
| Consent screen | Normal | "Google will display an unverified apps warning message if your project's OAuth clients request authorization of scopes considered sensitive or restricted before your project has completed verification" ([audience doc](https://support.google.com/cloud/answer/15549945)) |
| User cap | 100 test users | "100 new users in total, after the app presents the unverified app screen" ([unverified apps](https://support.google.com/cloud/answer/7454865)) |

Publishing to production without verification is explicitly sanctioned for personal use: "If the app is for your personal use (fewer than 100 users), you and your limited number of users can continue using the app without going through verification (users will be allowed to click through 'unverified app' warning screens during sign-in)" ([when verification is not needed](https://support.google.com/cloud/answer/13464323)). The click-through is Advanced > "Go to {Project Name} (unsafe)", documented in Google's own API troubleshooting pages ([example](https://developers.google.com/people/v1/troubleshoot-authentication-authorization)).

Remaining refresh-token death causes for a production app ([expiration doc](https://developers.google.com/identity/protocols/oauth2#expiration)): user revocation, 6 months unused, **password change when the token has Gmail scopes**, exceeding 100 live refresh tokens per account per client, admin restriction. None of these bite a single-user controller that refreshes regularly, except the Gmail-scope password-change rule, which Hydra should surface as a "reconnect after password change" expectation.

### Minimum-ceremony Gmail recipe

Create GCP project > enable Gmail API > configure consent screen, External user type > **Publish app (In production), skip verification** > create OAuth client. Result: non-expiring refresh token; the user clicks through one scary screen once. Staying in Testing instead means re-consenting every 7 days - unacceptable for an agent controller. Workspace users should pick **Internal** user type instead, which removes the warning and verification entirely ([audience doc](https://support.google.com/cloud/answer/15549945)).

## 2. Tailnet TLS and redirect URIs

[`tailscale cert`](https://tailscale.com/kb/1153/enabling-https) provisions real Let's Encrypt certificates for `<node>.<tailnet-name>.ts.net` via the DNS-01 challenge ("Tailscale creates a `*.ts.net` DNS TXT record for your nodes to complete their DNS-01 challenges"), with the private key generated and stored locally. Requirements: MagicDNS on, HTTPS toggle enabled in the admin console. The node is **not** exposed publicly - "access to your devices is still restricted by Tailscale as normal" - but the machine name becomes public via Certificate Transparency logs ("Do not enable the HTTPS feature if any of your machine names contain sensitive information").

Is `https://myhost.tailnet.ts.net/oauth/callback` acceptable to Google? Yes, by the [validation rules](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation): HTTPS scheme, not a raw IP, real public-suffix domain, exact-match registrable string. Google validates the string, not reachability; the redirect is a browser navigation, and the user's browser is on the tailnet, so MagicDNS resolves the name and the real LE cert makes the callback clean. One caveat: if the app ever went through Google verification, ownership of a `ts.net` name could not be proven in Search Console - irrelevant for a permanently-unverified personal app.

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) adds public-internet reachability (ports 443/8443/10000, TLS only, bandwidth-limited). **Not needed for OAuth redirects** - the browser performing the redirect can already reach the controller. Funnel only matters for provider-to-server calls (webhooks), which is event-ingress territory, not connection setup.

## 3. GitHub

### Device flow

Both [OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) and [GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) support the device flow; in both cases "you must first enable it in your app's settings." Mechanics: POST `https://github.com/login/device/code`, user enters the code at `https://github.com/login/device`, app polls `https://github.com/login/oauth/access_token` at a minimum 5-second interval; codes expire after 900 seconds. For OAuth apps the `scope` parameter works exactly as in the web flow ("a space-delimited list of the scopes that your app is requesting") - so `repo`, `user`, etc. all work over device flow; there is no scope restriction like Google's.

Token lifetime: "OAuth app tokens are long-lived by default" ([app-type comparison](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)) - an OAuth-app device-flow token does not expire unless expiration is opted into or the token is revoked. GitHub App user tokens expire after 8 hours with a 6-month refresh token when expiration is enabled (the default, opt-out) ([refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)).

### Redirect (web) flow

GitHub's [redirect rules](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#redirect-urls) are far more lenient than Google's: no HTTPS mandate is imposed on the callback URL, loopback redirects get port flexibility ("the `redirect_uri` does not need to match the port specified in the callback URL"), and the docs recommend `127.0.0.1`/`::1` over `localhost` per the OAuth RFC. Default matching is exact; optional wildcard matching allows subdirectory paths (with a documented security warning). A tailnet HTTPS callback works here too, trivially.

### PATs

Per the [PAT docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens):

| | Fine-grained PAT | Classic PAT |
|---|---|---|
| Expiry | "Infinite lifetimes are allowed but may be blocked by a maximum lifetime policy" (org/enterprise) | No-expiration allowed; "GitHub automatically removes personal access tokens that haven't been used in a year" |
| Granularity | Single user/org, per-repo selection, fine-grained permissions | Coarse scopes, all accessible repos |
| Coverage gaps | Cannot contribute to public repos where user isn't a member, no outside-collaborator access, one org at a time, no Packages, no Checks API, no user-owned Projects, incomplete REST coverage | Full API coverage |

### Ceremony comparison, honestly

Device flow requires the user to first create their own OAuth app and enable device flow in its settings (BYO client - reusing gh CLI's client id is not a legitimate option for a third-party product). That is: create app, copy client id, then run the code-entry dance. A PAT is: settings page, generate, paste. For one user, **PAT paste is strictly less ceremony** and yields an equally long-lived credential; device flow only wins if scoped-token rotation or avoiding a long-lived secret in the DB matters more than setup friction. Classic PAT is the pragmatic default for an agent (full API coverage); fine-grained where its gaps don't bite.

## Recommendation

The unifying trick: whatever origin the user's browser already uses to reach Hydra is, by definition, a working redirect target. Hydra should read its own request origin and generate the exact redirect URI for the user to register.

- **Google (Gmail/Calendar/Drive)** - redirect flow to the controller's own HTTPS origin. Device flow is impossible (Gmail scopes excluded). Recipe Hydra documents:
  1. Enable Tailscale HTTPS + MagicDNS; run `tailscale cert`; serve Hydra at `https://myhost.tailnet.ts.net`.
  2. GCP project > enable APIs > consent screen External > **publish to production, never verify** (Workspace: Internal type instead).
  3. Add authorized domain + redirect URI `https://myhost.tailnet.ts.net/oauth/callback` (Hydra displays the exact string), create Web client, paste client id/secret into Hydra.
  4. Connect; click Advanced > "Go to {app} (unsafe)" once. Result: non-expiring refresh token.
  `http://localhost` redirect is documented only as a fallback for users who browse from the controller machine itself - localhost resolves on the browser's machine, so it silently breaks for everyone else. Do not make it the default.
- **GitHub** - primary: **paste a PAT** (classic for full coverage; fine-grained if its limits are acceptable). Optional nicer path for users who care: BYO OAuth app + device flow (non-expiring token, no redirect URI to configure at all - device flow needs no reachable callback). The redirect flow also works against the tailnet origin but buys nothing over device flow here.
- **Slack/Discord** - paste bot token (already decided; unchanged).
- **Universal fallback** - paste-a-token, everywhere.
