/**
 * The GitHub objects the workflow actions read and return: an issue, a pull
 * request, a comment, a review and a merge, and the input fields that name
 * them. Each object has two schemas.
 *
 * - The `Github...` schema is the part of GitHub's REST response the plugin
 *   reads. Fields it does not name are ignored.
 * - The schema without the prefix is what an action returns, which an
 *   expression reads as `steps.<id>.output`. Its fields are named the way the
 *   rest of Hercule names things, not the way GitHub does.
 *
 * Every action that returns an issue or a pull request decodes it with the
 * same function, so `issue.read` and `issue.update` return the same shape.
 */
import { Effect, Schema } from "effect";
import type { ActionError } from "@hercule/plugin-host";
import { decodeGithubBody } from "./call";

/** The number of an issue or a pull request in its repository. */
export const ItemNumber = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * Builds the check that an update input names at least one of `changes`, the
 * fields it can change. Without it, a step that changes nothing would still
 * call GitHub. `message` is the error a save shows for such a step.
 */
export const refuseEmptyUpdate = (changes: Readonly<Record<string, unknown>>, message: string) =>
  Schema.makeFilter((update: Readonly<Record<string, unknown>>) =>
    Object.keys(changes).some((field) => update[field] !== undefined) ? undefined : message,
  );

/** A GitHub account, as GitHub's responses embed one. */
const GithubAccount = Schema.Struct({ login: Schema.String });

/** A list of accounts. GitHub sends null in place of an empty list in some responses. */
const GithubAccounts = Schema.NullOr(Schema.Array(GithubAccount));

const GithubLabel = Schema.Struct({ name: Schema.String });

const OpenOrClosed = Schema.Literals(["open", "closed"]);

/** An issue, as GitHub's REST API returns it. */
const GithubIssue = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: OpenOrClosed,
  state_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  labels: Schema.Array(GithubLabel),
  assignees: Schema.optionalKey(GithubAccounts),
  user: Schema.NullOr(GithubAccount),
  html_url: Schema.String,
});

/** The fields an issue and a pull request share, as an action returns them. */
const ISSUE_FIELDS = {
  number: Schema.Int,
  title: Schema.String,
  body: Schema.NullOr(Schema.String).annotate({ description: "Null when the body is empty." }),
  state: OpenOrClosed,
  labels: Schema.Array(Schema.String).annotate({ description: "The names of the labels." }),
  assignees: Schema.Array(Schema.String).annotate({
    description: "The logins of the assigned accounts.",
  }),
  author: Schema.NullOr(Schema.String).annotate({
    description: "The login of the account that opened it.",
  }),
  url: Schema.String.annotate({ description: "Where a person opens it on GitHub." }),
};

/** An issue, as an action returns it. */
export const Issue = Schema.Struct({
  ...ISSUE_FIELDS,
  stateReason: Schema.NullOr(Schema.String).annotate({
    description:
      "Why the issue is in its state, in GitHub's words: completed, not_planned or reopened. Null when GitHub gives no reason.",
  }),
});

export type Issue = Schema.Schema.Type<typeof Issue>;

/** A pull request, as GitHub's REST API returns it. */
const GithubPullRequest = Schema.Struct({
  node_id: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: OpenOrClosed,
  draft: Schema.optionalKey(Schema.Boolean),
  merged: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.Boolean),
  labels: Schema.Array(GithubLabel),
  assignees: Schema.optionalKey(GithubAccounts),
  requested_reviewers: Schema.optionalKey(GithubAccounts),
  user: Schema.NullOr(GithubAccount),
  html_url: Schema.String,
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
    /** Null when the fork the pull request came from was deleted. */
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({ ref: Schema.String }),
});

export type GithubPullRequest = Schema.Schema.Type<typeof GithubPullRequest>;

/** A pull request, as an action returns it. */
export const PullRequest = Schema.Struct({
  ...ISSUE_FIELDS,
  draft: Schema.Boolean,
  merged: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.Boolean).annotate({
    description:
      "Whether the pull request can be merged without conflicts. Null while GitHub is still working it out, which it does in the background after a change.",
  }),
  requestedReviewers: Schema.Array(Schema.String).annotate({
    description: "The logins of the accounts asked for a review that have not given one yet.",
  }),
  headSha: Schema.String.annotate({
    description: "The commit the pull request's branch points at.",
  }),
  headRef: Schema.String.annotate({ description: "The branch the changes are on." }),
  baseRef: Schema.String.annotate({ description: "The branch the changes would be merged into." }),
});

