/**
 * The workflow actions on a GitHub pull request: read it, comment on it,
 * review it, change it, merge it, and open one from a branch that is already
 * pushed.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { ActionError } from "@hercule/plugin-host";
import { callGithub, decodeGithubBody, defineGithubAction, readConnectionToken } from "./call";
import {
  buildPullRequest,
  Comment,
  decodeComment,
  decodeMerge,
  decodePullRequest,
  decodeReview,
  ItemNumber,
  PullRequest,
  refuseEmptyUpdate,
  Review,
  type GithubPullRequest,
} from "./objects";
import { RepoName } from "../repo-name";

/** The fields that name one pull request. */
const PULL_REQUEST_ADDRESS = {
  repo: RepoName,
  number: ItemNumber.annotate({ description: "The pull request's number in the repository." }),
};

interface PullRequestAddress {
  readonly repo: string;
  readonly number: number;
}

/** Returns the REST path of one pull request. */
const buildPullRequestPath = (address: PullRequestAddress): string =>
  `/repos/${address.repo}/pulls/${String(address.number)}`;

/** Names one pull request for the message of an error. */
const describePullRequest = (address: PullRequestAddress): string =>
  `The pull request ${address.repo}#${String(address.number)}`;

/** Reads one pull request as GitHub returns it. */
const fetchPullRequest = (
  address: PullRequestAddress,
  token: string,
): Effect.Effect<GithubPullRequest, ActionError, HttpClient.HttpClient> =>
  Effect.flatMap(
    callGithub(
      { method: "GET", path: buildPullRequestPath(address), token },
      describePullRequest(address),
    ),
    decodePullRequest,
  );

export const prRead = defineGithubAction({
  id: "pr.read",
  displayName: "Read a GitHub pull request",
  description:
    "Reads one pull request of a repository: its title, body, state, labels, people, branches, head commit, and whether it is a draft, merged or mergeable.",
  input: Schema.Struct(PULL_REQUEST_ADDRESS),
  output: PullRequest,
  perform: (input, context) =>
    Effect.gen(function* () {
      const token = yield* readConnectionToken(context);
      return buildPullRequest(yield* fetchPullRequest(input, token));
    }),
});

export const prComment = defineGithubAction({
  id: "pr.comment",
  displayName: "Comment on a GitHub pull request",
  description:
    "Adds a comment to a pull request's conversation, as the Connection's account. The output holds the comment's id and URL.",
  input: Schema.Struct({
    ...PULL_REQUEST_ADDRESS,
    body: Schema.NonEmptyString.annotate({ description: "The comment, in GitHub Markdown." }),
  }),
  output: Comment,
  perform: (input, context) =>
    Effect.gen(function* () {
      const token = yield* readConnectionToken(context);
      // GitHub keeps the comments of a pull request's conversation as the
      // comments of the issue with the same number.
      const body = yield* callGithub(
        {
          method: "POST",
          path: `/repos/${input.repo}/issues/${String(input.number)}/comments`,
          token,
          body: { body: input.body },
        },
        describePullRequest(input),
      );
      return yield* decodeComment(body);
    }),
});

/** The verdict a step gives in `pr.review`, and GitHub's word for it. */
const REVIEW_EVENTS = {
  approve: "APPROVE",
  "request-changes": "REQUEST_CHANGES",
  comment: "COMMENT",
} as const;

export const prReview = defineGithubAction({
  id: "pr.review",
  displayName: "Review a GitHub pull request",
  description:
    "Submits a review of a pull request, as the Connection's account: approve, request changes, or comment. The output holds the review's id, state and URL.",
  input: Schema.Struct({
    ...PULL_REQUEST_ADDRESS,
    event: Schema.Literals(["approve", "request-changes", "comment"]).annotate({
      description: "The review's verdict.",
    }),
    body: Schema.optionalKey(
      Schema.NonEmptyString.annotate({
        description: "The review's text, in GitHub Markdown. Required unless the event is approve.",
      }),
    ),
  }).check(
    Schema.makeFilter((review: { readonly event: string; readonly body?: string }) =>
      review.event === "approve" || review.body !== undefined
        ? undefined
        : "A review that requests changes or comments must have a body.",
    ),
  ),
  output: Review,
  perform: (input, context) =>
    Effect.gen(function* () {
      const token = yield* readConnectionToken(context);
      const body = yield* callGithub(
        {
          method: "POST",
          path: `${buildPullRequestPath(input)}/reviews`,
          token,
          body: { event: REVIEW_EVENTS[input.event], body: input.body },
        },
        describePullRequest(input),
      );
      return yield* decodeReview(body);
    }),
});

