import { describe, expect, it } from "vitest";
import { APPROVAL_ANSWER_LABELS, describeApprovalAnswer } from "./approval-answers";
import type { ApprovalDecision, ApprovalRequest } from "./groups/session";

const DECISIONS: ReadonlyArray<ApprovalDecision> = ["allow", "allow_always", "deny", "cancel"];
const REQUEST_KINDS: ReadonlyArray<ApprovalRequest["kind"]> = [
  "command_approval",
  "file_change_approval",
  "file_read_approval",
  "tool_approval",
];

describe("APPROVAL_ANSWER_LABELS", () => {
  it("gives every decision its own label", () => {
    const labels = DECISIONS.map((decision) => APPROVAL_ANSWER_LABELS[decision]);
    expect(labels).toEqual(["Allow", "Allow always", "Deny", "Cancel"]);
  });
});

describe("describeApprovalAnswer", () => {
  it("names the request's subject in the sentence", () => {
    expect(describeApprovalAnswer("allow", "command_approval")).toBe(
      "Runs the command this once; the agent asks again next time.",
    );
    expect(describeApprovalAnswer("cancel", "file_change_approval")).toBe(
      "Denies the change and stops the turn.",
    );
  });

  it("gives the decisions of one request kind different sentences, so the user can tell them apart", () => {
    for (const kind of REQUEST_KINDS) {
      const sentences = DECISIONS.map((decision) => describeApprovalAnswer(decision, kind));
      expect(new Set(sentences).size, kind).toBe(DECISIONS.length);
    }
  });
});
