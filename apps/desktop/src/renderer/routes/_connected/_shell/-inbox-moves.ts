/**
 * Taking on, handing off and dismissing the Inbox's cards, and the undo line at
 * the foot of the screen. It follows the Work board's moves (`-card-moves.ts`):
 *
 * - Moves are sent one at a time, in the order the user made them. The
 *   reversal of a move takes its place in the same line when the user presses
 *   Undo, and waits there for the move's own answer. A move the user makes
 *   after Undo therefore reaches the controller after the reversal.
 * - A dismissal shows at once: the card leaves the page and the cards after it
 *   close up, before the controller answers. The screen shows the Inbox in the
 *   query cache with every edit not yet answered applied over it
 *   (`reapplyInboxEdits`), so a read that lands meanwhile cannot put the card
 *   back. A Take shows when the controller answers, with the Task it made.
 * - When the controller answers, the edit is written into the cached Inbox and
 *   leaves the pending list in the same draw. A move it refuses leaves the
 *   pending list alone, so the card goes back, and the undo line says why.
 * - Each move the user makes is one gesture on the shared undo stack. The
 *   gesture takes its place when the user acts, before the controller answers,
 *   and its undo waits for the answer itself. The undo of a Link or Unlink is
 *   a Link or Unlink in the other direction, made when Undo is pressed: it
 *   shows at once and is reconciled with the controller's answer like any
 *   other, so it never replays what rode on what when the first move was
 *   planned. What rides on what is held by the visit, not here: this file
 *   starts, settles and refuses the gestures in it (`advanceLinkGesture`) and
 *   plans an Unlink over the place the visit holds. A move that fails, or a Take that
 *   makes no Task, takes its gesture off again. A gesture outlives the screen
 *   that made it, so it is undone through the screen that is open when Undo is
 *   pressed (`CardMover`).
 * - A hand-off shows at once too: a `hand-off` edit puts the workflow first in
 *   the card's live workflows, so the colleague takes the card's place in the
 *   wait slot and the chain plays, before the controller answers. The answer
 *   brings the Task's id, which goes into the Inbox as a `set-task` edit. A
 *   refusal takes the edit off again, backwards, and says why. Undo asks the
 *   controller whether the hand-off can be taken back, and plays it backwards
 *   (a `take-back-hand-off` edit) only when it was. A thing the Inbox does not
 *   list (a linked peer in the open sheet) is handed the same way, with
 *   nothing to draw: the undo line reports.
 * - A move waits in the line, and the user may sign out while it waits. The
 *   client sends the token it holds when a call is made, so a move or a
 *   reversal that started after sign-out would go out as the next account, and
 *   its late answer would be written into the next account's cache. So each
 *   one asks `isCurrent()` of the account scope when it starts and after every
 *   wait, before it calls the controller, writes the cache or says anything.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import {
  describeDismissal,
  describeHandOffRefusal,
  describeHandOffUndo,
  describeLinkRemaining,
  describeLinkRemoved,
  isHandOffTakenBack,
  nameCard,
  planLink,
  planUnlink,
  reapplyInboxEdits,
  type EntityLinkMove,
  type InboxEdit,
  type RidingMove,
} from "@hercule/client-core/inbox";
import type {
  EntityUnlinkResult,
  Inbox,
  InboxCard,
  LiveWorkflow,
  WorkflowOffer,
} from "@hercule/contract";
import type { AccountScope } from "../../../app/account-scope";
import {
  buildCachedCardMover,
  buildCachedEndedCardMover,
  buildCachedInboxWriter,
  type CardMover,
} from "../../../app/card-mover";
import type { SpringName } from "../../../app/motion";
import type { Gesture, UndoAnswer } from "../../../app/undo-stack";
import { undoAddedTask } from "../../../app/undo-added-task";
import { useUndoLine, type UndoLineState } from "../../../app/use-undo-line";
import { createHandOffChains } from "../../../screens/inbox/hand-off-motion";
import { findCardElement } from "../../../screens/inbox/inbox-page-dom";
import type { HandOffTarget } from "../../../screens/inbox/use-hand-off";
import type { VisitHistoryHandle } from "../../../screens/inbox/use-inbox-visit";
import {
  comeBackFromAside,
  copyCardToStepAside,
  flipInboxPage,
  riseMonogram,
  stepAside,
} from "../../../screens/inbox/inbox-motion";

/** The key every Inbox move runs under, so one move waits for the one before it. */
const INBOX_MOVES_KEY = ["inbox-moves"];

