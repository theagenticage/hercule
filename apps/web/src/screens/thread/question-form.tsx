import { type JSX, useId } from "react";
import {
  type ApprovalQuestion,
  buildQuestionDraft,
  buildQuestionStepper,
  pickQuestionOption,
  PREVIOUS_QUESTION_LABEL,
  type QuestionDraft,
  type RequestDraft,
  decideQuestionStep,
  typeQuestionAnswer,
} from "@hercule/client-core";
import type { QuestionAnswers } from "@hercule/contract";
import { Button, ChoiceInput, cn, Input } from "@hercule/ui";
import { useComposerDraft } from "../../app/thread-drafts";
import type { DockComposer } from "./permission-card";

/**
 * Renders the questions of a `question` request one at a time, and calls
 * `onSend` with the answers to all of them once the user sends.
 *
 * Each question shows its chip, its text, its options as choices (radios when
 * it takes one answer, checkboxes when it takes several) and, unless the
 * composer answers (`composerAnswers`), a field for the user's own answer
 * with Previous, from the second question on, and Next or Send answers. The
 * field of a secret question is masked. Next and Send stay unusable until
 * the shown question is answered, so the answers sent never leave a question
 * out. They use `aria-disabled` rather than `disabled`, so the button keeps
 * focus while the user picks. Enter in the field steps too. `client-core`
 * decides what each step does.
 *
 * Picking an option on a single-select question clears the text typed for
 * it. Where the thread has a Message Draft, that text is not lost: it moves
 * to the end of the Message Draft. The one exception is a secret question:
 * a pick erases the typed text and never moves it to the Message Draft, which
 * is not secret.
 */
