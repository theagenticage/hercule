/**
 * Builds all the text of the permission card: what the harness is asking, and
 * what each answer the request offers will do. It lives here rather than in a
 * component because no screen may drop or reword the line that describes an
 * answer: the user must see what a click does, in the same words on every
 * screen (spec 10 §7.4, spec 14 §Answers as a ledger).
 */
import {
  APPROVAL_ANSWER_LABELS,
  describeApprovalAnswer,
  type ApprovalDecision,
  type DescribeLine,
  type OpenRequest,
} from "@hercule/contract";

/**
 * One answer row, in the shape the answer ledger takes. The whole row is the
 * button; the label is its left column.
 */
export interface ApprovalRow {
  /** The decision the row sends, which also tells the rows apart. */
  readonly id: ApprovalDecision;
  readonly label: string;
  /**
   * Always `false`: no answer to an approval carries more weight than the
   * others, here or in the notification center.
   */
  readonly primary: false;
  /**
   * What the answer does, as one text part. The card already shows what the
   * request is about above its answers, so the line does not repeat it.
   */
  readonly describeLine: DescribeLine;
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
 * the card's place on screen, not its layout. The user answers it by picking
 * options or typing their own answer, kept in the draft `buildQuestionDraft`
 * starts.
 */
export interface ApprovalQuestion {
  /** The short chip label the harness gave the question. */
  readonly header: string;
  /** The question, in the agent's own words. */
  readonly question: string;
  /** The question's options, each with its label and what choosing it would mean. */
  readonly options: readonly ApprovalOption[];
  /** Whether the user may pick more than one option. */
  readonly multiSelect: boolean;
  /** A note shown when the question accepts more than one answer, else `null`. */
  readonly note: string | null;
  /**
   * A warning shown when the harness asked to keep the answer secret, else
   * `null`. Nothing keeps it secret, so the user is told before they type it.
   */
  readonly secretWarning: string | null;
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
  /** The questions of a `question` request; empty for every approval kind. */
  readonly questions: readonly ApprovalQuestion[];
  /**
   * One row per decision the approval offers, in the approval's order. Empty
   * for a question, which takes answers only: to turn it down, the user stops
   * the turn.
   */
  readonly rows: readonly ApprovalRow[];
}

/**
 * Builds the title of a card about files, from the verb and the paths the
 * request names. A request may name no path, such as a listing of the
 * workspace, and then the title names no file either.
 */
const buildFilesTitle = (verb: string, paths: readonly string[]): string => {
  if (paths.length === 0) return `${verb} files?`;
  return paths.length === 1 ? `${verb} this file?` : `${verb} these files?`;
};

const buildCardTitle = (request: OpenRequest): string => {
  switch (request.kind) {
    case "command_approval":
      return "Run this command?";
    case "file_change_approval":
      return buildFilesTitle("Change", request.detail.paths);
    case "file_read_approval":
      return buildFilesTitle("Read", request.detail.paths);
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

const SECRET =
  "The agent asked to keep this answer secret. It is stored in the thread like any other answer.";

const buildCardQuestions = (request: OpenRequest): readonly ApprovalQuestion[] =>
  request.kind === "question"
    ? request.detail.questions.map((question) => ({
        header: question.header,
        question: question.question,
        options: question.options,
        multiSelect: question.multiSelect,
        note: question.multiSelect ? MULTI : null,
        secretWarning: question.secret === true ? SECRET : null,
      }))
    : [];

/** Returns the permission card for an open request. */
export const buildApprovalCard = (request: OpenRequest): ApprovalCard => ({
  title: buildCardTitle(request),
  subject: buildCardSubject(request),
  code: request.kind !== "question",
  questions: buildCardQuestions(request),
  rows:
    request.kind === "question"
      ? []
      : request.decisions.map((decision) => ({
          id: decision,
          label: APPROVAL_ANSWER_LABELS[decision],
          primary: false,
          describeLine: [{ kind: "text", text: describeApprovalAnswer(decision, request.kind) }],
        })),
});