export type PullRequest = Schema.Schema.Type<typeof PullRequest>;

/** A comment on an issue or a pull request, as GitHub's REST API returns it. */
const GithubComment = Schema.Struct({ id: Schema.Int, html_url: Schema.String });

/** A comment, as an action returns it. */
export const Comment = Schema.Struct({
  id: Schema.Int.annotate({ description: "GitHub's id of the comment." }),
  url: Schema.String.annotate({ description: "Where a person opens the comment on GitHub." }),
});

export type Comment = Schema.Schema.Type<typeof Comment>;

/**
 * GitHub's word for a review's verdict, and the word the plugin uses for it.
 * The plugin's words are the ones the `github.pr.review-submitted` event uses.
 */
const REVIEW_VERDICTS = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  COMMENTED: "commented",
} as const;

/** A review, as GitHub's REST API returns it once it is submitted. */
const GithubReview = Schema.Struct({
  id: Schema.Int,
  state: Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]),
  html_url: Schema.String,
});

/** A submitted review, as an action returns it. */
export const Review = Schema.Struct({
  id: Schema.Int.annotate({ description: "GitHub's id of the review." }),
  state: Schema.Literals(["approved", "changes-requested", "commented"]),
  url: Schema.String.annotate({ description: "Where a person opens the review on GitHub." }),
});

export type Review = Schema.Schema.Type<typeof Review>;

/** The answer to a merge, as GitHub's REST API returns it. */
const GithubMerge = Schema.Struct({
  sha: Schema.String,
  merged: Schema.Boolean,
  message: Schema.String,
});

/** Converts GitHub's list of accounts into their logins. */
const listLogins = (
  accounts: Schema.Schema.Type<typeof GithubAccounts> | undefined,
): ReadonlyArray<string> => (accounts ?? []).map((account) => account.login);

/** Converts an issue as GitHub returns it into the issue an action returns. */
const buildIssue = (issue: Schema.Schema.Type<typeof GithubIssue>): Issue => ({
  number: issue.number,
  title: issue.title,
  body: issue.body,
  state: issue.state,
  stateReason: issue.state_reason ?? null,
  labels: issue.labels.map((label) => label.name),
  assignees: listLogins(issue.assignees),
  author: issue.user?.login ?? null,
  url: issue.html_url,
});

/** Converts a pull request as GitHub returns it into the pull request an action returns. */
export const buildPullRequest = (pull: GithubPullRequest): PullRequest => ({
  number: pull.number,
  title: pull.title,
  body: pull.body,
  state: pull.state,
  draft: pull.draft ?? false,
  merged: pull.merged,
  mergeable: pull.mergeable,
  labels: pull.labels.map((label) => label.name),
  assignees: listLogins(pull.assignees),
  requestedReviewers: listLogins(pull.requested_reviewers),
  author: pull.user?.login ?? null,
  url: pull.html_url,
  headSha: pull.head.sha,
  headRef: pull.head.ref,
  baseRef: pull.base.ref,
});

/** Decodes an issue from GitHub's response and converts it into the issue an action returns. */
export const decodeIssue = (body: Schema.Json): Effect.Effect<Issue, ActionError> =>
  Effect.map(decodeGithubBody(GithubIssue, body), buildIssue);

/**
 * Decodes a pull request from GitHub's response. Returns it as GitHub sent it,
 * because some actions need fields the output leaves out, such as `node_id`;
 * `buildPullRequest` converts it into what an action returns.
 */
export const decodePullRequest = (
  body: Schema.Json,
): Effect.Effect<GithubPullRequest, ActionError> => decodeGithubBody(GithubPullRequest, body);

/** Decodes a comment from GitHub's response and converts it into the comment an action returns. */
export const decodeComment = (body: Schema.Json): Effect.Effect<Comment, ActionError> =>
  Effect.map(decodeGithubBody(GithubComment, body), (comment) => ({
    id: comment.id,
    url: comment.html_url,
  }));

/** Decodes a submitted review from GitHub's response and converts it into the review an action returns. */
export const decodeReview = (body: Schema.Json): Effect.Effect<Review, ActionError> =>
  Effect.map(decodeGithubBody(GithubReview, body), (review) => ({
    id: review.id,
    state: REVIEW_VERDICTS[review.state],
    url: review.html_url,
  }));

/** Decodes the answer to a merge from GitHub's response. */
export const decodeMerge = (
  body: Schema.Json,
): Effect.Effect<Schema.Schema.Type<typeof GithubMerge>, ActionError> =>
  decodeGithubBody(GithubMerge, body);
