/**
 * The moves of the Inbox's things (Dismiss, Take on, hand-off, Go to its Task,
 * Open at its source) and the undo line at the foot of the list. It follows
 * the Work board's moves (`-card-moves.ts`):
 *
 * - A move shows at once on the visit (`visit.move`) and is sent after
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
 * - A move acts on what `visit.targets` names: one thing, a whole group of
 *   linked things, or the selection. A group is dismissed in one call with
 *   one Undo, and taken on (like a selection of several things) as one Task.
 *   Link and Unlink are not moves of the list: the rows stay where they are
 *   and the visit is told to read again, which is what draws the new group.
 */
import { useLayoutEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import {
  DISMISSAL_UNDONE,
  LINK_UNDONE,
  NO_SOURCE_ADDRESS,
  TAKE_ON_UNDONE,
  UNLINK_UNDONE,
  buildHandedThing,
  decideHandMove,
  describeHandOffUndo,
  describeInboxDismissalFailure,
  describeInboxHandOff,
  describeInboxHandOffFailure,
  describeInboxLink,
  describeInboxLinkFailure,
  describeInboxTakeOn,
  describeInboxTakeOnFailure,
  describeInboxTakeOnTogether,
  describeInboxTakeOnTogetherUndone,
  describeInboxUnlink,
  describeInboxUnlinkFailure,
  didTakeOnTogetherChange,
  isHandOffTakenBack,
  REFUSED_OFFLINE,
  planInboxMove,
  type InboxLineWords,
  type InboxLinkEnd,
  type InboxLinkPick,
  type InboxMoveKind,
  type InboxMovePlans,
  type MoveReceipt,
} from "@hercule/client-core/inbox";
import type { EntityLinkInput, WorkflowOffer } from "@hercule/contract";
import { requireSignedIn, type AccountScope } from "../../../app/account-scope";
import {
  buildCachedCardMover,
  buildCachedEndedCardMover,
  type CardMover,
} from "../../../app/card-mover";
import type { AnswerLine } from "../../../app/held-signal-answers";
import { readReason } from "../../../app/read-reason";
import type { Gesture, UndoAnswer } from "../../../app/undo-stack";
import { undoAddedTask } from "../../../app/undo-added-task";
import { useUndoLine, type UndoLineState } from "../../../app/use-undo-line";
import type { SidebarFlight } from "../../../app/motion/sidebar-flight";
import { flyHandedMarkToWork, rollHandedRow } from "../../../screens/inbox/inbox-hand-off-motion";
import type { InboxListRow, InboxListSnapshot, InboxListVisit } from "./-inbox-visit";

/** The key every Inbox move runs under, so one move waits for the one before it. */
const INBOX_MOVES_KEY = ["inbox-moves"];

/**
 * Returns a mutation that sends one move (or one reversal) with `send`, in the
 * line every Inbox move waits in. It fails before sending when the account in
 * `scope` is no longer signed in.
 */
const useMoveRequest = <Variables, Result>(
  scope: AccountScope,
  send: (variables: Variables) => Promise<Result>,
) =>
  useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: (variables: Variables) => {
      requireSignedIn(scope);
      return send(variables);
    },
  });

const NOT_SAVED = "That move did not save, so there is nothing to put back.";

/**
 * What `useInboxMoves` returns. A move that takes `hoveredKey` acts on the
 * list line whose own button was pressed (a thing's ref or a group's key), or
 * on the selection when that line is in it. Without it the move acts on the
 * selection, else the current line.
 */