/** A change to the Inbox that the controller has not answered yet. */
interface PendingEdit {
  readonly id: number;
  readonly edit: InboxEdit;
}

const NO_EDITS: readonly PendingEdit[] = [];

const NOTHING_TO_PUT_BACK = "That move changed nothing, so there is nothing to put back.";

const SIGNED_OUT = "You signed out before this was sent.";

/** Removes the full stops at the end of an error's words, so a sentence can go on after them. */
const readReason = (error: unknown): string => readErrorMessage(error).replace(/\.+$/, "");

/** Which way a change to a link goes. */
type LinkDirection = "link" | "unlink";

/** Whether `move` may be sent: it resolves to false when the move it reverses changed nothing. */
type MoveIsWanted = Promise<boolean>;

/** What the controller answered to a Link or Unlink, in one shape. */
interface LinkAnswer {
  /** False when a Link failed, or an Unlink removed nothing because the user had made no link. */
  readonly didChange: boolean;
  /** The firmest claim that still joins the two after an Unlink. */
  readonly remaining: EntityUnlinkResult["remaining"];
}

/** Returns the direction that reverses `direction`. */
const reverseDirection = (direction: LinkDirection): LinkDirection =>
  direction === "link" ? "unlink" : "link";

/** What the undo line says about a Link or Unlink: the gesture, and what a refusal says. */
const LINK_WORDS = {
  link: {
    gesture: (words: string) => `Linked ${words}`,
    done: (words: string) => `Linked ${words}.`,
    failed: (words: string, reason: string) => `${words} were not linked: ${reason}. Try again.`,
  },
  unlink: {
    gesture: (words: string) => `Removed the link between ${words}`,
    failed: (words: string, reason: string) =>
      `The link between ${words} was not removed: ${reason}. Try again.`,
  },
} as const;

/** What `useInboxMoves` returns. */
export interface InboxMoves {
  /** The Inbox with the pending edits applied, or `undefined` until the first read ends. */
  readonly inbox: Inbox | undefined;
  /** Whether a move the user made is applied over the read and not yet answered by the controller. */
  readonly hasPendingEdits: boolean;
  /**
   * Takes the card on as a Task. When the controller answers, the card shows
   * the user's monogram where its wait was, and the undo line offers Undo. A
   * failure says why.
   */
  readonly take: (card: InboxCard) => void;
  /**
   * Hands `target` to the workflow of `offer`. `connectionId` is the account
   * the user chose, or `undefined` to leave the choice to the controller,
   * which refuses an account that can no longer act. The colleague has the
   * card at once and the chain plays. When the controller answers, the card
   * holds the Task it made or continued, and the undo line offers Undo. A
   * refusal takes the colleague away again and says why. A thing whose
   * hand-off has not been answered yet is not handed again.
   */
  readonly handOff: (
    target: HandOffTarget,
    offer: WorkflowOffer,
    connectionId: string | undefined,
  ) => void;
  /**
   * Dismisses the card. It leaves the page at once: a copy steps aside (unless
   * `stepsAside` is false, as for a card dropped on the rail, which leaves from
   * the rail), and the cards after it close up on `hand`. A failure puts it
   * back on `travel` and says why. `riders` are the cards drawn riding on it:
   * they stand alone from then on, and the undo line says so.
   */
  readonly dismiss: (card: InboxCard, riders: readonly InboxCard[], stepsAside?: boolean) => void;
  /**
   * Links two things as the user's own claim. The undo line says what was
   * linked and offers Undo, which removes the link again. A failure says why.
   */
  readonly link: (move: EntityLinkMove) => void;
  /**
   * Removes the user's own link between two things. The undo line offers Undo,
   * which links them again, and says when a link of a source stays. A failure
   * says why.
   */
  readonly unlink: (move: EntityLinkMove) => void;
  /** Reverses the newest gesture on the undo stack, and says what happened. */
  readonly undoLastMove: () => void;
  /** What the undo line shows. */
  readonly line: UndoLineState;
  /** Shows `text` on the undo line with no Undo. */
  readonly sayWithoutUndo: (text: string) => void;
}

