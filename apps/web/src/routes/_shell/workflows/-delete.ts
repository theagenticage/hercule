import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";

/**
 * Handles Delete on a workflow's page: a confirmation question first, then
 * the delete request, then a return to the list once it succeeds. Returns
 * the delete mutation, whether the question is showing, and functions that
 * open the question, close it, and confirm the delete.
 */
export const useWorkflowDelete = (client: HerculeClient) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isAsking, setIsAsking] = useState(false);

  const remove = useMutation({
    mutationFn: (id: string) => client.workflow.delete({ params: { id } }),
    // `refetchType: "all"` also refetches the list while it is not on
    // screen, so the list never shows the deleted workflow.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.workflows(), refetchType: "all" }),
  });

  return {
    remove,
    isAsking,
    /** Shows the question, and clears the error of the last delete. */
    ask: (): void => {
      remove.reset();
      setIsAsking(true);
    },
    stopAsking: (): void => {
      setIsAsking(false);
    },
    deleteWorkflow: (id: string): void => {
      setIsAsking(false);
      remove.mutate(id, {
        // A per-call `onSuccess` runs only while the component is mounted, so
        // a user who already left the page is not pulled back.
        onSuccess: () => {
          void navigate({ to: "/workflows", ignoreBlocker: true }).then(() => {
            // Removed only after the navigation, because the page reads it until it unmounts.
            queryClient.removeQueries({ queryKey: queryKeys.workflow(id) });
          });
        },
      });
    },
  };
};
