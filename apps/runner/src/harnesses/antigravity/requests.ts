/**
 * Converts what Antigravity's `agy` asks the user (an approval or a form of
 * questions) into the decisions and questions Hercule shows, and converts the
 * user's decision or answers back into the ACP reply `agy` expects. Spec 06
 * section 6.5 ("Antigravity's Requests") owns the rules.
 */
import type { NonEmptyReadonlyArray } from "effect/Array";
import type {
  ApprovalOption,
  ApprovalOutcome,
  ElicitationField,
  ElicitationReply,
  ElicitationRequest,
} from "@hercule/acp";
import {
  MAX_FACT_LENGTH,
  type ApprovalDecision,
  type Question,
  type QuestionAnswers,
} from "@hercule/protocol";
import { truncateFact, truncateMessage, truncateWithMarker } from "../text";

const ALLOW_ONCE = "allow_once";
const REJECT_ONCE = "reject_once";

/**
 * Returns the decisions a request with these options offers, in the order
 * allow, deny, cancel. `allow` is there only when an option of kind
 * `allow_once` exists. `deny` and `cancel` are always there, so every surface
 * can refuse. `allow_always` is never offered, because nothing yet confirms
 * that `agy` forgets such an answer when its process ends.
 */
export const readApprovalDecisions = (
  options: ReadonlyArray<ApprovalOption>,
): NonEmptyReadonlyArray<ApprovalDecision> =>
  options.some((option) => option.kind === ALLOW_ONCE)
    ? ["allow", "deny", "cancel"]
    : ["deny", "cancel"];

/**
 * Returns the ACP reply for a decision. The option is chosen by its `kind`,
 * never by its id or its label, and the first of that kind wins.
 *
 * - `allow` selects the first `allow_once` option. A request with none offers
 *   no `allow`, so asking for it anyway answers `cancelled`: no call runs.
 * - `deny` selects the first `reject_once` option, or answers `cancelled` when
 *   there is none. Either way the call does not run.
 * - `cancel` and `allow_always` (never offered) answer `cancelled`.
 */
export const buildApprovalOutcome = (
  options: ReadonlyArray<ApprovalOption>,
  decision: ApprovalDecision,
): ApprovalOutcome => {
  const kind = decision === "allow" ? ALLOW_ONCE : decision === "deny" ? REJECT_ONCE : undefined;
  const option = options.find((candidate) => candidate.kind === kind);
  return option === undefined
    ? { outcome: "cancelled" }
    : { outcome: "selected", optionId: option.optionId };
};

/** One option of a question as the user sees it, with the value `agy` expects when it is chosen. */
interface FormChoice {
  readonly label: string;
  readonly value: string;
}

/** One question of the form: its form field names and its choices. */
interface FormQuestion {
  readonly header: string;
  readonly field: string;
  /** The name of the field that carries a typed answer, when the form has one. */
  readonly otherField: string | undefined;
  /** Whether the form lists the question in `required`, so it must be answered. */
  readonly required: boolean;
  readonly choices: ReadonlyArray<FormChoice>;
}

/**
 * A form read into Hercule's questions, with what is needed to turn the
 * answers back into the form's own field names and values.
 */
export interface QuestionForm {
  readonly questions: NonEmptyReadonlyArray<Question>;
  readonly mapping: ReadonlyArray<FormQuestion>;
}

/**
 * Returns `label` made unique among `taken`: unchanged when free, else the
 * label with the first free number after it ("Red (2)"). The user answers with
 * a label, so two options with one label could not both be chosen.
 */
