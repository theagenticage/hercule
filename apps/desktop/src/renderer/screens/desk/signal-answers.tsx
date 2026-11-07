/**
 * The answers of one signal (spec 17 §The pane): a ledger row for each
 * answer, and a Reply box in place of the row of an answer with a text field
 * while that box is open. Intake's pane draws them at its foot, and the
 * Inbox's open card draws them under an opened line, so a signal is answered
 * the same way in both.
 */
import type { JSX } from "react";
import type { DescribeLine, SignalAction } from "@hercule/contract";
import {
  trimAnswerEllipsis,
  type SignalAnswer,
  type SignalAnswerStyle,
} from "@hercule/client-core";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { isPrimaryModifierHeld } from "../../app/primary-modifier";
import type { AnswerFailure } from "../../app/use-answer-signal";
import { buildLook, Face } from "../../faces";
import { LedgerAnswer } from "./ledger-answer";
import "./signal-answers.css";

/** The classes of an answer's button, by how the pane draws the answer. */
const BUTTON_CLASSES: Readonly<Record<SignalAnswerStyle, string>> = {
  reply: "btn",
  done: "btn btn--quiet",
  quiet: "btn btn--quiet",
  plain: "btn",
};

/**
 * Renders a describe line, with the parts the core marked, such as a branch
 * or a pull request, in bold. An action with no describe line shows its
 * description, or nothing.
 */
function DescribeLineText({ action }: { readonly action: SignalAction }): JSX.Element | null {
  const line: DescribeLine | undefined = action.describeLine;
  if (line === undefined)
    return action.description === undefined ? null : <>{action.description}</>;
  return (
    <>
      {line.map((part, index) =>
        // The parts hold no id and never change order.
        part.kind === "marked" ? <b key={index}>{part.text}</b> : part.text,
      )}
    </>
  );
}

/** One run of answers drawn together: a ledger of rows, or one open Reply box. */
type AnswerGroup =
  | { readonly kind: "ledger"; readonly answers: ReadonlyArray<SignalAnswer> }
  | { readonly kind: "compose"; readonly answer: SignalAnswer };

/** Returns the answers in runs: each open Reply box alone, and the rows between them as one ledger. */
const groupAnswers = (
  answers: ReadonlyArray<SignalAnswer>,
  openReplyId: string | null,
): ReadonlyArray<AnswerGroup> => {
  const groups: AnswerGroup[] = [];
  for (const answer of answers) {
    if (answer.action.id === openReplyId) {
      groups.push({ kind: "compose", answer });
      continue;
    }
    const last = groups.at(-1);
    if (last?.kind === "ledger")
      groups[groups.length - 1] = { kind: "ledger", answers: [...last.answers, answer] };
    else groups.push({ kind: "ledger", answers: [answer] });
  }
  return groups;
};

/**
 * Renders the answers of a signal, in the order `answers` holds them.
 *
 * - A Hand to an agent answer wears the face of the workflow it starts. A
 *   workflow has no stored look yet, so its face is built from its id.
 * - The answer whose id is `openReplyId` draws as its Reply box: the text
 *   box, the describe line and the send button, which `⌘↩` presses too.
 *   Every other answer is a ledger row.
 * - A click on the row of an answer with a text field calls `onOpenReply`;
 *   a click on any other row calls `onAct`.
 * - `shortcutFor` returns the key a row shows beside it, or `null` for none.
 *   The caller decides, because the keys differ by page: on Intake `E` is
 *   Done, and in the Inbox `E` is Dismiss.
 * - While `locked`, every answer keeps its place and its focus, and does
 *   nothing.
 * - A `failure` shows under the button of the answer that failed.
 *
 * `idPrefix` makes the ids of the describe lines unique on the page, and
 * `className` is added to the root, for the spacing the caller wants around it.
 */
