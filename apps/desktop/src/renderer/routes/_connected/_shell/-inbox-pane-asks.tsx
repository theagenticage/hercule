import { useImperativeHandle, type JSX, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  buildSignalAnswers,
  findSuggestedAnswer,
  formatAge,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import {
  chooseCurrentAsk,
  describeAnswerFailure,
  describeInterruptedAnswer,
  stepAsk,
  type PaneAsks,
} from "@hercule/client-core/inbox";
import { DONE_ACTION_ID, type Signal } from "@hercule/contract";
import type { DesktopPlatform } from "../../../../ipc/platform/desktop-platform";
import type { AccountScope } from "../../../app/account-scope";
import type { PendingIntent } from "../../../app/pending-intents";
import { signalQuery } from "../../../app/queries";
import { usePendingIntents } from "../../../app/use-pending-intents";
import type { ChosenAnswer, OpenReply } from "../../../screens/inbox/inbox-answers";
import {
  InboxAskSection,
  InboxMoreAsks,
  type AskSectionBody,
} from "../../../screens/inbox/inbox-ask-section";
import { INBOX_PANE_ID } from "../../../screens/inbox/inbox-pane-frame";
import type { InboxAnswers } from "./-inbox-answers";
import type { InboxListRow } from "./-inbox-visit";

/** What the keys ask of the asks: answer the current one, or step to the one before or after. */
export interface InboxPaneAsksHandle {
  /**
   * Presses the suggested answer of the current ask, or moves the focus to its
   * first answer when it suggests none. A folded current ask is unfolded
   * instead, so the next press answers it. Returns false when no ask is
   * current. Does nothing while the pane draws the thing before's asks or is
   * not showing, because an answer must go to the thing the user sees.
   */
  readonly answerCurrentAsk: () => boolean;
  /** Makes the ask before (`-1`) or after (`1`) the current one current, and unfolds it. */
  readonly stepAsk: (by: -1 | 1) => void;
}

/** The reply box that is open in the pane, and for which signal. */
export interface PaneReply extends OpenReply {
  readonly signalId: string;
}

/**
 * Returns what became of the answer the user gave on `signalId`: on its way
 * while it is held or being sent, and not sent (with its sentence) once it
 * failed or the app closed. `undefined` when no answer is held for the signal.
 */
const readChosenAnswer = (
  intents: readonly PendingIntent[],
  signal: Signal,
  thing: Pick<InboxListRow, "identifier">,
  sourceName: string,
): { readonly intent: PendingIntent; readonly chosen: ChosenAnswer } | undefined => {
  const intent = intents.find(
    (each) => each.kind === "signal-answer" && each.signalId === signal.id,
  );
  if (intent?.kind !== "signal-answer") return undefined;
  if (intent.state !== "failed") {
    return {
      intent,
      chosen: { actionId: intent.actionId, state: intent.state === "sending" ? "sending" : "held" },
    };
  }
  const reason = intent.failure?.reason;
  const label = signal.actions.find((action) => action.id === intent.actionId)?.label ?? "Answer";
  const sentence =
    reason === "interrupted"
      ? describeInterruptedAnswer("before-sending", sourceName)
      : reason === "interrupted-while-sending"
        ? describeInterruptedAnswer("while-sending", sourceName)
        : describeAnswerFailure(
            { label, identifier: thing.identifier, sourceName },
            intent.failure?.message ?? "",
          );
  return {
    intent,
    chosen: {
      actionId: intent.actionId,
      state:
        reason === "interrupted" || reason === "interrupted-while-sending"
          ? "interrupted"
          : "failed",
      sentence,
    },
  };
};

/** Focuses the first answer of the ask that is current, so Return on an ask with no suggested answer lands on its answers. */
const focusFirstAnswer = (): void => {
  document
    .getElementById(INBOX_PANE_ID)
    ?.querySelector<HTMLElement>(".sig.is-current-ask [data-answer]")
    ?.focus();
};

/**
 * Renders the sections of the open asks of a thing and the line that counts
 * the asks it has no section for.
 *
 * The current ask is the one the user chose last for this thing (`chosenId`,
 * `undefined` for none yet), else the newest of the signal kinds the saved
 * query is about (`savedQueryKinds`), else the newest. It stays current when
 * the user folds it (`isFolded`), so `[` and `]` step on from it. Only an
 * unfolded current ask is drawn open and read in full (`signal.read`, for its
 * blocks and answers).
 *
 * `isStale` is true while `paneAsks` are the thing before's: nothing is read for
 * it then, and no answer is given. `isActive` is false while the pane is not
 * showing. `ref` receives the handle the keys use.
 *
 * Orchestrating: it owns the read of the current ask, and what becomes of the
 * answers given on it.
 */
export function InboxPaneAsks({
  client,
  scope,
  thing,
  paneAsks,
  isStale,
  isActive,
  savedQueryKinds,
  chosenId,
  isFolded,
  reply,
  sourceName,
  timezone,
  now,
  platform,
  answers,
  ref,
  onChoose,
  onReplyChange,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly thing: InboxListRow;
  /** The asks of the thing's record, which this part draws as sections. */
  readonly paneAsks: PaneAsks;
  readonly isStale: boolean;
  readonly isActive: boolean;
  readonly savedQueryKinds: readonly string[];
  readonly chosenId: string | undefined;
  readonly isFolded: boolean;
  readonly reply: PaneReply | null;
  readonly sourceName: string;
  readonly timezone: string;
  readonly now: Date;
  readonly platform: DesktopPlatform;
  readonly answers: InboxAnswers;
  readonly ref: Ref<InboxPaneAsksHandle>;
  /** Makes the ask `signalId` current, folded or unfolded. */
  readonly onChoose: (signalId: string, isFolded: boolean) => void;
  readonly onReplyChange: (reply: PaneReply | null) => void;
}): JSX.Element | null {
  const { sections, hiddenOpenCount } = paneAsks;
  const currentId = chooseCurrentAsk(sections, savedQueryKinds, chosenId);
  const isCurrentOpen = currentId !== undefined && !isFolded;
  const read = useQuery({
    ...signalQuery(client, currentId ?? ""),
    enabled: isCurrentOpen && !isStale,
  });
  // The answer a key gives goes to what the user sees: this thing, in a pane that shows.
  const canAnswer = isActive && !isStale;
  const { store, intents } = usePendingIntents(scope);
  const signal = read.data;
  const held =
    signal === undefined ? undefined : readChosenAnswer(intents, signal, thing, sourceName);
  const signalAnswers = signal === undefined ? [] : buildSignalAnswers(signal);
  const asker = sections.find((line) => line.id === currentId)?.asker;

  /** Gives the answer `actionId` of the current ask, with the words typed for it. */
  const answer = (actionId: string, text?: string): boolean => {
    const action = signal?.actions.find((each) => each.id === actionId);
    if (signal === undefined || action === undefined) return false;
    const isAccepted = answers.answer({
      thing,
      signalId: signal.id,
      action,
      text,
      sourceName,
      replyTo: text === undefined ? undefined : asker,
      reopenReply:
        text === undefined
          ? undefined
          : () => {
              onChoose(signal.id, false);
              onReplyChange({ signalId: signal.id, actionId, draft: text });
            },
    });
    // A refused answer leaves the box open with its words.
    if (isAccepted) onReplyChange(null);
    return isAccepted;
  };
  const openReply = (actionId: string): void => {
    if (currentId === undefined) return;
    onReplyChange({
      signalId: currentId,
      actionId,
      draft: scope.replyDrafts.read(currentId, actionId),
    });
  };

  useImperativeHandle(ref, () => ({
    answerCurrentAsk: () => {
      if (currentId === undefined) return false;
      if (!canAnswer) return true;
      if (isFolded) {
        onChoose(currentId, false);
        return true;
      }
      if (held !== undefined || signal === undefined) return true;
      const suggested = findSuggestedAnswer(
        signalAnswers.filter((each) => each.workflowId === null),
      );
      if (suggested === undefined) focusFirstAnswer();
      else if (suggested.style === "reply") openReply(suggested.action.id);
      else if (suggested.action.id === DONE_ACTION_ID) {
        answers.markDone({ thing, signalId: currentId, sourceName });
      } else answer(suggested.action.id);
      return true;
    },
    stepAsk: (by) => {
      const next = stepAsk(sections, currentId, by);
      if (next !== undefined) onChoose(next, false);
    },
  }));

  const bodyOf = (id: string): AskSectionBody => {
    if (id !== currentId || isFolded) return { state: "reading" };
    if (signal === undefined) {
      return read.isError
        ? {
            state: "failed",
            message: `This ask could not be read. ${readErrorMessage(read.error)}`,
          }
        : { state: "reading" };
    }
    const retryable = held?.chosen.state === "failed" || held?.chosen.state === "interrupted";
    return {
      state: "ready",
      blocks: signal.blocks,
      timezone,
      now,
      answers: {
        answers: signalAnswers,
        sourceName,
        chosen: held?.chosen,
        reply: reply?.signalId === id ? reply : null,
        platform,
        onAnswer: answer,
        onDone: () => {
          answers.markDone({ thing, signalId: id, sourceName });
        },
        onOpenReply: openReply,
        onCloseReply: () => {
          onReplyChange(null);
        },
        onDraftChange: (text) => {
          if (reply === null) return;
          scope.replyDrafts.write(id, reply.actionId, text);
          onReplyChange({ ...reply, draft: text });
        },
        onRetry: () => {
          if (held === undefined || !retryable || held.intent.kind !== "signal-answer") return;
          const { actionId, text, intentId } = held.intent;
          // The saved answer goes only once the new one was accepted: offline, it stays to be sent again.
          if (answer(actionId, text)) store.discard(intentId);
        },
        onDiscard: () => {
          if (held !== undefined) store.discard(held.intent.intentId);
        },
      },
    };
  };
  return (
    <>
      {sections.map((line) => (
        <InboxAskSection
          key={line.id}
          say={line.say.say}
          asker={line.asker}
          time={formatAge(line.createdAt, now)}
          isOpen={line.id === currentId && !isFolded}
          isCurrent={line.id === currentId}
          body={bodyOf(line.id)}
          onToggle={() => {
            onChoose(line.id, line.id === currentId && !isFolded);
          }}
        />
      ))}
      <InboxMoreAsks count={hiddenOpenCount} />
    </>
  );
}