const buildUniqueLabel = (label: string, taken: ReadonlySet<string>): string => {
  const shown = truncateFact(label);
  if (!taken.has(shown)) return shown;
  for (let number = 2; ; number++) {
    const suffix = ` (${String(number)})`;
    const numbered = `${truncateWithMarker(label, MAX_FACT_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(numbered)) return numbered;
  }
};

/**
 * Reads the choices of one single-select field. Returns `undefined` when the
 * field is not a plain string field with a non-empty `oneOf` of titled
 * choices. An option with an empty title is left out, because it could not be
 * shown.
 */
const readChoices = (field: ElicitationField): ReadonlyArray<FormChoice> | undefined => {
  if (field.type !== "string" || !field.oneOf || field.enum || field.items) return undefined;
  const labels = new Set<string>();
  const choices: Array<FormChoice> = [];
  for (const choice of field.oneOf) {
    if (typeof choice.const !== "string" || typeof choice.title !== "string") return undefined;
    if (choice.title === "") continue;
    const label = buildUniqueLabel(choice.title, labels);
    labels.add(label);
    choices.push({ label, value: choice.const });
  }
  return choices.length === 0 ? undefined : choices;
};

/**
 * Reads the form `agy` sent into questions. Returns `undefined` when the form
 * cannot be read, and the caller then answers `{ action: "cancel" }` with a
 * warning. A form is unreadable when:
 *
 * - a property is neither `qN` nor `qN_other`;
 * - a `qN` has no title, or is not a single-select string with `oneOf`
 *   (a multi-select or another type is not recorded yet);
 * - a `qN_other` is not a string field;
 * - it holds no question (a `qN_other` with no `qN` beside it is ignored).
 */
export const readQuestionForm = (request: ElicitationRequest): QuestionForm | undefined => {
  const properties = Object.entries(request.requestedSchema.properties ?? {});
  const questionFields: Array<{ readonly name: string; readonly field: ElicitationField }> = [];
  const otherFields = new Set<string>();
  for (const [name, field] of properties) {
    const other = /^(q\d+)_other$/.exec(name);
    if (other?.[1] !== undefined) {
      if (field.type !== "string") return undefined;
      otherFields.add(other[1]);
    } else if (/^q\d+$/.test(name)) {
      questionFields.push({ name, field });
    } else {
      return undefined;
    }
  }

  const required = new Set(request.requestedSchema.required ?? []);
  const mapping: Array<FormQuestion> = [];
  const questions: Array<Question> = [];
  for (const [index, { name, field }] of questionFields.entries()) {
    const choices = readChoices(field);
    if (choices === undefined || !field.title) return undefined;
    const header = questionFields.length === 1 ? "Question" : `Question ${String(index + 1)}`;
    mapping.push({
      header,
      field: name,
      otherField: otherFields.has(name) ? `${name}_other` : undefined,
      required: required.has(name),
      choices,
    });
    questions.push({
      question: truncateMessage(field.title),
      header,
      options: choices.map((choice) => ({ label: choice.label })),
      multiSelect: false,
    });
  }
  const [first, ...rest] = questions;
  return first === undefined ? undefined : { questions: [first, ...rest], mapping };
};

/** The result of turning answers into a reply: the reply, or why the answers cannot be sent. */
export type ElicitationAnswerResult =
  | { readonly kind: "reply"; readonly reply: ElicitationReply }
  | { readonly kind: "refused"; readonly message: string };

const refuse = (message: string): ElicitationAnswerResult => ({ kind: "refused", message });

/**
 * Builds the reply to the form from the user's answers, keyed by header, or
 * refuses them. Nothing is dropped or changed silently: an answer that cannot
 * be delivered as given is refused, with a message that tells the user what to
 * do, so the question can stay open for another try.
 *
 * - An answer equal to an option's label is sent as that option's own value in
 *   `qN`. The label is the one the question showed, so a label made unique
 *   ("Red (2)") still leads back to its own option.
 * - Any other text is a typed answer. It goes in `qN_other` alone, never with
 *   `qN`, because `agy` reads both fields when both are present.
 * - A list of one answer counts as that answer.
 *
 * It refuses when:
 * - a typed answer has no `qN_other` field to carry it;
 * - an answer is a list of several values (each question takes one answer);
 * - an answer has a header the form does not have;
 * - a question the form lists in `requestedSchema.required` got no answer. A
 *   question that is not required may be left unanswered, and then it is
 *   absent from the reply.
 */
export const buildElicitationReply = (
  form: QuestionForm,
  answers: QuestionAnswers,
): ElicitationAnswerResult => {
  const headers = new Set(form.mapping.map((question) => question.header));
  for (const header of Object.keys(answers)) {
    if (!headers.has(header)) {
      return refuse(`"${header}" is not a question of this form. Answer the questions shown.`);
    }
  }
  const content: Record<string, string> = {};
  for (const question of form.mapping) {
    const given = answers[question.header];
    if (given === undefined) {
      if (question.required) return refuse(`${question.header} needs an answer. Answer it.`);
      continue;
    }
    if (typeof given !== "string" && given.length !== 1) {
      return refuse(`${question.header} takes one answer. Give one answer.`);
    }
    const answer = typeof given === "string" ? given : given[0];
    const chosen = question.choices.find((choice) => choice.label === answer);
    if (chosen !== undefined) content[question.field] = chosen.value;
    else if (question.otherField !== undefined && answer !== undefined) {
      content[question.otherField] = answer;
    } else {
      return refuse(`${question.header} takes one of its options only. Pick one of them.`);
    }
  }
  return { kind: "reply", reply: { action: "accept", content } };
};
