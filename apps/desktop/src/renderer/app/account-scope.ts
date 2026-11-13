/**
 * The account scope: everything the window holds for the signed-in user that
 * must not outlive the sign-in. It is the one place that knows what sign-out
 * has to undo:
 *
 * - the undo stack (Undo must not reach the next user);
 * - the card moves the controller has not answered yet;
 * - the pending intents, with their undo-window timers;
 * - the reply drafts;
 * - the check a request makes before it goes on with its answer.
 *
 * A request that waits (a read before a spawn, a Try again on its way) can end
 * after sign-out. The client sends the token it holds at the moment of each
 * call, so a late call would go out as the next account, and a late write would
 * land in the next account's cache. So every continuation of such a request
 * asks `isCurrent()` first and does nothing when it is `false`.
 *
 * The scope is opened once the shell knows the user (its loader) and closed at
 * sign-out. Closing cancels every held timer, empties the undo stack and the
 * pending moves, and makes `isCurrent()` return `false` for good. What the
 * pending intents still held stays in storage, under the controller and user,
 * and comes back as unsent when that user opens a scope again. Main reloads
 * the window for another controller, which builds new scopes, so a controller
 * change needs no close.
 */
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import { actOnSignal } from "./act-on-signal";
import type { CardMover } from "./card-mover";
import { createPendingCardMoves, type PendingCardMoves } from "./pending-card-moves";
import {
  buildPendingIntentsKey,
  createPendingIntents,
  type IntentContent,
  type IntentStorage,
  type PendingIntents,
} from "./pending-intents";
import { createReplyDrafts, type ReplyDrafts } from "./reply-drafts";
import { createUndoStack, type UndoStack } from "./undo-stack";

/**
 * Throws when the user who made a request has signed out, so nothing goes to
 * the controller as the next account. Call it when a queued request reaches
 * the front of its line and after each wait in it.
 */
export const requireSignedIn = (scope: Pick<AccountScope, "isCurrent">): void => {
  if (!scope.isCurrent()) throw new Error("You signed out before this was sent.");
};

/** What the window holds for one signed-in user on one controller. */
export interface AccountScope {
  readonly username: string;
  /** The gestures the user made on Work and the Inbox, which Undo reverses one at a time. Nothing is saved. */
  readonly undoStack: UndoStack<CardMover>;
  /**
   * The card moves the controller has not answered yet. They live here, not in
   * the Work screen, so a screen opened again after a visit elsewhere still
   * draws a card as Done while its update is on the way, and Undo can queue
   * its inverse behind that update.
   */
  readonly pendingCardMoves: PendingCardMoves;
  /** The answers and merges the app holds back for the undo line before it sends them. */
  readonly pendingIntents: PendingIntents;
  /** The words typed into reply boxes and not yet sent, which a closed box gives back when it opens again. */
  readonly replyDrafts: ReplyDrafts;
  /**
   * Returns whether this user is still the one signed in. It is `false` once
   * the scope is closed, and once the client no longer holds the token the
   * scope was opened with. Neither comes back. Ask it before any step of a
   * request that acts for the user or writes to the shared caches.
   */
  readonly isCurrent: () => boolean;
}

/** The place where the window keeps the scope of the signed-in user. */
export interface AccountScopes {
  /**
   * Returns the scope of the user `username`, creating it on first use.
   * Asking again for the same user returns the same scope. Asking for another
   * user closes the first user's scope. Call it from a loader or an event, not
   * while rendering: creating a scope reads storage.
   */
  readonly open: (username: string) => AccountScope;
  /**
   * Returns the open scope. Fails when none is open, which is a bug: the
   * shell's loader opens it before any screen that reads it renders.
   */
  readonly read: () => AccountScope;
  /** Closes the open scope, as sign-out does. Does nothing when none is open. */
  readonly close: () => void;
}

/**
 * Reads the board and the details of each of the Tasks `taskIds` again and
 * waits for all. A failed read is ignored: the controller already accepted the
 * change, so the intent is done, and the live pushes bring the reads up to date.
 *
 * It waits so that the intent leaves the store only once the reads show the
 * change. Otherwise the card would draw its question again (or the merged card
 * would come back) until the reads arrived. A read that began before the change
 * is cancelled and started again.
 */
const readAgainAfterChange = async (
  queryClient: QueryClient,
  ...taskIds: readonly string[]
): Promise<void> => {
  await Promise.allSettled([
    queryClient.invalidateQueries({ queryKey: queryKeys.workBoard(), refetchType: "active" }),
    ...taskIds.map((taskId) =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.taskDetail(taskId),
        refetchType: "active",
      }),
    ),
  ]);
};

/**
 * Returns the function that sends an intent to the controller and resolves
 * once the reads it changes have been refreshed. It rejects when the
 * controller refuses the intent or cannot be reached, and when the user has
 * signed out before the send, which can happen in the moment between the token
 * going and the scope closing. When the scope has closed by the time the
 * controller answers, it leaves the caches alone: they belong to the next user.
 */
const buildIntentSender =
  (client: HerculeClient, queryClient: QueryClient, isCurrent: () => boolean) =>
  async (intent: IntentContent): Promise<void> => {
    requireSignedIn({ isCurrent });
    switch (intent.kind) {
      case "answer":
        await client.session.respondToQuestion({
          params: { id: intent.sessionId },
          payload: { requestId: intent.requestId, answers: intent.answers },
        });
        if (isCurrent()) await readAgainAfterChange(queryClient, intent.taskId);
        return;
      case "merge":
        await client.task.merge({
          params: { id: intent.taskId },
          payload: { intoTaskId: intent.intoTaskId },
        });
        if (isCurrent()) await readAgainAfterChange(queryClient, intent.taskId, intent.intoTaskId);
        return;
      case "signal-answer":
        await actOnSignal(client, queryClient, isCurrent, intent);
        return;
    }
  };

/**
 * Creates the holder for the controller at `controllerUrl`, whose requests go
 * through `client` and whose reads are cached in `queryClient`. The pending
 * intents are kept in `storage`.
 */
export const createAccountScopes = ({
  controllerUrl,
  client,
  queryClient,
  storage,
}: {
  readonly controllerUrl: string;
  readonly client: HerculeClient;
  readonly queryClient: QueryClient;
  readonly storage: IntentStorage;
}): AccountScopes => {
  let open: { readonly scope: AccountScope; readonly close: () => void } | null = null;

  const close = (): void => {
    open?.close();
    open = null;
  };

  return {
    open: (username) => {
      if (open?.scope.username === username) return open.scope;
      close();
      const token = client.getToken();
      let isClosed = false;
      const isCurrent = (): boolean => !isClosed && client.getToken() === token;
      const scope: AccountScope = {
        username,
        undoStack: createUndoStack(),
        pendingCardMoves: createPendingCardMoves(),
        pendingIntents: createPendingIntents({
          storage,
          storageKey: buildPendingIntentsKey(controllerUrl, username),
          send: buildIntentSender(client, queryClient, isCurrent),
        }),
        replyDrafts: createReplyDrafts(),
        isCurrent,
      };
      open = {
        scope,
        close: () => {
          isClosed = true;
          scope.pendingIntents.dispose();
          scope.undoStack.clear();
          scope.pendingCardMoves.clear();
          scope.replyDrafts.clear();
        },
      };
      return scope;
    },
    read: () => {
      if (open === null) {
        throw new Error(
          "No account scope is open: the shell's loader opens it once it knows the user.",
        );
      }
      return open.scope;
    },
    close,
  };
};
