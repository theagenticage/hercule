import {
  useImperativeHandle,
  useRef,
  useSyncExternalStore,
  type ActionDispatch,
  type JSX,
  type Ref,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  buildSignalAnswers,
  findSuggestedAnswer,
  formatAge,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import {
  decidePaneAsk,
  decideReturnPress,
  describeUnreadable,
  type PaneAskChoice,
  type PaneAskMove,
  type PaneAsks,
} from "@hercule/client-core/inbox";
import { DONE_ACTION_ID, type Signal } from "@hercule/contract";
import type { DesktopPlatform } from "../../../../ipc/platform/desktop-platform";
import type { AccountScope } from "../../../app/account-scope";
import { signalQuery } from "../../../app/queries";
import { InboxUnsentAnswers, type UnsentAnswer } from "../../../screens/inbox/inbox-answers";
import {
  InboxAskSection,
  InboxMoreAsks,
  type AskSectionBody,
  type InboxAskSectionHandle,
} from "../../../screens/inbox/inbox-ask-section";
import type { InboxAnswers } from "./-inbox-answers";
import type { ReadGate } from "./-use-read-gate";
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
 * Renders the sections of the open asks of a thing and the line that counts
 * the asks it has no section for.
 *
 * `choice` holds what the user decided in the pane and `dispatch` takes their
 * moves (`decidePaneAsk` says which ask is current and open). Only an open
 * current ask is read in full (`signal.read`, for its blocks and answers),
 * and only once `gate` is `rested`. Return does not wait for that: it answers
 * as soon as the ask has been read, and while it has not, it starts the read
 * at once. `isShowingRecord` keeps an answer from going to the thing before.
 * `savedQueryKinds` are the signal kinds of the saved query the user is on.
 * `ref` receives the handle the keys use.
 *
 * Orchestrating: it owns the read of the current ask, and what becomes of the
 * answers given on it.
 */
export function InboxPaneAsks({
  client,
  scope,
  thing,
  paneAsks,
  gate,
  isShowingRecord,
  savedQueryKinds,
  choice,
  sourceName,
  timezone,
  now,
  platform,
  answers,
  ref,
  dispatch,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly thing: InboxListRow;
  /** The asks of the thing's record, which this part draws as sections. */
  readonly paneAsks: PaneAsks;
  readonly gate: ReadGate;
  /** True while the pane shows and the record drawn is this thing's, not the thing before's. */
  readonly isShowingRecord: boolean;
  readonly savedQueryKinds: readonly string[];
  readonly choice: PaneAskChoice;
  readonly sourceName: string;
  readonly timezone: string;
  readonly now: Date;
  readonly platform: DesktopPlatform;
  readonly answers: InboxAnswers;
  readonly ref: Ref<InboxPaneAsksHandle>;
  readonly dispatch: ActionDispatch<[move: PaneAskMove]>;
}): JSX.Element | null {
  const { sections, hiddenOpenCount } = paneAsks;
  const ask = decidePaneAsk(choice, thing.id, sections, savedQueryKinds);
  const { currentId } = ask;
  const target = { thingId: thing.id, sections, savedQueryKinds };
  const queryClient = useQueryClient();
  const read = useQuery({
    ...signalQuery(client, currentId ?? ""),
    enabled: ask.isOpen && gate === "rested",
  });
  const held = scope.heldSignalAnswers;
  const heldNow = useSyncExternalStore(held.subscribe, held.getSnapshot);
  const currentSection = useRef<InboxAskSectionHandle>(null);
  const signal = read.data;
  // A signal that was answered is resolved in the cache before the list shows it gone: it offers no answers meanwhile.
  const signalAnswers =
    signal === undefined || signal.status !== "open" ? [] : buildSignalAnswers(signal);
  const askers = new Map(sections.map((line) => [line.id, line.asker]));

  /** Returns what opens the reply box of `actionId` again for a reply, which only a reply has. */
  const buildReopenReply = (signalId: string, actionId: string, text: string | undefined) =>
    text === undefined
      ? undefined
      : () => {
          dispatch({ kind: "reopen-reply", thingId: thing.id, signalId, actionId });
        };
  /** Gives the answer `actionId` of `target`, with the words typed for it. */
  const giveAnswer = (answered: Signal, actionId: string, text?: string): boolean => {
    const action = answered.actions.find((each) => each.id === actionId);
    if (action === undefined) return false;
    const isAccepted = answers.answer({
      thing,
      signalId: answered.id,
      action,
      text,
      sourceName,
      replyTo: text === undefined ? undefined : askers.get(answered.id),
      reopenReply: buildReopenReply(answered.id, actionId, text),
    });
    // A refused answer leaves the box open with its words.
    if (isAccepted) dispatch({ kind: "close-reply" });
    return isAccepted;
  };
  const answer = (actionId: string, text?: string): void => {
    if (signal !== undefined) giveAnswer(signal, actionId, text);
  };
  const openReply = (actionId: string): void => {
    dispatch({ kind: "open-reply", actionId, ...target });
  };

  useImperativeHandle(ref, () => ({
    answerCurrentAsk: () => {
      if (currentId === undefined) return;
      // The gate holds back reads while the user walks, but Return is a request for this ask: read it now.
      // A cached read is returned as it is, and nothing else happens until the next press.
      if (ask.isOpen && isShowingRecord && signal === undefined) {
        void queryClient.prefetchQuery(signalQuery(client, currentId));
      }
      const suggested = findSuggestedAnswer(
        signalAnswers.filter((each) => each.workflowId === null),
      );
      const press = decideReturnPress(ask, {
        isShowing: isShowingRecord,
        canAnswer: signal !== undefined && heldNow.readChosen(currentId) === undefined,
        suggested,
      });
      if (press === "unfold") dispatch({ kind: "unfold", ...target });
      else if (press === "focus-answers") currentSection.current?.focusFirstAnswer();
      else if (suggested === undefined) return;
      else if (press === "open-reply") openReply(suggested.action.id);
      else if (press === "answer") {
        if (suggested.action.id === DONE_ACTION_ID) {
          answers.markDone({ thing, signalId: currentId, sourceName });
        } else answer(suggested.action.id);
      }
    },
    stepAsk: (by) => {
      dispatch({ kind: "step", by, ...target });
    },
  }));

  const bodyOf = (id: string): AskSectionBody => {
    if (id !== currentId || !ask.isOpen) return { state: "reading" };
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
        chosen: heldNow.readChosen(id),
        // The box takes the words only when it opens: it keeps them while the user types.
        reply:
          ask.reply === null
            ? null
            : { actionId: ask.reply.actionId, draft: held.readDraft(id, ask.reply.actionId) },
        platform,
        onAnswer: answer,
        onDone: () => {
          answers.markDone({ thing, signalId: id, sourceName });
        },
        onOpenReply: openReply,
        onCloseReply: () => {
          dispatch({ kind: "close-reply" });
        },
        onDraftChange: (text) => {
          if (ask.reply !== null) held.writeDraft(id, ask.reply.actionId, text);
        },
      },
    };
  };
  const unsentAnswers: UnsentAnswer[] = heldNow.listUnsent(thing.id).map((unsent) => ({
    ...unsent,
    // Sending again goes to a question that is still open here; any other is out of reach.
    canSendAgain: askers.has(unsent.signalId),
    onSendAgain: () => {
      // The saved answer is forgotten only once the new one was held: offline, it stays to be sent again.
      const isAccepted = held.sendAgain(unsent.id, {
        thing,
        replyTo: unsent.words === undefined ? undefined : askers.get(unsent.signalId),
        reopenReply: buildReopenReply(unsent.signalId, unsent.actionId, unsent.words),
      });
      if (isAccepted) dispatch({ kind: "close-reply" });
    },
    onDiscard: () => {
      held.discard(unsent.id);
    },
  }));
  return (
    <>
      {sections.map((line) => (
        <InboxAskSection
          key={line.id}
          say={line.say.say}
          asker={line.asker}
          time={formatAge(line.createdAt, now)}
          isOpen={line.id === currentId && ask.isOpen}
          isCurrent={line.id === currentId}
          body={bodyOf(line.id)}
          ref={line.id === currentId ? currentSection : undefined}
          onToggle={() => {
            dispatch({ kind: "toggle", signalId: line.id, ...target });
          }}
        />
      ))}
      <InboxMoreAsks count={hiddenOpenCount} />
      <InboxUnsentAnswers answers={unsentAnswers} />
    </>
  );
}
