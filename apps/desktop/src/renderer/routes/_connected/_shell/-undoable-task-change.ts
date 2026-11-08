/**
 * How the details pane sends a change of one Task that the user can undo: a
 * link, a blocker, an Initiative. The undo line and the undo stack work the
 * same way for each, so the rules live here once.
 *
 * - Each change is one gesture on the undo stack, and its words are on the
 *   undo line, both taken when the user acts and while the request is still
 *   running. The line belongs to that moment and not to the order in which
 *   answers come, so a slow answer never takes the line from a gesture the
 *   user made after it. Its Undo is the change the other way.
 * - Every request and every reversal of one kind of change runs in one queue
 *   (the mutation scope), so a gesture made after Undo is sent after it.
 * - The controller says whether a call changed anything. A call that changed
 *   nothing takes its gesture off the stack again, and the line says so. A
 *   reversal is sent only when the gesture it reverses changed something, so
 *   Undo never makes a change the user did not ask for.
 * - The same change is not sent again while the first is on its way, so a
 *   double press cannot queue a second one.
 * - A refusal takes the gesture off the stack and the line says why. Nothing
 *   is queued for later when the controller cannot be reached: the line says
 *   the change was not made, and the user tries again.
 */
import { useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { requireSignedIn, type AccountScope } from "../../../app/account-scope";
import type { CardMover } from "../../../app/card-mover";
import type { Gesture } from "../../../app/undo-stack";
import type { CardMoves } from "./-card-moves";

const NOTHING_TO_PUT_BACK = "That change was not made, so there is nothing to put back.";

/** What one send answers: whether the controller changed anything. */
export interface TaskChangeAnswer {
  readonly changed: boolean;
}

/** One change of a Task, as `useUndoableTaskChanges` sends it. */
export interface UndoableTaskChange {
  /** Names the change while it is on its way: a second change with the same key is dropped. */
  readonly key: string;
  /** The Task the change is on, whose details are read again after it. */
  readonly taskId: string;
  /** Sends the change. */
  readonly send: () => Promise<TaskChangeAnswer>;
  /** Sends the change the other way, for Undo. */
  readonly sendBack: () => Promise<TaskChangeAnswer>;
  /** Reads again what the change touched. Called after an answer and after an Undo, while the user is signed in. */
  readonly readAgain: () => void;
  readonly words: {
    /** The gesture as Undo reports it ("Put back: ..."). */
    readonly gesture: string;
    /** The sentence for the undo line when the user acts. */
    readonly done: string;
    /** The sentence that replaces `done` when the change found nothing to do. */
    readonly nothing: string;
    /** The sentence that replaces `done` when the change was refused or never arrived. */
    readonly failed: (error: unknown) => string;
  };
}

/**
 * Returns the function that sends an `UndoableTaskChange`. `moves` puts the
 * gesture on the undo stack and says what happened on the undo line, and
 * `scope` says whether the user who made a change is still signed in.
 * `queueId` names the queue the changes of one kind wait in.
 *
 * The function resolves, when the change was answered or refused, to the
 * error of a refused change, so the caller can show it somewhere else too,
 * and to `null` otherwise. It never rejects.
 */
export const useUndoableTaskChanges = ({
  scope,
  moves,
  queueId,
}: {
  readonly scope: AccountScope;
  readonly moves: Pick<CardMoves, "reserveGesture" | "sayWithReservedUndo" | "sayWithoutUndo">;
  readonly queueId: string;
}): ((change: UndoableTaskChange) => Promise<unknown>) => {
  // The changes on their way, by key: a second one with the same key waits for nobody.
  const onItsWay = useRef(new Set<string>());

  const request = useMutation({
    mutationKey: [queueId],
    scope: { id: queueId },
    mutationFn: async ({
      send,
      isWanted,
    }: {
      readonly send: () => Promise<TaskChangeAnswer>;
      /** For a reversal: resolves to whether the change it reverses was made. */
      readonly isWanted: Promise<boolean> | undefined;
    }) => {
      // Checked when the request reaches the front of the queue, so a change that was refused is never reversed.
      requireSignedIn(scope);
      if (isWanted !== undefined && !(await isWanted)) throw new Error(NOTHING_TO_PUT_BACK);
      requireSignedIn(scope);
      return send();
    },
  });

  return async (change) => {
    if (onItsWay.current.has(change.key)) return null;
    onItsWay.current.add(change.key);
    const answered = request.mutateAsync({ send: change.send, isWanted: undefined });
    const wasChanged = answered.then(
      ({ changed }) => changed,
      () => false,
    );
    void wasChanged.then(() => {
      onItsWay.current.delete(change.key);
    });
    const gesture: Gesture<CardMover> = {
      words: change.words.gesture,
      undo: async () => {
        await request.mutateAsync({ send: change.sendBack, isWanted: wasChanged });
        if (scope.isCurrent()) change.readAgain();
        return undefined;
      },
    };
    moves.reserveGesture(gesture, wasChanged);
    moves.sayWithReservedUndo(change.words.done, gesture);
    try {
      const { changed } = await answered;
      if (!scope.isCurrent()) return null;
      change.readAgain();
      if (!changed) moves.sayWithoutUndo(change.words.nothing);
      return null;
    } catch (error) {
      if (scope.isCurrent()) moves.sayWithoutUndo(change.words.failed(error));
      return error;
    }
  };
};
