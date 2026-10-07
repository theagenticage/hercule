import { useEffect, useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildWorkspaceDetails,
  queryKeys,
  readErrorMessage,
  resolveDisplayTimezone,
} from "@hercule/client-core";
import type { Workspace } from "@hercule/contract";
import { runnersQuery, settingsQuery, workspacesQuery } from "../../app/queries";
import { GlassDialog } from "../glass-dialog";
import "./workspace-details.css";

/** Reads live workspace facts and offers deliberate refresh, discard and detach actions. */
export function WorkspaceDetails({
  workspaceId,
  onClose,
}: {
  readonly workspaceId: string;
  readonly onClose: () => void;
}): JSX.Element {
  const {
    controller: { client },
  } = useRouteContext({ from: "/_connected" });
  const queryClient = useQueryClient();
  const workspaces = useSuspenseQuery(workspacesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const workspace = workspaces.find((each) => each.id === workspaceId);
  const details =
    workspace === undefined
      ? undefined
      : buildWorkspaceDetails(workspace, {
          runners,
          timezone: resolveDisplayTimezone(settings.user.timezone),
        });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inspected = useRef(false);
  const [confirmation, setConfirmation] = useState<"discard" | "detach" | null>(null);
  const inspection = useMutation({
    mutationFn: () => client.workspace.inspect({ params: { id: workspaceId } }),
    onSuccess: (current) => {
      queryClient.setQueryData<readonly Workspace[]>(queryKeys.workspaces(), (records) =>
        records?.map((each) => (each.id === current.id ? current : each)),
      );
    },
  });
  const { mutate: inspect } = inspection;
  useEffect(() => {
    if (inspected.current) return;
    inspected.current = true;
    if (details?.canRefresh) inspect();
  }, [details?.canRefresh, inspect]);
  const removal = useMutation({
    mutationFn: (choice: "discard" | "detach") =>
      choice === "discard"
        ? client.workspace.dispose({
            params: { id: workspaceId },
            payload: { discardChanges: true },
          })
        : client.workspace.detach({ params: { id: workspaceId } }),
    onSuccess: () => {
      setConfirmation(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces() });
    },
  });
  const error = removal.error ?? inspection.error;
  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="workspace-details-dialog"
      label={
        confirmation === "discard"
          ? "Discard workspace"
          : confirmation === "detach"
            ? "Detach existing checkout"
            : "Workspace details"
      }
      onClose={onClose}
    >
      <div className="pop-h">
        <b>
          {confirmation === "discard"
            ? "Discard workspace?"
            : confirmation === "detach"
              ? "Detach existing checkout?"
              : "Workspace details"}
        </b>
        <button className="link" type="button" onClick={() => dialogRef.current?.close()}>
          Close
        </button>
      </div>
      <div className="pop-sec workspace-details-body">
        {details === undefined ? (
          <p>This workspace is no longer registered.</p>
        ) : confirmation !== null ? (
          <>
            <p>
              {confirmation === "discard"
                ? "Uncommitted tracked changes, untracked files and ignored files in this workspace will be lost. Committed branches remain in the repository."
                : "The existing checkout's files stay in place. This removes its registration in Hercule. Derived workspaces keep their existing Git repository; detachment does not move or remove their files."}
            </p>
            <div className="workspace-details-actions">
              <button
                className="link"
                type="button"
                disabled={removal.isPending}
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </button>
              <button
                className="link"
                type="button"
                disabled={
                  removal.isPending ||
                  (confirmation === "discard" ? !details.canDiscard : !details.canDetach)
                }
                onClick={() => removal.mutate(confirmation)}
              >
                {removal.isPending
                  ? "Requesting removal…"
                  : confirmation === "discard"
                    ? "Discard workspace"
                    : "Detach existing checkout"}
              </button>
            </div>
          </>
        ) : (
          <>
            <dl className="workspace-details-facts">
              <dt>Runner</dt>
              <dd>{details.runner}</dd>
              <dt>Source</dt>
              <dd>{details.source}</dd>
              <dt>Ownership</dt>
              <dd>{details.ownership}</dd>
              <dt>Status</dt>
              <dd>{details.status}</dd>
              {details.observation === null ? null : (
                <>
                  <dt>Last observed</dt>
                  <dd>{details.observation}</dd>
                </>
              )}
            </dl>
            {details.checkouts.map((checkout) => (
              <dl
                key={checkout.resourceId}
                className="workspace-details-facts workspace-details-checkout"
              >
                <dt>Branch</dt>
                <dd>{checkout.branch ?? "No branch observed"}</dd>
                {checkout.startingRevision === null ? null : (
                  <>
                    <dt>Starting revision</dt>
                    <dd>{checkout.startingRevision}</dd>
                  </>
                )}
                {checkout.baseCommit === null ? null : (
                  <>
                    <dt>Base commit</dt>
                    <dd>
                      <code title={checkout.baseCommit}>{checkout.baseCommit.slice(0, 8)}</code>
                    </dd>
                  </>
                )}
                {checkout.headCommit === null ? null : (
                  <>
                    <dt>Observed HEAD</dt>
                    <dd>
                      <code title={checkout.headCommit}>{checkout.headCommit.slice(0, 8)}</code>
                    </dd>
                  </>
                )}
              </dl>
            ))}
            <p className="workspace-details-note">{details.retention}</p>
            {details.message === null ? null : <p role="status">{details.message}</p>}
            {details.warnings.map((warning) => (
              <p key={warning} className="workspace-details-note">
                {warning}
              </p>
            ))}
            {details.actionReason === null ? null : (
              <p className="workspace-details-note">{details.actionReason}</p>
            )}
            {details.canDetach ? (
              <p className="workspace-details-note">
                Detaching keeps your files in place. Derived workspaces keep their existing Git
                repository.
              </p>
            ) : null}
            <div className="workspace-details-actions">
              <button
                className="link"
                type="button"
                disabled={!details.canRefresh || inspection.isPending}
                onClick={() => inspect()}
              >
                Refresh
              </button>
              {details.canDiscard ? (
                <button
                  className="link"
                  type="button"
                  onClick={() => {
                    removal.reset();
                    setConfirmation("discard");
                  }}
                >
                  Discard workspace
                </button>
              ) : null}
              {details.canDetach ? (
                <button
                  className="link"
                  type="button"
                  onClick={() => {
                    removal.reset();
                    setConfirmation("detach");
                  }}
                >
                  Detach existing checkout
                </button>
              ) : null}
            </div>
          </>
        )}
        {error === null ? null : (
          <p className="workspace-details-error" role="alert">
            {readErrorMessage(error)}
          </p>
        )}
      </div>
    </GlassDialog>
  );
}