/** The fields of a pull request that `pr.update` can change. */
const PULL_REQUEST_CHANGES = {
  title: Schema.optionalKey(Schema.NonEmptyString.annotate({ description: "The new title." })),
  body: Schema.optionalKey(
    Schema.String.annotate({ description: "The new body, in GitHub Markdown." }),
  ),
  state: Schema.optionalKey(
    Schema.Literals(["open", "closed"]).annotate({
      description: "Opens or closes the pull request without merging it.",
    }),
  ),
  base: Schema.optionalKey(
    Schema.NonEmptyString.annotate({
      description: "The branch the changes would be merged into.",
    }),
  ),
  labels: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "The names of the labels the pull request has afterwards. Labels not in the list are removed, and an empty list removes them all.",
    }),
  ),
  reviewers: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMinLength(1)).annotate({
      description:
        "The logins of accounts to ask for a review, in addition to those already asked.",
    }),
  ),
  draft: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "true turns the pull request into a draft, false marks it ready for review.",
    }),
  ),
};

/** The part of a GraphQL response the plugin reads: the errors, when there are any. */
const GraphqlErrors = Schema.Struct({
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ message: Schema.String, type: Schema.optionalKey(Schema.String) }),
    ),
  ),
});

/** The step error code for each GraphQL error type the plugin tells apart. */
const GRAPHQL_ERROR_CODES: Readonly<Record<string, string>> = {
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  RATE_LIMITED: "rate_limited",
};

/**
 * Turns a pull request into a draft, or marks a draft ready for review.
 * GitHub's REST API cannot do either, so this one change goes through its
 * GraphQL API. Fails with the code of GitHub's first error, or `validation`
 * for an error type the plugin does not tell apart.
 */
const changeDraftState = (
  pull: GithubPullRequest,
  draft: boolean,
  token: string,
  subject: string,
): Effect.Effect<void, ActionError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const mutation = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    const body = yield* callGithub(
      {
        method: "POST",
        path: "/graphql",
        token,
        body: {
          query: `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { pullRequest { id } } }`,
          variables: { id: pull.node_id },
        },
      },
      subject,
    );
    const errors = (yield* decodeGithubBody(GraphqlErrors, body)).errors ?? [];
    const first = errors[0];
    if (first === undefined) return;
    return yield* Effect.fail(
      new ActionError({
        code: GRAPHQL_ERROR_CODES[first.type ?? ""] ?? "validation",
        message: `GitHub refused to ${draft ? "turn the pull request into a draft" : "mark the pull request ready for review"}. GitHub said: ${errors.map((error) => error.message).join("; ")}`,
      }),
    );
  });

export const prUpdate = defineGithubAction({
  id: "pr.update",
  displayName: "Update a GitHub pull request",
  description:
    "Changes a pull request's title, body, state, base branch, labels or draft state, and asks reviewers for a review. Fields left out of the params are not changed. The output is the pull request as it is afterwards.",
  input: Schema.Struct({ ...PULL_REQUEST_ADDRESS, ...PULL_REQUEST_CHANGES }).check(
    refuseEmptyUpdate(
      PULL_REQUEST_CHANGES,
      "A pull request update must include at least one field to change, such as labels or draft.",
    ),
  ),
  output: PullRequest,
  // GitHub has a separate endpoint for the labels, for the reviewers and for
  // the draft state, so one update can take up to four requests. They are
  // sent in order, and a failure stops the rest: the step's error says which
  // change GitHub refused, and the changes before it stay made.
  perform: (input, context) =>
    Effect.gen(function* () {
      const token = yield* readConnectionToken(context);
      const subject = describePullRequest(input);
      const { title, body, state, base } = input;
      if (title !== undefined || body !== undefined || state !== undefined || base !== undefined) {
        yield* callGithub(
          {
            method: "PATCH",
            path: buildPullRequestPath(input),
            token,
            body: { title, body, state, base },
          },
          subject,
        );
      }
      if (input.labels !== undefined) {
        yield* callGithub(
          {
            method: "PATCH",
            path: `/repos/${input.repo}/issues/${String(input.number)}`,
            token,
            body: { labels: input.labels },
          },
          subject,
        );
      }
      if (input.reviewers !== undefined) {
        yield* callGithub(
          {
            method: "POST",
            path: `${buildPullRequestPath(input)}/requested_reviewers`,
            token,
            body: { reviewers: input.reviewers },
          },
          subject,
        );
      }
      if (input.draft !== undefined) {
        const pull = yield* fetchPullRequest(input, token);
        if ((pull.draft ?? false) !== input.draft) {
          yield* changeDraftState(pull, input.draft, token, subject);
        }
      }
      return buildPullRequest(yield* fetchPullRequest(input, token));
    }),
});

/** What `pr.merge` returns. */
const MergeResult = Schema.Struct({
  merged: Schema.Boolean,
  sha: Schema.String.annotate({ description: "The commit the merge made on the base branch." }),
  message: Schema.String.annotate({ description: "GitHub's message about the merge." }),
  branchDeleted: Schema.Boolean.annotate({
    description: "Whether the pull request's branch was deleted after the merge.",
  }),
});

