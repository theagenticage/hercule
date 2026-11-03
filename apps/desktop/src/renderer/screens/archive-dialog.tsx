import { useEffect, useRef, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildArchiveTitle, readErrorMessage, type ArchivePlan } from "@hercule/client-core";
import { useDoneMoves } from "../app/done-moves";
import { settingsQuery } from "../app/queries";
import { ConfirmDialog } from "./confirm-dialog";

/**
 * How many days an archived workspace is kept when the controller's settings
 * do not set `workspace.archivedTtlDays`: the controller's default.
 */
const DEFAULT_KEPT_DAYS = 7;

/**
 * Renders the confirmation that asks before the rows of `plan` are archived
 * (spec 17 §Archiving a row), and archives them on Archive. The header's More
 * menu opens it for one row, and the Done shelf for a row or for "Archive
 * all". The caller unmounts it when `onClose` is called, which happens
 * whenever the dialog closes.
 *
 * The title names the rows (`buildArchiveTitle`). The text says that
 * archiving is final, that transcripts stay readable, and how long Hercule
 * keeps the workspace afterwards, which is the controller's
 * `workspace.archivedTtlDays`. So the dialog reads the controller's settings
 * when it mounts, which is when the user starts the archive, and draws
 * nothing until it has them. They are usually cached, so that is no wait.
 * When the read fails, the dialog never shows: the failure shows as an alert
 * toast, like any other failed move, and `onClose` is called.
 *
 * Keep it closes the dialog and has the focus, so a stray Enter does not
 * archive. Archive sends the archive through the Done moves and closes the
 * dialog without waiting: the move shows the controller's answer or refusal
 * as a toast.
 */
export function ArchiveDialog({
  plan,
  onClose,
}: {
  readonly plan: ArchivePlan;
  readonly onClose: () => void;
}): JSX.Element | null {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { archive, toasts } = useDoneMoves();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { data: settings, error } = useQuery(settingsQuery(client));
  useEffect(() => {
    if (error === null) return;
    toasts.showFailure(`Couldn't archive: ${readErrorMessage(error)}`, null);
    onClose();
  }, [error, toasts, onClose]);
  if (settings === undefined) return null;
  const days = settings.controller["workspace.archivedTtlDays"] ?? DEFAULT_KEPT_DAYS;
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title={buildArchiveTitle(plan.rows)}
      actionLabel="Archive"
      actionClass="danger"
      closeLabel="Keep it"
      initialFocus="close"
      onConfirm={() => {
        archive(plan);
        dialogRef.current?.close();
      }}
      onClose={onClose}
    >
      <p>
        {`Its threads leave the sidebar for good and can never be resumed. Their transcripts stay readable. Hercule removes the workspace and everything in it once nobody has used it for ${String(days)} ${days === 1 ? "day" : "days"}, files you never committed included.`}
      </p>
    </ConfirmDialog>
  );
}
