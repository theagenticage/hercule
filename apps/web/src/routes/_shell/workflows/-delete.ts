/**
 * The delete of a workflow's page: the question that asks first, and the
 * write, which returns to the list once the controller answers.
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";

/** The delete mutation of the page, whether the page asks to delete, and the answers. */
export const useWorkflowDelete = (client: HerculeClient) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isAsking, setIsAsking] = useState(false);

  const remove = useMutation({
    mutationFn: (id: string) => client.workflow.delete({ params: { id } }),
    // The list is read again before it shows, so it never shows the
    // workflow that is gone.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.workflows(), refetchType: "all" }),
  });

  return {
    remove,
    isAsking,
    /** Asks to delete. The question replaces what the last delete said. */
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
        // A callback of one call runs only while the page is mounted, so an
        // author who left before the answer is not brought back.
        onSuccess: () => {
          void navigate({ to: "/workflows", ignoreBlocker: true }).then(() => {
            // Removed only once the page is gone, because the page reads it until then.
            queryClient.removeQueries({ queryKey: queryKeys.workflow(id) });
          });
        },
      });
    },
  };
};