export function QuestionForm({
  questions,
  draft: requestDraft,
  onDraftChange,
  locked,
  composer,
  composerAnswers,
  onSend,
}: {
  readonly questions: readonly ApprovalQuestion[];
  /** The Request's draft, which holds the answers typed so far and the shown question. */
  readonly draft: RequestDraft;
  readonly onDraftChange: (change: (draft: RequestDraft) => RequestDraft) => void;
  /** Whether an answer was sent, so nothing in the form takes input. */
  readonly locked: boolean;
  /** Where the thread's composer is, which decides where displaced text goes. */
  readonly composer: DockComposer;
  /** Whether the composer, not this form, takes the shown question's own answer. */
  readonly composerAnswers: boolean;
  readonly onSend: (answers: QuestionAnswers) => void;
}): JSX.Element {
  const [composerDraft, changeComposerDraft] = useComposerDraft();
  const draft = requestDraft.question ?? buildQuestionDraft(questions);
  const { shownQuestionIndex } = requestDraft;
  const setDraft = (question: QuestionDraft): void => {
    onDraftChange((current) => ({ ...current, question }));
  };
  // Radios of one question share a name, so the browser moves between them
  // with the arrow keys. The id keeps two cards from sharing a group.
  const groupName = useId();
  const question = questions[shownQuestionIndex]!;
  const answer = draft[question.header]!;
  const stepper = buildQuestionStepper(requestDraft, questions);
  const isSecret = question.secretWarning !== null;
  const hasDescriptions = question.options.some((option) => option.description !== undefined);

  const step = (direction: "previous" | "next"): void => {
    const next = decideQuestionStep(requestDraft, questions, direction);
    if (next === null) return;
    if (next.kind === "send") onSend(next.answers);
    else onDraftChange((current) => ({ ...current, shownQuestionIndex: next.index }));
  };
  // The question draft and the Message Draft change together, from what
  // `pickQuestionOption` returns, so the typed text is never both erased and
  // not moved.
  const pick = (label: string): void => {
    const messageText = composerDraft.message.text;
    const picked = pickQuestionOption(
      draft,
      question,
      label,
      composer === "none" ? "" : messageText,
    );
    setDraft(picked.question);
    if (composer !== "none" && picked.messageText !== messageText) {
      changeComposerDraft((current) => ({
        ...current,
        message: { ...current.message, text: picked.messageText },
      }));
    }
  };

  return (
    // Not a `<form>`: a native submit next to a masked field makes browsers
    // offer to save the answer as a password. Enter and the step button call
    // `step` themselves.
    <div role="group" aria-label={question.header} className="mt-3 flex flex-col">
      <div className="flex items-baseline justify-between gap-3">
        {/* The chip is styled as a lane label, not a sentence: 10px uppercase
            `--faint`, the size of a label inside a surface (spec 14
            §Measurements, the popover's options grid). */}
        <span className="text-[10px] font-emph tracking-[0.09em] text-faint uppercase">
          {question.header}
        </span>
        {questions.length === 1 ? null : (
          <span className="text-[11px] text-faint tabular-nums">
            {/* "Question" keeps this count apart from the dock's "1 of 2",
                which pages through Requests. */}
            Question {shownQuestionIndex + 1} of {questions.length}
          </span>
        )}
      </div>
      {/* An async question's text is the agent's whole title, which can run
          to several paragraphs: it keeps its line breaks and scrolls past
          about eight lines rather than push the transcript out of view. */}
      <span className="mt-0.5 max-h-[8lh] overflow-y-auto text-meta whitespace-pre-line text-ink wrap-anywhere">
        {question.question}
      </span>
      {/* The same two columns as the answer ledger, so options and answers
          line up: the choice and its label on the shared left edge, its
          meaning beside it. The whole row is the click target. The list, not
          each row, reaches 8px past the column, because a scrolling box
          clips its rows at its own edges. */}
      {question.options.length === 0 ? null : (
        <div className="-mx-2 mt-1 flex max-h-48 flex-col overflow-y-auto">
          {question.options.map((option, index) => (
            // Keyed by place, so a focused choice keeps the focus when the next
            // question has a choice in the same place, and ↩ moves on again
            // from there.
            <label
              key={index}
              className={cn(
                "grid items-baseline gap-3 rounded-control px-2 py-[3px]",
                // With no description to line up, the label takes the whole
                // row instead of wrapping in the first column.
                hasDescriptions ? "grid-cols-[140px_minmax(0,1fr)]" : "grid-cols-1",
                locked ? "cursor-not-allowed" : "cursor-pointer hover:bg-line-soft",
              )}
            >
              {/* The label, not the choice, gives this column its baseline, so
                the label sits on the same line as its description. The
                choice is one line of the label's text tall and centred in
                it, so it stays beside the first line when a long label
                wraps. */}
              <span className="flex min-w-0 items-baseline gap-2">
                <ChoiceInput
                  type={question.multiSelect ? "checkbox" : "radio"}
                  name={groupName}
                  checked={answer.picks.includes(option.label)}
                  disabled={locked}
                  onChange={() => {
                    pick(option.label);
                  }}
                  className="h-[1lh] self-start text-meta"
                />
                <span className="text-meta font-emph text-ink wrap-anywhere">{option.label}</span>
              </span>
              {option.description === undefined ? null : (
                <span className="text-fine text-muted wrap-anywhere">{option.description}</span>
              )}
            </label>
          ))}
        </div>
      )}
      {/* Smaller and fainter than an option, with space above it, so it does
          not look like another option. */}
      {question.note === null ? null : (
        <span className="mt-1 text-[11px] text-faint">{question.note}</span>
      )}
      {question.secretWarning === null ? null : (
        <span className="mt-1 text-[11px] text-attn">{question.secretWarning}</span>
      )}
      {composerAnswers ? null : (
        <div className="mt-2 flex items-center gap-2">
          <Input
            aria-label="Your own answer"
            // A secret answer is masked, and no password manager may treat it
            // as a login. Chrome ignores `autocomplete="off"` on a password
            // field. `new-password` tells it that this is not the saved
            // password, so it does not fill the Hercule login into the
            // field. The `data-` attributes do the same for the 1Password,
            // LastPass and Bitwarden extensions.
            type={isSecret ? "password" : "text"}
            autoComplete={isSecret ? "new-password" : undefined}
            data-1p-ignore={isSecret ? true : undefined}
            data-lpignore={isSecret ? "true" : undefined}
            data-bwignore={isSecret ? "true" : undefined}
            placeholder={stepper.placeholder}
            value={answer.text}
            disabled={locked}
            onChange={(event) => setDraft(typeQuestionAnswer(draft, question, event.target.value))}
            onKeyDown={(event) => {
              // The Enter that ends an IME composition only commits the text.
              if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) {
                return;
              }
              event.preventDefault();
              if (!locked) step("next");
            }}
            className="py-1 text-meta"
          />
          {stepper.showsPrevious ? (
            <Button
              disabled={!stepper.canGoBack}
              className="py-1.5"
              onClick={() => {
                step("previous");
              }}
            >
              {PREVIOUS_QUESTION_LABEL}
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={locked}
            aria-disabled={!stepper.ready}
            className="py-1.5"
            onClick={() => {
              step("next");
            }}
          >
            {stepper.stepLabel}
          </Button>
        </div>
      )}
      {composerAnswers || stepper.notice === null ? null : (
        <span className="mt-1 text-[11px] text-attn" role="status">
          {stepper.notice}
        </span>
      )}
    </div>
  );
}
