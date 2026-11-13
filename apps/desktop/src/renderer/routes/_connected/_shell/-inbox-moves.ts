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
import type { WorkflowOffer } from "@hercule/contract";
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

/** The two ends of a link, as `link` and `unlink` take them. */
interface LinkPair {
  readonly fromRef: string;
  readonly toRef: string;
}

/** What linking some pairs did: the pairs whose link this call wrote, and the failure that stopped it, if any. */
interface LinkOutcome {
  readonly created: readonly LinkPair[];
  readonly failure?: unknown;
}

/**
 * Links `pairs` one after the other and returns the pairs this call wrote
 * (the controller answers `created: false` for a pair the user had already
 * linked). It stops at the first failure and returns it with what was written
 * until then, so the caller can still offer to undo that.
 */
const linkEveryPair = async (
  client: HerculeClient,
  pairs: readonly LinkPair[],
): Promise<LinkOutcome> => {
  const created: LinkPair[] = [];
  for (const pair of pairs) {
    try {
      const result = await client.externalEntity.link({ payload: pair });
      if (result.created) created.push(pair);
    } catch (failure) {
      return { created, failure };
    }
  }
  return { created };
};

/**
 * Unlinks `pairs` one after the other. It stops at the first failure and
 * returns it, or returns `undefined` when every pair is unlinked.
 */
