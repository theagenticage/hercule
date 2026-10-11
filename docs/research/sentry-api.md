# Sentry API facts for the Sentry plugin

These facts back the Sentry plugin's spec. They come from Sentry's documentation, the Sentry CLI's source, and read-only calls against one real sentry.io organization on 2026-10-11. No content of that organization appears here: every name, slug and value below is invented or generic.

## Method

- The device flow ran against sentry.io through Hercule's public OAuth application, which was created under a personal Sentry account. A user of a different account approved it for a work organization.
- The scopes were read-only: `org:read project:read event:read member:read team:read`.
- Responses were saved to a scratch directory outside the repository, read for their shape, and deleted afterwards. The token was revoked afterwards.
- Write endpoints (resolve, archive, assign) were not called. What this note says about them comes from Sentry's documentation and is marked as such.

## Signing in

- **Any Sentry user can create a public OAuth application**: Settings → Account → API → Applications → Create New Application, type Public. No contact with Sentry is needed. Self-hosted Sentry supports the same from version 26.1.0 ([Sentry CLI self-hosted docs](https://github.com/getsentry/cli/blob/main/apps/cli-docs/src/content/docs/self-hosted.md)).
- **The device flow (RFC 8628) needs only the public client id.** `POST https://sentry.io/oauth/device/code/` with `client_id` and `scope` returns `device_code`, `user_code`, `verification_uri` (`https://sentry.io/oauth/device/`), `verification_uri_complete`, `expires_in` 600 and `interval` 5. Polling `POST https://sentry.io/oauth/token/` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` answers `authorization_pending` until the user approves ([Sentry API authentication](https://docs.sentry.io/api/auth/)).
- **An application created by one user works for another user's organization.** Recorded.
- **The token response** has `access_token`, `refresh_token`, `expires_in` (2,591,999 seconds, 30 days), `expires_at`, `scope`, `token_type` and `user` (`id`, `name`, `email`). Recorded.
- **The token is limited to one organization**, the one the user picks on the approval page: "The access token only provides access to the specific organization the user selected during the OAuth flow" ([Sentry API authentication](https://docs.sentry.io/api/auth/)). `GET /api/0/organizations/` listed one organization. The approving user belongs to one organization, so the recording does not prove this; the documentation does.
- **Refresh needs no client secret.** `POST https://sentry.io/oauth/token/` with `client_id`, `grant_type=refresh_token` and `refresh_token` returns a new token set of the same shape. Recorded.
- **Refresh rotates both tokens at once.** Right after a refresh, the old access token gets 401 and the old refresh token gets 400. Recorded. So two refreshes that race lose the Connection: the refresh must run once at a time per Connection, and the new token set must be stored before anything uses it.
- **Who signed in** comes from the token response's `user`, or from `GET /api/0/organizations/{org}/members/me/`, whose `user` holds `id`, `username` and `email`. That one works for a pasted token too. `GET /api/0/users/me/` and `GET /api/0/auth/` answer 404 on the region host.

## Hosts

- `GET /api/0/organizations/` returns each organization's `links.organizationUrl` (`https://<org>.sentry.io`) and `links.regionUrl` (`https://us.sentry.io`, or `https://de.sentry.io` for an EU organization). Recorded for a US organization.
- Organization endpoints answered the same on `https://sentry.io` and on the region host. Recorded. Calling the region host directly avoids a hop.
- An issue's `permalink` is on the organization's own host: `https://<org>.sentry.io/issues/<id>/`.

## Rate limits and paging

- Each response carries `x-sentry-rate-limit-limit` (40), `-remaining`, `-reset` (epoch seconds), `-concurrentlimit` (25) and `-concurrentremaining`. Recorded.
- Lists page by cursor in the `Link` header: `rel="next"; results="true"; cursor="..."`. `results="false"` means there is no next page. Recorded.
- The issue list takes `limit` up to 100. Recorded.

## Organization lookups

| Endpoint | Returns | Fields a plugin reads |
|---|---|---|
| `GET /api/0/organizations/{org}/teams/` | every team | `id`, `slug`, `name`, `isMember`, `projects` |
| `GET /api/0/organizations/{org}/user-teams/` | the signed-in user's teams | as above |
| `GET /api/0/teams/{org}/{team}/projects/` | a team's projects | `id`, `slug`, `name` |
| `GET /api/0/organizations/{org}/projects/` | every project | `id`, `slug`, `name`, `teams` |
| `GET /api/0/organizations/{org}/environments/` | every environment | `id`, `name` |
| `GET /api/0/organizations/{org}/members/` | every member | `id`, `email`, `name`, `user` (`id`, `username`) |
| `GET /api/0/organizations/{org}/members/me/` | the signed-in member | as above |

All recorded.

## The issue list

`GET /api/0/organizations/{org}/issues/` is the list the Sentry issues page shows. Recorded parameters:

- `query`: Sentry search syntax. Tokens that worked:
  - `is:unresolved`, `is:resolved`, `is:archived`, `is:regressed`, `is:escalating`
  - `assigned:me`, `assigned:my_teams`, `assigned:none` (no assignee), `assigned:#<team-slug>`, `assigned:<username>`
  - a list in brackets is OR'd: `assigned:[me, my_teams, none, #<team-slug>, <username>]` returned the union of each value alone
  - a user is matched by `user.username`, not by email: `assigned:<email>` returned nothing for a user whose username is not their email, and `assigned:<user id>` returned nothing either
  - `lastSeen:-90d`, and an absolute time, `lastSeen:>2026-10-01T00:00:00`
  - `environment:<name>`, inside the query
- `environment`: repeat it for more than one. Repeated values are OR'd: two environments returned the union of each alone.
- `project`: a project id; repeat it for more than one.
- `group`: an issue id; repeat it to read up to 100 named issues in one request. This is how a poller learns why an issue left its list.
- `sort`: `date` (last seen, the default), `new` (first seen).
- `statsPeriod`: the window for the `stats` field.
- `collapse`: leaves fields out. `collapse=stats` drops the hourly counts and shrinks the response by about a third. **`collapse=lifetime` drops `firstSeen`, `lastSeen`, `count` and `userCount` too**, so a poller must not collapse it.

**An unknown value is not an error.** `assigned:#no-such-team` answered 200 with an empty list. A team, project or environment that was renamed or deleted makes the filter match nothing, silently. Recorded.

### An issue

Fields on each list item, recorded: `id`, `shortId` (`WEBSHOP-1A2`), `title`, `culprit`, `permalink`, `level` (`error`, `warning`, `info`, ...), `status`, `substatus`, `priority` (`high`, `medium`, `low`), `assignedTo` (`{type: "user" | "team", id, name}` or null), `project` (`{id, slug, name, platform}`), `firstSeen`, `lastSeen`, `count` (a string), `userCount`, `isUnhandled`, `issueCategory`, `issueType`, `metadata` (`type`, `value`, `filename`, `function`, ...), `statusDetails`, `stats`, `numComments`, `hasSeen`.

`statusDetails` on an archived issue holds the archiving user as `actor`, with their email. `assignedTo` holds a user's or team's name. Fixtures must invent both whole.

### Status and substatus

Every combination seen in the recording:

| `status` | `substatus` | Meaning |
|---|---|---|
| `unresolved` | `new` | first seen recently |
| `unresolved` | `ongoing` | open, nothing new happened |
| `unresolved` | `regressed` | was resolved, then had a new event |
| `unresolved` | `escalating` | Sentry's forecast says its event rate spiked; also how an issue archived "until escalating" comes back |
| `resolved` | none | resolved |
| `ignored` | `archived_forever` | archived for good |
| `ignored` | `archived_until_escalating` | archived until it spikes |
| `ignored` | `archived_until_condition_met` | archived until a count, user count or time is reached |

`is:unresolved` returns all four `unresolved` substatuses.

### Issue detail and activity

- `GET /api/0/organizations/{org}/issues/{id}/` adds `activity`, `firstRelease`, `lastRelease`, `participants`, `seenBy`, `tags` and `userReportCount` to the list fields.
- Activity types seen: `first_seen`, `set_regression`, `set_resolved`, `set_resolved_by_age`, `set_escalating`, `auto_set_ongoing`, `assigned`.
- A `set_regression` activity's `data` holds `version` (the release it came back in, when known), `event_id`, `event_title`, `event_type` and `event_metadata`.
- One issue had ten `set_regression` activities: an issue can regress many times. An issue that resolves and regresses again between two polls keeps the substatus `regressed`, so the list alone cannot show the second regression. The newest `set_regression` activity in the detail can.

### The latest event

`GET /api/0/organizations/{org}/issues/{id}/events/latest/` returns the newest event: `title`, `message`, `culprit`, `dateCreated`, `release`, `tags`, `contexts`, `user`, and `entries` of types such as `exception`, `breadcrumbs` and `debugmeta`. The `exception` entry holds the stack trace a signal's body can show. Recorded.

## Writes (from documentation, not recorded)

All need the `event:write` scope, which the plugin's device flow must request ([Sentry API: update an issue](https://docs.sentry.io/api/events/update-an-issue/)).

- `PUT /api/0/organizations/{org}/issues/{id}/` with `{"status": "resolved"}` resolves.
- The same with `{"status": "ignored", "substatus": "archived_forever"}` archives.
- The same with `{"assignedTo": "<user id or email>"}` assigns; `"team:<id>"` assigns a team.

The build ticket's fake Sentry server implements these. They are not tried against a real organization until the plugin's own end-to-end check.
