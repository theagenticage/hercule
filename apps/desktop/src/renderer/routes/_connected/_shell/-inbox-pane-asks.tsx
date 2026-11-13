import { useImperativeHandle, type JSX, type Ref } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  buildSignalAnswers,
  findSuggestedAnswer,
  formatAge,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import {
  chooseCurrentAsk,
  describeUnsentSignalAnswer,
  describeUnreadable,
  stepAsk,
  type PaneAsks,
} from "@hercule/client-core/inbox";
import { DONE_ACTION_ID, type Signal } from "@hercule/contract";
import type { DesktopPlatform } from "../../../../ipc/platform/desktop-platform";
import type { AccountScope } from "../../../app/account-scope";
import type { IntentFailure, PendingIntent } from "../../../app/pending-intents";
import { signalQuery } from "../../../app/queries";
import { usePendingIntents } from "../../../app/use-pending-intents";
import {
  InboxUnsentAnswers,
  type ChosenAnswer,
  type UnsentAnswer,
} from "../../../screens/inbox/inbox-answers";
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
   * instead, so the next press answers it. Does nothing while the pane draws the thing before's asks or is
   * not showing, because an answer must go to the thing the user sees.
   */
  readonly answerCurrentAsk: () => void;
  /** Makes the ask before (`-1`) or after (`1`) the current one current, and unfolds it. */
  readonly stepAsk: (by: -1 | 1) => void;
}

/**
 * The reply box that is open in the pane, and for which signal. The words in
 * it are not here: the box keeps them while the user types, and the account
 * scope's reply drafts keep them for when the box opens again.
 */
export interface PaneReply {
  readonly signalId: string;
  readonly actionId: string;
}

/** An answer to a signal that was not sent, as a pending intent holds it. */
type UnsentAnswerIntent = PendingIntent & {
  readonly kind: "signal-answer";
  readonly state: "failed";
  readonly failure: IntentFailure;
};

/** Returns the answers on the signals of the thing `entityId` that were not sent, oldest first. */
const listUnsentSignalAnswers = (
  intents: readonly PendingIntent[],
  entityId: string,
): readonly UnsentAnswerIntent[] =>
  intents.filter(
    (intent): intent is UnsentAnswerIntent =>
      intent.kind === "signal-answer" &&
      intent.entityId === entityId &&
      intent.state === "failed" &&
      intent.failure !== null,
  );

/**
 * Returns what became of the answer the user gave on `signalId`: held, being
 * sent, or unsent (shown apart, in the list of unsent answers). `undefined`
 * when no answer was given. The ask takes no other answer until this one is
 * sent or discarded.
 */
const readChosenAnswer = (
  intents: readonly PendingIntent[],
  signalId: string,
): ChosenAnswer | undefined => {
  const intent = intents.find(
    (each) => each.kind === "signal-answer" && each.signalId === signalId,
  );
  if (intent?.kind !== "signal-answer") return undefined;
  return {
    actionId: intent.actionId,
    state: intent.state === "failed" ? "unsent" : intent.state === "sending" ? "sending" : "held",
  };
};

