/**
 * The GitHub objects the feeds read, as schemas of only the fields they use.
 * GitHub's responses hold many more fields; decoding ignores them, and the
 * whole object is kept as the event's `raw`.
 *
 * A feed reads GitHub's own words, such as an issue's or a review's `state`,
 * as plain strings and passes them on. The workflow actions read a single
 * object right after changing it, and keep their own, stricter schemas in
 * `actions/objects.ts`. The names here start with `Listed`, because a feed
 * reads these objects from GitHub's listings.
 */
import { Schema } from "effect";
import { GithubAccount, GithubAccounts, GithubLabel } from "../github-objects";

/**
 * An issue, as `GET /repos/{owner}/{repo}/issues` returns it. That listing
 * holds pull requests too: those have a `pull_request` field, whose
 * `merged_at` tells a merge from a close.
 */
export const ListedIssue = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  user: Schema.NullOr(GithubAccount),
  labels: Schema.Array(GithubLabel),
  assignees: Schema.optionalKey(GithubAccounts),
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.NullOr(Schema.String),
  /** Who closed it, or merged it for a pull request. Only `GET .../issues/{number}` sends it. */
  closed_by: Schema.optionalKey(Schema.NullOr(GithubAccount)),
  /** Why the issue is in its state, such as `reopened` for an open issue that was closed before. */
  state_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pull_request: Schema.optionalKey(
    Schema.Struct({ merged_at: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
});

export type ListedIssue = Schema.Schema.Type<typeof ListedIssue>;

/** A team, as GitHub embeds one in a pull request's review requests. */
const ListedTeamRef = Schema.Struct({ slug: Schema.String });

/**
 * A pull request, as `GET /repos/{owner}/{repo}/pulls` and `.../pulls/{number}`
 * return it. `requested_reviewers` and `requested_teams` list the reviews
 * still asked for: GitHub drops a reviewer from them once they review.
 * `merged_by` is only in the answer of `.../pulls/{number}`.
 */
export const ListedPull = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  user: Schema.NullOr(GithubAccount),
  head: Schema.Struct({ sha: Schema.String }),
  updated_at: Schema.String,
  requested_reviewers: Schema.optionalKey(GithubAccounts),
  requested_teams: Schema.optionalKey(Schema.NullOr(Schema.Array(ListedTeamRef))),
  merged_by: Schema.optionalKey(Schema.NullOr(GithubAccount)),
});

export type ListedPull = Schema.Schema.Type<typeof ListedPull>;

/** A review, as `GET /repos/{owner}/{repo}/pulls/{number}/reviews` returns it. */
export const ListedReview = Schema.Struct({
  id: Schema.Int,
  user: Schema.NullOr(GithubAccount),
  state: Schema.String,
  submitted_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export type ListedReview = Schema.Schema.Type<typeof ListedReview>;

/**
 * A comment on an issue or on a pull request's conversation, as
 * `GET /repos/{owner}/{repo}/issues/comments` returns it. `issue_url` ends in
 * the item's number, and `html_url` has `/pull/<number>#` in it for a pull
 * request.
 */
export const ListedComment = Schema.Struct({
  id: Schema.Int,
  html_url: Schema.String,
  issue_url: Schema.String,
  user: Schema.NullOr(GithubAccount),
  /** Markdown. GitHub leaves it out of a comment that has no text. */
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  updated_at: Schema.String,
});

export type ListedComment = Schema.Schema.Type<typeof ListedComment>;

/**
 * One entry of an issue's or a pull request's history, as
 * `GET /repos/{owner}/{repo}/issues/{number}/events` returns it, oldest
 * first. `event` is GitHub's word, such as `review_requested`, `merged` or
 * `closed`. A review request names either one reviewer or one team; an
 * assignment names its `assignee`.
 */
export const IssueEvent = Schema.Struct({
  id: Schema.Int,
  event: Schema.String,
  created_at: Schema.String,
  actor: Schema.NullOr(GithubAccount),
  requested_reviewer: Schema.optionalKey(Schema.NullOr(GithubAccount)),
  requested_team: Schema.optionalKey(Schema.NullOr(ListedTeamRef)),
  review_requester: Schema.optionalKey(Schema.NullOr(GithubAccount)),
  assignee: Schema.optionalKey(Schema.NullOr(GithubAccount)),
});

export type IssueEvent = Schema.Schema.Type<typeof IssueEvent>;

/**
 * One result of `GET /search/issues`. The search does not name the
 * repository directly; `repository_url` is its API URL, which ends in
 * `/repos/{owner}/{repo}`.
 */
export const FoundIssue = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  repository_url: Schema.String,
  updated_at: Schema.String,
});

export type FoundIssue = Schema.Schema.Type<typeof FoundIssue>;

/** A team the user belongs to, as `GET /user/teams` returns it. */
export const ListedTeam = Schema.Struct({
  slug: Schema.String,
  organization: Schema.Struct({ login: Schema.String }),
});

/** One notification thread, as `GET /notifications` returns it. */
export const GithubNotification = Schema.Struct({
  id: Schema.String,
  reason: Schema.String,
  updated_at: Schema.String,
  subject: Schema.Struct({
    title: Schema.String,
    /** The API URL of the issue or pull request; null for a discussion or a check suite. */
    url: Schema.NullOr(Schema.String),
    type: Schema.String,
  }),
  repository: Schema.Struct({ full_name: Schema.String }),
});

export type GithubNotification = Schema.Schema.Type<typeof GithubNotification>;

/**
 * One check suite on a commit, as an entry of the `check_suites` list that
 * `GET /repos/{owner}/{repo}/commits/{sha}/check-suites` returns.
 */
export const GithubCheckSuite = Schema.Struct({
  id: Schema.Int,
  status: Schema.NullOr(Schema.String),
  conclusion: Schema.NullOr(Schema.String),
  updated_at: Schema.NullOr(Schema.String),
  latest_check_runs_count: Schema.Int,
  /** The app that ran the suite; `slug` is `github-actions` for GitHub Actions. */
  app: Schema.NullOr(Schema.Struct({ name: Schema.String, slug: Schema.String })),
});

export type GithubCheckSuite = Schema.Schema.Type<typeof GithubCheckSuite>;

/**
 * One check run on a commit, as an entry of the `check_runs` list that
 * `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` returns. `output`
 * holds what the check reported: `summary` and `text` are markdown, and
 * `annotations_count` says how many annotations
 * `GET .../check-runs/{id}/annotations` lists.
 */
export const ListedCheckRun = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.NullOr(Schema.String),
  app: Schema.NullOr(Schema.Struct({ name: Schema.String, slug: Schema.String })),
  output: Schema.Struct({
    title: Schema.NullOr(Schema.String),
    summary: Schema.NullOr(Schema.String),
    text: Schema.NullOr(Schema.String),
    annotations_count: Schema.Int,
  }),
});

export type ListedCheckRun = Schema.Schema.Type<typeof ListedCheckRun>;
