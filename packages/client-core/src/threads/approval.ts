/**
 * The whole text of the permission card: what the harness is asking, and what
 * each answer the request offers will do. It lives here rather than in a
 * component because the describe line is the one thing a surface may not drop
 * or reword - the user reads what the click does, in the same words on every
 * surface (spec 10 §7.4, spec 14 §Answers as a ledger).
 */
import type { ApprovalDecision, OpenRequest } from "@hydra/contract";

/** One answer row: the row is the button, the label its left column. */
export interface ApprovalRow {
  readonly decision: ApprovalDecision;
  readonly label: string;
  readonly describe: string;
}

export interface ApprovalCard {
  /** The question, naming what is being asked about. */
  readonly title: string;
  /** What the request is about, verbatim: the command, the paths, the questions. */
  readonly subject: readonly string[];
  /**
   * Whether the subject is machine text - a command, a path - rather than
   * prose. Mono is for ids, paths and commands; a question the agent wrote is
   * a sentence and reads as one (design language §Typography).
   */
  readonly code: boolean;
  /** Why an answer the user expects is missing; null where none is. */
  readonly note: string | null;
  /** One row per decision the request offers, in the order it offered them. */
  readonly rows: readonly ApprovalRow[];
}

const LABELS: Readonly<Record<ApprovalDecision, string>> = {
  allow: "Allow",
  allow_always: "Allow always",
  deny: "Deny",
  cancel: "Cancel",
};

/**
 * What the answers are about, in the words the describe lines read it as. A
 * request kind the surfaces cannot name would leave four describe lines saying
 * nothing, so every kind names its own subject.
 */
const SUBJECTS: Readonly<Record<OpenRequest["kind"], string>> = {
  command_approval: "the command",
  file_change_approval: "the change",
  file_read_approval: "the read",
  tool_approval: "the tool call",
  user_input: "the question",
};

const describeOf = (decision: ApprovalDecision, subject: string): string => {
  switch (decision) {
    case "allow":
      return `Runs ${subject} this once; the agent asks again next time.`;
    case "allow_always":
      // Not "for the rest of this thread": a resume starts a fresh harness
      // process, and the rule lives in the process that was asked.
      return `Runs ${subject} and stops asking for it while this thread keeps running.`;
    case "deny":
      return `Refuses ${subject}; the agent is told and carries on.`;
    case "cancel":
      return `Refuses ${subject} and stops the turn.`;
  }
};

/**
 * Conflict between what the harness asks and what Hydra can send back:
 * `session.respond` carries a decision and no answers, so there is nothing an
 * allow could run the tool with. The card says so rather than leaving the
 * missing Allow to be read as a bug.
 */
const NOT_BUILT =
  "Answering a question here is not built yet. Reply in the thread instead, then deny this request.";

const titleOf = (request: OpenRequest): string => {
  switch (request.kind) {
    case "command_approval":
      return "Run this command?";
    case "file_change_approval":
      return request.detail.paths.length === 1 ? "Change this file?" : "Change these files?";
    case "file_read_approval":
      return request.detail.paths.length === 1 ? "Read this file?" : "Read these files?";
    case "tool_approval":
      return `Run ${request.detail.toolName}?`;
    case "user_input":
      return "The agent is asking a question.";
  }
};

const subjectOf = (request: OpenRequest): readonly string[] => {
  switch (request.kind) {
    case "command_approval":
      return [request.detail.command];
    case "file_change_approval":
    case "file_read_approval":
      return request.detail.paths;
    case "tool_approval":
      return [];
    case "user_input":
      return request.detail.questions;
  }
};

export const approvalCard = (request: OpenRequest): ApprovalCard => ({
  title: titleOf(request),
  subject: subjectOf(request),
  code: request.kind !== "user_input",
  note: request.kind === "user_input" ? NOT_BUILT : null,
  rows: request.decisions.map((decision) => ({
    decision,
    label: LABELS[decision],
    describe: describeOf(decision, SUBJECTS[request.kind]),
  })),
});
