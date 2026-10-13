# Linear API facts for the Linear plugin

These facts back the Linear plugin's spec. They come from Linear's developer documentation, its published GraphQL schema and SDK source, and read-only calls against one real Linear workspace on 2026-10-13. No content of that workspace appears here: every name, identifier and value below is invented or generic.

## Method

- The sign-in ran through Hercule's public Linear OAuth application (client id `900702e5f1522b44e9a312dfb21acc47`), created in a personal Linear workspace. Its approval page was used to authorize a different workspace, one where the approving user is an admin.
- The redirect went to a throwaway Bun server on `http://127.0.0.1:4938/oauth/callback`, with PKCE (S256) and no client secret anywhere. The scopes were `read write`, and the request added `prompt=consent`.
- Only queries were sent; no mutation was called. Responses were read for their shape and not kept. The token was revoked and deleted afterwards.
- What this note says about anything not sent is marked as coming from the documentation, the schema or the SDK.

Sources:

- OAuth: [linear.app/developers/oauth-2-0-authentication](https://linear.app/developers/oauth-2-0-authentication) and the server metadata at [api.linear.app/.well-known/oauth-authorization-server](https://api.linear.app/.well-known/oauth-authorization-server).
- The API: [graphql](https://linear.app/developers/graphql), [filtering](https://linear.app/developers/filtering), [pagination](https://linear.app/developers/pagination), [rate limiting](https://linear.app/developers/rate-limiting).
- The schema: [`packages/sdk/src/schema.graphql`](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql). The SDK's error mapping: [`packages/sdk/src/error.ts`](https://github.com/linear/linear/blob/master/packages/sdk/src/error.ts).
- The inbox: [linear.app/docs/inbox](https://linear.app/docs/inbox), [linear.app/docs/notifications](https://linear.app/docs/notifications).

## Signing in

### OAuth

- **Creating an OAuth application needs a workspace admin**: Settings → Administration → API ([API and webhooks](https://linear.app/docs/api-and-webhooks)). Anyone can make a free workspace of their own and be its admin there.
- **A public application can be authorized into other workspaces.** The application's distribution is `private` (only the owning workspace) or `public` (schema: `OAuthApplication.distribution`). Recorded: an application created in one workspace was authorized into another. The approving user was an admin of that workspace, so whether a member who is not an admin can authorize it is not recorded. A workspace can require an admin to approve every OAuth application first (schema: `Organization.oauthAppReview`; [third-party application approvals](https://linear.app/docs/third-party-application-approvals)).
- **The approval page has a workspace switcher** in its top-left corner, and it picks the workspace the browser last used. One authorization grants one workspace. Recorded. `prompt=consent` shows the page every time, "if you want to give users the opportunity to connect multiple workspaces" ([OAuth docs](https://linear.app/developers/oauth-2-0-authentication)).
- **Authorize** is `https://linear.app/oauth/authorize` with `client_id`, `redirect_uri`, `response_type=code`, `scope` (space-separated: `read write` worked), `state`, `code_challenge` and `code_challenge_method=S256`. Recorded. **S256 must be sent explicitly**: Linear has required it since 2026-10-08 ([changelog](https://linear.app/changelog/2026-10-08-stacked-pull-requests)); the OAuth page still mentions `plain`, which is out of date. The metadata lists `S256` only.
- **Redirect URIs match exactly, port included.** A registered `http://127.0.0.1:4938/oauth/callback` worked; the same URI on port 4939, not registered, stopped at "Invalid redirect_uri parameter for the application." Recorded. An application registers up to 32 redirect URIs, and no wildcard is documented ([OAuth app manifests](https://linear.app/developers/oauth-app-manifests)). So a shared application can only serve redirect URIs known in advance, such as a fixed loopback port.
- **No client secret is needed with PKCE**, neither for the code exchange nor for refresh. `POST https://api.linear.app/oauth/token` as a form with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id` and `code_verifier` returned a token set. Recorded, and documented: `client_secret` is "optional" with PKCE. The metadata lists `none` among `token_endpoint_auth_methods_supported`.
- **The token response** has `access_token`, `token_type` (`Bearer`), `expires_in` (86,399 seconds, 24 hours), `refresh_token` and `scope` (`read write`). Recorded. It names no user and no workspace.
- **Refresh** is the same endpoint with `grant_type=refresh_token`, `refresh_token` and `client_id`. It returns a new access token and a new refresh token. Recorded. Unlike Sentry:
  - **the old access token keeps working after a refresh**. Recorded.
  - **the old refresh token can be used again for 30 minutes**, Linear's grace period "to allow for network errors" ([OAuth docs](https://linear.app/developers/oauth-2-0-authentication)). Recorded.
  - So a refresh that races another does not lose the Connection, though running one at a time per Connection is still the simple rule.
- Every OAuth application has issued 24-hour access tokens with refresh tokens since 2026-04-01 ([OAuth docs](https://linear.app/developers/oauth-2-0-authentication)). The refresh token's own lifetime is not documented.
- **Revoke** is `POST https://api.linear.app/oauth/revoke` with form field `token`; it answered 200 `{"success":true}`. Recorded:
  - the refresh token was refused at once: 400 "Refresh token revoked";
  - the access token still answered for a few seconds, and answered 401 within 20 seconds;
  - a second revoke answered 401 "Token has already been revoked."
- **There is no device flow.** The metadata lists no device grant, and `POST https://api.linear.app/oauth/device/code` answers 404. **There is no dynamic client registration** on `api.linear.app` either; `mcp.linear.app` has one, but its clients are unknown to `api.linear.app` (`invalid_client`).
- **Scopes**: `read` (always included), `write`, `issues:create`, `comments:create`, `timeSchedule:write`, `admin` ([OAuth docs](https://linear.app/developers/oauth-2-0-authentication)). A `read write` token answered every query in this note; whether `read` alone covers notifications is not recorded.
- **`actor` must stay `user`**, the default. With `actor=app` the token acts as the application's own user, so "me" filters and the inbox would be the application's, not the person's ([OAuth docs](https://linear.app/developers/oauth-2-0-authentication); the consequence is inferred from the schema).

### Personal API key

- Admins choose whether members may create keys ([API and webhooks](https://linear.app/docs/api-and-webhooks)).
- Sent as `Authorization: <key>`, with no `Bearer` ([GraphQL docs](https://linear.app/developers/graphql)). An OAuth token is sent as `Authorization: Bearer <token>`. Recorded.
- A key belongs to one user in one workspace.

### Who signed in

```graphql
query { viewer { id name displayName } organization { id name urlKey } }
```

Answered for the OAuth token. Recorded. A Linear user belongs to one workspace (schema: `User.organization`), so the same person in two workspaces has two user ids. `organization.id` plus `viewer.id` names one account in one workspace. `urlKey` can be renamed, so it is not an id.

## Requests, errors and limits

- Every call is `POST https://api.linear.app/graphql` with a JSON body `{query, variables}`.
- **Bad credentials** answer HTTP 401. Recorded for a wrong key, a wrong token, no header, and a revoked token:

  ```json
  {"errors":[{"message":"Authentication required, not authenticated","extensions":{"type":"authentication error","code":"AUTHENTICATION_ERROR","statusCode":401,"userError":true}}]}
  ```

- **No permission** is `extensions.type` `"forbidden"`, HTTP 403 (SDK `error.ts`). Not recorded.
- **A query can partly succeed**: HTTP 200 with `errors` beside `data` ([GraphQL docs](https://linear.app/developers/graphql)). Every 200 must be checked for `errors`.
- **Bad input** is `extensions.code` `INVALID_INPUT`. Recorded for `first: 251`: "first must not be greater than 250".
- **Rate limits** are per user, shared by everything that user signs in with ([rate limiting](https://linear.app/developers/rate-limiting)):

  | Sign-in | Requests per hour | Complexity points per hour |
  |---|---|---|
  | OAuth | 5,000 | 2,000,000 |
  | Personal API key | 2,500 | 3,000,000 |

  The OAuth figures were recorded in the headers. One query may cost at most 10,000 points.
- **Headers** on every response: `x-ratelimit-requests-limit`, `-remaining`, `-reset`, `x-ratelimit-complexity-limit`, `-remaining`, `-reset`, and `x-complexity` (this query's cost). **The reset values are epoch milliseconds** (for example `1791903093101`), not seconds. Recorded.
- **Being limited answers HTTP 400, not 429**, with `extensions.code` `"RATELIMITED"` ([rate limiting](https://linear.app/developers/rate-limiting)); the SDK matches `extensions.type` `"ratelimited"` and reads a `retry-after` header in seconds when present. Not recorded.
- **The documentation discourages polling**: "One thing that we especially discourage is polling the API to fetch updates" ([rate limiting](https://linear.app/developers/rate-limiting)). It suggests ordering by `updatedAt`, filtering, and explicit page sizes.
- **Cost depends on the rows returned.** Recorded `x-complexity`:
  - 4 for `id` and `updatedAt` of a filtered issue set at `first: 250` that returned 23 issues;
  - 13 for 50 issues with every display field below;
  - 25 for 5 notifications with the issue fragment below.

## Paging

- Relay cursors: `first` and `after`, `pageInfo { hasNextPage endCursor }`, and a `nodes` shortcut ([pagination](https://linear.app/developers/pagination)).
- The default page is 50; **the largest is 250**. Recorded.
- `orderBy` is `createdAt` (the default) or `updatedAt`, newest first. Recorded for notifications.
- Archived items are left out unless `includeArchived: true`.

## Filtering issues

`issues(filter: IssueFilter, first, after, orderBy, includeArchived)` returns the issues the user can see. Sibling fields in a filter are ANDed; every filter also takes `and: [...]` and `or: [...]` ([filtering](https://linear.app/developers/filtering)). The fields a plugin needs (schema: `IssueFilter`):

| Choice | Filter |
|---|---|
| Teams | `team: {id: {in: [...]}}` |
| Projects | `project: {id: {in: [...]}}`; `project: {null: true}` is "no project" |
| Project milestones | `projectMilestone: {id: {in: [...]}}` |
| Labels, any of | `labels: {some: {id: {in: [...]}}}` |
| Labels, all of | `and: [{labels: {some: {id: {eq: A}}}}, {labels: {some: {id: {eq: B}}}}]` |
| Assignee is me | `assignee: {isMe: {eq: true}}` |
| Unassigned | `assignee: {null: true}` |
| Particular people | `assignee: {id: {in: [...]}}`; several choices are joined with `or` |
| Open states | `state: {type: {in: ["triage", "backlog", "unstarted", "started"]}}` |
| Changed since | `updatedAt: {gt: "<ISO time>"}`; a duration such as `"-P2W"` also works |

- A workflow state's `type` is one of `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`, `duplicate`. The schema types it as a string, not an enum, so a misspelled value is not rejected (inferred).
- **What happens to an id that no longer exists** (a deleted label, an archived project) was not recorded. A plugin must not assume the server reports it.

### An issue

Display fields (schema: `Issue`), all read in the recording:

| Field | Shape |
|---|---|
| `id` | UUID |
| `identifier` | `SHOP-123` |
| `title`, `url` | strings |
| `priority`, `priorityLabel` | 0 none, 1 urgent, 2 high, 3 medium, 4 low; the label is its name |
| `state` | `{id, name, type, color}` |
| `assignee`, `creator` | `{id, name, displayName}` or null |
| `labels(first: n)` | `{nodes: [{id, name, color}]}`; `labelIds` holds the ids alone |
| `project`, `projectMilestone`, `cycle` | `{id, name}` or null |
| `team` | `{id, key, name}` |
| `dueDate` | `2026-10-20` or null |
| `estimate` | number or null |
| `description` | markdown or null |
| `createdAt`, `updatedAt` | ISO times |

`updatedAt` is "the last time at which the entity was meaningfully updated" (schema). **Which changes move it is not documented and not recorded**: the recording skipped writes. Field changes on the issue itself (state, assignee, project, milestone, priority) very likely do; whether a label change or a new comment does is unknown. A plugin that relies on `updatedAt` to find changes must check this first.

**An issue that left a filtered set cannot be found by the same filter**, by definition. A query for "changed since" with the user's filter only returns issues still in the set. To see an issue leave, a poller either lists the whole set each time and compares, or asks for every change without the filter and checks membership itself.

Issue history (`Issue.history`) lists each change with `fromState`/`toState`, `fromAssignee`/`toAssignee`, `addedLabelIds`, `removedLabelIds` and more (schema: `IssueHistory`). It is read one issue at a time; there is no list of changes across issues.

## Lists for choosing filters

| Query | Returns | Fields a plugin reads |
|---|---|---|
| `teams` | every team the user can see, private teams included if they are a member | `id`, `key`, `name` |
| `projects(filter: {accessibleTeams: {id: {in: [...]}}})` | projects of those teams; one project can span several teams | `id`, `name` |
| `projectMilestones(filter: {project: {id: {in: [...]}}})` | the milestones of those projects | `id`, `name`, `project {id}` |
| `issueLabels` | every label | `id`, `name`, `isGroup`, `parent {id}`, `team {id}` |
| `users` | every active user; `includeDisabled: true` adds the rest | `id`, `name`, `displayName` |
| `team(id) { states }` | that team's workflow states | `id`, `name`, `type` |

From the schema (`Query.*`). A label with `team: null` is a workspace label, offered in every team. A group label (`isGroup: true`) cannot be put on an issue; its children have `parent` set (schema: `IssueLabel`).

## Notifications

`notifications(filter: NotificationFilter, first, after, orderBy, includeArchived)` returns the signed-in user's own inbox (schema: `Query.notifications`). Recorded.

```graphql
query {
  notifications(first: 50, filter: {createdAt: {gt: "<ISO time>"}}) {
    nodes {
      id type category createdAt updatedAt readAt archivedAt snoozedUntilAt
      actor { id }
      ... on IssueNotification { issue { id identifier } comment { id } }
    }
  }
}
```

- `NotificationFilter` takes `createdAt`, `updatedAt`, `archivedAt`, `type`, `id`, `and` and `or`. **It has no `category` and no `readAt` field**, so a poller filters on those itself (schema).
- `category` is an enum and the steadier field to match on: `mentions`, `assignments`, `commentsAndReplies`, `statusChanges`, `postsAndUpdates`, `reactions`, `reminders`, `triage`, `subscriptions`, `system` and more (schema: `NotificationCategory`).
- `type` is a free string. Values recorded:
  - `issueMention` (mentioned in an issue's description)
  - `issueCommentMention` (mentioned in a comment)
  - `issueAssignedToYou`, `issueUnassignedFromYou`
  - `issueNewComment`, `issueStatusChanged`, `issueAddedToView`, `issueUnblocked`
  - `projectCommentMention`, `projectUpdateCreated` and more `project*` values

  More appear over time; a poller must accept a value it does not know.
- `actor` is the user who caused the notification, or null for an integration or the system.
- **`updatedAt` moves without anyone acting**: on notifications nobody touched, `updatedAt` was about an hour after `createdAt`. Recorded. So a poller that wants new notifications pages by `createdAt` and remembers the ids it has seen, because two notifications can share a timestamp.
- **Done in Linear** sets `archivedAt` (mutation `notificationArchive`). An archived notification drops out of the list unless `includeArchived: true`. Read in Linear sets `readAt`. Snoozed sets `snoozedUntilAt`.
- The inbox keeps at most 2,000 notifications ([inbox](https://linear.app/docs/inbox)).
- **Whether mentioning yourself makes a notification** is not documented and not recorded. A poller drops notifications whose `actor` is the viewer.

## Writes (from documentation, not recorded)

For the actions follow-up, all under the `write` scope:

- (schema: `Mutation`) `commentCreate(input: {issueId, body, parentId})` replies to an issue or, with `parentId`, in a comment's thread.
- `issueUpdate(id, input: {stateId})` moves an issue to another workflow state of its team.
- `notificationArchive(id)` marks a notification done.