export interface InboxMoves {
  /**
   * Dismisses what the move is for. A thing, every member of a group or the
   * selection leave the list at once, in one call, with one Undo. A refusal
   * says why on the undo line.
   */
  readonly dismiss: (hoveredKey?: string) => void;
  /**
   * Takes what the move is for on as a Task. For one thing the current row
   * moves on at once and the row stays until the list is read again. A group
   * or a selection of several things become one Task.
   */
  readonly takeOn: (hoveredKey?: string) => void;
  /**
   * Starts a hand-off of the one thing the move is for. With one workflow
   * that fits, hands it at once and returns `null`. With several, returns the
   * thing, for the screen to open the menu of workflows over. A refusal says
   * why on the undo line and returns `null`.
   */
  readonly startHandOff: (hoveredKey?: string) => InboxListRow | null;
  /**
   * Hands the one thing the move is for to `offer`, as `connectionId` (or the
   * account the controller picks), after the same check the H key makes:
   * offline, a group, a selection of several things and a thing no workflow
   * takes are refused with their reason on the undo line. The current row
   * moves on at once and the mark flies to Work.
   */
  readonly handOff: (
    hoveredKey: string | undefined,
    offer: WorkflowOffer,
    connectionId: string | undefined,
  ) => void;
  /** Goes to the Task of the one thing the move is for, or says it has none. */
  readonly goToTask: (hoveredKey?: string) => void;
  /**
   * Starts a link of what the move is for. A selection of two or more things
   * is linked at once (a star from the first) and `null` comes back. One
   * thing, one selected thing or a group returns what "Link to..." opens with,
   * for the screen to let the user pick the other end. A refusal says why on
   * the undo line and returns `null`.
   */
  readonly startLink: (hoveredKey?: string) => InboxLinkPick | null;
  /**
   * Links `from` to `to`, the thing the user picked in "Link to..." or dropped a
   * row on. Returns whether a link was written: `false` when the two were linked
   * already, the call was refused or it failed, and the line says why.
   */
  readonly linkTo: (from: InboxLinkEnd, to: InboxLinkEnd) => Promise<boolean>;
  /**
   * Removes the user's own link between `first` and `second`, with an Undo
   * that links them again. The line says so when a source still links them.
   */
  readonly unlink: (first: InboxLinkEnd, second: InboxLinkEnd) => void;
  /** Opens the current thing at its source, or says it has no address. */
  readonly openAtSource: () => void;
  /** Says `text` on the undo line, with no Undo. */
  readonly say: (text: string) => void;
  /**
   * Puts `gesture` on the undo stack and says `text` on the undo line with
   * Undo. Returns a function that takes the gesture off the stack again.
   */
  readonly sayWithUndo: (text: string, gesture: Gesture<CardMover>) => () => void;
  /** Changes the undo line while it shows `gesture`. See `UndoLineControls.restate`. */
  readonly restate: AnswerLine["restate"];
  /** Tells the screen what is current after the caller changed the list with `visit`, so the focus follows. */
  readonly tellMoved: () => void;
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
 * the list `visit` holds. `isOffline` makes every move but Go to its Task
 * refuse. `openTask` opens a Task on Work. `onMoved` is called with the
 * snapshot a move or an undo left, so the screen can move the focus to the
 * row that is current now, or to the empty state when none is.
 */
export const useInboxMoves = ({
  client,
  scope,
  visit,
  isOffline,
  openTask,
  onMoved,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly visit: InboxListVisit;
  readonly isOffline: boolean;
  readonly openTask: (taskId: string) => void;
  readonly onMoved: (snapshot: InboxListSnapshot) => void;
}): InboxMoves => {
  const queryClient = useQueryClient();
  const { undoStack, isCurrent } = scope;

  // A gesture outlives the render that made it, so it reads the newest of these.
  const latest = useRef({ isOffline, openTask, onMoved });
  useLayoutEffect(() => {
    latest.current = { isOffline, openTask, onMoved };
  });
  // The things whose hand-off the controller has not answered, so a second H waits for the first.
  const handing = useRef(new Set<string>());

  const { line, say, withdraw, restate, hold, undo } = useUndoLine(undoStack, () => ({
    putCardBack: buildCachedCardMover(client, queryClient),
    putEndedCardBack: buildCachedEndedCardMover(client, queryClient),
  }));

  const dismissRequest = useMoveRequest(scope, (ids: readonly string[]) =>
    client.externalEntity.dismiss({ payload: { ids: [...ids] } }),
  );
  const handOffRequest = useMoveRequest(
    scope,
    ({
      id,
      workflowId,
      connectionId,
    }: {
      readonly id: string;
      readonly workflowId: string;
      readonly connectionId: string | undefined;
    }) =>
      client.externalEntity.handOff({
        params: { id },
        payload: connectionId === undefined ? { workflowId } : { workflowId, connectionId },
      }),
  );
  const linkRequest = useMoveRequest(scope, (input: EntityLinkInput) =>
    client.externalEntity.link({ payload: input }),
  );
  const unlinkRequest = useMoveRequest(scope, (input: EntityLinkInput) =>
    client.externalEntity.unlink({ payload: input }),
  );
  // Take on has no request of its own: `takeOnExecutor` is given what to send, and sends it in this line.
  const sendInLine = useMoveRequest(scope, (send: () => Promise<unknown>) => send());
  // The reversals wait in the same line as the moves, so none overtakes another.
  const reverseMove = useMoveRequest(scope, (reverse: () => Promise<UndoAnswer | undefined>) =>
    reverse(),
  );

  /**
   * Returns the plan of `move` for what it is for (see `InboxVisit.targets`),
   * or says why not on the undo line and returns `null`. The caller sends
   * exactly what the plan says.
   */
  const planMove = <Move extends InboxMoveKind>(
    move: Move,
    hoveredKey: string | undefined,
  ): InboxMovePlans<InboxListRow>[Move] | null => {
    const target = visit.targets(hoveredKey);
    if (target === null) return null;
    const plan = planInboxMove({ move, target, isOffline: latest.current.isOffline });
    if (plan.kind === "refuse") {
      say(plan.reason);
      return null;
    }
    return plan;
  };

  /** Tells the screen what is current once a move or an undo has changed the list. */
  const tellMoved = (): void => {
    latest.current.onMoved(visit.getSnapshot());
  };

  const dismiss = (hoveredKey?: string): void => {
    const plan = planMove("dismiss", hoveredKey);
    if (plan === null) return;
    const { ids, words } = plan;
    const receipt = visit.move("dismissed", plan.refs);
    tellMoved();
    const request = dismissRequest.mutateAsync(ids);
    const wasSaved = request.then(
      () => {
        visit.confirmMove(receipt);
        return true;
      },
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
          visit.undo(receipt);
          tellMoved();
          return { text: DISMISSAL_UNDONE };
        }),
    };
    undoStack.reserve(gesture, wasSaved);
    say(words.text, gesture, undefined, words.title ?? undefined);
    request.catch((error: unknown) => {
      if (!isCurrent()) return;
      visit.failMove(receipt);
      tellMoved();
      say(describeInboxDismissalFailure(plan.named, readReason(error)));
    });
  };

  /**
   * Runs one Take on, for a single thing or for several as one Task. The
   * caller has decided what to send and what to say; this does the part both
   * share: the rows move at once, the request goes out in the line, the gesture
   * takes its place on the undo stack, and a failure puts the rows back.
   *
   * - `send` makes the request and `reverse` takes it back; `reverse` returns
   *   the words of the undo line and fails when the Task was touched since.
   * - `didChange` tells whether the call wrote anything an undo can take back.
   * - `words` and `failureText` build the lines; `taskId` is the Task the line
   *   offers to open.
   */
  const runTakeOn = <Result extends { readonly taskId: string }>({
    refs,
    send,
    didChange,
    reverse,
    gestureWords,
    words,
    failureText,
  }: {
    readonly refs: readonly string[];
    readonly send: () => Promise<Result>;
    readonly didChange: (result: Result) => boolean;
    readonly reverse: (result: Result) => Promise<string>;
    readonly gestureWords: InboxLineWords;
    readonly words: (result: Result) => InboxLineWords;
    readonly failureText: (reason: string) => string;
  }): void => {
    const receipt = visit.move("taken", refs);
    tellMoved();
    // Sound because sendInLine's mutation returns exactly `send()`'s value unchanged, so the
    // result type is the caller's. Revisit if sendInLine ever transforms its output.
    const request = sendInLine.mutateAsync(send) as Promise<Result>;
    // A call that wrote nothing (it failed, or the things already had their Task) has nothing to put back.
    const wasChanged = request.then(
      (result) => {
        visit.confirmMove(receipt);
        return didChange(result);
      },
      () => false,
    );
    const gesture: Gesture<CardMover> = {
      words: joinGestureWords(gestureWords),
      undo: () =>
        reverseMove.mutateAsync(async () => {
          if (!(await wasChanged)) throw new Error(NOT_SAVED);
          const result = await request;
          requireSignedIn(scope);
          const text = await reverse(result);
          if (!isCurrent()) return undefined;
          visit.undo(receipt);
          tellMoved();
          return { text };
        }),
    };
    undoStack.reserve(gesture, wasChanged);
    request.then(
      async (result) => {
        if (!isCurrent()) return;
        const line = words(result);
        say(
          line.text,
          (await wasChanged) ? gesture : undefined,
          { label: "Go to the Task", act: () => latest.current.openTask(result.taskId) },
          line.title ?? undefined,
        );
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        visit.failMove(receipt);
        tellMoved();
        say(failureText(readReason(error)));
      },
    );
  };

  const takeOn = (hoveredKey?: string): void => {
    const plan = planMove("takeOn", hoveredKey);
    if (plan === null) return;
    if (plan.kind === "takeOnTogether") {
      const { title } = plan;
      runTakeOn({
        refs: plan.refs,
        send: () =>
          client.externalEntity.takeOnTogether({ payload: { ids: [...plan.ids], title } }),
        didChange: didTakeOnTogetherChange,
        reverse: async (result) => {
          const outcome = await client.externalEntity.undoTakeOnTogether({
            payload: { recordId: result.recordId },
          });
          // The Task was touched since, so it stays and the line says why.
          if (!outcome.undone) {
            throw new Error(outcome.reason ?? "The Task has changed since you made it.");
          }
          return describeInboxTakeOnTogetherUndone(result.created);
        },
        gestureWords: describeInboxTakeOnTogether(title, { created: true, added: 0, taken: 0 }),
        words: (result) => describeInboxTakeOnTogether(title, result),
        failureText: (reason) => describeInboxTakeOnFailure({ title }, reason),
      });
      return;
    }
    const { thing } = plan;
    runTakeOn({
      refs: [thing.ref],
      send: () => client.externalEntity.takeOn({ params: { id: thing.id } }),
      didChange: ({ created }) => created,
      reverse: async ({ taskId }) => {
        // The Task was touched since, so it stays and the line says why.
        await undoAddedTask(client, thing.id, taskId);
        return TAKE_ON_UNDONE;
      },
      gestureWords: describeInboxTakeOn(thing, true),
      words: ({ created }) => describeInboxTakeOn(thing, created),
      failureText: (reason) => describeInboxTakeOnFailure(thing, reason),
    });
  };

  /** Hands `thing`, which the caller has checked may be handed, to `offer`. */
  const sendHandOff = (
    thing: InboxListRow,
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
    const moved: { receipt?: MoveReceipt<InboxListRow> } = {};
    const roll = rollHandedRow(ref, () => {
      moved.receipt = visit.move("taken", [ref], (row) => ({
        ...buildHandedThing(row, offer),
        offers: row.offers,
      }));
    });
    const receipt = moved.receipt!;
    tellMoved();
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
            visit.undo(receipt);
            tellMoved();
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
        visit.failMove(receipt);
        tellMoved();
        if (!isCurrent()) return;
        say(describeInboxHandOffFailure(thing, offer.name, readReason(error)));
      },
    );
  };

  const handOff = (
    hoveredKey: string | undefined,
    offer: WorkflowOffer,
    connectionId: string | undefined,
  ): void => {
    const plan = planMove("handOff", hoveredKey);
    if (plan !== null) sendHandOff(plan.thing, offer, connectionId);
  };

  const startHandOff = (hoveredKey?: string): InboxListRow | null => {
    const plan = planMove("handOff", hoveredKey);
    if (plan === null) return null;
    const { thing } = plan;
    const move = decideHandMove(thing.offers);
    if (move.kind === "one") {
      sendHandOff(thing, move.offer, undefined);
      return null;
    }
    return move.kind === "several" ? thing : null;
  };

  const goToTask = (hoveredKey?: string): void => {
    const plan = planMove("goToTask", hoveredKey);
    if (plan !== null) latest.current.openTask(plan.taskId);
  };

  /**
   * Links `fromRef` to `toRefs` in one call, in the line of the moves, and says
   * what happened, with an Undo that unlinks exactly what the call created.
   * `named` are the things the line names. A failure saves nothing. Afterwards
   * the visit reads again, which is what draws the group. Returns whether a
   * link was written.
   */
  const linkSet = (
    fromRef: string,
    toRefs: readonly string[],
    named: readonly InboxLinkEnd[],
  ): Promise<boolean> => {
    const request = linkRequest.mutateAsync({ fromRef, toRefs: [...toRefs] });
    const wasLinked = request.then(
      ({ created }) => created.length > 0,
      () => false,
    );
    const gesture: Gesture<CardMover> = {
      words: joinGestureWords(describeInboxLink(named, true)),
      undo: () =>
        reverseMove.mutateAsync(async () => {
          if (!(await wasLinked)) throw new Error(NOT_SAVED);
          const { created } = await request;
          requireSignedIn(scope);
          await client.externalEntity.unlink({ payload: { fromRef, toRefs: created } });
          visit.pushArrived();
          return { text: LINK_UNDONE };
        }),
    };
    undoStack.reserve(gesture, wasLinked);
    request.then(
      ({ created }) => {
        if (!isCurrent()) return;
        if (created.length > 0) visit.linkMade([fromRef, ...created]);
        const words = describeInboxLink(named, created.length > 0);
        say(
          words.text,
          created.length > 0 ? gesture : undefined,
          undefined,
          words.title ?? undefined,
        );
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        say(describeInboxLinkFailure(readReason(error)));
      },
    );
    return wasLinked;
  };

  const startLink = (hoveredKey?: string): InboxLinkPick | null => {
    const plan = planMove("link", hoveredKey);
    if (plan === null) return null;
    if (plan.kind === "pickLink") return plan;
    void linkSet(plan.fromRef, plan.toRefs, plan.named);
    return null;
  };

  const linkTo = (from: InboxLinkEnd, to: InboxLinkEnd): Promise<boolean> => {
    if (latest.current.isOffline) {
      say(REFUSED_OFFLINE);
      return Promise.resolve(false);
    }
    return linkSet(from.ref, [to.ref], [from, to]);
  };

  const unlink = (first: InboxLinkEnd, second: InboxLinkEnd): void => {
    if (latest.current.isOffline) {
      say(REFUSED_OFFLINE);
      return;
    }
    const input = { fromRef: first.ref, toRefs: [second.ref] };
    const request = unlinkRequest.mutateAsync(input);
    const wasRemoved = request.then(
      ({ results }) => results[0]!.removed,
      () => false,
    );
    const gesture: Gesture<CardMover> = {
      words: "Unlinked",
      undo: () =>
        reverseMove.mutateAsync(async () => {
          if (!(await wasRemoved)) throw new Error(NOT_SAVED);
          requireSignedIn(scope);
          await client.externalEntity.link({ payload: input });
          visit.pushArrived();
          return { text: UNLINK_UNDONE };
        }),
    };
    undoStack.reserve(gesture, wasRemoved);
    request.then(
      ({ results }) => {
        if (!isCurrent()) return;
        visit.pushArrived();
        const result = results[0]!;
        const words = describeInboxUnlink(first, second, result);
        say(words.text, result.removed ? gesture : undefined, undefined, words.title ?? undefined);
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        say(describeInboxUnlinkFailure(readReason(error)));
      },
    );
  };

  const openAtSource = (): void => {
    const { rows, current } = visit.getSnapshot();
    const thing = rows.find((row) => row.ref === current);
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
    goToTask,
    startLink,
    linkTo,
    unlink,
    openAtSource,
    say: (text) => {
      say(text);
    },
    sayWithUndo: (text, gesture) => {
      undoStack.reserve(gesture, Promise.resolve(true));
      say(text, gesture);
      return () => {
        withdraw(gesture);
      };
    },
    restate,
    tellMoved,
    line,
    holdLine: hold,
    undoLastMove: undo,
  };
};
