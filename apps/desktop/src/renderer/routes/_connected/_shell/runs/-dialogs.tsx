import { useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  queryKeys,
  readErrorMessage,
  type HerculeClient,
  type RerunChoice,
} from "@hercule/client-core";
import type { RerunMode } from "@hercule/contract";
import { CheckIcon } from "../../../../icons/check";
import { ConfirmDialog } from "../../../../screens/confirm-dialog";

/**
 * Asks before the run with `runId` is cancelled, and cancels it (spec 17
 * §Workflows, "A run's page"). Keep running, the closing button, has the
 * focus, because a cancel cannot be undone.
 *
 * When `asksOnCancel` is true, which `describeRunWorkspace` decides for a
 * live run in an automatic workspace, the checkbox "Delete workspace"
 * follows, checked. Unchecked, the cancel keeps the workspace. Any other
 * run, such as one in a project's main checkout, has nothing to lose, and
 * the dialog does not mention it.
 *
 * Once the cancel succeeds, the dialog closes and the page shows the
 * cancelled run. A refusal shows in the dialog: "Not cancelled: " and why.
 */
export function CancelRunDialog({
  client,
  runId,
  asksOnCancel,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly runId: string;
  readonly asksOnCancel: boolean;
  readonly onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [deletesWorkspace, setDeletesWorkspace] = useState(true);
  const cancel = useMutation({
    mutationFn: (keepWorkspace: boolean) =>
      client.run.cancel({ params: { id: runId }, payload: { keepWorkspace } }),
    onSuccess: async (cancelled) => {
      dialogRef.current?.close();
      queryClient.setQueryData(queryKeys.run(runId), cancelled);
      await queryClient.invalidateQueries({ queryKey: queryKeys.runs() });
    },
  });
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title="Cancel this run?"
      actionLabel={cancel.isPending ? "Cancelling…" : "Cancel run"}
      actionClass="danger"
      closeLabel="Keep running"
      initialFocus="close"
      pending={cancel.isPending}
      error={cancel.error === null ? null : `Not cancelled: ${readErrorMessage(cancel.error)}`}
      onConfirm={() => cancel.mutate(asksOnCancel && !deletesWorkspace)}
      onClose={onClose}
    >
      <p>
        Its running steps stop and their sessions end, and so do the runs it started. You can re-run
        it afterwards.
      </p>
      {asksOnCancel ? (
        <div className="options">
          <label className="option">
            <span className="choice-box">
              <input
                type="checkbox"
                checked={deletesWorkspace}
                onChange={(event) => setDeletesWorkspace(event.target.checked)}
              />
              <CheckIcon size={12} />
            </span>
            <b>Delete workspace</b>
          </label>
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

/**
 * Asks before the run with `runId` is re-run with the same inputs, and
 * starts the re-run. Re-run, the action, has the focus, because it only adds
 * a run.
 *
 * `choices` are `listRerunChoices`: with two, each is a radio in the group
 * "Re-run from", its explanation under its label, and the first is picked
 * when the dialog opens. With one, its explanation is a paragraph instead.
 * The choices can change while the dialog is open, such as when the
 * workflow turns out to be deleted; a pick that is no longer a choice falls
 * back to the first, so the dialog never sends a mode it does not show.
 *
 * Once the re-run starts, the dialog closes and the app goes to the new
 * run's page. A refusal shows in the dialog: "Not re-run: " and why.
 */
export function RerunDialog({
  client,
  runId,
  choices,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly runId: string;
  readonly choices: readonly [RerunChoice, ...RerunChoice[]];
  readonly onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<RerunMode>(choices[0].mode);
  const picked = choices.some((choice) => choice.mode === mode) ? mode : choices[0].mode;
  const rerun = useMutation({
    mutationFn: (picked: RerunMode) =>
      client.run.rerun({ params: { id: runId }, payload: { mode: picked } }),
    onSuccess: async (started) => {
      dialogRef.current?.close();
      await queryClient.invalidateQueries({ queryKey: queryKeys.runs() });
      await navigate({ to: "/runs/$runId", params: { runId: started.runId } });
    },
  });
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title="Re-run with the same inputs?"
      actionLabel={rerun.isPending ? "Starting…" : "Re-run"}
      actionClass="accent"
      initialFocus="action"
      pending={rerun.isPending}
      error={rerun.error === null ? null : `Not re-run: ${readErrorMessage(rerun.error)}`}
      onConfirm={() => rerun.mutate(picked)}
      onClose={onClose}
    >
      {choices.length === 1 ? (
        <p>{choices[0].explanation}</p>
      ) : (
        <div className="options" role="radiogroup" aria-label="Re-run from">
          {choices.map((choice) => (
            <label key={choice.mode} className="option">
              <span className="choice-box">
                <input
                  type="radio"
                  name="from"
                  value={choice.mode}
                  checked={picked === choice.mode}
                  onChange={() => setMode(choice.mode)}
                />
              </span>
              <b>{choice.label}</b>
              <small>{choice.explanation}</small>
            </label>
          ))}
        </div>
      )}
    </ConfirmDialog>
  );
}

/**
 * Asks before the run's workspace with `workspaceId` is deleted, and deletes
 * it. Keep it, the closing button, has the focus, because the delete cannot
 * be undone. Once the delete succeeds, the dialog closes and the page reads
 * the workspace again. A refusal shows in the dialog: "Not deleted: " and
 * why.
 */
export function DeleteWorkspaceDialog({
  client,
  workspaceId,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly workspaceId: string;
  readonly onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const deleteWorkspace = useMutation({
    mutationFn: () => client.workspace.dispose({ params: { id: workspaceId }, payload: {} }),
    onSuccess: async () => {
      dialogRef.current?.close();
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces() });
    },
  });
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title="Delete the run's workspace?"
      actionLabel={deleteWorkspace.isPending ? "Deleting…" : "Delete"}
      actionClass="danger"
      closeLabel="Keep it"
      initialFocus="close"
      pending={deleteWorkspace.isPending}
      error={
        deleteWorkspace.error === null
          ? null
          : `Not deleted: ${readErrorMessage(deleteWorkspace.error)}`
      }
      onConfirm={() => deleteWorkspace.mutate()}
      onClose={onClose}
    >
      <p>This removes the workspace and its files. This cannot be undone.</p>
    </ConfirmDialog>
  );
}
