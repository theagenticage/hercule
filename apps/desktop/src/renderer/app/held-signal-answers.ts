/**
 * The Inbox's held answers: the answers to a signal that act on its source (a
 * plugin's action, perhaps with a typed reply). Such an answer is held for a
 * few seconds with Undo, then sent, and one that was not sent stays to be sent
 * again or discarded. This module owns that whole life, and the words typed
 * into reply boxes.
 *
 * It is built on the pending intents (`pending-intents.ts`) and lives in the
 * account scope, so an answer held when the user leaves the Inbox still sends,
 * fails or is cancelled correctly. Each held answer has one watcher, with one
 * switch over what the intent reports, which drives all three places that
 * show it:
 *
 * - the undo line: its words while the answer waits, while it waits on the
 *   user holding the line, and once it is sent;
 * - the row of the answered thing in the Inbox list: confirmed, put back or
 *   failed;
 * - the reply box: it opens again with its words when Undo takes a reply back.
 *
 * Those three are drawn by a presentation the Inbox attaches while it is
 * mounted (`attach`). With none attached the answer still completes and
 * nothing is drawn.
 */
import {
  ANSWER_CANCELLED,
  ANSWER_WAITS_NOTE,
  REFUSED_OFFLINE,
  describeAnswerSending,
  describeAnswerSent,
  describeAnswerTooLate,
  describeHeldSignalAnswer,
  describeUnsentSignalAnswer,
} from "@hercule/client-core/inbox";
import type { CardMover } from "./card-mover";
import type { PendingIntent, PendingIntents } from "./pending-intents";
import type { Gesture } from "./undo-stack";

/** One answer the user gives on an ask of a thing. */
export interface HeldSignalAnswer {
  /** The thing the signal is about, as the Inbox list knows it. */
  readonly thing: { readonly ref: string; readonly id: string; readonly identifier: string };
  readonly signalId: string;
  readonly actionId: string;
  /** What the action is called, such as "Approve". */
  readonly label: string;
  /** The words typed in the reply box, for an action with a field. */
  readonly text?: string | undefined;
  /** The name of the source, such as "GitHub". */
  readonly sourceName: string;
  /** The asker's name, which a reply's line names. */
  readonly replyTo?: string | undefined;
  /** Opens the reply box again, in the pane that shows the thing, when Undo takes a held reply back. */
  readonly reopenReply?: (() => void) | undefined;
}

/** What the screen offers to send an unsent answer again: where its thing is drawn, as for `HeldSignalAnswer`. */
export type SendAgainContext = Pick<HeldSignalAnswer, "thing" | "replyTo" | "reopenReply">;

/** What became of the answer the user gave on a signal. */
export interface ChosenSignalAnswer {
  readonly actionId: string;
  /** `unsent` is an answer that failed, or was left by a closed app, and waits for Send again or Discard. */
  readonly state: "held" | "sending" | "unsent";
}

/** An answer that was not sent, with the words that say why. */
export interface UnsentSignalAnswer {
  /** The id to give `sendAgain` and `discard`. */
  readonly id: string;
  readonly signalId: string;
  readonly actionId: string;
  /** Says what happened and whether the source may have the answer. */
  readonly sentence: string;
  /** True when the app closed, which is quieter than a refusal. */
  readonly isInterrupted: boolean;
  /** The words typed in the reply box, when the answer had a reply. */
  readonly words: string | undefined;
}

/** The row of an answered thing in the Inbox list. */
export interface AnsweredRow {
  /** The source has the answer. */
  readonly confirm: () => void;
  /** The answer was taken back: the row returns to its place. */
  readonly putBack: () => void;
  /** The answer was not sent: the row returns to its place. */
  readonly fail: () => void;
}

/** The undo line, as a held answer uses it. */
export interface AnswerLine {
  /**
   * Puts `gesture` on the undo stack and says `text` on the line with Undo.
   * Returns a function that takes the gesture off the stack again.
   */
  readonly sayWithUndo: (text: string, gesture: Gesture<CardMover>) => () => void;
  /**
   * Changes the line, only while it shows `gesture`. See `UndoLineControls.restate`.
   */
  readonly restate: (
    gesture: Gesture<CardMover>,
    update: { readonly text: string; readonly offersUndo: boolean; readonly isWaiting: boolean },
  ) => void;
}

