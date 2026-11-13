/**
 * The answers of one open signal as the Inbox's pane draws them (spec 17 §The
 * pane): buttons, the suggested answer filled and carrying ↩ only on the
 * current ask, Done quiet at the end, the describe line of the answer under
 * the pointer or the focus, and the reply box of an answer with a text field.
 */
import { useLayoutEffect, useRef, useState, type JSX } from "react";
import type { SignalAction } from "@hercule/contract";
import { DONE_ACTION_ID } from "@hercule/contract";
import { trimAnswerEllipsis, type SignalAnswer } from "@hercule/client-core";
import { describeDoneEffect } from "@hercule/client-core/inbox";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { isPrimaryModifierHeld } from "../../app/primary-modifier";
import { DescribeLineText } from "../desk/signal-answers";
import "./inbox-answers.css";

/**
 * The answer the user chose on an ask and what became of it. The ask takes no
 * other answer meanwhile: `held` and `sending` are on their way, `unsent`
 * failed or was left by a closed app and waits for Send again or Discard
 * (`InboxUnsentAnswers`).
 */
export interface ChosenAnswer {
  readonly actionId: string;
  readonly state: "held" | "sending" | "unsent";
}

/** The reply box that is open on an ask, and the words it opens with. It keeps the words itself from then on. */
export interface OpenReply {
  readonly actionId: string;
  readonly draft: string;
}

/** What `InboxAnswers` takes: the answers, which one was chosen, the open reply box, and what each press does. */
export interface InboxAnswersProps {
  readonly answers: ReadonlyArray<SignalAnswer>;
  readonly isCurrent: boolean;
  readonly sourceName: string;
  readonly chosen: ChosenAnswer | undefined;
  readonly reply: OpenReply | null;
  readonly platform: DesktopPlatform;
  readonly onAnswer: (actionId: string, text?: string) => void;
  readonly onDone: () => void;
  readonly onOpenReply: (actionId: string) => void;
  readonly onCloseReply: () => void;
  /** Tells the caller the words so far, to keep for when the box opens again. */
  readonly onDraftChange: (text: string) => void;
}

/**
 * Renders the answers of one signal, in the order `answers` holds them.
 *
 * - An answer that hands the work to an agent is left out: the pane's footer
 *   does that.
 * - Only the suggested answer of the current ask (`isCurrent`) is filled and
 *   shows ↩, because ↩ answers it.
 * - The answer in `chosen` draws as pressed while it is on its way, and every
 *   answer is inert while one is on its way and after one was not sent, until
 *   the user sends it again or discards it.
 * - Pressing an answer with a text field calls `onOpenReply`; the box shows
 *   when `reply` names that answer. The words in it belong to the caller, so
 *   closing the box (Cancel or Esc) keeps them.
 * - Pressing any other answer calls `onAnswer` with its id, Done calls `onDone`,
 *   and sending the reply calls `onAnswer` with the id and the words.
 *
 * `sourceName` is the source the answers act on, such as "GitHub".
 * `platform` decides which key sends a reply with Return: ⌘ on a Mac, Ctrl on Linux.
 */
export function InboxAnswers({
  answers,
  isCurrent,
  sourceName,
  chosen,
  reply,
  platform,
  onAnswer,
  onDone,
  onOpenReply,
  onCloseReply,
  onDraftChange,
}: InboxAnswersProps): JSX.Element | null {
  const shown = answers.filter((answer) => answer.workflowId === null);
  const [describedId, setDescribedId] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  if (shown.length === 0) return null;
  const described = shown.find((answer) => answer.action.id === describedId) ?? shown[0]!;
  const isWaiting = chosen !== undefined;
  const replyAnswer =
    reply === null ? undefined : shown.find((a) => a.action.id === reply.actionId);

  const closeReply = (): void => {
    if (reply !== null) buttons.current.get(reply.actionId)?.focus();
    onCloseReply();
  };
  return (
    <>
      <div className="sig-answers">
        {shown.map((answer) => {
          const { action } = answer;
          const isDone = action.id === DONE_ACTION_ID;
          const isFilled = isCurrent && answer.suggested;
          const isPressed =
            (chosen !== undefined &&
              (chosen.state === "held" || chosen.state === "sending") &&
              chosen.actionId === action.id) ||
            reply?.actionId === action.id;
          const classes = [
            "btn btn--sm",
            isFilled && "btn--answer",
            isDone && "btn--quiet sig-done",
            isPressed && "is-pressed",
          ];
          return (
            <button
              key={action.id}
              ref={(element) => {
                if (element === null) buttons.current.delete(action.id);
                else buttons.current.set(action.id, element);
              }}
              type="button"
              className={classes.filter(Boolean).join(" ")}
              data-answer={action.id}
              aria-keyshortcuts={isFilled ? "Enter" : undefined}
              aria-pressed={isPressed || undefined}
              aria-disabled={(isWaiting && !isPressed) || undefined}
              inert={(isWaiting && !isPressed) || undefined}
              onPointerEnter={() => {
                setDescribedId(action.id);
              }}
              onFocus={() => {
                setDescribedId(action.id);
              }}
              onClick={() => {
                if (isWaiting) return;
                if (isDone) onDone();
                else if (answer.style === "reply") onOpenReply(action.id);
                else onAnswer(action.id);
              }}
            >
              {action.label}
              {isFilled && <kbd aria-hidden="true">↩</kbd>}
            </button>
          );
        })}
      </div>
      {replyAnswer !== undefined && reply !== null && (
        <ReplyBox
          key={replyAnswer.action.id}
          action={replyAnswer.action}
          isFilled={isCurrent}
          initialDraft={reply.draft}
          sourceName={sourceName}
          isLocked={isWaiting}
          platform={platform}
          onDraftChange={onDraftChange}
          onSend={(text) => {
            onAnswer(replyAnswer.action.id, text);
          }}
          onClose={closeReply}
        />
      )}
      <p className="sig-desc" aria-live="polite">
        {described.action.id === DONE_ACTION_ID &&
        described.action.describeLine === undefined &&
        described.action.description === undefined ? (
          describeDoneEffect(sourceName)
        ) : (
          <DescribeLineText action={described.action} />
        )}
      </p>
    </>
  );
}

