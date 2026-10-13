/**
 * The workflow actions on a Sentry issue: resolve it, archive it, and assign
 * it. A step binds them as `sentry/issue.resolve` and so on, and a Signal's
 * answer runs them with the input the signal's `build` stored.
 */
import { Effect, Schema } from "effect";
import {
  defineSentryAction,
  IssueAddress,
  IssueUpdated,
  readConnectionToken,
  updateIssue,
} from "./call";
import { describeIssue, nameIssueBriefly, readAssigneeName, readInputText } from "./describe";

export const issueResolve = defineSentryAction({
  id: "issue.resolve",
  displayName: "Resolve a Sentry issue",
  description:
    "Marks an issue resolved in Sentry, as the Connection's account. Sentry reopens it as a regression when it has a new event. The output holds the issue's id and status.",
  usableIn: ["workflow.step", "signal.answer"],
  describe: (input) => [{ kind: "text", text: "Resolves " }, ...describeIssue(input)],
  outcome: (input) => `Resolved ${nameIssueBriefly(input)}`,
  input: IssueAddress,
  output: IssueUpdated,
  perform: (input, context) =>
    Effect.gen(function* () {
      const token = yield* readConnectionToken(context);
      return yield* updateIssue(input, { status: "resolved" }, token);
    }),
});

export const issueArchive = defineSentryAction({
  id: "issue.archive",
  displayName: "Archive a Sentry issue",
  description:
    "Archives an issue in Sentry, as the Connection's account: until it escalates (the default), or for good. The output holds the issue's id and status.",
  usableIn: ["workflow.step", "signal.answer"],
  describe: (input) => [
    { kind: "text", text: "Archives " },
    ...describeIssue(input),
    // An absent `until` archives until the issue escalates, as `perform` does.
    {
      kind: "text",
      text: readInputText(input, "until") === "forever" ? " for good" : " until it escalates",
    },
  ],
  outcome: (input) => `Archived ${nameIssueBriefly(input)}`,
  input: Schema.Struct({
    ...IssueAddress.fields,
    until: Schema.optionalKey(
      Schema.Literals(["escalating", "forever"]).annotate({
        description: "When the issue comes back: when it escalates (the default), or never.",
      }),
    ),
  }),
  output: IssueUpdated,
  perform: (input, context) =>
    Effect.gen(function* () {
      const token = yield* readConnectionToken(context);
      return yield* updateIssue(
        input,
        {
          status: "ignored",
          substatus: input.until === "forever" ? "archived_forever" : "archived_until_escalating",
        },
        token,
      );
    }),
});

export const issueAssign = defineSentryAction({
  id: "issue.assign",
  displayName: "Assign a Sentry issue",
  description:
    "Assigns an issue in Sentry to a user or a team. The output holds the issue's id and status.",
  usableIn: ["workflow.step", "signal.answer"],
  describe: (input) => {
    const name = readAssigneeName(input);
    return [
      { kind: "text", text: "Assigns " },
      ...describeIssue(input),
      ...(name === undefined
        ? []
        : [
            { kind: "text" as const, text: " to " },
            { kind: "marked" as const, text: name },
          ]),
    ];
  },
  outcome: (input) => {
    const name = readAssigneeName(input);
    return name === undefined
      ? `Assigned ${nameIssueBriefly(input)}`
      : `Assigned ${nameIssueBriefly(input)} to ${name}`;
  },
  input: Schema.Struct({
    ...IssueAddress.fields,
    assignee: Schema.Struct({
      type: Schema.Literals(["user", "team"]).annotate({
        description: "Whether it is a user or a team.",
      }),
      id: Schema.NonEmptyString.annotate({ description: "The user's or the team's id." }),
      name: Schema.String.annotate({ description: "The name shown for the assignee." }),
    }),
  }),
  output: IssueUpdated,
  perform: (input, context) =>
    Effect.gen(function* () {
      const token = yield* readConnectionToken(context);
      const assignedTo = `${input.assignee.type}:${input.assignee.id}`;
      return yield* updateIssue(input, { assignedTo }, token);
    }),
});
