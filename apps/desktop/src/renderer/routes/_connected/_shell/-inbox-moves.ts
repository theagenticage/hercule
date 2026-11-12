/**
 * The moves of the Inbox's things (Dismiss, Take on, hand-off, Go to its Task,
 * Open at its source) and the undo line at the foot of the list. It follows
 * the Work board's moves (`-card-moves.ts`):
 *
 * - A move shows at once on the held list (`applyInboxMove`) and is sent after
 *   the moves before it, one at a time, in the order the user made them. The
 *   reversal of a move joins the same line when the user presses Undo, so a
 *   move made after Undo reaches the controller after the reversal.
 * - Dismiss takes the rows off the list at once, and a refusal puts them back
 *   and says why. Take on and the hand-off keep the row: the next read of the
 *   list updates it in place, or drops it when it no longer belongs.
 * - Each move is one gesture on the shared undo stack. It takes its place when
 *   the user acts, before the controller answers, and its undo waits for the
 *   answer itself. A move that fails takes its gesture off again. A gesture
 *   outlives the screen, so it is undone through the screen that is open when
 *   Undo is pressed.
 * - Every request first asks the account scope that the user who made the move
 *   is still signed in, because the client sends the token it holds when it is
 *   called.
 * - A refused move says why on the undo line, and nothing is sent: the choice
 *   of what may be moved is `planInboxMove`.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import {
  DISMISSAL_UNDONE,
  TAKE_ON_UNDONE,
  NO_SOURCE_ADDRESS,
  applyInboxMove,
  buildHandedThing,
  decideHandMove,
  decideMoveTargets,
  describeHandOffUndo,
  describeInboxDismissal,
  describeInboxDismissalFailure,
  describeInboxHandOff,
  describeInboxHandOffFailure,
  describeInboxTakeOn,
  describeInboxTakeOnFailure,
  isHandOffTakenBack,
  listCardOffers,
  planInboxMove,
  undoInboxMove,
  type InboxLineWords,
  type InboxListState,
} from "@hercule/client-core/inbox";
import type { InboxThing, WorkflowOffer } from "@hercule/contract";
import { requireSignedIn, type AccountScope } from "../../../app/account-scope";
import {
  buildCachedCardMover,
  buildCachedEndedCardMover,
  type CardMover,
} from "../../../app/card-mover";
import { readReason } from "../../../app/read-reason";
import type { Gesture, UndoAnswer } from "../../../app/undo-stack";
import { undoAddedTask } from "../../../app/undo-added-task";
import { useUndoLine, type UndoLineState } from "../../../app/use-undo-line";
import type { SidebarFlight } from "../../../app/motion/sidebar-flight";
import { flyHandedMarkToWork, rollHandedRow } from "../../../screens/inbox/inbox-hand-off-motion";
import type { InboxLeaveHow } from "../../../screens/inbox/use-inbox-list-motion";
import type { HeldInboxList } from "./-inbox-held-list";

/** The key every Inbox move runs under, so one move waits for the one before it. */
const INBOX_MOVES_KEY = ["inbox-moves"];

const NOT_SAVED = "That move did not save, so there is nothing to put back.";

/**
 * How the rows of a move went, for the list's motion: whether the rows that
 * left were dismissed (they slide aside as they fade) and which rows an undo
 * put back (they come back from aside).
 */
export interface InboxMoveMotion {
  readonly leaveHow: InboxLeaveHow;
  readonly returning: ReadonlyArray<string>;
}

