/**
 * The words of the answers to an approval: the label of each decision, and
 * the sentence describing what answering with it does. The permission card in
 * the session view and the `core.approval` decision in the notification
 * center both use them, so an answer reads the same wherever it is given.
 */
import type { ApprovalDecision, ApprovalRequest } from "./groups/session";

/** The label of each approval answer. */
export const APPROVAL_ANSWER_LABELS: Readonly<Record<ApprovalDecision, string>> = {
  allow: "Allow",
  allow_always: "Allow always",
  deny: "Deny",
  cancel: "Cancel",
};

/**
 * The words the answer sentences use for what each request kind asks about,
 * such as "the command".
 */
const REQUEST_SUBJECTS: Readonly<Record<ApprovalRequest["kind"], string>> = {
  command_approval: "the command",
  file_change_approval: "the change",
  file_read_approval: "the read",
  tool_approval: "the tool call",
};

/**
 * Returns a sentence describing what answering an approval of `requestKind`
 * with `decision` does, such as "Runs the command this once; the agent asks
 * again next time."
 */
export const describeApprovalAnswer = (
  decision: ApprovalDecision,
  requestKind: ApprovalRequest["kind"],
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
