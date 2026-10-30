import { useState } from "react";
import {
  ANSWER_ATTACH_OFF_REASON,
  REFUSED_FILE_NOTICE,
  buildQuestionDraft,
  buildQuestionStepper,
  findComposerQuestion,
  decideQuestionStep,
  typeQuestionAnswer,
} from "@hercule/client-core";
import type { SessionRequest } from "@hercule/contract";
import { useRequestDraft, useSendAnswers } from "../../app/request-drafts";
import type { ComposerAttachments, ComposerStep } from "./composer-frame";

/** The `historyKey` of the message field while it shows the Message Draft. */
export const MESSAGE_HISTORY_KEY = "message";

/**
 * What a composer shows and does while it answers an agent's question, in the
 * props `ComposerFrame` takes.
 */
export interface ComposerAnswer {
  /** The shown question's own answer, typed so far. */
  readonly text: string;
  /** Stores the text the user typed as the shown question's own answer. */
  readonly onTextChange: (text: string) => void;
  /** "Or type your own answer" when the question has options, otherwise "Type your answer". */
  readonly placeholder: string;
  /** Names the answer, so the field starts an empty undo history when it moves between answers or to the message. */
  readonly historyKey: string;
  /** Whether the answers are sent. The field then takes no text, until the controller closes the Request. */
  readonly locked: boolean;
  /** Previous and the step button. ⏎, ⌘↵ and the menu's Send call `step.onStep` too. */
  readonly step: ComposerStep;
  /** Attach off with its reason, no shelf, and a pasted or dropped file refused with a notice. */
  readonly attachments: ComposerAttachments;
  /** The refused file's notice, or else why a length limit stops the step; `null` when neither. */
  readonly notice: string | null;
  /** Why sending the answers failed, or `null`. */
  readonly failure: string | null;
}

/** Attach's state while answering: nothing to show or remove, and the reason it is off. */
const NO_IMAGES: Omit<ComposerAttachments, "onFiles"> = {
  shelf: [],
  model: { imageInput: null, modelName: "" },
  onRemove: () => {},
  onRetry: () => {},
  attachBlockedReason: ANSWER_ATTACH_OFF_REASON,
};

/**
 * Returns what a composer needs to answer the shown Request of the session
 * `sessionId`, or `null` when it stays a message composer. `request` is the
 * Request the dock shows, or `null` when none is open. The composer answers
 * when `findComposerQuestion` finds a question in `request` and `holding` is
 * false. `holding` is the typing guard's, see `useTypingGuard`.
 *
 * The answer is the Request's draft, so a half-typed answer survives paging
 * to another Request and back. The Message Draft is not touched.
 *
 * Previous works while the answers are not sent. The step button shows the
 * next question, and sends the answers from the last one with
 * `useSendAnswers`; it does nothing while the shown question is unanswered
 * or a length limit is exceeded.
 */
export function useComposerAnswer(
  sessionId: string,
  request: SessionRequest | null,
  holding: boolean,
): ComposerAnswer | null {
  // A Request id is never empty, so "" reads the empty draft.
  const [draft, changeDraft] = useRequestDraft(sessionId, request?.requestId ?? "");
  const sendAnswers = useSendAnswers(sessionId);
  const found = findComposerQuestion(request, draft);
  // Names the question being answered. A refusal belongs to it: it is
  // forgotten once the composer answers another question of the same Request
  // or of another one, and once it stops answering.
  const answeringKey = found === null ? null : `${found.requestId}:${found.question.header}`;
  const [refusedFor, setRefusedFor] = useState<string | null>(null);
  if (refusedFor !== null && refusedFor !== answeringKey) setRefusedFor(null);
  if (found === null || holding) return null;
  const { requestId, questions, question } = found;
  const stepper = buildQuestionStepper(draft, questions);

  const step = (direction: "previous" | "next"): void => {
    const next = decideQuestionStep(draft, questions, direction);
    if (next === null) return;
    setRefusedFor(null);
    if (next.kind === "send") {
      sendAnswers(requestId, next.answers);
      return;
    }
    changeDraft((current) => ({ ...current, shownQuestionIndex: next.index }));
  };

  return {
    text: (draft.question ?? buildQuestionDraft(questions))[question.header]!.text,
    onTextChange: (text) => {
      setRefusedFor(null);
      changeDraft((current) => ({
        ...current,
        question: typeQuestionAnswer(
          current.question ?? buildQuestionDraft(questions),
          question,
          text,
        ),
      }));
    },
    placeholder: stepper.placeholder,
    historyKey: `${requestId}:${question.header}`,
    locked: draft.answered,
    step: {
      label: stepper.stepLabel,
      showsPrevious: stepper.showsPrevious,
      canGoBack: stepper.canGoBack,
      ready: stepper.ready,
      onPrevious: () => {
        step("previous");
      },
      onStep: () => {
        step("next");
      },
    },
    attachments: {
      ...NO_IMAGES,
      onFiles: () => {
        setRefusedFor(answeringKey);
      },
    },
    notice: refusedFor === answeringKey ? REFUSED_FILE_NOTICE : stepper.notice,
    failure: draft.failure,
  };
}