/** Sends a Link or Unlink of the pair in `move` to the controller and returns its answer. */
const sendLinkChange = async (
  client: HerculeClient,
  move: EntityLinkMove,
  direction: LinkDirection,
): Promise<LinkAnswer> => {
  const payload = { fromRef: move.fromRef, toRef: move.toRef };
  if (direction === "link") {
    await client.externalEntity.link({ payload });
    return { didChange: true, remaining: undefined };
  }
  const { removed, remaining } = await client.externalEntity.unlink({ payload });
  return { didChange: removed, remaining };
};

/**
 * Moves cards of the Inbox for `client` and returns the Inbox to draw.
 * `serverInbox` is the Inbox as the last read gave it, and `scrollRef` is the
 * element that scrolls the page, which the motion of a move measures. `visit`
 * is the history of the visit, where the Links and Unlinks the user makes are
 * followed. Undo waits while `isCarrying()` is true. `scope` is the signed-in
 * user's: it holds the undo stack, and says whether that user is still the one
 * signed in.
 */
export const useInboxMoves = ({
  client,
  scope,
  serverInbox,
  visit,
  scrollRef,
  isCarrying,
  openTask,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly serverInbox: Inbox | undefined;
  readonly visit: VisitHistoryHandle;
  readonly scrollRef: RefObject<HTMLElement | null>;
  /** Returns whether a card is in the hand of a carry: Undo waits while one is. */
  readonly isCarrying: () => boolean;
  /** Opens the Task `taskId` on Work. */
  readonly openTask: (taskId: string) => void;
}): InboxMoves => {
  const queryClient = useQueryClient();
  const { undoStack, isCurrent } = scope;
  /** Throws when the user who made the move has signed out, so nothing goes to the controller as the next account. */
  const requireSignedIn = (): void => {
    if (!isCurrent()) throw new Error(SIGNED_OUT);
  };
  const pendingRef = useRef<readonly PendingEdit[]>(NO_EDITS);
  const [pendingEdits, setPendingEdits] = useState(NO_EDITS);
  const changePending = (change: (edits: readonly PendingEdit[]) => readonly PendingEdit[]) => {
    pendingRef.current = change(pendingRef.current);
    setPendingEdits(pendingRef.current);
  };
  const nextId = useRef(1);
  // The cards whose hand-off the controller has not answered, so a second click waits for the first.
  const handingOff = useRef(new Set<string>());
  // The hand-off chains playing on this screen: they stop with it.
  const [handOffChains] = useState(createHandOffChains);
  useEffect(() => handOffChains.stopAll, [handOffChains]);
  const writeCachedInbox = buildCachedInboxWriter(queryClient);

  // The same Inbox object until a read or an edit changes it, because the screen compares it with the last.
  const inbox = useMemo(
    () =>
      serverInbox === undefined
        ? undefined
        : reapplyInboxEdits(
            serverInbox,
            pendingEdits.map((each) => each.edit),
          ),
    [serverInbox, pendingEdits],
  );
  // What a Link or Unlink is planned over. It is read when the move is made, which for an Undo is long after
  // the render that made the gesture.
  const newestInbox = useRef(inbox);

  /**
   * Makes `change` and glides every part of the page that moves because of it
   * on `spring`. The change is committed at once, because the page is
   * measured again right after it. With no page on screen, only makes it.
   * Returns the parts that are new.
   */
  const playPageChange = (spring: SpringName, change: () => void): readonly HTMLElement[] => {
    const scroller = scrollRef.current;
    if (scroller === null) {
      change();
      return [];
    }
    return flipInboxPage(scroller, spring, () => {
      flushSync(change);
    }).born;
  };

  /**
   * Shows `edit` on the page at once, gliding on `spring`, and lists it as
   * pending. `ridingMove` is what a Link or Unlink does to what rides on what:
   * the visit starts a gesture for it, which waits for the controller's answer
   * with the edit. Returns the edit and the parts that are new.
   */
  const showEdit = (edit: InboxEdit, spring: SpringName, ridingMove?: RidingMove) => {
    const shown: PendingEdit = { id: nextId.current++, edit };
    const born = playPageChange(spring, () => {
      changePending((edits) => [...edits, shown]);
      if (ridingMove !== undefined) {
        visit.advanceLinkGesture({ _tag: "start", gesture: shown.id, move: ridingMove });
      }
    });
    return { shown, born };
  };

  /**
   * Shows `edit`, a hand-off or the taking back of one, on the page at once,
   * with the hand-off chain playing on the card forwards or backwards
   * (`direction`), and lists it as pending. Returns the pending edit. The
   * card's neighbours do not move, so the page does not glide.
   */
  const showHandOffEdit = (
    edit: Extract<InboxEdit, { readonly kind: "hand-off" | "take-back-hand-off" }>,
    direction: "forwards" | "backwards",
  ): PendingEdit => {
    const shown: PendingEdit = { id: nextId.current++, edit };
    handOffChains.play(scrollRef.current, edit.id, direction, () => {
      changePending((edits) => [...edits, shown]);
    });
    return shown;
  };

  /**
   * Takes `shown`, a hand-off edit on the card `cardId` that the controller
   * refused, off the page again, with the hand-off chain playing backwards.
   */
  const takeHandOffEditBack = (shown: PendingEdit, cardId: string): void => {
    handOffChains.play(scrollRef.current, cardId, "backwards", () => {
      changePending((edits) => edits.filter((each) => each.id !== shown.id));
    });
  };

  /**
   * Takes `shown` off the page again because the controller refused it, or
   * because it changed nothing. The cards it moved are put back where they
   * stood, and a move made after it stays.
   */
  const takeEditBack = (shown: PendingEdit): void => {
    playPageChange("hand", () => {
      changePending((edits) => edits.filter((each) => each.id !== shown.id));
      visit.advanceLinkGesture({ _tag: "refuse", gesture: shown.id });
    });
  };

  /**
   * Writes an edit the controller answered into the cached Inbox, and drops it
   * from the pending list in the same draw. `remaining` is an Unlink's answer.
   */
  const settleEdit = async (
    shown: PendingEdit,
    remaining?: EntityUnlinkResult["remaining"],
  ): Promise<void> => {
    await writeCachedInbox(shown.edit);
    changePending((edits) => edits.filter((each) => each.id !== shown.id));
    visit.advanceLinkGesture({ _tag: "settle", gesture: shown.id, remaining });
  };

  /**
   * Shows an edit made by Undo on the page that is open, and writes it into
   * the cached Inbox. A card put back parts the page on `hand` and comes from
   * 14px aside on `travel`. A hand-off taken back plays the hand-off chain
   * backwards.
   */
  const writeInboxEdit = async (edit: InboxEdit): Promise<void> => {
    if (edit.kind === "take-back-hand-off") {
      await settleEdit(showHandOffEdit(edit, "backwards"));
      return;
    }
    const { shown, born } = showEdit(edit, "hand");
    if (edit.kind === "put-back") {
      for (const card of born) {
        if (card.dataset["cardId"] === edit.card.id) comeBackFromAside(card);
      }
    }
    await settleEdit(shown);
  };

  const { line, say, undo } = useUndoLine(
    undoStack,
    () => ({
      putCardBack: buildCachedCardMover(client, queryClient),
      putEndedCardBack: buildCachedEndedCardMover(client, queryClient),
      writeInboxEdit,
    }),
    isCarrying,
  );

  const takeOn = useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: (card: InboxCard) => {
      requireSignedIn();
      return client.externalEntity.takeOn({ params: { id: card.id } });
    },
  });
  const handOffCard = useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: ({
      entityId,
      workflowId,
      connectionId,
    }: {
      readonly entityId: string;
      readonly workflowId: string;
      readonly connectionId: string | undefined;
    }) => {
      requireSignedIn();
      return client.externalEntity.handOff({
        params: { id: entityId },
        payload: connectionId === undefined ? { workflowId } : { workflowId, connectionId },
      });
    },
  });
  const dismissCard = useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: (card: InboxCard) => {
      requireSignedIn();
      return client.externalEntity.dismiss({ params: { id: card.id } });
    },
  });

  const changeLinkRequest = useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: async ({
      move,
      direction,
      isWanted,
    }: {
      readonly move: EntityLinkMove;
      readonly direction: LinkDirection;
      readonly isWanted: MoveIsWanted | undefined;
    }): Promise<LinkAnswer> => {
      // Checked when the move reaches the front of the line, so a move that changed nothing is never reversed.
      requireSignedIn();
      if (isWanted !== undefined && !(await isWanted)) throw new Error(NOTHING_TO_PUT_BACK);
      requireSignedIn();
      return sendLinkChange(client, move, direction);
    },
  });

  // The reversals wait in the same line as the moves, so none overtakes another. A reversal that
  // has its own words for the undo line (a hand-off's) resolves to them.
  const reverseMove = useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: (reverse: () => Promise<UndoAnswer | undefined>) => {
      requireSignedIn();
      return reverse();
    },
  });

  const take = (card: InboxCard): void => {
    const name = nameCard(card);
    const request = takeOn.mutateAsync(card);
    // A Take that made no Task (it failed, or the card already had one) has nothing to put back.
    const wasCreated = request.then(
      ({ created }) => created,
      () => false,
    );
    const gesture: Gesture<CardMover> = {
      words: `Took on ${name}`,
      undo: async (page) => {
        return reverseMove.mutateAsync(async () => {
          if (!(await wasCreated)) throw new Error(NOTHING_TO_PUT_BACK);
          const { taskId } = await request;
          requireSignedIn();
          // The Task was touched since, so it stays and the line says why.
          await undoAddedTask(client, card.id, taskId);
          if (!isCurrent()) return undefined;
          await page.writeInboxEdit({ kind: "set-task", id: card.id, taskId: undefined });
          return undefined;
        });
      },
    };
    undoStack.reserve(gesture, wasCreated);
    request.then(
      async ({ taskId, created }) => {
        if (!isCurrent()) return;
        const { shown } = showEdit({ kind: "set-task", id: card.id, taskId }, "hand");
        const scroller = scrollRef.current;
        const element = scroller === null ? null : findCardElement(scroller, card.id);
        if (element !== null) riseMonogram(element);
        await settleEdit(shown);
        if (!isCurrent()) return;
        if (!created) {
          say(`${name} already had a Task, so no new one was made.`);
          return;
        }
        say(`Took on ${name}. A Task is on Work.`, gesture);
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        say(`${name} was not taken on: ${readReason(error)}. Try again.`);
      },
    );
  };

  const handOff = (
    target: HandOffTarget,
    offer: WorkflowOffer,
    connectionId: string | undefined,
  ): void => {
    if (handingOff.current.has(target.id)) return;
    handingOff.current.add(target.id);
    const name = nameCard(target);
    const workflow: LiveWorkflow = { workflowId: offer.workflowId, name: offer.name };
    // What the hand-off ends stays ended, whatever Undo does.
    const endedKinds = target.openKinds.filter((kind) => offer.answers.includes(kind));
    const handShown = showHandOffEdit({ kind: "hand-off", id: target.id, workflow }, "forwards");

    const request = handOffCard.mutateAsync({
      entityId: target.id,
      workflowId: offer.workflowId,
      connectionId,
    });
    const wasHanded = request.then(
      () => true,
      () => false,
    );
    const gesture: Gesture<CardMover> = {
      words: `Handed ${name} to ${offer.name}`,
      undo: (page) =>
        reverseMove.mutateAsync(async () => {
          if (!(await wasHanded)) throw new Error(NOTHING_TO_PUT_BACK);
          const { runId, taskId } = await request;
          requireSignedIn();
          const result = await client.externalEntity.undoHandOff({ params: { runId } });
          // The answer belongs to the user who signed out: the caches and the line are the next one's.
          if (!isCurrent()) return undefined;
          const text = describeHandOffUndo(result, offer.name, endedKinds);
          // Stopped and too-late are the controller's final answers, not failures: the line says
          // them in its own words, and the card stays as it is, because a reversal that did not
          // happen would be a lie. Only a hand-off that was taken back plays backwards.
          if (!isHandOffTakenBack(result)) {
            return result.outcome === "stopped"
              ? { text, action: { label: "See its Task", act: () => openTask(taskId) } }
              : { text };
          }
          // A Task the hand-off made is gone. A Task it continued stays, and so does the card's hold on it.
          await page.writeInboxEdit({
            kind: "take-back-hand-off",
            id: target.id,
            workflowId: offer.workflowId,
            taskId: result.taskRemoved ? undefined : taskId,
          });
          return { text };
        }),
    };
    undoStack.reserve(gesture, wasHanded);
    request.then(
      async ({ taskId }) => {
        handingOff.current.delete(target.id);
        if (!isCurrent()) return;
        const { shown: taskShown } = showEdit({ kind: "set-task", id: target.id, taskId }, "hand");
        // The hand-off edit is written first, so the colleague stays when it leaves the pending list.
        await settleEdit(handShown);
        await settleEdit(taskShown);
        if (!isCurrent()) return;
        say(`Handed ${name} to ${offer.name}. Its Task is on Work.`, gesture);
      },
      (error: unknown) => {
        handingOff.current.delete(target.id);
        if (!isCurrent()) return;
        takeHandOffEditBack(handShown, target.id);
        say(describeHandOffRefusal(target, offer.name, readReason(error)));
      },
    );
  };

  const dismiss = (card: InboxCard, riders: readonly InboxCard[], stepsAside = true): void => {
    const name = nameCard(card);
    const scroller = scrollRef.current;
    const element = scroller === null ? null : findCardElement(scroller, card.id);
    // The copy is made while the card is still on the page, and steps aside once it has left.
    const copy =
      !stepsAside || scroller === null || element === null
        ? null
        : copyCardToStepAside(scroller, element);
    const { shown } = showEdit({ kind: "drop", id: card.id }, "hand");
    if (copy !== null) stepAside(copy);

    const wasSaved = dismissCard.mutateAsync(card).then(
      async () => {
        if (isCurrent()) await settleEdit(shown);
        return true;
      },
      (error: unknown) => {
        if (!isCurrent()) return false;
        playPageChange("travel", () => {
          changePending((edits) => edits.filter((each) => each.id !== shown.id));
        });
        say(`${name} was not dismissed, so it is back: ${readReason(error)}. Try again.`);
        return false;
      },
    );
    const gesture: Gesture<CardMover> = {
      words: `Dismissed ${name}`,
      undo: async (page) => {
        return reverseMove.mutateAsync(async () => {
          if (!(await wasSaved)) throw new Error(NOTHING_TO_PUT_BACK);
          requireSignedIn();
          await client.externalEntity.restore({ params: { id: card.id } });
          if (!isCurrent()) return undefined;
          await page.writeInboxEdit({ kind: "put-back", card });
          return undefined;
        });
      },
    };
    undoStack.reserve(gesture, wasSaved);
    say(describeDismissal(card, riders), gesture);
  };

  /** Reads again what a link decides: what rides on what, the count, and every open entity's links. */
  const readLinksAgain = (): void => {
    for (const key of [queryKeys.inbox(), queryKeys.inboxCount(), queryKeys.externalEntity()]) {
      invalidateWithoutCancelling(queryClient, key);
    }
  };

  /**
   * Links the two things, or removes the user's link between them, and shows
   * it at once. A request that is linked to a ticket flies from Requests into
   * the ticket's tucked sheet and everything between closes up, in one
   * movement on `hand`; a card that rode on the other end stands alone. The
   * controller's answer decides what rides on what: a link a source still
   * reports keeps its card riding. A failure takes it back and rejects.
   * It is planned over the newest Inbox and the place the visit holds, wherever
   * it is called from, because Undo calls it long after the gesture it reverses.
   * `isWanted` is for Undo: the move is sent only if it resolves to true.
   * Returns the controller's answer, once it is settled on the page.
   */
  const changeLink = (
    move: EntityLinkMove,
    direction: LinkDirection,
    isWanted?: MoveIsWanted,
  ): Promise<LinkAnswer> => {
    const shownInbox = newestInbox.current;
    const plan =
      shownInbox === undefined
        ? undefined
        : direction === "link"
          ? planLink(shownInbox, move.fromRef, move.toRef)
          : planUnlink(shownInbox, move.fromRef, move.toRef, visit.readLatest().placement);
    const shown =
      plan === undefined ? undefined : showEdit(plan.edit, "hand", plan.ridingMove).shown;
    return changeLinkRequest.mutateAsync({ move, direction, isWanted }).then(
      async (answer) => {
        if (!isCurrent()) return answer;
        if (shown !== undefined) {
          if (answer.didChange) await settleEdit(shown, answer.remaining);
          else takeEditBack(shown);
        }
        readLinksAgain();
        return answer;
      },
      (error: unknown) => {
        if (shown !== undefined && isCurrent()) takeEditBack(shown);
        throw error;
      },
    );
  };
  // A gesture outlives the render that made it, so its undo calls the newest `changeLink`.
  const changeLinkRef = useRef(changeLink);
  useLayoutEffect(() => {
    changeLinkRef.current = changeLink;
    newestInbox.current = inbox;
  });

  /**
   * Makes a Link or Unlink the user asked for and puts it on the undo stack.
   * The undo line says what was done and offers Undo, which makes the move in
   * the other direction (see `changeLink`).
   */
  const makeLinkChange = (move: EntityLinkMove, direction: LinkDirection): void => {
    const words = `${move.fromName} and ${move.toName}`;
    const answered = changeLink(move, direction);
    const wasChanged = answered.then(
      ({ didChange }) => didChange,
      () => false,
    );
    const gesture: Gesture<CardMover> = {
      words: LINK_WORDS[direction].gesture(words),
      undo: async () => {
        const { remaining } = await changeLinkRef.current(
          move,
          reverseDirection(direction),
          wasChanged,
        );
        return describeLinkRemaining(remaining);
      },
    };
    undoStack.reserve(gesture, wasChanged);
    answered.then(
      ({ didChange, remaining }) => {
        if (!isCurrent()) return;
        if (!didChange) {
          say(`You had made no link between ${words}, so none was removed.`);
          return;
        }
        say(
          direction === "link" ? LINK_WORDS.link.done(words) : describeLinkRemoved(remaining),
          gesture,
        );
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        say(LINK_WORDS[direction].failed(words, readReason(error)));
      },
    );
  };

  return {
    inbox,
    hasPendingEdits: pendingEdits.length > 0,
    take,
    handOff,
    dismiss,
    link: (move) => {
      makeLinkChange(move, "link");
    },
    unlink: (move) => {
      makeLinkChange(move, "unlink");
    },
    undoLastMove: undo,
    line,
    sayWithoutUndo: (text) => {
      say(text);
    },
  };
};