/** What `useInboxMoves` returns. */
export interface InboxMoves {
  /**
   * Dismisses the things the move is for: the selection, else the current
   * row, or with `hoveredRef` the row whose own button was pressed (the
   * selection when that row is in it). They leave the list at once, in one
   * call, with one Undo. A refusal says why on the undo line.
   */
  readonly dismiss: (hoveredRef?: string) => void;
  /**
   * Takes the one thing the move is for on as a Task (see `dismiss` for which
   * thing). The current row moves on at once and the row stays until the list
   * is read again.
   */
  readonly takeOn: (hoveredRef?: string) => void;
  /**
   * Starts a hand-off of the one thing the move is for. With one workflow
   * that fits, hands it at once and returns `null`. With several, returns the
   * thing, for the screen to open the menu of workflows over. A refusal says
   * why on the undo line and returns `null`.
   */
  readonly startHandOff: (hoveredRef?: string) => InboxThing | null;
  /**
   * Hands the one thing the move is for (see `dismiss`: the selection, else
   * the current row, or with `hoveredRef` that row) to `offer`, as
   * `connectionId` (or the account the controller picks), after the same
   * check the H key makes: offline, a selection of several things and a thing
   * no workflow takes are refused with their reason on the undo line. The
   * current row moves on at once and the mark flies to Work.
   */
  readonly handOff: (
    hoveredRef: string | undefined,
    offer: WorkflowOffer,
    connectionId: string | undefined,
  ) => void;
  /**
   * Returns `thing` as it reads while its hand-off is on its way: the
   * workflow has it. Returns `thing` itself when it was not handed, or the
   * list has been read since. The list draws its rows through it.
   */
  readonly readHandedThing: (thing: InboxThing) => InboxThing;
  /** Goes to the Task of the one thing the move is for, or says it has none. */
  readonly goToTask: (hoveredRef?: string) => void;
  /** Opens the current thing at its source, or says it has no address. */
  readonly openAtSource: () => void;
  /** Says `text` on the undo line, with no Undo. */
  readonly say: (text: string) => void;
  /** What the undo line shows. */
  readonly line: UndoLineState;
  /** Tells the line whether the pointer or the focus is on it, which keeps it from hiding. */
  readonly holdLine: (isHeld: boolean) => void;
  /** Reverses the newest gesture on the undo stack, and says what happened. */
  readonly undoLastMove: () => void;
}

/** Joins the words of a gesture the way Undo reports them: the title after a colon, in quotes. */
const joinGestureWords = ({ text, title }: InboxLineWords): string =>
  title === null ? text : `${text}: “${title}”`;

/**
 * Makes the moves of the Inbox for `client`, for the user of `scope`, over
 * the list `held`. `isOffline` makes every move but Go to its Task refuse.
 * `openTask` opens a Task on Work. `onMoved` is called with the list a move
 * or an undo left and how its rows went, so the screen can move the focus to
 * the row that is current now, or to the empty state when none is, and tell
 * the list how to move.
 */
