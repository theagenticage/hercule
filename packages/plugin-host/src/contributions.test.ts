import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import type { WorkflowActionContribution } from "./contributions";

const FIELDS = {
  id: "issue.comment",
  displayName: "Comment on an issue",
  description: "Adds a comment to an issue.",
  input: Schema.Struct({ body: Schema.String }),
  output: Schema.Struct({}),
  execute: () => Effect.succeed({}),
};

describe("WorkflowActionContribution", () => {
  it("lets a step-only action leave out usableIn and describe", () => {
    const action: WorkflowActionContribution = FIELDS;
    expect(action.usableIn).toBeUndefined();
  });

  it("lets an action that lists an answer place declare describe and outcome", () => {
    const action: WorkflowActionContribution = {
      ...FIELDS,
      usableIn: ["workflow.step", "signal.answer"],
      describe: () => [{ kind: "text", text: "Comments on the issue" }],
      outcome: () => "Commented",
    };
    expect(action.usableIn).toEqual(["workflow.step", "signal.answer"]);
  });

  it("refuses, at compile time, an action that lists an answer place without describe", () => {
    // @ts-expect-error An action bound as an answer must write its own describe line.
    const action: WorkflowActionContribution = { ...FIELDS, usableIn: ["signal.answer"] };
    expect(action.id).toBe("issue.comment");
  });
});
