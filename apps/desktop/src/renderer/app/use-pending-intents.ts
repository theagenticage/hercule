/**
 * How components reach the held intents (`pending-intents.ts`): the store of
 * the signed-in user, what it sends, and a hook that redraws when it changes.
 */
import { useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import type { SavedController } from "./context";
import type { IntentContent, PendingIntent, PendingIntents } from "./pending-intents";

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
 * controller refuses the intent or cannot be reached.
 */
const buildIntentSender =
  (client: HerculeClient, queryClient: QueryClient) =>
  async (intent: IntentContent): Promise<void> => {
    switch (intent.kind) {
      case "answer":
        await client.session.respondToQuestion({
          params: { id: intent.sessionId },
          payload: { requestId: intent.requestId, answers: intent.answers },
        });
        await readAgainAfterChange(queryClient, intent.taskId);
        return;
      case "merge":
        await client.task.merge({
          params: { id: intent.taskId },
          payload: { intoTaskId: intent.intoTaskId },
        });
        await readAgainAfterChange(queryClient, intent.taskId, intent.intoTaskId);
        return;
    }
  };

/** What `usePendingIntents` returns. */
export interface HeldIntents {
  /** The store, to hold, undo, retry and discard intents. */
  readonly store: PendingIntents;
  /** The intents the store holds now, oldest first. */
  readonly intents: readonly PendingIntent[];
}

/**
 * Returns the store of the signed-in user `username` on `controller`, and the
 * intents it holds, and redraws the caller when they change. The store is
 * opened on first use and lives in the controller, not in the component, so
 * an intent goes on when the user leaves the screen that made it.
 */
export const usePendingIntents = (controller: SavedController, username: string): HeldIntents => {
  const queryClient = useQueryClient();
  const store = controller.pendingIntents.open(
    username,
    buildIntentSender(controller.client, queryClient),
  );
  const intents = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, intents };
};
