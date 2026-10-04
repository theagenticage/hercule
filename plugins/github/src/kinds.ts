/**
 * The events this plugin can emit, and what each one carries.
 *
 * Every payload starts with the same `subject` block, so a reader gets the
 * External Ref and the "open in GitHub" URL of any event the same way,
 * whatever its kind. A kind has a field of its own only when it needs one:
 * which labels changed, who reviewed, what the checks concluded.
 *
 * Nothing here polls. Declaring the kinds lets a subscription and a workflow
 * filter refer to them, and gives the schemas emitted payloads are validated
 * against. The feeds in `ingest/` emit them.
 */
import { Schema } from "effect";
import type { EventKindDeclaration } from "@hercule/plugin-host";
import { ReviewVerdict } from "./github-objects";

/**
 * The thing an event is about: a repository, and the issue or pull request
 * inside it, if there is one. Only the repository and the web URL are always
 * known; the other fields are what GitHub reported at the time.
 */
const Subject = Schema.Struct({
  repo: Schema.String,
  number: Schema.optionalKey(Schema.Int),
  title: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  url: Schema.String,
}).annotate({
  // Named, so the catalog stores the block once, under its name, and each of
  // the fifteen kinds refers to it instead of repeating it.
  identifier: "GithubSubject",
});

export type GithubSubject = Schema.Schema.Type<typeof Subject>;

/** Declares a kind whose payload is only the subject: what happened, and to what. */
const declareSubjectKind = (description: string): EventKindDeclaration => ({
  description,
  schema: Schema.Struct({ subject: Subject }),
});

/** Declares a label kind: which labels were added and which were removed, in one event. */
const declareLabelKind = (description: string): EventKindDeclaration => ({
  description,
  schema: Schema.Struct({
    subject: Subject,
    added: Schema.Array(Schema.String),
    removed: Schema.Array(Schema.String),
  }),
});

export const GITHUB_EVENT_KINDS: Record<string, EventKindDeclaration> = {
  "github.notification": {
    description:
      "One entry of the user's GitHub notifications, whatever put it there; the reason says which.",
    schema: Schema.Struct({
      subject: Subject,
      /** GitHub's own word: mention, assign, review_requested, state_change and more. */
      reason: Schema.String,
    }),
  },

  "github.issue.opened": declareSubjectKind("An issue was opened."),
  "github.issue.closed": declareSubjectKind("An issue was closed."),
  "github.issue.reopened": declareSubjectKind("An issue was reopened."),
  "github.issue.labeled": declareLabelKind("The labels on an issue changed."),
  "github.issue.assigned": declareSubjectKind("An issue was assigned."),
  "github.issue.commented": declareSubjectKind("A comment was added to an issue."),

  "github.pr.opened": declareSubjectKind("A pull request was opened."),
  "github.pr.synchronized": declareSubjectKind("A pull request got a new head commit."),
  "github.pr.review-submitted": {
    description: "A review was submitted on a pull request.",
    schema: Schema.Struct({
      subject: Subject,
      reviewer: Schema.String,
      verdict: ReviewVerdict,
    }),
  },
  "github.pr.commented": declareSubjectKind("A comment was added to a pull request."),
  "github.pr.merged": declareSubjectKind("A pull request was merged."),
  "github.pr.closed": declareSubjectKind("A pull request was closed without being merged."),
  "github.pr.labeled": declareLabelKind("The labels on a pull request changed."),
  "github.pr.checks-completed": {
    description:
      "Every check suite on a pull request's head commit finished; one rolled-up verdict.",
    schema: Schema.Struct({
      subject: Subject,
      /** The roll-up of every suite: success, failure, neutral and the rest. */
      conclusion: Schema.String,
      suites: Schema.Array(Schema.Struct({ name: Schema.String, conclusion: Schema.String })),
    }),
  },
};
