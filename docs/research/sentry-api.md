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
- `project`: a project id; repeat it for more than one. Leaving it out returns every project the user can see, the same as `project=-1`. Recorded. **An unknown project id is an error**, unlike the other filters: it answered 403 with a `detail` message. Recorded.
- `group`: an issue id; repeat it to read up to 100 named issues in one request. This is how a poller learns why an issue left its list.
- `sort`: `date` (last seen, the default), `new` (first seen).
- `groupStatsPeriod`: the window for the `stats` field: `24h`, `14d` or `auto`, else 400. (`statsPeriod` is a different parameter: the date window the search covers. From Sentry's source, `src/sentry/issues/endpoints/organization_group_index.py`.)
- `collapse`: leaves fields out. `collapse=stats` drops the hourly counts and shrinks the response by about a third. **`collapse=lifetime` drops `firstSeen`, `lastSeen`, `count` and `userCount` too**, so a poller must not collapse it.

**An unknown value in the query is not an error.** `assigned:#no-such-team` answered 200 with an empty list. A team, project or environment that was renamed or deleted makes the filter match nothing, silently. Recorded.

### An issue

Fields on each list item, recorded: `id`, `shortId` (`WEBSHOP-1A2`), `title`, `culprit`, `permalink`, `level` (`error`, `warning`, `info`, ...), `status`, `substatus`, `priority` (`high`, `medium`, `low`), `assignedTo` (`{type: "user" | "team", id, name}` or null), `project` (`{id, slug, name, platform}`), `firstSeen`, `lastSeen`, `count` (a string), `userCount`, `isUnhandled`, `issueCategory`, `issueType`, `metadata` (`type`, `value`, `filename`, `function`, ...), `statusDetails`, `stats`, `numComments`, `hasSeen`.

`statusDetails` may hold the user who resolved or archived the issue as `actor`, a full user object with `id`, `username`, `name` and `email`. Most issues have none: in a sample of 25 resolved issues, 5 had an `actor` (beside `inRelease`), 3 had only `inCommit` and 17 had an empty `statusDetails`; of 25 archived issues, 2 had an `actor` (beside the `ignore*` fields). Recorded. `assignedTo` holds a user's or team's name. Fixtures must invent both whole.

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

## For the Inbox (#1163)

None of this was recorded: there was no token. Each fact is marked "From the documentation" or "From Sentry's source" with the file path at getsentry/sentry (read on 2026-11-15). Check each against a real response when the plugin first runs.

### Reading one issue

- **Short id lookup.** `GET /api/0/organizations/{org}/shortids/{short_id}/` answers `{organizationSlug, projectSlug, groupId (string), shortId, group}`. `group` is the same serializer as the issue detail without `activity`, `tags`, `stats` and releases, so it has `id`, `shortId`, `title`, `permalink`, `level`, `status`, `substatus`, `assignedTo`, `project`, `firstSeen`, `lastSeen`, `count`, `userCount` and the rest of the list fields. From the documentation, and `src/sentry/issues/endpoints/organization_shortid.py`.
- The short id is matched case-insensitively (the project slug is lower-cased, the base32 part upper-cased). A leading `issue:` is allowed. An unknown or malformed short id, or one in another organization, answers 404. From `src/sentry/models/group.py` (`parse_short_id`, `get_group_with_redirect`) and `src/sentry/utils/numbers.py`.
- Every issue endpoint under `/issues/{id}/` takes a short id in place of the numeric id, by the same code. So the detail request can be made with the short id and no lookup request is needed.
- **Gone issues answer 404.** `pending_deletion`, `deletion_in_progress` and `pending_merge` issues answer 404 on the lookup and on every `/issues/{id}/...` endpoint (`EXCLUDED_STATUSES` in `src/sentry/issues/endpoints/bases/group.py`). A `reprocessing` issue still answers 200.

### Statuses

`status` strings are `unresolved`, `resolved`, `ignored`, `pending_deletion`, `pending_merge` and `reprocessing`. `deletion_in_progress` is reported as `pending_deletion`. Only `unresolved` and `ignored` carry a `substatus`. From `src/sentry/api/serializers/models/group.py` (`_get_status_label`) and `src/sentry/models/group.py`.

The issues list with `group=<id>` ignores `query` and does not filter by status, so it returns `pending_deletion`, `pending_merge` and `reprocessing` issues with that status string. An issue that no longer exists is simply missing from the answer. Search by `query` leaves out the three gone statuses (`_initialize_group_queryset` in `src/sentry/search/snuba/backend.py`). Source only.

### Searching

- **The default `is:unresolved` applies only when the `query` parameter is absent.** `query=` (empty) returns every status, and so does a query with words and no `is:` token. The documentation says the same for the empty value. From `src/sentry/api/helpers/group_index/index.py` (`if query is None: query = DEFAULT_QUERY`). The existing "applies the default" wording above holds only for a missing parameter.
- Free text matches the issue's title and message, as a contains match ([search docs](https://docs.sentry.io/concepts/search/)). A status filter is optional: `is:resolved` or `is:unresolved` narrow, nothing widens.
- **A short id in `query` is found only with `shortIdLookup=1`.** Every whitespace-separated token that looks like a short id is looked up; hits come back alone, with header `X-Sentry-Direct-Hit: 1` when there is one. Without `shortIdLookup=1` it is searched as plain text. From `get_by_short_ids` in `src/sentry/api/helpers/group_index/index.py`.

### Daily counts for 14 days

- **Issues list with `groupStatsPeriod=14d`** returns `stats: {"14d": [[epochSeconds, count], ...]}` on each issue: 14 buckets of 24 hours. The series is built from now backwards in steps of 86,400 seconds, and each timestamp is rounded down to a multiple of 86,400, so buckets start at UTC midnight and the last one is today so far (partial). From `GroupStatsMixin.get_stats` in `src/sentry/api/serializers/models/group_stream.py` (`STATS_PERIOD_CHOICES`) and `get_optimal_rollup_series` in `src/sentry/tsdb/base.py`. Do not send `collapse=stats`. One request serves up to 100 issues (`group=` repeated).
- **Issue detail** (`GET .../issues/{id}/`) carries `stats: {"24h": [...], "30d": [...]}`, same pair format, daily buckets with the same boundaries. The loop runs from `now - 30 days`, so `30d` should hold 31 buckets; the last 14 are the trend. `collapse=stats` removes it. From `src/sentry/issues/endpoints/group_details.py` (`__group_hourly_daily_stats`). Count the buckets in the first real response.
- **`GET .../issues/{id}/stats/`** is `PRIVATE` and deprecated (`src/sentry/issues/endpoints/group_stats.py`). Do not use it.
- **Recommendation: take `30d` from the issue detail and keep its last 14 entries.** The detail is needed anyway for activity, releases and tags, so the trend costs no request.

### Tags

- `GET /api/0/organizations/{org}/issues/{id}/tags/browser/` answers `{key, name, uniqueValues, totalValues, topValues: [{key, name, value, count, lastSeen, firstSeen}]}`. `topValues` is ordered by `count`, most frequent first, limited to a few values (the limit is `TOP_VALUES_DEFAULT_LIMIT` in the tagstore; its number was not read). In a value, `value` is the raw tag value and `name` its display label; for `browser` both are like `Safari 19.1`. From the documentation, `src/sentry/issues/endpoints/group_tagkey_details.py` and `src/sentry/tagstore/types.py`.
- **No `browser` tag on the issue answers 404** (`GroupTagKeyNotFound`; a key whose only values are empty counts as missing).
- The tag URL is rate limited to 10 requests a second per user.
- **The issue detail's `tags` array does not carry `topValues`**: its items are `{key, name, totalValues}` only, because the detail builds them without top values (`get_group_tag_keys` in `src/sentry/tagstore/snuba/backend.py`). Reading the browser needs its own request. Use it as the signal whether an issue has a `browser` key at all, to skip a 404.

### Releases and activity

- `firstRelease` and `lastRelease` are `null` when the issue has none, else a release: `{id, version, shortVersion, status, ref, url, dateReleased, dateCreated, ...}`. A release that no longer exists comes back as `{version}` alone. `shortVersion` equals `version` in this code. From `src/sentry/api/serializers/models/release.py` and `group.py` (`GroupReleaseVersionResponse`).
- `activity` is newest first, at most 100 items; each is `{type, dateCreated, data, user, ...}`.
- **Resolved:** the newest `set_resolved` / `set_resolved_in_release` / `set_resolved_by_age` item. Its `dateCreated` is when. For `set_resolved_in_release`, `data.version` is the release, and is `""` for "in the next release" (`inNextRelease: true`). `set_resolved_by_age` has `data.age` (hours) and no version. From `src/sentry/api/helpers/group_index/update.py` and `activity_response_schemas.py`.
- **Came back:** the newest `set_regression` item. `dateCreated` is when, `data.version` the release it came back in (`""` when the event had none), and `data.resolved_in_version` the release it was resolved in before. From `src/sentry/event_manager.py`.

### Latest event frames

`GET .../issues/{id}/events/latest/` has `entries: [{type: "exception", data: {values: [{type, value, module, stacktrace: {frames, framesOmitted, hasSystemFrames}}]}}]`. A frame has `filename`, `absPath`, `module`, `function`, `lineNo`, `colNo`, `inApp` (bool or null), `context`, `vars` and more, all nullable. `colNo` is confirmed. Frames are in the order the SDK sent them: **oldest call first, the throwing frame last**; the web app reverses them for display only. From `src/sentry/interfaces/stacktrace.py` (`Frame.get_api_context`, "ordered by the oldest call first").

### Projects with teams

`GET /api/0/organizations/{org}/projects/` returns each project with `id`, `name`, `slug`, `teams: [{id, slug, name}]` (`id` a string) and a legacy `team`. It pages by `Link` header at up to 100 per page (`per_page`, default 100); `all_projects=1` returns every project unpaged. From `src/sentry/core/endpoints/organization_projects.py` and `src/sentry/api/serializers/models/project.py`.
