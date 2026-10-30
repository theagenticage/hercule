import { useState } from "react";
import {
  ANSWER_ATTACH_OFF_REASON,
  REFUSED_FILE_NOTICE,
  buildQuestionDraft,
  buildQuestionStepper,
  buildRequestDock,
  findComposerQuestion,
  decideQuestionStep,
  typeQuestionAnswer,
  type HerculeClient,
} from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import { useRequestDraft, useSendAnswers, useShownRequestId } from "../../app/thread-drafts";

/** The step controls of the composer while it answers: Previous, and Next or Send answers. */
export interface ComposerStep {
  /** "Next", or "Send answers" on the last question. */
  readonly label: string;
  /** Whether to draw Previous: from the second question on. */
  readonly showsPrevious: boolean;
  /** Whether Previous works: the answers are not sent yet. */
  readonly canGoBack: boolean;
  /** Whether the step button works: the shown question is answered and no length limit is exceeded. */
  readonly ready: boolean;
  readonly onPrevious: () => void;
  readonly onStep: () => void;
}

/** What the composer shows and does while it answers an agent's question. */
export interface ComposerAnswer {
  /** The shown question's own answer, typed so far. */
  readonly text: string;
  /** Stores the text the user typed as the shown question's own answer. */
  readonly onTextChange: (text: string) => void;
  /** "Or type your own answer" when the question has options, otherwise "Type your answer". */
  readonly placeholder: string;
  /** Whether the answers are sent. The field then takes no text, until the controller closes the Request. */
  readonly locked: boolean;
  readonly step: ComposerStep;
  /** Attach is off with its reason, and a pasted or dropped file is refused with a notice. */
  readonly attachments: {
    readonly attachBlockedReason: string;
    readonly onFiles: () => void;
  };
  /** The refused file's notice, or else why a length limit stops the step; `null` when neither. */
  readonly notice: string | null;
  /** Whether `notice` is the refusal of a pasted, dropped or picked file, which is shown as a failure. */
  readonly refusedFile: boolean;
  /** Why sending the answers failed, or `null`. */
  readonly failure: string | null;
}

/**
 * Returns what the composer needs to answer the Request the dock shows, or
 * `null` while it stays a message composer. Pass `null` as `session` in a
 * draft thread, which has no Requests.
 *
 * The composer answers when the shown Request is a question that
 * `findComposerQuestion` accepts and `holding` is false. `holding` is the
 * typing guard's, see `useTypingGuard`. The shown Request is found the way
 * the dock finds it, from the session's open Requests and the thread's shown
 * Request id, so the two can never show different Requests.
 *
 * The answer is the Request's draft, so a half-typed answer survives paging
 * to another Request and back. The Message Draft is not touched.
 *
 * Previous works while the answers are not sent. The step button shows the
 * next question, and sends the answers from the last one with
 * `useSendAnswers`; it does nothing while the shown question is unanswered
 * or a length limit is exceeded. Enter calls the same `step.onStep`.
 */
export function useComposerAnswer(
  client: HerculeClient,
  session: Session | null,
  holding: boolean,
): ComposerAnswer | null {
  const [shownRequestId] = useShownRequestId();
  const shown =
    session === null
      ? null
      : (buildRequestDock(session.openRequests, [], undefined, shownRequestId)?.request ?? null);
  const [draft, changeDraft] = useRequestDraft(shown?.requestId ?? null);
  const sendAnswers = useSendAnswers(client, session?.id ?? null);
  const found = findComposerQuestion(shown, draft);
  const [refusedFor, setRefusedFor] = useState<string | null>(null);

  const answeringKey =
    found === null ? null : `${found.requestId}:${String(draft.shownQuestionIndex)}`;
  // A refusal belongs to the question it happened on. It is forgotten once
  // the composer answers another question or stops answering.
  if (refusedFor !== null && refusedFor !== answeringKey) setRefusedFor(null);

  if (found === null || holding) return null;
  const { requestId, questions, question } = found;
  const stepper = buildQuestionStepper(draft, questions);
  const refusedFile = refusedFor === answeringKey;

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
      attachBlockedReason: ANSWER_ATTACH_OFF_REASON,
      onFiles: () => {
        setRefusedFor(answeringKey);
      },
    },
    notice: refusedFile ? REFUSED_FILE_NOTICE : stepper.notice,
    refusedFile,
    failure: draft.failure,
  };
}
