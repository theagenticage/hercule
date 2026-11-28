/**
 * The answers of the Inbox's pane. An answer is a move on the list: the thing
 * stays in its row and the current row moves on, as for Take on.
 *
 * - An answer that acts on the source (a plugin's action) is held for eight
 *   seconds with Undo and then sent, by the account scope's held answers
 *   (`held-signal-answers.ts`). This hook attaches the Inbox's list, undo
 *   line and pane to them while it is mounted.
 * - Any other answer, and Done, is sent at once. Done has no Undo anywhere in
 *   the app, so its line says that.
 * - Offline, an answer is refused like every other Inbox move.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys, trimAnswerEllipsis, type HerculeClient } from "@hercule/client-core";
import {
  REFUSED_OFFLINE,
  describeAnswerFailure,
  describeMarkedDone,
  isAnswerHeld,
} from "@hercule/client-core/inbox";
import type { Signal, SignalAction } from "@hercule/contract";
import { actOnSignal } from "../../../app/act-on-signal";
import { requireSignedIn, type AccountScope } from "../../../app/account-scope";
import { readReason } from "../../../app/read-reason";
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
  /** Opens the reply box again, when Undo takes the held reply back. */
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
  showThing,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly visit: InboxListVisit;
  readonly moves: Pick<InboxMoves, "say" | "sayWithUndo" | "restate" | "tellMoved">;
  readonly isOffline: boolean;
  /** Shows the thing `ref` alone in the pane, whatever the pane showed before. */
  readonly showThing: (ref: string) => void;
}): InboxAnswers => {
  const queryClient = useQueryClient();
  const held = scope.heldSignalAnswers;
  const latest = useRef({ visit, moves, isOffline, showThing });
  useLayoutEffect(() => {
    latest.current = { visit, moves, isOffline, showThing };
  });
  // The held answers draw through the newest of these while the Inbox is mounted, and stop when it unmounts.
  useEffect(
    () =>
      held.attach({
        line: {
          sayWithUndo: (text, gesture) => latest.current.moves.sayWithUndo(text, gesture),
          restate: (gesture, update) => {
            latest.current.moves.restate(gesture, update);
          },
        },
        takeRow: (ref) => {
          const { visit: list } = latest.current;
          const receipt = list.move("taken", [ref]);
          return {
            confirm: () => {
              list.confirmMove(receipt);
            },
            putBack: () => {
              list.undo(receipt);
            },
            fail: () => {
              list.failMove(receipt);
            },
          };
        },
        moved: () => {
          latest.current.moves.tellMoved();
        },
        showThing: (ref) => {
          latest.current.showThing(ref);
        },
        say: (text) => {
          latest.current.moves.say(text);
        },
        isOffline: () => latest.current.isOffline,
      }),
    [held],
  );

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

  return {
    answer: (request) => {
      const label = trimAnswerEllipsis(request.action.label);
      if (isAnswerHeld(request.action)) {
        const { thing, signalId, action, text, sourceName, replyTo, reopenReply } = request;
        return scope.heldSignalAnswers.hold({
          thing,
          signalId,
          actionId: action.id,
          label,
          text,
          sourceName,
          replyTo,
          reopenReply,
        });
      }
      if (isOffline) {
        moves.say(REFUSED_OFFLINE);
        return false;
      }
      sendNow(
        request,
        label,
        () =>
          actOnSignal(client, queryClient, scope.isCurrent, {
            signalId: request.signalId,
            actionId: request.action.id,
            text: request.text,
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
        async () => {
          await client.signal.markDone({ payload: { signalIds: [request.signalId] } });
          // Done returns no signal: show the cached one as resolved until the controller's push reads the lists.
          if (scope.isCurrent()) {
            queryClient.setQueryData<Signal>(queryKeys.signal(request.signalId), (cached) =>
              cached === undefined ? undefined : { ...cached, status: "resolved" },
            );
          }
        },
        describeMarkedDone(request.sourceName),
      );
    },
  };
};
