import { useState, type JSX } from "react";
import { useLocation } from "@tanstack/react-router";
import { decideWorkflowHeaderStatus, type HerculeClient, type Live } from "@hercule/client-core";
import { STARTER_WORKFLOW_SOURCE, type Workflow } from "@hercule/contract";
import { InPlaceQuestion } from "../../../screens/in-place-question";
import type { WorkflowView } from "../../../screens/workflow-editor";
import { WorkflowEditorBody } from "./-body";
import { useWorkflowDelete } from "./-delete";
import { useWorkflowDraft } from "./-draft";
import { WorkflowHeader, WorkflowHeaderActions } from "./-header";
import { useLeaveBlocker } from "./-leave";
import { isJustCreatedState, useWorkflowSave } from "./-save";

/**
 * The page on which a workflow is written: its name, the view control and
 * its actions in one row, and the body with the editor under it. A new
 * workflow has no stored source, so it starts from the starter source and
 * has nothing to delete.
 *
 * The page holds the source as the author types it, and compares it with the
 * stored source to know if there are changes to save. While there are,
 * leaving the page asks first. A stored source that changes elsewhere
 * replaces the source on the page only while the author has not edited it;
 * otherwise the page says so beside Save. A workflow that is deleted
 * elsewhere keeps its source on the page, and Save creates a new workflow
 * from it.
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
  /** The workflow as it was stored when it was last read, or `undefined` for a new one. */
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

  const deletion = useWorkflowDelete(client);
  const { remove } = deletion;
  // The page's own delete also makes the workflow gone before the delete
  // answers, and the page then leaves. Only a workflow that is gone while no
  // delete of the page's own has started was deleted elsewhere.
  const isDeletedElsewhere = isGone && remove.isIdle;
  const existingWorkflow = isDeletedElsewhere ? undefined : stored;
  const { save, saveSource } = useWorkflowSave({
    client,
    stored,
    existingWorkflow,
    onUpdated: markSaved,
  });
  // A create moves to the new workflow's page, which starts from the stored
  // source. The source cannot change while the create is in flight, so that
  // move never drops what the author typed.
  const isCreating = save.isPending && existingWorkflow === undefined;

  // A save of the source on the page stores it, so while one is in flight,
  // leaving loses nothing. A workflow deleted elsewhere has its source on
  // this page only, so leaving it asks also when the source has no changes.
  const shouldAskToLeave =
    (hasChanges || isDeletedElsewhere) && !(save.isPending && save.variables === source);
  const leaveBlocker = useLeaveBlocker(shouldAskToLeave);
  // One question at a time: the question to leave closes the question to
  // delete, which does not come back after Stay.
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
        // A source that has never read as a workflow names none, as a stored
        // source that a later version of the contract refuses.
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
          canDelete={existingWorkflow !== undefined}
          isDeleteDisabled={remove.isPending}
          // While the page's own delete is in flight, a save would race it.
          isSaveDisabled={
            save.isPending || remove.isPending || (existingWorkflow !== undefined && !hasChanges)
          }
          onDelete={deletion.ask}
          onSave={() => {
            // The header says what the last write did, and a save is the last now.
            remove.reset();
            saveSource(source);
          }}
        />
      </WorkflowHeader>
      <WorkflowEditorBody
        client={client}
        live={live}
        source={source}
        onSourceChange={editSource}
        view={view}
        onViewChange={onViewChange}
        isInert={isCreating}
        onNameChange={setName}
      />
    </div>
  );
}
