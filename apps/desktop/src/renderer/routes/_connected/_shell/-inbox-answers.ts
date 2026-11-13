/**
 * The answers of the Inbox's pane. An answer is a move on the list: the thing
 * stays in its row and the current row moves on, as for Take on.
 *
 * - An answer that acts on the source (a plugin's action) is held for eight
 *   seconds with Undo (`holdWithUndo`) and then sent. Undo within the hold
 *   makes the thing current again, and opens a reply's box with its words.
 *   After the send, Undo says it is too late and changes nothing.
 * - Any other answer, and Done, is sent at once. Done has no Undo anywhere in
 *   the app, so its line says that.
 * - Offline, an answer is refused like every other Inbox move.
 */
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys, trimAnswerEllipsis, type HerculeClient } from "@hercule/client-core";
import {
  ANSWER_CANCELLED,
  REFUSED_OFFLINE,
  describeAnswerFailure,
  describeAnswerSending,
  describeAnswerSent,
  describeAnswerTooLate,
  describeHeldAnswer,
  isAnswerHeld,
} from "@hercule/client-core/inbox";
import type { SignalAction } from "@hercule/contract";
import { requireSignedIn, type AccountScope } from "../../../app/account-scope";
import { readReason } from "../../../app/read-reason";
import { holdWithUndo } from "../../../app/use-pending-intents";
import type { InboxMoves } from "./-inbox-moves";
import type { InboxListRow, InboxListVisit } from "./-inbox-visit";

/** One answer the user gave on an ask of a thing. */
export interface ThingAnswer {
  readonly thing: Pick<InboxListRow, "ref" | "id" | "identifier">;
  readonly signalId: string;
  readonly action: Pick<SignalAction, "id" | "label" | "operation">;
  /** The words typed in the reply box, for an action with a field. */
  readonly text?: string | undefined;
  /** The name of the source, such as "GitHub". */
  readonly sourceName: string;
  /** The asker's name, which a reply's line names. */
  readonly replyTo?: string | undefined;
  /** Opens the reply box again with its words, when Undo takes the held reply back. */
  readonly reopenReply?: (() => void) | undefined;
}

/** What `useInboxAnswers` returns. */
export interface InboxAnswers {
  /**
   * Gives the answer `request`: held and sent after eight seconds, or sent at
   * once. Returns false, with the reason on the undo line, when the answer was
   * refused and nothing happened.
   */
  readonly answer: (request: ThingAnswer) => boolean;
  /** Ends the ask `request.signalId` here with Done. The source is not told. */
  readonly markDone: (request: Omit<ThingAnswer, "action" | "text">) => void;
}

/**
 * Makes the answers of the pane for `client`, for the user of `scope`, over the
 * list `visit` holds. `moves` lends the undo line and the focus after a move.
 */
export const useInboxAnswers = ({
  client,
  scope,
  visit,
  moves,
  isOffline,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly visit: InboxListVisit;
  readonly moves: Pick<InboxMoves, "say" | "sayWithUndo" | "tellMoved">;
  readonly isOffline: boolean;
}): InboxAnswers => {
  const queryClient = useQueryClient();
  const store = scope.pendingIntents;

  /** Reads again what an answer changed: the thing, the signal and the list. */
  const readAgain = (request: Pick<ThingAnswer, "thing" | "signalId">): void => {
    if (!scope.isCurrent()) return;
    for (const queryKey of [
      queryKeys.externalEntity(request.thing.id),
      queryKeys.signal(request.signalId),
      queryKeys.inbox(),
    ]) {
      void queryClient.invalidateQueries({ queryKey, refetchType: "active" });
    }
  };

  /** Sends `send` now and settles the row: confirmed when it works, put back with the reason when it fails. */
  const sendNow = (
    request: ThingAnswer,
    label: string,
    send: () => Promise<unknown>,
    sentLine: string | undefined,
  ): void => {
    const receipt = visit.move("taken", [request.thing.ref]);
    moves.tellMoved();
    Promise.resolve()
      .then(() => {
        requireSignedIn(scope);
        return send();
      })
      .then(
        () => {
          visit.confirmMove(receipt);
          readAgain(request);
          if (sentLine !== undefined && scope.isCurrent()) moves.say(sentLine);
        },
        (error: unknown) => {
          if (!scope.isCurrent()) return;
          visit.failMove(receipt);
          moves.tellMoved();
          moves.say(
            describeAnswerFailure(
              { label, identifier: request.thing.identifier, sourceName: request.sourceName },
              readReason(error),
            ),
          );
        },
      );
  };

  const hold = (request: ThingAnswer, label: string): void => {
    const { thing, signalId, action, text, sourceName, replyTo } = request;
    const receipt = visit.move("taken", [thing.ref]);
    moves.tellMoved();
    const words = describeHeldAnswer({
      label,
      identifier: thing.identifier,
      sourceName,
      ...(replyTo === undefined ? {} : { replyTo }),
    });
    const intentId = holdWithUndo(
      store,
      {
        kind: "signal-answer",
        signalId,
        entityId: thing.id,
        actionId: action.id,
        ...(text === undefined ? {} : { text }),
        sourceName,
      },
      {
        sayWithUndo: moves.sayWithUndo,
        line: `${words.text}. ${words.note}.`,
        words: words.text,
        cancelledText: ANSWER_CANCELLED,
        afterSending: {
          text: describeAnswerTooLate(sourceName),
          sendingText: describeAnswerSending(sourceName),
          sentLine: describeAnswerSent(sourceName),
        },
      },
    );
    const stopWatching = store.watch(intentId, (progress) => {
      if (progress === "sending") return;
      stopWatching();
      if (progress === "sent") {
        visit.confirmMove(receipt);
        return;
      }
      // Cancelled by Undo: the thing is current again and a reply's box opens with its words.
      // Failed: the thing is back with its reason in the ask.
      if (progress === "cancelled") {
        visit.undo(receipt);
        request.reopenReply?.();
      } else visit.failMove(receipt);
      moves.tellMoved();
    });
  };

  return {
    answer: (request) => {
      if (isOffline) {
        moves.say(REFUSED_OFFLINE);
        return false;
      }
      const label = trimAnswerEllipsis(request.action.label);
      if (isAnswerHeld(request.action)) {
        hold(request, label);
        return true;
      }
      sendNow(
        request,
        label,
        () =>
          client.signal.act({
            params: { id: request.signalId },
            payload:
              request.text === undefined
                ? { actionId: request.action.id }
                : { actionId: request.action.id, text: request.text },
          }),
        undefined,
      );
      return true;
    },
    markDone: (request) => {
      if (isOffline) {
        moves.say(REFUSED_OFFLINE);
        return;
      }
      sendNow(
        { ...request, action: { id: "done", label: "Done", operation: null } },
        "Done",
        () => client.signal.markDone({ payload: { signalIds: [request.signalId] } }),
        `Marked done. ${request.sourceName} was not told, and it can't be undone here.`,
      );
    },
  };
};
