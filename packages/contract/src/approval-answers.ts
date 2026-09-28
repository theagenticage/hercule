/**
 * The words of the answers to an approval: the label of each decision, and
 * the sentence that says what answering with it does. The permission card in
 * the session view and the core's approval decision in the notification
 * center both use them, so an answer reads the same wherever it is given.
 */
import type { ApprovalDecision, OpenRequest } from "./groups/session";

/** The label of each approval answer. */
export const APPROVAL_ANSWER_LABELS: Readonly<Record<ApprovalDecision, string>> = {
  allow: "Allow",
  allow_always: "Allow always",
  deny: "Deny",
  cancel: "Cancel",
};

/**
 * The subject of each request kind, as the answer sentences refer to it.
 * Without a subject, the sentences for a request kind would say nothing
 * useful, so every kind has one.
 */
const REQUEST_SUBJECTS: Readonly<Record<OpenRequest["kind"], string>> = {
  command_approval: "the command",
  file_change_approval: "the change",
  file_read_approval: "the read",
  tool_approval: "the tool call",
  question: "the question",
};

/**
 * Returns the sentence that says what answering a request of `requestKind`
 * with `decision` does, such as "Runs the command this once; the agent asks
 * again next time."
 */
export const describeApprovalAnswer = (
  decision: ApprovalDecision,
  requestKind: OpenRequest["kind"],
): string => {
  const subject = REQUEST_SUBJECTS[requestKind];
  switch (decision) {
    case "allow":
      return `Runs ${subject} this once; the agent asks again next time.`;
    case "allow_always":
      // Not "for the rest of this thread": a resume starts a new harness
      // process, and the harness keeps the rule only in the process that asked.
      return `Runs ${subject} and stops asking for it while this thread keeps running.`;
    case "deny":
      return `Denies ${subject}; the agent is told and continues.`;
    case "cancel":
      return `Denies ${subject} and stops the turn.`;
  }
};
