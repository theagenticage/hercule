/**
 * The save of a workflow's page: a create for a new workflow, and an update
 * for a stored one. A create moves to the page of the new workflow.
 */
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
 * What a create puts in the history entry of the page that it opens. The new
 * page reads it to say that the workflow was created, and to put the focus in
 * the text.
 */
const JUST_CREATED_STATE: HistoryState & { readonly isJustCreated: true } = {
  isJustCreated: true,
};

/** Whether a history entry is the page that a create opened. */
export const isJustCreatedState = (state: object): boolean =>
  "isJustCreated" in state && state.isJustCreated === true;

/**
 * The save mutation of the page, and the function that starts a save. A
 * refusal becomes the controller's answer about the refused source, so the
 * editor marks its errors.
 */
export const useWorkflowSave = ({
  client,
  stored,
  existingWorkflow,
  onUpdated,
}: {
  readonly client: HerculeClient;
  /** The workflow as it was stored when it was last read, or `undefined` for a new one. */
  readonly stored: Workflow | undefined;
  /** The stored workflow while the controller has it, or `undefined` when a save creates one. */
  readonly existingWorkflow: Workflow | undefined;
  /** Receives the source that an update of the page's own workflow stored. */
  readonly onUpdated: (savedSource: string) => void;
}) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Set when a save starts, so that a second click that comes before the page
  // renders the pending save cannot start a second save.
  const isSaving = useRef(false);

  const save = useMutation({
    mutationFn: (source: string) =>
      existingWorkflow === undefined
        ? client.workflow.create({ payload: { source } })
        : client.workflow.update({ params: { id: existingWorkflow.id }, payload: { source } }),
    onSuccess: ({ workflow }) => {
      // The answer is the stored workflow, so its page reads nothing again.
      queryClient.setQueryData(workflowQuery(client, workflow.id).queryKey, workflow);
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows() });
      // An update answers the page's own workflow. A create moves to the
      // page of the new workflow.
      if (workflow.id === stored?.id) onUpdated(workflow.source);
    },
    onError: (error, source) => {
      const refused = readValidationIssues(error);
      if (refused !== undefined) recordSaveRefusal(queryClient, client, source, refused);
      // The workflow was deleted elsewhere. It is read again, so that the
      // page says so.
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
    // A create from the page of a workflow that was deleted elsewhere takes
    // the place of that page in the history. Back then cannot return to a
    // page that offers to create the workflow again.
    const replacedWorkflowId = existingWorkflow === undefined ? stored?.id : undefined;
    save.mutate(source, {
      // A callback of one call runs only while the page is mounted, so an
      // author who left before the answer is not brought back.
      onSuccess: ({ workflow }) => {
        if (existingWorkflow !== undefined) return;
        void navigate({
          to: "/workflows/$workflowId",
          params: { workflowId: workflow.id },
          // The view of the address now, which the author can change while
          // the create is in flight.
          search: true,
          state: JUST_CREATED_STATE,
          replace: replacedWorkflowId !== undefined,
          // The source is saved, so there is nothing to ask about on the way out.
          ignoreBlocker: true,
        }).then(() => {
          // Removed only once the page is gone, because the page reads it until then.
          if (replacedWorkflowId !== undefined) {
            queryClient.removeQueries({ queryKey: queryKeys.workflow(replacedWorkflowId) });
          }
        });
      },
    });
  };

  return { save, saveSource };
};
