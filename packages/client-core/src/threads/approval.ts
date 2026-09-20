/**
 * The whole text of the permission card: what the harness is asking, and what
 * each answer the request offers will do. It lives here rather than in a
 * component because the describe line is the one thing a surface may not drop
 * or reword - the user reads what the click does, in the same words on every
 * surface (spec 10 §7.4, spec 14 §Answers as a ledger).
 */
import type { ApprovalDecision, OpenRequest } from "@hercule/contract";

/** One answer row: the row is the button, the label its left column. */
export interface ApprovalRow {
  readonly decision: ApprovalDecision;
  readonly label: string;
  readonly describe: string;
}

/**
 * One option of a question, kept as its two parts rather than one line: the
 * card lays the label and what it would have meant out in the same two columns
 * as the answer ledger under it (spec 14 §Measurements).
 */
export interface ApprovalOption {
  /** The short label the harness put on the option. */
  readonly label: string;
  /** What choosing it would mean; empty where the harness said nothing. */
  readonly description: string;
}

/**
 * One question of a `question` request, as the card reads it. A question is
 * not an approval: it has a chip, prose and answers of its own, and they share
 * the request slot rather than the shape (decisions D-27, D-28). The options
 * are shown read-only - what each answer would have meant is part of the
 * question - until answering with one is built.
 */
export interface ApprovalQuestion {
  /** The short chip the harness labelled the question with. */
  readonly header: string;
  /** The question, in the agent's own words. */
  readonly question: string;
  /** The options it offers, each its label and what choosing it would mean. */
  readonly options: readonly ApprovalOption[];
  /** Said where the question takes more than one answer; null where it takes one. */
  readonly note: string | null;
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
  /** The questions of a `question` request; empty on every approval kind. */
  readonly questions: readonly ApprovalQuestion[];
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
  question: "the question",
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
 * Conflict between what the harness asks and what Hercule can send back:
 * `session.respond` carries a decision and no answers, so there is nothing an
 * allow could run the tool with. The card says so rather than leaving the
 * missing Allow to be read as a bug.
 *
 * Cancel first, then reply: a message sent while the session is parked is
 * queued behind the turn, so it would not reach the harness that is asking.
 */
const NOT_BUILT = "Answering here is not built yet. Cancel the turn, then reply in the thread.";

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
    case "question":
      return "The agent needs answers.";
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
    case "question":
      // The questions carry their own structure, so there is nothing here for
      // a flat list of lines to repeat.
      return [];
  }
};

const MULTI = "More than one answer may be chosen.";

const questionsOf = (request: OpenRequest): readonly ApprovalQuestion[] =>
  request.kind === "question"
    ? request.detail.questions.map((question) => ({
        header: question.header,
        question: question.question,
        options: question.options,
        note: question.multiSelect ? MULTI : null,
      }))
    : [];

export const approvalCard = (request: OpenRequest): ApprovalCard => ({
  title: titleOf(request),
  subject: subjectOf(request),
  code: request.kind !== "question",
  questions: questionsOf(request),
  note: request.kind === "question" ? NOT_BUILT : null,
  rows: request.decisions.map((decision) => ({
    decision,
    label: LABELS[decision],
    describe: describeOf(decision, SUBJECTS[request.kind]),
  })),
});