const unlinkEveryPair = async (
  client: HerculeClient,
  pairs: readonly LinkPair[],
): Promise<Error | undefined> => {
  for (const pair of pairs) {
    try {
      await client.externalEntity.unlink({ payload: pair });
    } catch (failure) {
      return failure instanceof Error ? failure : new Error(readReason(failure));
    }
  }
  return undefined;
};

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
  const takeOnRequest = useMoveRequest(scope, (id: string) =>
    client.externalEntity.takeOn({ params: { id } }),
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
  const takeOnTogetherRequest = useMoveRequest(
    scope,
    (input: { readonly ids: string[]; readonly title: string }) =>
      client.externalEntity.takeOnTogether({ payload: input }),
  );
  const linkRequest = useMoveRequest(scope, (pairs: readonly LinkPair[]) =>
    linkEveryPair(client, pairs),
  );
  const unlinkRequest = useMoveRequest(scope, (pair: LinkPair) =>
    client.externalEntity.unlink({ payload: pair }),
  );
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
   * Takes the things of a group or of a selection of several on as one Task.
   * The undo takes back what the call wrote, and is offered only when the
   * call wrote something: a Task, a link to it or a taken mark.
   */
  const takeOnTogether = (
    together: Extract<InboxMovePlans<InboxListRow>["takeOn"], { kind: "takeOnTogether" }>,
  ): void => {
    const receipt = visit.move("taken", together.refs);
    tellMoved();
    const request = takeOnTogetherRequest.mutateAsync({
      ids: [...together.ids],
      title: together.title,
    });
    const wasChanged = request.then(
      (result) => {
        visit.confirmMove(receipt);
        return didTakeOnTogetherChange(result);
      },
      () => false,
    );
    const gesture: Gesture<CardMover> = {
      words: joinGestureWords(
        describeInboxTakeOnTogether(together.title, { created: true, added: [], taken: [] }),
      ),
      undo: () =>
        reverseMove.mutateAsync(async () => {
          if (!(await wasChanged)) throw new Error(NOT_SAVED);
          const result = await request;
          requireSignedIn(scope);
          const outcome = await client.externalEntity.undoTakeOnTogether({ payload: result });
          // The Task was touched since, so it stays and the line says why.
          if (!outcome.undone) {
            throw new Error(outcome.reason ?? "The Task has changed since you made it.");
          }
          if (!isCurrent()) return undefined;
          visit.undo(receipt);
          tellMoved();
          return { text: describeInboxTakeOnTogetherUndone(result.created) };
        }),
    };
    undoStack.reserve(gesture, wasChanged);
    request.then(
      async (result) => {
        if (!isCurrent()) return;
        const words = describeInboxTakeOnTogether(together.title, result);
        say(
          words.text,
          (await wasChanged) ? gesture : undefined,
          { label: "Go to the Task", act: () => latest.current.openTask(result.taskId) },
          words.title ?? undefined,
        );
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        visit.failMove(receipt);
        tellMoved();
        say(describeInboxTakeOnFailure({ title: together.title }, readReason(error)));
      },
    );
  };

  const takeOn = (hoveredKey?: string): void => {
    const plan = planMove("takeOn", hoveredKey);
    if (plan === null) return;
    if (plan.kind === "takeOnTogether") {
      takeOnTogether(plan);
      return;
    }
    const { thing } = plan;
    const receipt = visit.move("taken", [thing.ref]);
    tellMoved();
    const request = takeOnRequest.mutateAsync(thing.id);
    // A Take on that made no Task (it failed, or the thing already had one) has nothing to put back.
    const wasCreated = request.then(
      ({ created }) => {
        visit.confirmMove(receipt);
        return created;
      },
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
          visit.undo(receipt);
          tellMoved();
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
        visit.failMove(receipt);
        tellMoved();
        say(describeInboxTakeOnFailure(thing, readReason(error)));
      },
    );
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
   * Links `pairs` in the line of the moves and says what happened, with an Undo
   * that unlinks only the pairs this call wrote. `named` are the things the
   * line names. Afterwards the visit reads again, which is what draws the group.
   */
  const linkPairs = (
    pairs: readonly LinkPair[],
    named: readonly InboxLinkEnd[],
  ): Promise<boolean> => {
    const request = linkRequest
      .mutateAsync(pairs)
      .catch((error: unknown): LinkOutcome => ({ created: [], failure: error }));
    const wasLinked = request.then(({ created }) => created.length > 0);
    const gesture: Gesture<CardMover> = {
      words: joinGestureWords(describeInboxLink(named, true)),
      undo: () =>
        reverseMove.mutateAsync(async () => {
          if (!(await wasLinked)) throw new Error(NOT_SAVED);
          const { created } = await request;
          requireSignedIn(scope);
          // An unlink that fails part way has still taken some pairs away, so the list reads again either way.
          const failure = await unlinkEveryPair(client, created);
          visit.pushArrived();
          if (failure !== undefined) throw failure;
          return { text: LINK_UNDONE };
        }),
    };
    undoStack.reserve(gesture, wasLinked);
    // The request never rejects: its failure is folded into the outcome above.
    void request.then(({ created, failure }) => {
      if (!isCurrent()) return;
      if (created.length > 0) visit.linkMade(created.flatMap((pair) => [pair.fromRef, pair.toRef]));
      if (failure !== undefined) {
        say(
          describeInboxLinkFailure(readReason(failure)),
          created.length > 0 ? gesture : undefined,
        );
        return;
      }
      const words = describeInboxLink(named, created.length > 0);
      say(
        words.text,
        created.length > 0 ? gesture : undefined,
        undefined,
        words.title ?? undefined,
      );
    });
    return wasLinked;
  };

  const startLink = (hoveredKey?: string): InboxLinkPick | null => {
    const plan = planMove("link", hoveredKey);
    if (plan === null) return null;
    if (plan.kind === "pickLink") return plan;
    void linkPairs(
      plan.toRefs.map((toRef) => ({ fromRef: plan.fromRef, toRef })),
      plan.named,
    );
    return null;
  };

  const linkTo = (from: InboxLinkEnd, to: InboxLinkEnd): Promise<boolean> => {
    if (latest.current.isOffline) {
      say(REFUSED_OFFLINE);
      return Promise.resolve(false);
    }
    return linkPairs([{ fromRef: from.ref, toRef: to.ref }], [from, to]);
  };

  const unlink = (first: InboxLinkEnd, second: InboxLinkEnd): void => {
    if (latest.current.isOffline) {
      say(REFUSED_OFFLINE);
      return;
    }
    const pair = { fromRef: first.ref, toRef: second.ref };
    const request = unlinkRequest.mutateAsync(pair);
    const wasRemoved = request.then(
      ({ removed }) => removed,
      () => false,
    );
    const gesture: Gesture<CardMover> = {
      words: "Unlinked",
      undo: () =>
        reverseMove.mutateAsync(async () => {
          if (!(await wasRemoved)) throw new Error(NOT_SAVED);
          requireSignedIn(scope);
          await client.externalEntity.link({ payload: pair });
          visit.pushArrived();
          return { text: UNLINK_UNDONE };
        }),
    };
    undoStack.reserve(gesture, wasRemoved);
    request.then(
      (result) => {
        if (!isCurrent()) return;
        visit.pushArrived();
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