/** Focuses the first answer of the ask that is current, so Return on an ask with no suggested answer lands on its answers. */
const focusFirstAnswer = (): void => {
  document
    .getElementById(INBOX_PANE_ID)
    ?.querySelector<HTMLElement>('[aria-current="true"] [data-answer]')
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
 * showing. `isRested` gates the read of the current ask, so holding J reads
 * no ask of the rows it passes. `ref` receives the handle the keys use.
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
  isRested,
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
  /** True once the thing has been current long enough for its asks to be read from the source. */
  readonly isRested: boolean;
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
  // The fold belongs to the ask the user folded: another ask that became current is drawn open.
  const isCurrentFolded = isFolded && currentId === chosenId;
  const isCurrentOpen = currentId !== undefined && !isCurrentFolded;
  const canRead = isActive && !isStale;
  const read = useQuery({
    ...signalQuery(client, currentId ?? ""),
    enabled: isCurrentOpen && canRead && isRested,
  });
  const { store, intents } = usePendingIntents(scope);
  const signal = read.data;
  // A signal that was answered is resolved in the cache before the list shows it gone: it offers no answers meanwhile.
  const signalAnswers =
    signal === undefined || signal.status !== "open" ? [] : buildSignalAnswers(signal);
  const askers = new Map(sections.map((line) => [line.id, line.asker]));

  // Every unsent answer of the thing is listed, whichever of its asks it was given on.
  const unsent = listUnsentSignalAnswers(intents, thing.id);
  const unsentReads = useQueries({
    queries: unsent.map((intent) => ({
      ...signalQuery(client, intent.signalId),
      enabled: askers.has(intent.signalId) && canRead,
    })),
  });

  /** Gives the answer `actionId` of `target`, with the words typed for it. */
  const giveAnswer = (target: Signal, actionId: string, text?: string): boolean => {
    const action = target.actions.find((each) => each.id === actionId);
    if (action === undefined) return false;
    const isAccepted = answers.answer({
      thing,
      signalId: target.id,
      action,
      text,
      sourceName,
      replyTo: text === undefined ? undefined : askers.get(target.id),
      reopenReply:
        text === undefined
          ? undefined
          : () => {
              scope.replyDrafts.write(target.id, actionId, text);
              onChoose(target.id, false);
              onReplyChange({ signalId: target.id, actionId });
            },
    });
    // A refused answer leaves the box open with its words.
    if (isAccepted) onReplyChange(null);
    return isAccepted;
  };
  const answer = (actionId: string, text?: string): void => {
    if (signal !== undefined) giveAnswer(signal, actionId, text);
  };
  const openReply = (actionId: string): void => {
    if (currentId !== undefined) onReplyChange({ signalId: currentId, actionId });
  };

  useImperativeHandle(ref, () => ({
    answerCurrentAsk: () => {
      // The answer a key gives goes to what the user sees: this thing, in a pane that shows.
      if (currentId === undefined || !canRead) return;
      if (isCurrentFolded) {
        onChoose(currentId, false);
        return;
      }
      if (signal === undefined || readChosenAnswer(intents, currentId) !== undefined) return;
      const suggested = findSuggestedAnswer(
        signalAnswers.filter((each) => each.workflowId === null),
      );
      if (suggested === undefined) focusFirstAnswer();
      else if (suggested.style === "reply") openReply(suggested.action.id);
      else if (suggested.action.id === DONE_ACTION_ID) {
        answers.markDone({ thing, signalId: currentId, sourceName });
      } else answer(suggested.action.id);
    },
    stepAsk: (by) => {
      const next = stepAsk(sections, currentId, by);
      if (next !== undefined) onChoose(next, false);
    },
  }));

  const bodyOf = (id: string): AskSectionBody => {
    if (id !== currentId || isCurrentFolded) return { state: "reading" };
    if (signal === undefined) {
      return read.isError
        ? {
            state: "failed",
            message: describeUnreadable("ask", readErrorMessage(read.error)),
          }
        : { state: "reading" };
    }
    return {
      state: "ready",
      blocks: signal.blocks,
      timezone,
      now,
      answers: {
        answers: signalAnswers,
        sourceName,
        chosen: readChosenAnswer(intents, id),
        // The box takes the words only when it opens: it keeps them while the user types.
        reply:
          reply?.signalId === id
            ? { actionId: reply.actionId, draft: scope.replyDrafts.read(id, reply.actionId) }
            : null,
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
          if (reply !== null) scope.replyDrafts.write(id, reply.actionId, text);
        },
      },
    };
  };
  const unsentAnswers: UnsentAnswer[] = unsent.map((intent, index) => {
    const unsentSignal = unsentReads[index]?.data;
    const label =
      unsentSignal?.actions.find((action) => action.id === intent.actionId)?.label ?? "Answer";
    return {
      id: intent.intentId,
      sentence: describeUnsentSignalAnswer(
        { label, identifier: thing.identifier, sourceName },
        intent.failure,
      ),
      isInterrupted:
        intent.failure.reason === "interrupted" ||
        intent.failure.reason === "interrupted-while-sending",
      words: intent.text,
      // Sending again goes to a question that is still open here; any other is out of reach.
      canSendAgain: unsentSignal !== undefined && askers.has(intent.signalId),
      onSendAgain: () => {
        // The saved answer goes only once the new one was accepted: offline, it stays to be sent again.
        if (unsentSignal !== undefined && giveAnswer(unsentSignal, intent.actionId, intent.text)) {
          store.discard(intent.intentId);
        }
      },
      onDiscard: () => {
        store.discard(intent.intentId);
      },
    };
  });
  return (
    <>
      {sections.map((line) => (
        <InboxAskSection
          key={line.id}
          say={line.say.say}
          asker={line.asker}
          time={formatAge(line.createdAt, now)}
          isOpen={line.id === currentId && !isCurrentFolded}
          isCurrent={line.id === currentId}
          body={bodyOf(line.id)}
          onToggle={() => {
            onChoose(line.id, line.id === currentId && !isCurrentFolded);
          }}
        />
      ))}
      <InboxMoreAsks count={hiddenOpenCount} />
      <InboxUnsentAnswers answers={unsentAnswers} />
    </>
  );
}
