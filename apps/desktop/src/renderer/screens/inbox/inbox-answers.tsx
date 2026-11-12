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
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { isPrimaryModifierHeld } from "../../app/primary-modifier";
import { DescribeLineText } from "../desk/signal-answers";
import "./inbox-answers.css";

/**
 * The answer the user chose on an ask and what became of it:
 *
 * - `held` and `sending`: on its way. The ask shows the answer as chosen and
 *   takes no other answer.
 * - `failed` and `interrupted`: not sent. `sentence` says why, and the ask
 *   offers to send it again or to discard it.
 */
export type ChosenAnswer =
  | { readonly actionId: string; readonly state: "held" | "sending" }
  | {
      readonly actionId: string;
      readonly state: "failed" | "interrupted";
      readonly sentence: string;
    };

/** The reply box that is open on an ask, and the words in it. */
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
  readonly onDraftChange: (text: string) => void;
  readonly onRetry: () => void;
  readonly onDiscard: () => void;
}

/**
 * Renders the answers of one signal, in the order `answers` holds them.
 *
 * - An answer that hands the work to an agent is left out: the pane's footer
 *   does that.
 * - Only the suggested answer of the current ask (`isCurrent`) is filled and
 *   shows ↩, because ↩ answers it.
 * - The answer in `chosen` draws as pressed while it is on its way, and every
 *   answer waits until it is sent, failed or discarded.
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
  onRetry,
  onDiscard,
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
          action={replyAnswer.action}
          isFilled={isCurrent}
          draft={reply.draft}
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
      {chosen !== undefined && (chosen.state === "failed" || chosen.state === "interrupted") && (
        <div className="sig-failed" data-state={chosen.state} role="alert">
          <span>{chosen.sentence}</span>
          <button type="button" className="btn btn--sm" onClick={onRetry}>
            Send again
          </button>
          <button type="button" className="btn btn--sm btn--quiet" onClick={onDiscard}>
            Discard
          </button>
        </div>
      )}
      <p className="sig-desc" aria-live="polite">
        {described.action.id === DONE_ACTION_ID &&
        described.action.describeLine === undefined &&
        described.action.description === undefined ? (
          `Ends this ask here. ${sourceName} is not told.`
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
  draft,
  sourceName,
  isLocked,
  platform,
  onDraftChange,
  onSend,
  onClose,
}: {
  readonly action: SignalAction;
  readonly isFilled: boolean;
  readonly draft: string;
  readonly sourceName: string;
  readonly isLocked: boolean;
  readonly platform: DesktopPlatform;
  readonly onDraftChange: (text: string) => void;
  readonly onSend: (text: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const input = useRef<HTMLTextAreaElement>(null);
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