export function SignalAnswers({
  answers,
  openReplyId,
  drafts,
  locked,
  failure,
  idPrefix,
  className,
  shortcutFor,
  onOpenReply,
  onDraftChange,
  onAct,
  platform,
}: {
  readonly answers: ReadonlyArray<SignalAnswer>;
  readonly openReplyId: string | null;
  /** The text typed in each Reply box, by action id. */
  readonly drafts: Readonly<Record<string, string>>;
  readonly locked: boolean;
  readonly failure: AnswerFailure | null;
  readonly idPrefix: string;
  readonly className?: string;
  readonly shortcutFor: (answer: SignalAnswer) => string | null;
  readonly onOpenReply: (actionId: string) => void;
  readonly onDraftChange: (actionId: string, text: string) => void;
  readonly onAct: (actionId: string, text?: string) => void;
  /** The platform the app runs on, which decides the key that sends a Reply with ⏎: ⌘ on a Mac, Ctrl on Linux. */
  readonly platform: DesktopPlatform;
}): JSX.Element {
  return (
    <div className={className === undefined ? "signal-answers" : `signal-answers ${className}`}>
      {groupAnswers(answers, openReplyId).map((group) =>
        group.kind === "compose" ? (
          <ReplyBox
            key={group.answer.action.id}
            answer={group.answer}
            draft={drafts[group.answer.action.id] ?? ""}
            locked={locked}
            error={failure?.actionId === group.answer.action.id ? failure.message : null}
            idPrefix={idPrefix}
            onDraftChange={onDraftChange}
            onAct={onAct}
            platform={platform}
          />
        ) : (
          <div key={`ledger:${group.answers[0]!.action.id}`} className="ledger">
            {group.answers.map((answer) => (
              <AnswerRow
                key={answer.action.id}
                answer={answer}
                locked={locked}
                error={failure?.actionId === answer.action.id ? failure.message : null}
                idPrefix={idPrefix}
                shortcut={shortcutFor(answer)}
                onOpenReply={onOpenReply}
                onAct={onAct}
              />
            ))}
          </div>
        ),
      )}
    </div>
  );
}

/** Renders one answer as a ledger row, with `shortcut` as the key beside it, when it has one. */
function AnswerRow({
  answer,
  locked,
  error,
  idPrefix,
  shortcut,
  onOpenReply,
  onAct,
}: {
  readonly answer: SignalAnswer;
  readonly locked: boolean;
  readonly error: string | null;
  readonly idPrefix: string;
  readonly shortcut: string | null;
  readonly onOpenReply: (actionId: string) => void;
  readonly onAct: (actionId: string) => void;
}): JSX.Element {
  const { action, style, suggested } = answer;
  return (
    <LedgerAnswer
      answerId={action.id}
      label={action.label}
      buttonClass={suggested ? "btn btn--accent" : BUTTON_CLASSES[style]}
      mark={
        answer.workflowId === null ? undefined : (
          <Face look={buildLook(answer.workflowId)} pose="idle" size={18} />
        )
      }
      describe={<DescribeLineText action={action} />}
      shortcut={shortcut}
      error={error}
      locked={locked}
      idPrefix={idPrefix}
      onPress={() => {
        if (style === "reply") onOpenReply(action.id);
        else onAct(action.id);
      }}
    />
  );
}

/**
 * Renders an answer's Reply box: the text box with the field's placeholder,
 * the describe line, and the send button. The typed text stays when a send
 * fails, so the user can try again.
 */
function ReplyBox({
  answer,
  draft,
  locked,
  error,
  idPrefix,
  onDraftChange,
  onAct,
  platform,
}: {
  readonly answer: SignalAnswer;
  readonly draft: string;
  readonly locked: boolean;
  readonly error: string | null;
  readonly idPrefix: string;
  readonly onDraftChange: (actionId: string, text: string) => void;
  readonly onAct: (actionId: string, text: string) => void;
  readonly platform: DesktopPlatform;
}): JSX.Element {
  const { action, suggested } = answer;
  const describeId = `${idPrefix}-${action.id}-describe`;
  const errorId = `${idPrefix}-${action.id}-error`;
  const empty = draft.trim() === "";
  const send = (): void => {
    if (!locked && !empty) onAct(action.id, draft);
  };
  return (
    <div>
      <div className="ad-compose">
        <textarea
          className="ad-compose-input"
          data-compose-for={action.id}
          rows={3}
          aria-label={trimAnswerEllipsis(action.label)}
          aria-describedby={error === null ? describeId : `${describeId} ${errorId}`}
          placeholder={action.field?.placeholder}
          value={draft}
          readOnly={locked}
          onChange={(event) => {
            onDraftChange(action.id, event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && isPrimaryModifierHeld(event, platform)) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="ad-compose-row">
          <span className="ad-compose-desc" id={describeId}>
            <DescribeLineText action={action} />
          </span>
          <button
            type="button"
            className={suggested ? "btn btn--sm btn--accent" : "btn btn--sm"}
            aria-disabled={locked || empty || undefined}
            data-unready={empty || undefined}
            onClick={send}
          >
            {trimAnswerEllipsis(action.label)} <kbd>⌘↩</kbd>
          </button>
        </div>
      </div>
      {error !== null && (
        <p className="ad-err ad-compose-err" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
