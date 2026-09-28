import { useState, type JSX } from "react";
import { useLocation } from "@tanstack/react-router";
import { decideWorkflowHeaderStatus, type HerculeClient, type Live } from "@hercule/client-core";
import { STARTER_WORKFLOW_SOURCE, type Workflow } from "@hercule/contract";
import { InPlaceQuestion } from "../../../screens/in-place-question";
import { RunFormDrawer } from "../../../screens/runs/run-form-drawer";
import type { WorkflowView } from "../../../screens/workflow-editor";
import { WorkflowEditorBody } from "./-body";
import { useWorkflowDelete } from "./-delete";
import { useWorkflowDraft } from "./-draft";
import { WorkflowHeader, WorkflowHeaderActions } from "./-header";
import { useLeaveBlocker } from "./-leave";
import { isJustCreatedState, useWorkflowSave } from "./-save";

/**
 * Renders the page for editing a workflow: a header row with the name, the
 * view control and the actions, and the editor below it. A new workflow has
 * no stored source, so it starts from the starter source and has no Delete.
 *
 * The page keeps the source the user is typing and compares it with the
 * stored source to decide whether there are unsaved changes.
 * - While there are unsaved changes, leaving the page asks first.
 * - When another client changes the stored source, the page shows the new
 *   source if the user has not edited it. Otherwise it keeps the user's
 *   edits and shows a note beside Save.
 * - When another client deletes the workflow, the page keeps the source, and
 *   Save creates a new workflow from it.
 */
export function WorkflowEditorPage({
  client,
  live,
  stored,
  isGone,
  view,
  onViewChange,
}: {
  readonly client: HerculeClient;
  readonly live: Live;
  /** The workflow as last read from the controller, or `undefined` for a new one. */
  readonly stored: Workflow | undefined;
  /** Whether the controller no longer has the stored workflow. */
  readonly isGone: boolean;
  readonly view: WorkflowView;
  readonly onViewChange: (view: WorkflowView) => void;
}): JSX.Element {
  const isJustCreated = useLocation({ select: (location) => isJustCreatedState(location.state) });

  const storedSource = stored?.source ?? STARTER_WORKFLOW_SOURCE;
  const { draft, editSource, markSaved } = useWorkflowDraft(storedSource);
  const { source } = draft;
  const hasChanges = source !== storedSource;

  const [name, setName] = useState<string>();
  const [isRunFormOpen, setRunFormOpen] = useState(false);

  const deletion = useWorkflowDelete(client);
  const { remove } = deletion;
  // This page's own delete also makes the workflow gone, before the delete
  // request returns. So a gone workflow counts as deleted elsewhere only when
  // this page has not started a delete.
  const isDeletedElsewhere = isGone && remove.isIdle;
  const existingWorkflow = isDeletedElsewhere ? undefined : stored;
  const { save, saveSource } = useWorkflowSave({
    client,
    stored,
    existingWorkflow,
    onUpdated: markSaved,
  });
  // After a create, the app navigates to the new workflow's page, which
  // starts from the stored source. The editor takes no input while the
  // create is in flight, so nothing the user types is lost in the move.
  const isCreating = save.isPending && existingWorkflow === undefined;

  // While a save of the current source is in flight, leaving loses nothing,
  // so the page does not ask. The source of a workflow deleted elsewhere
  // exists only on this page, so leaving asks even when nothing changed.
  const shouldAskToLeave =
    (hasChanges || isDeletedElsewhere) && !(save.isPending && save.variables === source);
  const leaveBlocker = useLeaveBlocker(shouldAskToLeave);
  // Show one question at a time. The leave question closes the delete
  // question, and Stay does not reopen it.
  if (leaveBlocker.status === "blocked" && deletion.isAsking) deletion.stopAsking();

  const question =
    leaveBlocker.status === "blocked" ? (
      <InPlaceQuestion
        key="leave"
        question="Leave without saving?"
        declineLabel="Stay"
        acceptLabel="Leave"
        onDecline={leaveBlocker.reset}
        onAccept={leaveBlocker.proceed}
      />
    ) : deletion.isAsking && existingWorkflow !== undefined ? (
      <InPlaceQuestion
        key="delete"
        question="Delete this workflow?"
        declineLabel="Cancel"
        acceptLabel="Confirm"
        onDecline={deletion.stopAsking}
        onAccept={() => {
          deletion.deleteWorkflow(existingWorkflow.id);
        }}
      />
    ) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorkflowHeader
        // `name` stays undefined until the source parses as a workflow. A
        // stored source can fail to parse, for example when a newer contract
        // rejects it.
        name={name ?? (stored === undefined ? "New workflow" : "Workflow")}
        view={view}
        onViewChange={onViewChange}
      >
        {question}
        <WorkflowHeaderActions
          isHidden={question !== undefined}
          status={decideWorkflowHeaderStatus({
            draft,
            storedSource,
            isStoredOff: stored?.enabled === false,
            isDeletedElsewhere,
            isJustCreated,
            save: { status: save.status, source: save.variables, error: save.error },
            deleteError: remove.error,
          })}
          isStored={existingWorkflow !== undefined}
          isRunDisabled={hasChanges}
          onRun={() => {
            setRunFormOpen(true);
          }}
          isDeleteDisabled={remove.isPending}
          // While the page's own delete is in flight, a save would race it.
          isSaveDisabled={
            save.isPending || remove.isPending || (existingWorkflow !== undefined && !hasChanges)
          }
          onDelete={deletion.ask}
          onSave={() => {
            // The header shows the result of the latest write. This save is
            // now the latest, so clear the error of an earlier delete.
            remove.reset();
            saveSource(source);
          }}
        />
      </WorkflowHeader>
      {isRunFormOpen && existingWorkflow !== undefined ? (
        <RunFormDrawer
          client={client}
          workflowId={existingWorkflow.id}
          onClose={() => {
            setRunFormOpen(false);
          }}
        />
      ) : null}
      <WorkflowEditorBody
        client={client}
        live={live}
        source={source}
        onSourceChange={editSource}
        view={view}
        onViewChange={onViewChange}
        isInert={isCreating}
        onNameChange={setName}
        storedWorkflowId={existingWorkflow?.id}
      />
    </div>
  );
}
