import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import type { TriggerKey } from "@hercule/contract";

/**
 * Returns the one mutation the web app resumes a start trigger with. Its
 * variable is `discardHeld`: `true` discards the trigger's held events before
 * it resumes, `false` keeps them, to start runs as the window frees up.
 *
 * On success it refetches:
 *
 * - every trigger read, through the `triggers` prefix: the workflow's list,
 *   the list on Settings > Bounds, and the trigger's held events;
 * - the notifications, because a resume answers the decision the breaker
 *   raised about the trigger.
 *
 * `onSuccess` returns the refetch, so the mutation stays pending until the
 * new trigger is read. The buttons that send it then never show the paused
 * trigger after the response.
 */
export const useResumeTrigger = (client: HerculeClient, key: TriggerKey) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (discardHeld: boolean) =>
      client.trigger.resume({
        params: key,
        payload: discardHeld ? { discardHeld: true } : {},
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.triggers() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications() }),
      ]),
  });
};
