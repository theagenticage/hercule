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
  /** Why the issue is in its state, such as `reopened` for an open issue that was closed before. */
  state_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pull_request: Schema.optionalKey(
    Schema.Struct({ merged_at: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
});

export type ListedIssue = Schema.Schema.Type<typeof ListedIssue>;

/** A pull request, as `GET /repos/{owner}/{repo}/pulls` and `.../pulls/{number}` return it. */
export const ListedPull = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  user: Schema.NullOr(GithubAccount),
  head: Schema.Struct({ sha: Schema.String }),
  updated_at: Schema.String,
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
  created_at: Schema.String,
  updated_at: Schema.String,
});

export type ListedComment = Schema.Schema.Type<typeof ListedComment>;

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
      id: Schema.Int,
      status: Schema.NullOr(Schema.String),
      conclusion: Schema.NullOr(Schema.String),
      updated_at: Schema.NullOr(Schema.String),
      latest_check_runs_count: Schema.Int,
      app: Schema.NullOr(Schema.Struct({ name: Schema.String })),
    }),
  ),
});

export type GithubCheckSuite = Schema.Schema.Type<typeof GithubCheckSuites>["check_suites"][number];