/** What the Inbox draws held answers with while it is mounted. */
export interface AnswerPresentation {
  readonly line: AnswerLine;
  /** Moves the row of the thing `ref` on, as an answer does, and returns what to do with that row later. */
  readonly takeRow: (ref: string) => AnsweredRow;
  /** Tells the screen the list changed, so the focus follows. */
  readonly moved: () => void;
  /** Shows the thing `ref` alone in the pane. */
  readonly showThing: (ref: string) => void;
  /** Says `text` on the undo line, with no Undo. */
  readonly say: (text: string) => void;
  readonly isOffline: () => boolean;
}

/** The held answers at one moment. */
export interface HeldAnswersView {
  /** Returns what became of the answer given on `signalId`, or `undefined` when none was given. */
  readonly readChosen: (signalId: string) => ChosenSignalAnswer | undefined;
  /** Returns the answers on the signals of the thing `entityId` that were not sent, oldest first. */
  readonly listUnsent: (entityId: string) => readonly UnsentSignalAnswer[];
}

export interface HeldSignalAnswers {
  /**
   * Holds the answer for its window with Undo on the undo line, then sends
   * it. Returns false, with the reason on the undo line, when it was refused
   * because the app is offline and nothing was held.
   */
  readonly hold: (answer: HeldSignalAnswer) => boolean;
  /**
   * Holds the unsent answer `id` again, as `hold` does, and forgets the old
   * one once the new one is held. Returns false, leaving the unsent answer
   * in place, when it is unknown or the app is offline.
   */
  readonly sendAgain: (id: string, context: SendAgainContext) => boolean;
  /** Removes the unsent answer `id`. */
  readonly discard: (id: string) => void;
  /** Returns the words typed in the reply box of the answer `actionId` on `signalId`, or "" for none. */
  readonly readDraft: (signalId: string, actionId: string) => string;
  /** Keeps `text` as that reply's draft. Empty text removes it. */
  readonly writeDraft: (signalId: string, actionId: string, text: string) => void;
  /**
   * Makes `presentation` draw the held answers until the returned function
   * is called. An answer held under an earlier presentation is not drawn by a
   * later one: the screen that showed it is gone.
   */
  readonly attach: (presentation: AnswerPresentation) => () => void;
  /** Calls `listener` after every change to the answers, until the returned function is called. For React's `useSyncExternalStore`. */
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Returns the answers as they are now. A new view comes back after every
   * change and the same one until then, as `useSyncExternalStore` requires,
   * so a component that reads through it redraws when an answer changes.
   */
  readonly getSnapshot: () => HeldAnswersView;
  /** Drops every draft and detaches the presentation. */
  readonly clear: () => void;
}

type UnsentIntent = PendingIntent & {
  readonly kind: "signal-answer";
  readonly state: "failed";
  readonly failure: NonNullable<PendingIntent["failure"]>;
};

const isUnsent = (intent: PendingIntent): intent is UnsentIntent =>
  intent.kind === "signal-answer" && intent.state === "failed" && intent.failure !== null;

