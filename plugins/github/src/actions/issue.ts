/**
 * The workflow actions on a GitHub issue: read it, comment on it, and change
 * it. GitHub treats a pull request as an issue too, so these also work with a
 * pull request's number.
 */
import { Effect, Schema } from "effect";
import { callGithub, defineGithubAction, readConnectionToken } from "./call";
import {
  Comment,
  decodeComment,
  decodeIssue,
  Issue,
  ItemNumber,
  refuseEmptyUpdate,
} from "./objects";
import { RepoName } from "../repo-name";

/** The fields that name one issue. */
const ISSUE_ADDRESS = {
  repo: RepoName,
  number: ItemNumber.annotate({ description: "The issue's number in the repository." }),
};

/** Returns the REST path of one issue. */
const buildIssuePath = (input: { readonly repo: string; readonly number: number }): string =>
  `/repos/${input.repo}/issues/${String(input.number)}`;

/** Names one issue for the message of an error. */
const describeIssue = (input: { readonly repo: string; readonly number: number }): string =>
  `The issue ${input.repo}#${String(input.number)}`;

export const issueRead = defineGithubAction({
  id: "issue.read",
  displayName: "Read a GitHub issue",
  description:
    "Reads one issue of a repository: its title, body, state, labels, assignees, author and URL.",
  input: Schema.Struct(ISSUE_ADDRESS),
  output: Issue,
  perform: (input, context) =>
    Effect.gen(function* () {
      const token = yield* readConnectionToken(context);
      const body = yield* callGithub(
        { method: "GET", path: buildIssuePath(input), token },
        describeIssue(input),
      );
      return yield* decodeIssue(body);
    }),
});

export const issueComment = defineGithubAction({
  id: "issue.comment",
  displayName: "Comment on a GitHub issue",
  description:
    "Adds a comment to an issue, as the Connection's account. The output holds the comment's id and URL.",
  input: Schema.Struct({
    ...ISSUE_ADDRESS,
    body: Schema.NonEmptyString.annotate({ description: "The comment, in GitHub Markdown." }),
  }),
  output: Comment,
  perform: (input, context) =>
    Effect.gen(function* () {
      const token = yield* readConnectionToken(context);
      const body = yield* callGithub(
        {
          method: "POST",
          path: `${buildIssuePath(input)}/comments`,
          token,
          body: { body: input.body },
        },
        describeIssue(input),
      );
      return yield* decodeComment(body);
    }),
});

/** The fields of an issue that `issue.update` can change. */
const ISSUE_CHANGES = {
  title: Schema.optionalKey(Schema.NonEmptyString.annotate({ description: "The new title." })),
  body: Schema.optionalKey(
    Schema.String.annotate({ description: "The new body, in GitHub Markdown." }),
  ),
  state: Schema.optionalKey(
    Schema.Literals(["open", "closed"]).annotate({ description: "Opens or closes the issue." }),
  ),
  stateReason: Schema.optionalKey(
    Schema.Literals(["completed", "not_planned", "reopened"]).annotate({
      description: "Why the state changed, as GitHub records it.",
    }),
  ),
  labels: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "The names of the labels the issue has afterwards. Labels not in the list are removed, and an empty list removes them all.",
    }),
  ),
  assignees: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "The logins of the accounts assigned afterwards. Accounts not in the list are unassigned, and an empty list unassigns everyone.",
    }),
  ),
};

export const issueUpdate = defineGithubAction({
  id: "issue.update",
  displayName: "Update a GitHub issue",
  description:
    "Changes an issue's title, body, state, labels or assignees. Fields left out of the params are not changed. The output is the issue as it is afterwards.",
  input: Schema.Struct({ ...ISSUE_ADDRESS, ...ISSUE_CHANGES }).check(
    refuseEmptyUpdate(
      ISSUE_CHANGES,
      "An issue update must include at least one field to change, such as state or labels.",
    ),
  ),
  output: Issue,
  perform: (input, context) =>
    Effect.gen(function* () {
      const token = yield* readConnectionToken(context);
      const body = yield* callGithub(
        {
          method: "PATCH",
          path: buildIssuePath(input),
          token,
          body: {
            title: input.title,
            body: input.body,
            state: input.state,
            state_reason: input.stateReason,
            labels: input.labels,
            assignees: input.assignees,
          },
        },
        describeIssue(input),
      );
      return yield* decodeIssue(body);
    }),
});
