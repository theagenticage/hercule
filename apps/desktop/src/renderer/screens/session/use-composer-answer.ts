import { useState } from "react";
import {
  ANSWER_ATTACH_OFF_REASON,
  REFUSED_FILE_NOTICE,
  decideQuestionStep,
  findComposerQuestion,
  typeAnswerInRequestDraft,
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
 * Returns what a composer needs to answer `request`, the Request of the
 * session `sessionId` that the dock shows (`null` when none is open), or
 * `null` when it stays a message composer: when `findComposerQuestion` finds
 * no question in it, or `holding` is true (the typing guard's, see
 * `useTypingGuard`).
 *
 * The answer is the Request's draft, so a half-typed answer survives paging
 * to another Request and back. The Message Draft is not touched. The step
 * button, ⏎, ⌘↵ and the menu's Send all call `step.onStep`.
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
  // A refusal belongs to the question it happened on. It is forgotten once
  // the composer answers another question or stops answering.
  const answerKey = found?.answerKey ?? null;
  const [refusedFor, setRefusedFor] = useState<string | null>(null);
  if (refusedFor !== null && refusedFor !== answerKey) setRefusedFor(null);
  if (found === null || holding) return null;
  const { requestId, questions, question, stepper } = found;

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
    text: found.text,
    onTextChange: (text) => {
      setRefusedFor(null);
      changeDraft((current) => typeAnswerInRequestDraft(current, questions, question, text));
    },
    placeholder: stepper.placeholder,
    historyKey: found.answerKey,
    locked: found.locked,
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
        setRefusedFor(answerKey);
      },
    },
    notice: refusedFor === answerKey ? REFUSED_FILE_NOTICE : stepper.notice,
    failure: found.failure,
  };
}
