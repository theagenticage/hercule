# Research: what GitHub tells us about an ask and its end

Ticket: [#383](https://github.com/theagenticage/hercule/issues/383), for the map [Intake v1: from the Asks prototype to a buildable spec (#380)](https://github.com/theagenticage/hercule/issues/380).
Date: 2026-10-04.

The question: what does GitHub's API tell us about an ask, and about its end? v1 ships five GitHub asks: review requested, mentioned, assigned, changes requested on your PR, and checks failed on your PR. Spec 08 §5.1 polls `GET /notifications` every 60 seconds into one `github.notification` kind that carries the API's `reason`.

Sources are GitHub's own docs (the `github/docs` repository, which builds docs.github.com) and GitHub's OpenAPI description of the REST API (`github/rest-api-description`, version 1.1.4, pulled 2026-10-04). Where a claim comes from watching the live API instead of the docs, it says "observed". The observations come from one read-only sample of Rogier's own notifications with an OAuth App token (`gho_`).

## The answer in short

- **The notifications feed can start an ask. It can never end one.**
  - There is no `reason` for "review request removed", "unassigned", "you reviewed", "someone else approved", "merged by someone else" or "checks went green".
  - Every end signal is read from another endpoint: the pull request, its requested reviewers, its reviews, the issue timeline, or the checks on the head commit.
- **`reason` belongs to the thread, not to the update.** GitHub keeps one `reason` per thread and changes it only when a later notification has a different reason. A thread that once had `review_requested` keeps it after you review, after a re-request, and after unrelated comments. So the feed cannot tell "a new review request" from "any activity on a thread that was once a review request". The plugin must read the pull request to know.
- **Two of the five asks have no reason of their own.**
  - "Changes requested on your PR" arrives with reason `author` (you opened the thread), like every other update on your PR. Only `GET .../pulls/{pull_number}/reviews` (or the timeline) shows the verdict.
  - "Checks failed on your PR" has `ci_activity`, but only for GitHub Actions runs that *you triggered*, only when you opted in to Actions notifications, and the thread has no PR number, no commit SHA and no API URL (observed: `subject.url` is `null`). Spec 08's `checks` feed is the reliable source; `ci_activity` is a hint at best.
- **Direct versus team:** `mention` and `team_mention` are separate reasons. `review_requested` covers both "you" and "a team you're a member of". To tell them apart, read `requested_reviewers` versus `requested_teams` on the pull request.
- **Read and done on GitHub:** marking a thread read is visible to Hercule only if it lists with `all=true` (the thread then has `unread: false` and a `last_read_at`). Without `all=true` a read thread simply drops out of the list. Read and done do not move the thread's `updated_at`, so a conditional poll returns `304` and does not reveal them (observed). Whether a thread marked done still appears with `all=true` is unverified.
- **A fine-grained PAT cannot read notifications at all.** The notifications endpoints "only support authentication using a personal access token (classic)". OAuth App tokens work (observed). This conflicts with spec 08 §9.3, which offers a fine-grained PAT as a fallback and does not list this gap.
- **Rate limits:** 5,000 requests per hour per user, shared by every token and app acting for that user, including `gh` and agents in sessions. A conditional request that returns `304` is free. Reading one extra endpoint per open ask every 60 seconds costs at most 60 requests per hour per ask: 20 open asks is at most 1,200 per hour, on top of spec 08's `checks` feed (also up to about 1,200). The search API has its own bucket of 30 requests per minute and can return all open asks of one kind in one request.

## The table: per v1 ask, how it starts and how it ends

"Feed" means `GET /notifications`. "repos feed" and "checks feed" are spec 08 §5.1's other two feeds, which only cover repositories on the Connection's watch list. All endpoint paths are under `https://api.github.com`. `{pr}` stands for `/repos/{owner}/{repo}/pulls/{pull_number}`, `{issue}` for `/repos/{owner}/{repo}/issues/{issue_number}`.

| Ask | Start signal | End signal | Where the end is read | In the feed? |
|---|---|---|---|---|
| **Review requested** | Feed: `reason: review_requested`, `subject.type: PullRequest`. Confirm it is current and whether it is you or a team: `GET {pr}/requested_reviewers` returns `users[]` and `teams[]` | You submit a review (any verdict) | `GET {pr}/requested_reviewers` - you drop out of `users` ("Once a requested reviewer submits a review, they are no longer considered a requested reviewer"). `GET {pr}/reviews` - a review with your `user`. Timeline: `reviewed` | No. The thread may update; the reason does not change |
| | | The request is removed | `GET {pr}/requested_reviewers` or `GET {pr}` (`requested_reviewers`, `requested_teams`). Timeline: `review_request_removed` with `requested_reviewer` or `requested_team` | No reason exists for it |
| | | A team request is replaced by individual requests (code review assignment) | `requested_teams` loses the team, `requested_reviewers` gains members. Docs: "If you request a review from a team and code review assignment is enabled, specific members will be requested and the team will be removed as a reviewer" | No |
| | | A teammate reviews for the team | Not documented whether a teammate's review clears the team request. Unverified | No |
| | | PR merged or closed | `GET {pr}`: `state` (`open`/`closed`), `merged`, `merged_at`, `closed_at`. Timeline: `merged`, `closed`. repos feed: `github.pr.merged`, `github.pr.closed` | Unreliable, see `state_change` below |
| | | (Re-request after you reviewed: a new start, not an end) | You reappear in `requested_reviewers`. Timeline: a new `review_requested` | Thread updates, reason stays `review_requested`; indistinguishable from other activity |
| **Mentioned** | Feed: `reason: mention` (you), `team_mention` (a team you're on). The text is at `subject.latest_comment_url` (a comment) or in the issue or PR body. Timeline: `mentioned` | GitHub has no "answered" state for a mention | Candidates only: you comment after the mention (`GET {issue}/comments?since=...`, or timeline `commented` by you); the issue or PR is closed or merged (`GET {issue}` `state`); you mark the thread read on GitHub (`unread: false` with `all=true`) | No. Later updates keep `reason: mention`, so a new mention and an unrelated comment look the same |
| **Assigned** | Feed: `reason: assign` ("You were assigned to the issue"). Confirm: `GET {issue}` `assignees[]`. Timeline: `assigned` with `assignee` | You are unassigned | `GET {issue}` `assignees[]`. Timeline: `unassigned` with `assignee` | No reason exists for it |
| | | The issue or PR is closed or merged | `GET {issue}` `state`, `state_reason`; `GET {pr}` `merged`. Timeline: `closed`, `merged`. repos feed: `github.issue.closed`, `github.pr.merged`, `github.pr.closed` | Unreliable |
| **Changes requested on your PR** | Not in the feed as its own reason. Your PR's thread has `reason: author`. Read `GET {pr}/reviews`: a review with `state: CHANGES_REQUESTED`. Timeline: `reviewed` with `state: changes_requested`. repos feed: `github.pr.review-submitted` with `verdict: changes-requested` | That reviewer approves later | `GET {pr}/reviews` (chronological): the reviewer's latest review has `state: APPROVED`. Timeline: `reviewed` with `state: approved` | No |
| | | The review is dismissed | Timeline: `review_dismissed` with `dismissed_review.state`, `review_id`, `dismissal_message`. Docs: "Dismissing a review changes the status of the review to a review comment" | No |
| | | You re-request that reviewer (you consider it addressed) | `GET {pr}/requested_reviewers` contains the reviewer again. Timeline: `review_requested` with `review_requester` = you | No |
| | | You push new commits (a product choice, not a GitHub state) | `GET {pr}` `head.sha` changes. Timeline: `committed`, `head_ref_force_pushed`. repos feed: `github.pr.synchronized` | No |
| | | PR merged or closed | `GET {pr}` `state`, `merged` | Unreliable |
| **Checks failed on your PR** | Not reliably in the feed. checks feed: `github.pr.checks-completed` with a failing `conclusion`. Read `GET /repos/{owner}/{repo}/commits/{ref}/check-suites` (`status`, `conclusion`) and `GET /repos/{owner}/{repo}/commits/{ref}/check-runs?filter=latest`, plus `GET /repos/{owner}/{repo}/commits/{ref}/status` for commit statuses (combined `state`: `failure`, `pending`, `success`) | A re-run goes green on the same commit | Same endpoints on the same `head.sha`: `filter=latest` (the default) returns the most recent run per check | Sometimes: `ci_activity` fires again when an Actions run you triggered completes, if you opted in |
| | | A new commit is pushed | `GET {pr}` `head.sha` changes; the old failure no longer describes the PR | No |
| | | PR merged or closed | `GET {pr}` `state`, `merged` | Unreliable |

`state_change` is unreliable as an end signal because GitHub documents it two ways. The REST page says "You changed the thread state (for example, closing an issue or merging a pull request)". The inbox-filter page says "When the state of a pull request or issue is changed". Either way, `reason` is sticky per thread, so a PR merged by someone else does not reliably show up as `state_change` on your thread.

## Every `reason` value

From the REST notifications page ("About notification reasons"). The inbox-filter page spells them with dashes (`reason:review-requested`) and adds `reason:participating`, which is a filter, not an API value.

| `reason` | GitHub's description | Names you or a team |
|---|---|---|
| `approval_requested` | You were requested to review and approve a deployment | You (a deployment reviewer) |
| `assign` | You were assigned to the issue | You |
| `author` | You created the thread | You |
| `ci_activity` | A GitHub Actions workflow run that you triggered was completed | You (as the one who triggered the run) |
| `comment` | You commented on the thread | You |
| `invitation` | You accepted an invitation to contribute to the repository | You |
| `manual` | You subscribed to the thread (via an issue or pull request) | You |
| `member_feature_requested` | Organization members have requested to enable a feature such as Copilot | You (an org owner) |
| `mention` | You were specifically **@mentioned** in the content | You |
| `review_requested` | You, or a team you're a member of, were requested to review a pull request | **Either.** The reason does not say which |
| `security_advisory_credit` | You were credited for contributing to a security advisory | You |
| `security_alert` | GitHub discovered a security vulnerability in your repository | Your repository |
| `state_change` | You changed the thread state (for example, closing an issue or merging a pull request) | You (REST page); see the conflict above |
| `subscribed` | You're watching the repository | Your watch |
| `team_mention` | You were on a team that was mentioned | A team |

How the reason behaves, quoted from the REST page: "Note that the `reason` is modified on a per-thread basis, and can change, if the `reason` on a later notification is different. For example, if you are the author of an issue, subsequent notifications on that issue will have a `reason` of `author`. If you're then **@mentioned** on the same issue, the notifications you fetch thereafter will have a `reason` of `mention`. The `reason` remains as `mention`, regardless of whether you're ever mentioned again." The order in which reasons override each other is not documented.

Spec 08 §5.1 lists `mention`, `assign`, `review_requested`, `state_change`, `comment`, `subscribed`, `ci_activity`, `security_alert`. The full list adds `approval_requested`, `author`, `invitation`, `manual`, `member_feature_requested`, `security_advisory_credit` and `team_mention`. `author` matters for the "your PR" asks; `team_mention` matters for "mentioned".

## What a notification thread carries

`GET /notifications` returns "threads". The OpenAPI `thread` schema:

| Field | Type | Notes |
|---|---|---|
| `id` | string | The thread id, used by `/notifications/threads/{thread_id}` |
| `repository` | minimal repository | `full_name`, `owner`, and so on |
| `subject.title` | string | The issue or PR title. For a `CheckSuite` it is prose, for example "Build workflow run failed for feat/x branch" (observed) |
| `subject.url` | string | The API URL of the issue or PR (`/repos/{owner}/{repo}/pulls/{n}`). `null` for `CheckSuite` (observed, although the schema marks it required) |
| `subject.latest_comment_url` | string | The API URL of the latest comment. Equal to `subject.url` on every PR thread sampled (observed): it falls back to the PR when the latest activity was not a comment. `null` for `CheckSuite` (observed) |
| `subject.type` | string | Not enumerated in the schema. Seen: `PullRequest`, `CheckSuite`. The inbox filters also name commits, releases, gists, discussions, invitations and vulnerability alerts |
| `reason` | string | See above |
| `unread` | boolean | |
| `updated_at` | string | When the thread last received a notification |
| `last_read_at` | string, nullable | When you last read it; `null` if never read |
| `url` | string | The thread's API URL |
| `subscription_url` | string | |

What is missing for spec 08's common `subject` block `{repo, number?, title?, author?, state?, url}`: the thread has no author, no state and no web URL. The number can be parsed from `subject.url` for issues and PRs only. Filling `author` and `state` takes a read of `subject.url`; a `CheckSuite` thread has nothing to read.

Listing parameters on `GET /notifications`:

- `all` - "If `true`, show notifications marked as read." The default is unread only.
- `participating` - "If `true`, only shows notifications in which the user is directly participating or mentioned." The docs do not say whether team mentions and team review requests count.
- `since`, `before` - timestamps on `updated_at`.
- `per_page` - "max 50", default 50. This endpoint caps at 50, not 100.

Polling: "Notifications are optimized for polling with the `Last-Modified` header. If there are no new notifications, you will see a `304 Not Modified` response, leaving your current rate limit untouched. There is an `X-Poll-Interval` header that specifies how often (in seconds) you are allowed to poll." Observed: `X-Poll-Interval: 60`, and `Last-Modified` equals the newest `updated_at` in the list. Sending that value back in `If-Modified-Since` returned `304`.

### Is read or done on GitHub visible to Hercule?

- **Read:** yes, but only by listing with `all=true` (then `unread: false`, `last_read_at` set) or by `GET /notifications/threads/{thread_id}`. Without `all=true` the thread disappears from the list, which looks the same as "never there". Observed: a thread read after its last update kept its `updated_at` (`last_read_at` 13:02, `updated_at` 13:00), so reading does not move `Last-Modified`, and a conditional poll answers `304`. Hercule sees a read only on a full (non-conditional) poll or on the thread's next real update.
- **Done:** GitHub documents done as "Remove a notification from the inbox" and `is:done` as an inbox filter. The API's `DELETE /notifications/threads/{thread_id}` "is equivalent to marking a notification in your notification inbox on GitHub as done". Whether a done thread still comes back with `all=true`, or from `GET /notifications/threads/{thread_id}`, is not documented. **Unverified**; not tested, because testing it would change Rogier's live inbox.
- **Retention:** "Notifications that are not marked as **Saved** are kept for 3 months."
- Hercule can also write: `PATCH /notifications/threads/{thread_id}` marks a thread read, and `DELETE` marks it done. Spec 05 §4.4's action roster decides whether that is offered.

### Who can read notifications

- "These endpoints only support authentication using a personal access token (classic)." So a fine-grained PAT cannot read notifications.
- OAuth App tokens work: the sample in this research used a `gho_` token that has the `repo` scope and no `notifications` scope. The docs say "All calls to these endpoints require the `notifications` or `repo` scopes."
- So spec 08 §9.3's device flow covers asks. A user on the fine-grained PAT fallback gets no asks from the feed.

## Rate limits at 60-second polling

Facts from the docs:

- **Primary limit:** 5,000 requests per hour for an authenticated user. "All of these requests count towards your personal rate limit": personal access tokens, OAuth Apps and GitHub Apps acting for the user share one budget. 15,000 when the OAuth App is owned or approved by a GitHub Enterprise Cloud organization the user belongs to.
- **Conditional requests:** "Making a conditional request does not count against your primary rate limit if a `304` response is returned." Most endpoints return an `etag`, many a `last-modified`.
- **Smaller responses 304 more often:** "A smaller, more specific response changes less often, so it returns `304 Not Modified` more often." Use the same parameters every poll; a different page size or filter is a different response with a different `etag`.
- **Secondary limits:** no more than 100 concurrent requests; no more than 900 points per minute per REST endpoint (a `GET` is 1 point); "you should make requests serially instead of concurrently".
- **Search:** a separate limit of 30 requests per minute for authenticated users (search code: 10).
- **GraphQL:** a separate primary limit of 5,000 points per hour per user.

What that means per ask, worst case (every request a `200`):

| What is read | Requests per hour |
|---|---|
| `GET /notifications`, one page | 60, mostly free `304`s |
| One endpoint per open ask, every tick | 60 per ask: 20 asks = 1,200 |
| Two endpoints per open ask (for example `requested_reviewers` and `reviews`) | 120 per ask: 20 asks = 2,400 |
| Spec 08 `checks` feed, 20 open PRs | about 1,200 |
| One search query per ask kind, every tick | 60 per kind, in the separate search bucket (4 kinds = 4 per minute, against 30) |

Choosing the endpoint matters for how often a `304` comes back. `GET {pr}` changes on any edit to the PR (title, labels, head, `mergeable_state`), so its `etag` moves often. `GET {pr}/requested_reviewers` changes only when the set of requested reviewers changes. Not measured here: how often each endpoint actually returns `304` in practice.

The budget is shared with whatever else uses the same GitHub account: `gh` in Rogier's shell and agents in sessions that use the same token. During this research the agent's own `gh` calls briefly hit a rate-limit warning.

## Sources

GitHub docs, from the `github/docs` repository (`main`, read 2026-10-04); the docs.github.com page is the same text:

- REST notifications, with "About notification reasons" and the polling note: `content/rest/activity/notifications.md` - https://docs.github.com/en/rest/activity/notifications
- Classic PAT only note: `data/reusables/user-settings/notifications-api-classic-pat-only.md`
- About notifications (triage, done, retention): `content/subscriptions-and-notifications/concepts/about-notifications.md` - https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications
- Inbox filters (`reason:` filter descriptions): `content/subscriptions-and-notifications/reference/inbox-filters.md`
- Actions notifications (opt-in, failed only): `content/subscriptions-and-notifications/how-tos/managing-github-actions-notifications.md`, `content/actions/concepts/workflows-and-actions/notifications-for-workflow-runs.md`
- Issue event types (`review_requested`, `review_request_removed`, `review_dismissed`, `reviewed`, `assigned`, `unassigned`, `mentioned`, `merged`, `closed`, `head_ref_force_pushed`): `content/rest/using-the-rest-api/issue-event-types.md`, `data/reusables/issue-events/review-request-properties.md`, `data/reusables/issue-events/review-dismissed-properties.md` - https://docs.github.com/en/rest/using-the-rest-api/issue-event-types
- Review requests and reviews: `content/rest/pulls/review-requests.md`, `content/rest/pulls/reviews.md`, `content/pull-requests/reference/pull-request-reviews.md`, `content/pull-requests/how-tos/create-pull-requests/requesting-a-pull-request-review.md`, `content/pull-requests/how-tos/review-pull-requests/dismissing-a-pull-request-review.md`
- Protected branches (stale approvals): `content/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches.md`
- Commit statuses: `content/rest/commits/statuses.md`
- Rate limits: `content/rest/using-the-rest-api/rate-limits-for-the-rest-api.md`, `data/reusables/rest-api/primary-rate-limit-authenticated-users.md`, `data/reusables/rest-api/secondary-rate-limit-rest-graphql.md` - https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- Conditional requests: `content/rest/using-the-rest-api/best-practices-for-using-the-rest-api.md` - https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- Search limits and qualifiers: `content/rest/search/search.md`, `content/search-github/searching-on-github/searching-issues-and-pull-requests.md`
- GraphQL limits: `content/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api.md`; GraphQL fields: `src/graphql/data/fpt/schema.docs.graphql`

GitHub's OpenAPI description, `github/rest-api-description`, `descriptions/api.github.com/api.github.com.json`, version 1.1.4: the `thread`, `pull-request`, `pull-request-review`, `pull-request-review-request`, `check-suite`, `check-run`, `review-requested-issue-event`, `review-request-removed-issue-event`, `review-dismissed-issue-event` and `timeline-reviewed-event` schemas, and the parameters of `GET /notifications` and `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`.

Observed, one read-only sample (2026-10-04) of `GET /notifications?all=true&per_page=50` with an OAuth App token: the `X-Poll-Interval` and `Last-Modified` headers, the `304` on `If-Modified-Since`, `CheckSuite` threads with `null` URLs and prose titles, `latest_comment_url` equal to `subject.url` on PR threads, and `updated_at` not moving on read.

## What this means for the ask contract

Facts and options, not decisions.

**Facts the contract has to accept:**

1. An ask's start can come from the notifications feed for three asks (review requested, mentioned, assigned). For changes requested and checks failed, the start comes from reading the PR (reviews, checks), which spec 08 already does in the `repos` and `checks` feeds, but only for watched repositories.
2. An ask's end never comes from the notifications feed. Every v1 ask needs at least one extra read per open ask, or a batched read that covers all of them.
3. A thread's `reason` cannot be used as "what just happened". A new event on a thread must be confirmed against current state on the PR or issue.
4. `review_requested` does not say whether you or a team was asked. The contract can only show "you" versus "your team" after reading `requested_reviewers` and `requested_teams` (or the timeline event's `requested_reviewer` versus `requested_team`).
5. A mention has no end on GitHub. "Leaves when" for a mention is a Hercule choice: you answer on GitHub, the thread closes, you mark it read there, or only you answer it in Intake.
6. "Changes requested" has several possible ends, and which one counts is a product choice: an approval, a dismissal, a re-request, a new push, or merge or close.
7. A fine-grained PAT Connection gets no notifications, so no review-requested, mentioned or assigned asks.

**Options for reading end state (each is a real option; none is chosen here):**

- **A. Per-ask polling with `etag`s.** For each open ask, poll the one small endpoint that decides it (`requested_reviewers`, `reviews`, the issue's `assignees`, the head commit's checks). Simple and exact; costs up to 60 requests per hour per open ask, mostly free `304`s.
- **B. Read only when the thread moves.** Re-read an ask's state only when its notification thread's `updated_at` changes. Cheapest. But it is not documented which ends bump the thread (request removed, unassigned, merged by someone else), so an ask could stay open after its end.
- **C. One search per ask kind per tick.** `GET /search/issues` with `q=is:open is:pr user-review-requested:@me` (direct requests only), `is:open is:pr review-requested:@me` (also matches team requests), `is:open assignee:@me`, `is:open is:pr author:@me review:changes_requested`, `is:open is:pr author:@me status:failure`. Each returns the full current set, so an end is "the item left the set". Runs in the separate search bucket. Caveats: search results come from an index, and its delay is not documented; `status:` is documented for commit statuses and "a CI service", and it is not stated whether it covers check runs; `review:changes_requested` is the PR's overall review state, not "a reviewer still asks for changes from you".
- **D. One GraphQL query per tick.** `PullRequest` has `reviewRequests`, `reviewDecision` and `statusCheckRollup` (confirmed in GitHub's public schema), so one query can read the state of every open ask. Separate 5,000-point budget. The point cost of such a query was not researched.
- **E. Extend the watch list.** Spec 08's `repos` and `checks` feeds already emit `github.pr.review-submitted`, `github.pr.merged`, `github.pr.closed`, `github.issue.assigned` and `github.pr.checks-completed`, but only for watched repositories. An ask from a repository outside the watch list could add that repository, or that one PR, to what the feeds read.
- **F. Poll the feed with `all=true`.** Makes "marked read on GitHub" visible as an end. Costs more `200`s, because read threads stay in the list and the list is larger. Does not help with done (unverified).

**Spec conflicts surfaced by this research:**

- Spec 08 §9.3 offers a fine-grained PAT as a fallback and lists its gaps ("no Packages, no Checks API, single org, no outside-collaborator access"). It does not list "no notifications", which removes three of the five v1 asks.
- Spec 08 §5.1 says every payload carries `subject` `{repo, number?, title?, author?, state?, url}`. A notification thread carries no author or state, and a `CheckSuite` thread has no `subject.url` at all.