export const useInboxMoves = ({
  client,
  scope,
  held,
  isOffline,
  openTask,
  onMoved,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly held: HeldInboxList;
  readonly isOffline: boolean;
  readonly openTask: (taskId: string) => void;
  readonly onMoved: (list: InboxListState<InboxThing>, motion: InboxMoveMotion) => void;
}): InboxMoves => {
  const queryClient = useQueryClient();
  const { undoStack, isCurrent } = scope;

  // A gesture outlives the render that made it, so it reads the newest of these.
  const latest = useRef({ held, isOffline, openTask, onMoved });
  useLayoutEffect(() => {
    latest.current = { held, isOffline, openTask, onMoved };
  });
  // The things handed and what they read as meanwhile. An entry applies only to the very thing it
  // was made for, so the next read of the list, which brings a new thing, ends it.
  const [handed, setHanded] = useState<ReadonlyMap<string, { from: InboxThing; to: InboxThing }>>(
    new Map(),
  );
  const putHandedBack = (ref: string): void => {
    setHanded((before) => {
      const next = new Map(before);
      next.delete(ref);
      return next;
    });
  };
  // The things whose hand-off the controller has not answered, so a second H waits for the first.
  const handing = useRef(new Set<string>());

  const { line, say, hold, undo } = useUndoLine(undoStack, () => ({
    putCardBack: buildCachedCardMover(client, queryClient),
    putEndedCardBack: buildCachedEndedCardMover(client, queryClient),
  }));

  const dismissRequest = useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: (ids: readonly string[]) => {
      requireSignedIn(scope);
      return client.externalEntity.dismiss({ payload: { ids: [...ids] } });
    },
  });
  const takeOnRequest = useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: (id: string) => {
      requireSignedIn(scope);
      return client.externalEntity.takeOn({ params: { id } });
    },
  });
  const handOffRequest = useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: ({
      id,
      workflowId,
      connectionId,
    }: {
      readonly id: string;
      readonly workflowId: string;
      readonly connectionId: string | undefined;
    }) => {
      requireSignedIn(scope);
      return client.externalEntity.handOff({
        params: { id },
        payload: connectionId === undefined ? { workflowId } : { workflowId, connectionId },
      });
    },
  });
  // The reversals wait in the same line as the moves, so none overtakes another.
  const reverseMove = useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: (reverse: () => Promise<UndoAnswer | undefined>) => {
      requireSignedIn(scope);
      return reverse();
    },
  });

  /** Returns the things a move is for, in list order: see `decideMoveTargets`. */
  const readTargets = (hoveredRef: string | undefined): InboxThing[] => {
    const list = latest.current.held.readLatest()?.list;
    if (list === undefined) return [];
    const wanted = new Set(decideMoveTargets(list, hoveredRef));
    return list.rows.filter((row) => wanted.has(row.ref));
  };

  /** Returns the things `move` may be made on, or says why not and returns `null`. */
  const readAllowedTargets = (
    move: Parameters<typeof planInboxMove>[0]["move"],
    hoveredRef: string | undefined,
  ): InboxThing[] | null => {
    const things = readTargets(hoveredRef);
    const first = things[0];
    if (first === undefined) return null;
    const plan = planInboxMove({
      move,
      things,
      isOffline: latest.current.isOffline,
      offers: listCardOffers(first, latest.current.held.readLatest()?.offerSets ?? {}),
    });
    if (plan.kind === "refuse") {
      say(plan.reason);
      return null;
    }
    return things;
  };

  /** Applies a move to the newest held list at once, and tells the screen what is current now. */
  const showMove = (
    refs: readonly string[],
    leavesList: boolean,
    leaveHow: InboxLeaveHow,
  ): void => {
    const { held: now, onMoved: tell } = latest.current;
    const next = now.change((list) => applyInboxMove(list, refs, { leavesList }));
    if (next !== null) tell(next, { leaveHow, returning: [] });
  };

  /** Puts back the rows of a move that left or stayed, and makes the topmost current. */
  const showUndo = (refs: readonly string[]): void => {
    const { held: now, onMoved: tell } = latest.current;
    const next = now.change((list) => undoInboxMove(list, refs));
    if (next !== null) tell(next, { leaveHow: "taken", returning: refs });
  };

  const dismiss = (hoveredRef?: string): void => {
    const things = readAllowedTargets("dismiss", hoveredRef);
    if (things === null) return;
    const refs = things.map((thing) => thing.ref);
    const ids = things.map((thing) => thing.id);
    const words = describeInboxDismissal(things);
    showMove(refs, true, "dismiss");
    const request = dismissRequest.mutateAsync(ids);
    const wasSaved = request.then(
      () => true,
      () => false,
    );
    const gesture: Gesture<CardMover> = {
      words: joinGestureWords(words),
      undo: () =>
        reverseMove.mutateAsync(async () => {
          if (!(await wasSaved)) throw new Error(NOT_SAVED);
          requireSignedIn(scope);
          await client.externalEntity.restore({ payload: { ids } });
          if (!isCurrent()) return undefined;
          showUndo(refs);
          return { text: DISMISSAL_UNDONE };
        }),
    };
    undoStack.reserve(gesture, wasSaved);
    say(words.text, gesture, undefined, words.title ?? undefined);
    request.catch((error: unknown) => {
      if (!isCurrent()) return;
      showUndo(refs);
      say(describeInboxDismissalFailure(things, readReason(error)));
    });
  };

  const takeOn = (hoveredRef?: string): void => {
    const things = readAllowedTargets("takeOn", hoveredRef);
    const thing = things?.[0];
    if (thing === undefined) return;
    showMove([thing.ref], false, "taken");
    const request = takeOnRequest.mutateAsync(thing.id);
    // A Take on that made no Task (it failed, or the thing already had one) has nothing to put back.
    const wasCreated = request.then(
      ({ created }) => created,
      () => false,
    );
    const gesture: Gesture<CardMover> = {
      words: joinGestureWords(describeInboxTakeOn(thing, true)),
      undo: () =>
        reverseMove.mutateAsync(async () => {
          if (!(await wasCreated)) throw new Error(NOT_SAVED);
          const { taskId } = await request;
          requireSignedIn(scope);
          // The Task was touched since, so it stays and the line says why.
          await undoAddedTask(client, thing.id, taskId);
          if (!isCurrent()) return undefined;
          showUndo([thing.ref]);
          return { text: TAKE_ON_UNDONE };
        }),
    };
    undoStack.reserve(gesture, wasCreated);
    request.then(
      ({ taskId, created }) => {
        if (!isCurrent()) return;
        const words = describeInboxTakeOn(thing, created);
        say(
          words.text,
          created ? gesture : undefined,
          { label: "Go to the Task", act: () => latest.current.openTask(taskId) },
          words.title ?? undefined,
        );
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        say(describeInboxTakeOnFailure(thing, readReason(error)));
      },
    );
  };

  /** Hands `thing`, which the caller has checked may be handed, to `offer`. */
  const sendHandOff = (
    thing: InboxThing,
    offer: WorkflowOffer,
    connectionId: string | undefined,
  ): void => {
    const { ref } = thing;
    if (handing.current.has(ref)) {
      say("That hand-off is still on its way.");
      return;
    }
    handing.current.add(ref);
    const flight: SidebarFlight = flyHandedMarkToWork(ref);
    // The row draws the workflow having the thing as the chain starts, and keeps it until the list is read.
    const handedThing = buildHandedThing(thing, offer);
    const roll = rollHandedRow(ref, () => {
      setHanded((before) => new Map(before).set(ref, { from: thing, to: handedThing }));
    });
    showMove([ref], false, "taken");
    // What the hand-off ends stays ended, whatever Undo does.
    const endedKinds = thing.openKinds.filter((kind) => offer.answers.includes(kind));
    const request = handOffRequest.mutateAsync({
      id: thing.id,
      workflowId: offer.workflowId,
      connectionId,
    });
    const wasHanded = request.then(
      () => true,
      () => false,
    );
    const words = describeInboxHandOff(thing, offer.name);
    const gesture: Gesture<CardMover> = {
      words: joinGestureWords(words),
      undo: () => {
        // Undo during the chain stops the roll and the mark where they are: Work receives nothing.
        roll.cancel();
        flight.cancel();
        return reverseMove.mutateAsync(async () => {
          if (!(await wasHanded)) throw new Error(NOT_SAVED);
          const { runId, taskId } = await request;
          requireSignedIn(scope);
          const result = await client.externalEntity.undoHandOff({ params: { runId } });
          if (!isCurrent()) return undefined;
          const text = describeHandOffUndo(result, offer.name, endedKinds);
          // Stopped and too-late are the controller's final answers, not failures: the line says
          // them in its own words, and the row stays as it is.
          if (isHandOffTakenBack(result)) {
            putHandedBack(ref);
            showUndo([ref]);
          }
          return result.outcome === "stopped"
            ? {
                text,
                action: { label: "See its Task", act: () => latest.current.openTask(taskId) },
              }
            : { text };
        });
      },
    };
    undoStack.reserve(gesture, wasHanded);
    request.then(
      () => {
        handing.current.delete(ref);
        if (!isCurrent()) return;
        say(words.text, gesture, undefined, words.title ?? undefined);
      },
      (error: unknown) => {
        handing.current.delete(ref);
        roll.cancel();
        flight.cancel();
        putHandedBack(ref);
        if (!isCurrent()) return;
        say(describeInboxHandOffFailure(thing, offer.name, readReason(error)));
      },
    );
  };

  const handOff = (
    hoveredRef: string | undefined,
    offer: WorkflowOffer,
    connectionId: string | undefined,
  ): void => {
    const thing = readAllowedTargets("handOff", hoveredRef)?.[0];
    if (thing !== undefined) sendHandOff(thing, offer, connectionId);
  };

  const startHandOff = (hoveredRef?: string): InboxThing | null => {
    const things = readAllowedTargets("handOff", hoveredRef);
    const thing = things?.[0];
    if (thing === undefined) return null;
    const move = decideHandMove(
      listCardOffers(thing, latest.current.held.readLatest()?.offerSets ?? {}),
    );
    if (move.kind === "one") {
      sendHandOff(thing, move.offer, undefined);
      return null;
    }
    return move.kind === "several" ? thing : null;
  };

  const goToTask = (hoveredRef?: string): void => {
    const taskId = readAllowedTargets("goToTask", hoveredRef)?.[0]?.taskId;
    if (taskId !== undefined) latest.current.openTask(taskId);
  };

  const openAtSource = (): void => {
    const list = latest.current.held.readLatest()?.list;
    const thing = list?.rows.find((row) => row.ref === list.current);
    if (thing === undefined) return;
    if (thing.url === "") {
      say(NO_SOURCE_ADDRESS);
      return;
    }
    window.open(thing.url, "_blank", "noreferrer");
  };

  return {
    dismiss,
    takeOn,
    startHandOff,
    handOff,
    readHandedThing: (thing) => {
      const entry = handed.get(thing.ref);
      return entry?.from === thing ? entry.to : thing;
    },
    goToTask,
    openAtSource,
    say: (text) => {
      say(text);
    },
    line,
    holdLine: hold,
    undoLastMove: undo,
  };
};
