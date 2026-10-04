/**
 * The GitHub objects the feeds read, as schemas of only the fields they use.
 * GitHub's responses hold many more fields; decoding ignores them, and the
 * whole object is kept as the event's `raw`.
 */
import { Schema } from "effect";

/** An account, as GitHub embeds one in another object. */
const GithubUser = Schema.Struct({ login: Schema.String });

/**
 * An issue, as `GET /repos/{owner}/{repo}/issues` returns it. That listing
 * holds pull requests too: those have a `pull_request` field, whose
 * `merged_at` tells a merge from a close.
 */
export const GithubIssue = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  user: Schema.NullOr(GithubUser),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  assignees: Schema.optionalKey(Schema.NullOr(Schema.Array(GithubUser))),
  comments: Schema.Int,
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.NullOr(Schema.String),
  pull_request: Schema.optionalKey(
    Schema.Struct({ merged_at: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
});

export type GithubIssue = Schema.Schema.Type<typeof GithubIssue>;

/** A pull request, as `GET /repos/{owner}/{repo}/pulls` and `.../pulls/{number}` return it. */
export const GithubPull = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  user: Schema.NullOr(GithubUser),
  head: Schema.Struct({ sha: Schema.String }),
  updated_at: Schema.String,
});

export type GithubPull = Schema.Schema.Type<typeof GithubPull>;

/** A review, as `GET /repos/{owner}/{repo}/pulls/{number}/reviews` returns it. */
export const GithubReview = Schema.Struct({
  id: Schema.Int,
  user: Schema.NullOr(GithubUser),
  state: Schema.String,
  submitted_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export type GithubReview = Schema.Schema.Type<typeof GithubReview>;

/**
 * A comment on an issue or on a pull request's conversation, as
 * `GET /repos/{owner}/{repo}/issues/comments` returns it. `issue_url` ends in
 * the item's number, and `html_url` has `/pull/` in it for a pull request.
 */
export const GithubComment = Schema.Struct({
  id: Schema.Int,
  html_url: Schema.String,
  issue_url: Schema.String,
  created_at: Schema.String,
});

export type GithubComment = Schema.Schema.Type<typeof GithubComment>;

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
 * The check suites on one commit, as
 * `GET /repos/{owner}/{repo}/commits/{sha}/check-suites` returns them.
 */
export const GithubCheckSuites = Schema.Struct({
  check_suites: Schema.Array(
    Schema.Struct({
      status: Schema.NullOr(Schema.String),
      conclusion: Schema.NullOr(Schema.String),
      updated_at: Schema.NullOr(Schema.String),
      latest_check_runs_count: Schema.Int,
      app: Schema.NullOr(Schema.Struct({ name: Schema.String })),
    }),
  ),
});

export type GithubCheckSuite = Schema.Schema.Type<typeof GithubCheckSuites>["check_suites"][number];
