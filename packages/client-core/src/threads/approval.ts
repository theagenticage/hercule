/**
 * Builds all the text of the permission card: what the harness is asking, and
 * what each answer the request offers will do. It lives here rather than in a
 * component because no screen may drop or reword the line that describes an
 * answer: the user must see what a click does, in the same words on every
 * screen (spec 10 §7.4, spec 14 §Answers as a ledger).
 */
import type { ApprovalDecision, OpenRequest } from "@hercule/contract";

/** One answer row. The whole row is the button; the label is its left column. */
export interface ApprovalRow {
  readonly decision: ApprovalDecision;
  readonly label: string;
  readonly describe: string;
}

/**
 * One option of a question, kept as two parts rather than one line: the card
 * shows the label and its meaning in the same two columns as the answer rows
 * below it (spec 14 §Measurements).
 */
export interface ApprovalOption {
  /** The short label the harness put on the option. */
  readonly label: string;
  /** What choosing the option would mean, or empty when the harness gave no description. */
  readonly description: string;
}

/**
 * One question of a `question` request, as the card shows it. A question is
 * not an approval: it has its own chip, text and answers. The two only share
 * the card's place on screen, not its layout. The options are shown read-only,
 * because they help explain the question, until answering with an option is
 * built.
 */
export interface ApprovalQuestion {
  /** The short chip label the harness gave the question. */
  readonly header: string;
  /** The question, in the agent's own words. */
  readonly question: string;
  /** The question's options, each with its label and what choosing it would mean. */
  readonly options: readonly ApprovalOption[];
  /** A note shown when the question accepts more than one answer, else `null`. */
  readonly note: string | null;
}

export interface ApprovalCard {
  /** The card's title: a question that names what is being asked about. */
  readonly title: string;
  /** What the request is about, verbatim: the command, the paths, the questions. */
  readonly subject: readonly string[];
  /**
   * Whether the subject is machine text (a command, a path) rather than prose.
   * Mono is for ids, paths and commands; a question the agent wrote is a
   * sentence and is shown as one (design language §Typography).
   */
  readonly code: boolean;
  /** Why an answer the user expects is missing, or `null` when none is. */
  readonly note: string | null;
  /** The questions of a `question` request; empty for every approval kind. */
  readonly questions: readonly ApprovalQuestion[];
  /** One row per decision the request offers, in the request's order. */
  readonly rows: readonly ApprovalRow[];
}

const LABELS: Readonly<Record<ApprovalDecision, string>> = {
  allow: "Allow",
  allow_always: "Allow always",
  deny: "Deny",
  cancel: "Cancel",
};

/**
 * The subject of each request kind, as the answer descriptions refer to it.
 * Without a subject, the descriptions of a request kind would say nothing
 * useful, so every kind has one.
 */
const SUBJECTS: Readonly<Record<OpenRequest["kind"], string>> = {
  command_approval: "the command",
  file_change_approval: "the change",
  file_read_approval: "the read",
  tool_approval: "the tool call",
  question: "the question",
};

const describeDecision = (decision: ApprovalDecision, subject: string): string => {
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

/**
 * The harness asks for answers, but `session.respond` can only send a
 * decision, not answers, so Allow would have nothing to run the tool with.
 * The card says so, so that the missing Allow does not look like a bug.
 *
 * The user must cancel first and then reply: a message sent while the session
 * waits for the answer is queued behind the turn, so it would not reach the
 * harness that is asking.
 */
const NOT_BUILT = "Answering here is not built yet. Cancel the turn, then reply in the thread.";

const buildCardTitle = (request: OpenRequest): string => {
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

const buildCardSubject = (request: OpenRequest): readonly string[] => {
  switch (request.kind) {
    case "command_approval":
      return [request.detail.command];
    case "file_change_approval":
    case "file_read_approval":
      return request.detail.paths;
    case "tool_approval":
      return [];
    case "question":
      // The questions are shown with their own structure, so a flat list of
      // lines would only repeat them.
      return [];
  }
};

const MULTI = "More than one answer may be chosen.";

const buildCardQuestions = (request: OpenRequest): readonly ApprovalQuestion[] =>
  request.kind === "question"
    ? request.detail.questions.map((question) => ({
        header: question.header,
        question: question.question,
        options: question.options,
        note: question.multiSelect ? MULTI : null,
      }))
    : [];

/** Returns the permission card for an open request. */
export const buildApprovalCard = (request: OpenRequest): ApprovalCard => ({
  title: buildCardTitle(request),
  subject: buildCardSubject(request),
  code: request.kind !== "question",
  questions: buildCardQuestions(request),
  note: request.kind === "question" ? NOT_BUILT : null,
  rows: request.decisions.map((decision) => ({
    decision,
    label: LABELS[decision],
    describe: describeDecision(decision, SUBJECTS[request.kind]),
  })),
});
