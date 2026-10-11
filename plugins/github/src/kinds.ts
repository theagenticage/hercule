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
  // the kinds refers to it instead of repeating it.
  identifier: "GithubSubject",
});

export type GithubSubject = Schema.Schema.Type<typeof Subject>;

/**
 * Whether an account the event names is the user's, worked out at ingest from
 * the Connection's identity, so a rule can read it without knowing the
 * user's login.
 */
const ByYou = Schema.Boolean;

/**
 * Whether the user's own pull request is the one an event is about, worked
 * out at ingest from the Connection's identity. The description is in the
 * catalog, so a rule or a triage agent knows what the field means.
 */
const OnYourPullRequest = Schema.Boolean.annotate({
  description: "True when the user wrote the pull request the event is about.",
});

/**
 * Declares an assignment kind: the login of who was assigned or unassigned,
 * `toYou` when that is the user, and `byYou` when the user made the change.
 * Who made the change is the event's `author`. Issues and pull requests both
 * emit it.
 */
const declareAssignmentKind = (
  description: string,
  availableToTriage: boolean,
): EventKindDeclaration => ({
  description,
  schema: Schema.Struct({
    subject: Subject,
    /** The login of the account assigned or unassigned. */
    assignee: Schema.String,
    /** True when the assignee is the user. */
    toYou: Schema.Boolean,
    /** True when the user made the change. */
    byYou: ByYou,
  }),
  availableToTriage,
});

/** Declares a kind whose payload is only the subject: what happened, and to what. */
const declareSubjectKind = (
  description: string,
  availableToTriage: boolean,
): EventKindDeclaration => ({
  description,
  schema: Schema.Struct({ subject: Subject }),
  availableToTriage,
});

/** Declares a label kind: which labels were added and which were removed, in one event. */
const declareLabelKind = (
  description: string,
  availableToTriage: boolean,
): EventKindDeclaration => ({
  description,
  schema: Schema.Struct({
    subject: Subject,
    added: Schema.Array(Schema.String),
    removed: Schema.Array(Schema.String),
  }),
  availableToTriage,
});

/** Declares a comment kind: who wrote the comment is in the event's `author`, and whether it was the user here. */
const declareCommentKind = (description: string): EventKindDeclaration => ({
  description,
  schema: Schema.Struct({ subject: Subject, byYou: ByYou }),
  availableToTriage: true,
});

/**
 * Every kind this plugin emits. `availableToTriage` is false for the kinds
 * that only end a signal or would flood triage: a removed review request, a
 * new head commit, a pull request's labels, and finished checks.
 */
export const GITHUB_EVENT_KINDS: Record<string, EventKindDeclaration> = {
  "github.notification": {
    description:
      "One entry of the user's GitHub notifications, whatever put it there; the reason says which.",
    schema: Schema.Struct({
      subject: Subject,
      /** GitHub's own word: mention, assign, review_requested, state_change and more. */
      reason: Schema.String,
    }),
    availableToTriage: true,
  },

  "github.issue.opened": declareSubjectKind("An issue was opened.", true),
  "github.issue.closed": declareSubjectKind("An issue was closed.", true),
  "github.issue.reopened": declareSubjectKind("An issue was reopened.", true),
  "github.issue.labeled": declareLabelKind("The labels on an issue changed.", true),
  "github.issue.assigned": declareAssignmentKind(
    "Someone was assigned to an issue or a pull request.",
    true,
  ),
  "github.issue.unassigned": declareAssignmentKind(
    "Someone was unassigned from an issue or a pull request.",
    false,
  ),
  "github.issue.commented": declareCommentKind("A comment was added to an issue."),

  "github.pr.opened": declareSubjectKind("A pull request was opened.", true),
  "github.pr.synchronized": declareSubjectKind("A pull request got a new head commit.", false),
  "github.pr.review-requested": {
    description:
      "A review was requested on a pull request from the user or one of their teams, or by the user from anyone.",
    schema: Schema.Struct({
      subject: Subject,
      /**
       * Who the review was requested from: the user, one of the user's
       * teams, or, only when the user asked, anyone else.
       */
      reviewer: Schema.Literals(["you", "team", "other"]),
      /** The team, as `org/slug`, when `reviewer` is `team`. */
      team: Schema.optionalKey(Schema.String),
      /** The login of who asked for the review, or null when GitHub did not say. */
      requestedBy: Schema.NullOr(Schema.String),
      /** True when the user asked for the review. */
      byYou: ByYou,
      /** True when the request names the user, rather than one of their teams. */
      toYou: Schema.Boolean,
    }),
    availableToTriage: true,
  },
  "github.pr.review-request-removed": {
    description:
      "A review request to the user or one of their teams was taken back on a pull request.",
    schema: Schema.Struct({
      subject: Subject,
      /** Who the review request was taken back from: the user, or one of the user's teams. */
      reviewer: Schema.Literals(["you", "team"]),
      /** The team, as `org/slug`, when `reviewer` is `team`. */
      team: Schema.optionalKey(Schema.String),
      /**
       * When `reviewer` is `team`: true when the pull request still asks
       * another of the user's teams for a review, as GitHub listed its
       * requests when the removal was read.
       */
      teamStillRequested: Schema.optionalKey(Schema.Boolean),
      /** True when the user took the request back. */
      byYou: ByYou,
    }),
    availableToTriage: false,
  },
  "github.pr.review-submitted": {
    description: "A review was submitted on a pull request.",
    schema: Schema.Struct({
      subject: Subject,
      reviewer: Schema.String,
      verdict: ReviewVerdict,
      /** GitHub's id of the review, to read it and its comments. */
      reviewId: Schema.Int,
      /** True when the user submitted the review. */
      byYou: ByYou,
      onYourPullRequest: OnYourPullRequest,
    }),
    availableToTriage: true,
  },
  "github.pr.commented": declareCommentKind("A comment was added to a pull request."),
  "github.pr.merged": declareSubjectKind("A pull request was merged.", true),
  "github.pr.closed": declareSubjectKind("A pull request was closed without being merged.", true),
  "github.pr.labeled": declareLabelKind("The labels on a pull request changed.", false),
  "github.pr.checks-completed": {
    description:
      "Every check suite on a pull request's head commit finished; one rolled-up verdict.",
    schema: Schema.Struct({
      subject: Subject,
      /** The roll-up of every suite: success, failure, neutral and the rest. */
      conclusion: Schema.String,
      suites: Schema.Array(Schema.Struct({ name: Schema.String, conclusion: Schema.String })),
      /** The head commit the checks ran on. */
      headSha: Schema.String,
      /**
       * The names of the check runs that failed, sorted. Empty unless
       * `conclusion` is `failure`.
       */
      failedChecks: Schema.Array(Schema.String),
      onYourPullRequest: OnYourPullRequest,
    }),
    availableToTriage: false,
  },

  "github.mentioned": {
    description: "A comment on an issue or a pull request mentions the user by login.",
    schema: Schema.Struct({
      subject: Subject,
      commentId: Schema.Int,
      commentUrl: Schema.String,
      /** The comment's text around the mention, at most about 280 characters. */
      excerpt: Schema.String,
      /** True when the user wrote the comment, mentioning themselves. */
      byYou: ByYou,
    }),
    availableToTriage: true,
  },
};
