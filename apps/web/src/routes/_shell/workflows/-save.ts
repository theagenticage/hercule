import { useRef } from "react";
import { useNavigate, type HistoryState } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  isNotFound,
  queryKeys,
  readValidationIssues,
  type HerculeClient,
} from "@hercule/client-core";
import type { Workflow } from "@hercule/contract";
import { workflowQuery } from "../../../app/queries";
import { recordSaveRefusal } from "./-validation";

/**
 * The history state that a create attaches to the new workflow's page. The
 * page reads it to show that the workflow was created, and to focus the
 * editor.
 */
const JUST_CREATED_STATE: HistoryState & { readonly isJustCreated: true } = {
  isJustCreated: true,
};

/** Checks whether a history entry's state was set by a create. */
export const isJustCreatedState = (state: object): boolean =>
  "isJustCreated" in state && state.isJustCreated === true;

/**
 * Handles Save on a workflow's page. Returns the save mutation and
 * `saveSource`, which starts a save. A save creates a new workflow when
 * `existingWorkflow` is undefined, and updates it otherwise. After a create,
 * the app navigates to the new workflow's page.
 *
 * When the controller rejects the source, its errors are stored as the
 * validation result for that source, so the editor marks them.
 */
export const useWorkflowSave = ({
  client,
  stored,
  existingWorkflow,
  onUpdated,
}: {
  readonly client: HerculeClient;
  /** The workflow as last read from the controller, or `undefined` for a new one. */
  readonly stored: Workflow | undefined;
  /** The workflow to update, or `undefined` when a save creates a new one. */
  readonly existingWorkflow: Workflow | undefined;
  /** Called with the saved source after an update of this page's workflow succeeds. */
  readonly onUpdated: (savedSource: string) => void;
}) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // A ref, not the mutation's state, so that a second click that lands before
  // React re-renders cannot start a second save.
  const isSaving = useRef(false);

  const save = useMutation({
    mutationFn: (source: string) =>
      existingWorkflow === undefined
        ? client.workflow.create({ payload: { source } })
        : client.workflow.update({ params: { id: existingWorkflow.id }, payload: { source } }),
    onSuccess: ({ workflow }) => {
      // The response is the saved workflow, so put it in the cache instead of
      // refetching it.
      queryClient.setQueryData(workflowQuery(client, workflow.id).queryKey, workflow);
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows() });
      // Only an update returns this page's workflow. After a create,
      // `saveSource` navigates to the new workflow's page instead.
      if (workflow.id === stored?.id) onUpdated(workflow.source);
    },
    onError: (error, source) => {
      const refused = readValidationIssues(error);
      if (refused !== undefined) recordSaveRefusal(queryClient, client, source, refused);
      // The workflow was deleted elsewhere. Refetch it, so the page shows
      // that it is gone.
      if (isNotFound(error) && stored !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.workflow(stored.id) });
      }
    },
    onSettled: () => {
      isSaving.current = false;
    },
  });

  const saveSource = (source: string): void => {
    if (isSaving.current) return;
    isSaving.current = true;
    // When the create comes from the page of a workflow deleted elsewhere,
    // the new page replaces that page in the history. Otherwise Back would
    // return to a page that offers to create the workflow again.
    const replacedWorkflowId = existingWorkflow === undefined ? stored?.id : undefined;
    save.mutate(source, {
      // A per-call `onSuccess` runs only while the component is mounted, so
      // a user who already left the page is not pulled back.
      onSuccess: ({ workflow }) => {
        if (existingWorkflow !== undefined) return;
        void navigate({
          to: "/workflows/$workflowId",
          params: { workflowId: workflow.id },
          // Keeps the current search params, read when the navigation runs,
          // because the user can change the view while the create is in flight.
          search: true,
          state: JUST_CREATED_STATE,
          replace: replacedWorkflowId !== undefined,
          // The source is saved, so skip the unsaved-changes question.
          ignoreBlocker: true,
        }).then(() => {
          // Removed only after the navigation, because the page reads it until it unmounts.
          if (replacedWorkflowId !== undefined) {
            queryClient.removeQueries({ queryKey: queryKeys.workflow(replacedWorkflowId) });
          }
        });
      },
    });
  };

  return { save, saveSource };
};