/**
 * Renders the reply box of an answer with a text field: the words so far,
 * who the reply is from, Cancel and Send. Esc and Cancel close the box
 * through `onClose`; Send, or Return with the platform's modifier, sends the
 * words, and an empty draft sends nothing and keeps the cursor in the box.
 */
function ReplyBox({
  action,
  isFilled,
  initialDraft,
  sourceName,
  isLocked,
  platform,
  onDraftChange,
  onSend,
  onClose,
}: {
  readonly action: SignalAction;
  readonly isFilled: boolean;
  readonly initialDraft: string;
  readonly sourceName: string;
  readonly isLocked: boolean;
  readonly platform: DesktopPlatform;
  readonly onDraftChange: (text: string) => void;
  readonly onSend: (text: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const input = useRef<HTMLTextAreaElement>(null);
  // The words live here, so a keystroke renders this box and not the pane around it.
  const [draft, setDraft] = useState(initialDraft);
  // The box opens with the cursor after the kept words: the user pressed the answer to write.
  useLayoutEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  const label = trimAnswerEllipsis(action.label);
  const send = (): void => {
    if (isLocked) return;
    if (draft.trim() === "") input.current?.focus();
    else onSend(draft);
  };
  return (
    <div className="sig-reply">
      <textarea
        ref={input}
        rows={3}
        aria-label={label}
        placeholder={action.field?.placeholder}
        value={draft}
        readOnly={isLocked}
        onChange={(event) => {
          setDraft(event.target.value);
          onDraftChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          } else if (event.key === "Enter" && isPrimaryModifierHeld(event, platform)) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className="sig-reply-row">
        <span className="sig-reply-as">as you on {sourceName}</span>
        <button type="button" className="btn btn--sm btn--quiet" onClick={onClose}>
          Cancel
          <kbd aria-hidden="true">Esc</kbd>
        </button>
        <button
          type="button"
          className={isFilled ? "btn btn--sm btn--answer" : "btn btn--sm"}
          aria-disabled={isLocked || undefined}
          onClick={send}
        >
          {label}
          <kbd aria-hidden="true">{platform === "mac" ? "⌘↩" : "Ctrl↩"}</kbd>
        </button>
      </div>
    </div>
  );
}

/** One answer that was not sent, as `InboxUnsentAnswers` draws it. */
export interface UnsentAnswer {
  readonly id: string;
  /** Says what happened and whether the source may have the answer. */
  readonly sentence: string;
  /** True when the app closed, which is quieter than a refusal. */
  readonly isInterrupted: boolean;
  /** The words typed in the reply box, when the answer had a reply. */
  readonly words: string | undefined;
  /** False when the ask is no longer open here: only Discard is offered, and the words stay to be copied. */
  readonly canSendAgain: boolean;
  readonly onSendAgain: () => void;
  readonly onDiscard: () => void;
}

/**
 * Renders each answer in `answers` that was not sent: what happened, then Send
 * again and Discard. When an answer cannot be sent again, its words (if it had
 * any) are shown instead, so the user can copy them. Draws nothing for none.
 */
export function InboxUnsentAnswers({
  answers,
}: {
  readonly answers: ReadonlyArray<UnsentAnswer>;
}): JSX.Element | null {
  if (answers.length === 0) return null;
  return (
    <>
      {answers.map((answer) => (
        <div
          key={answer.id}
          className="sig-failed"
          data-state={answer.isInterrupted ? "interrupted" : "failed"}
          role="alert"
        >
          <span>{answer.sentence}</span>
          {!answer.canSendAgain && answer.words !== undefined && (
            <q className="sig-failed-words">{answer.words}</q>
          )}
          {answer.canSendAgain && (
            <button type="button" className="btn btn--sm" onClick={answer.onSendAgain}>
              Send again
            </button>
          )}
          <button type="button" className="btn btn--sm btn--quiet" onClick={answer.onDiscard}>
            Discard
          </button>
        </div>
      ))}
    </>
  );
}