/** Returns the REST path of a branch, with each part of its name encoded for a URL. */
const buildBranchRefPath = (repo: string, branch: string): string =>
  `/repos/${repo}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;

/**
 * Deletes the branch of a merged pull request. Succeeds when GitHub answers
 * 422, which it does when the branch is already gone, for example because the
 * repository deletes merged branches by itself. Fails with GitHub's error
 * otherwise, with a message that says the merge itself succeeded.
 */
const deleteMergedBranch = (
  headRepo: string,
  headRef: string,
  mergeSha: string,
  token: string,
): Effect.Effect<void, ActionError, HttpClient.HttpClient> =>
  callGithub(
    { method: "DELETE", path: buildBranchRefPath(headRepo, headRef), token },
    `The branch ${headRef} of ${headRepo}`,
  ).pipe(
    Effect.asVoid,
    Effect.catchIf(
      (error) => error.code === "validation",
      () => Effect.void,
    ),
    Effect.mapError(
      (error) =>
        new ActionError({
          code: error.code,
          message: `The pull request was merged as ${mergeSha}, but its branch ${headRef} was not deleted. ${error.message}`,
        }),
    ),
  );

export const prMerge = defineGithubAction({
  id: "pr.merge",
  displayName: "Merge a GitHub pull request",
  description:
    "Merges a pull request, and deletes its branch afterwards when deleteBranch is true. With sha, the merge happens only if the branch still points at that commit. The output holds the merge commit.",
  input: Schema.Struct({
    ...PULL_REQUEST_ADDRESS,
    method: Schema.optionalKey(
      Schema.Literals(["merge", "squash", "rebase"]).annotate({
        description:
          "How to merge: a merge commit, one squashed commit, or the commits rebased. Without it, GitHub uses merge.",
      }),
    ),
    commitTitle: Schema.optionalKey(
      Schema.NonEmptyString.annotate({
        description: "The title of the merge or squash commit. Without it, GitHub writes one.",
      }),
    ),
    commitMessage: Schema.optionalKey(
      Schema.String.annotate({
        description: "The message of the merge or squash commit. Without it, GitHub writes one.",
      }),
    ),
    sha: Schema.optionalKey(
      Schema.NonEmptyString.annotate({
        description:
          "The commit the pull request's branch must point at. When the branch has moved on, the merge is refused with the code conflict.",
      }),
    ),
    deleteBranch: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "true deletes the pull request's branch after the merge.",
      }),
    ),
  }),
  output: MergeResult,
  perform: (input, context) =>
    Effect.gen(function* () {
      const token = yield* readConnectionToken(context);
      const subject = describePullRequest(input);
      // The branch to delete is read before the merge, so that a branch that
      // cannot be deleted refuses the step before anything changes.
      let head: { readonly repo: string; readonly ref: string } | undefined;
      if (input.deleteBranch === true) {
        const pull = yield* fetchPullRequest(input, token);
        if (pull.head.repo === null) {
          return yield* Effect.fail(
            new ActionError({
              code: "conflict",
              message:
                "The pull request's branch is in a fork that no longer exists, so it cannot be deleted. Leave deleteBranch out to merge without deleting it.",
            }),
          );
        }
        head = { repo: pull.head.repo.full_name, ref: pull.head.ref };
      }
      const merge = yield* Effect.flatMap(
        callGithub(
          {
            method: "PUT",
            path: `${buildPullRequestPath(input)}/merge`,
            token,
            body: {
              merge_method: input.method,
              commit_title: input.commitTitle,
              commit_message: input.commitMessage,
              sha: input.sha,
            },
          },
          subject,
        ),
        decodeMerge,
      );
      if (head !== undefined) yield* deleteMergedBranch(head.repo, head.ref, merge.sha, token);
      return { ...merge, branchDeleted: head !== undefined };
    }),
});

export const prCreate = defineGithubAction({
  id: "pr.create",
  displayName: "Open a GitHub pull request",
  description:
    "Opens a pull request from a branch that is already pushed. The output is the new pull request.",
  input: Schema.Struct({
    repo: RepoName,
    head: Schema.NonEmptyString.annotate({
      description: "The branch with the changes. For a branch in a fork, write it as owner:branch.",
    }),
    base: Schema.NonEmptyString.annotate({
      description: "The branch the changes would be merged into.",
    }),
    title: Schema.NonEmptyString.annotate({ description: "The pull request's title." }),
    body: Schema.optionalKey(
      Schema.String.annotate({ description: "The pull request's body, in GitHub Markdown." }),
    ),
    draft: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "true opens the pull request as a draft." }),
    ),
  }),
  output: PullRequest,
  perform: (input, context) =>
    Effect.gen(function* () {
      const token = yield* readConnectionToken(context);
      const body = yield* callGithub(
        {
          method: "POST",
          path: `/repos/${input.repo}/pulls`,
          token,
          body: {
            title: input.title,
            head: input.head,
            base: input.base,
            body: input.body,
            draft: input.draft,
          },
        },
        `The repository ${input.repo}`,
      );
      return buildPullRequest(yield* decodePullRequest(body));
    }),
});