/** Creates the held answers over `store`, which holds their intents. */
export const createHeldSignalAnswers = (store: PendingIntents): HeldSignalAnswers => {
  let attached: AnswerPresentation | undefined;
  const drafts = new Map<string, string>();
  // JSON keeps two different pairs from sharing a key, whatever characters the ids hold.
  const buildDraftKey = (signalId: string, actionId: string): string =>
    JSON.stringify([signalId, actionId]);
  const writeDraft = (signalId: string, actionId: string, text: string): void => {
    if (text === "") drafts.delete(buildDraftKey(signalId, actionId));
    else drafts.set(buildDraftKey(signalId, actionId), text);
  };

  const start = (answer: HeldSignalAnswer): void => {
    const { thing, signalId, actionId, label, text, sourceName, replyTo, reopenReply } = answer;
    // What this answer draws on. A screen that replaced it later draws nothing for this answer.
    const shown = attached;
    const row = shown?.takeRow(thing.ref);
    shown?.moved();
    const words = describeHeldSignalAnswer({
      label,
      identifier: thing.identifier,
      sourceName,
      ...(replyTo === undefined ? {} : { replyTo }),
    });
    const waitsLine = `${words.text}. ${words.note}.`;
    const overdueLine = `${words.text}. ${ANSWER_WAITS_NOTE}.`;
    const intentId = store.hold({
      kind: "signal-answer",
      signalId,
      entityId: thing.id,
      actionId,
      ...(text === undefined ? {} : { text }),
      sourceName,
      label,
      identifier: thing.identifier,
    });

    let isSending = false;
    const gesture: Gesture<CardMover> = {
      words: words.text,
      // The line is held while the user is on it: the answer waits past its window.
      hold: (isHeld) => {
        store.setHeld(intentId, isHeld);
      },
      undo: () => {
        if (store.undo(intentId)) return Promise.resolve({ text: ANSWER_CANCELLED });
        // While sending, delivery is not confirmed: say so and leave the reply box alone.
        return Promise.resolve({
          text: isSending ? describeAnswerSending(sourceName) : describeAnswerTooLate(sourceName),
        });
      },
    };
    const isDrawn = (): boolean => shown !== undefined && attached === shown;
    const takeOffStack = shown?.line.sayWithUndo(waitsLine, gesture);
    shown?.line.restate(gesture, { text: waitsLine, offersUndo: true, isWaiting: true });

    const stopWatching = store.watch(intentId, (progress) => {
      switch (progress) {
        case "overdue":
          if (isDrawn()) {
            shown?.line.restate(gesture, { text: overdueLine, offersUndo: true, isWaiting: true });
          }
          return;
        case "sending":
          isSending = true;
          return;
        case "sent":
          isSending = false;
          // The gesture stays on the undo stack, so Undo says it is too late.
          if (isDrawn()) {
            shown?.line.restate(gesture, {
              text: describeAnswerSent(sourceName),
              offersUndo: false,
              isWaiting: false,
            });
            row?.confirm();
          }
          return;
        case "failed":
          stopWatching();
          takeOffStack?.();
          if (isDrawn()) {
            row?.fail();
            shown?.moved();
          }
          return;
        case "cancelled":
          takeOffStack?.();
          if (text !== undefined) writeDraft(signalId, actionId, text);
          if (!isDrawn()) return;
          row?.putBack();
          if (reopenReply === undefined) {
            shown?.moved();
            return;
          }
          // The box takes the focus, so the list must not ask for it.
          shown?.showThing(thing.ref);
          reopenReply();
      }
    });
  };

  const findUnsent = (id: string): UnsentIntent | undefined =>
    store.getSnapshot().find((intent): intent is UnsentIntent => {
      return intent.intentId === id && isUnsent(intent);
    });

  const buildView = (intents: readonly PendingIntent[]): HeldAnswersView => ({
    readChosen: (signalId) => {
      const intent = intents.find(
        (each) => each.kind === "signal-answer" && each.signalId === signalId,
      );
      if (intent?.kind !== "signal-answer") return undefined;
      return {
        actionId: intent.actionId,
        state:
          intent.state === "failed" ? "unsent" : intent.state === "sending" ? "sending" : "held",
      };
    },
    listUnsent: (entityId) =>
      intents
        .filter(isUnsent)
        .filter((intent) => intent.entityId === entityId)
        .map((intent) => ({
          id: intent.intentId,
          signalId: intent.signalId,
          actionId: intent.actionId,
          sentence: describeUnsentSignalAnswer(
            { label: intent.label, identifier: intent.identifier, sourceName: intent.sourceName },
            intent.failure,
          ),
          isInterrupted:
            intent.failure.reason === "interrupted" ||
            intent.failure.reason === "interrupted-while-sending",
          words: intent.text,
        })),
  });
  let view = buildView(store.getSnapshot());
  let viewOf = store.getSnapshot();
  const getSnapshot = (): HeldAnswersView => {
    if (viewOf !== store.getSnapshot()) {
      viewOf = store.getSnapshot();
      view = buildView(viewOf);
    }
    return view;
  };

  return {
    hold: (answer) => {
      if (attached?.isOffline() === true) {
        attached.say(REFUSED_OFFLINE);
        return false;
      }
      start(answer);
      return true;
    },
    sendAgain: (id, context) => {
      const intent = findUnsent(id);
      if (intent === undefined) return false;
      if (attached?.isOffline() === true) {
        attached.say(REFUSED_OFFLINE);
        return false;
      }
      start({
        thing: { ...context.thing, id: intent.entityId, identifier: intent.identifier },
        signalId: intent.signalId,
        actionId: intent.actionId,
        label: intent.label,
        text: intent.text,
        sourceName: intent.sourceName,
        replyTo: context.replyTo,
        reopenReply: context.reopenReply,
      });
      store.discard(id);
      return true;
    },
    discard: (id) => {
      store.discard(id);
    },
    readDraft: (signalId, actionId) => drafts.get(buildDraftKey(signalId, actionId)) ?? "",
    writeDraft,
    attach: (presentation) => {
      attached = presentation;
      return () => {
        if (attached === presentation) attached = undefined;
      };
    },
    subscribe: store.subscribe,
    getSnapshot,
    clear: () => {
      drafts.clear();
      attached = undefined;
    },
  };
};
