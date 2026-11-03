import { useEffect, useRef, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import { useDoneMoves } from "../app/done-moves";
import { settingsQuery } from "../app/queries";
import { ConfirmDialog } from "./confirm-dialog";

/**
 * How many days an archived workspace is kept when the controller's settings
 * do not set `workspace.archivedTtlDays`: the controller's default.
 */
const DEFAULT_KEPT_DAYS = 7;

/**
 * Renders the dialog that asks before rows are archived (spec 17 §Archiving a
 * row): `title` names what is archived, and the text says that archiving is
 * final, that transcripts stay readable, and how long Hercule keeps the
 * workspace afterwards. Keep it closes the dialog and has the focus, so a
 * stray Enter does not archive.
 *
 * The days are the controller's `workspace.archivedTtlDays`, so the dialog
 * reads the controller's settings when it mounts, which is when the user
 * starts the archive, and draws nothing until it has them. The settings are
 * usually cached, so that is no wait. When the read fails, the dialog never
 * shows: the failure shows as an alert toast, like any other failed move,
 * and `onClose` is called.
 *
 * Archive calls `onConfirm` and closes the dialog. The caller sends the
 * request and shows the controller's answer or refusal as a toast, so the
 * dialog does not wait for it. `onClose` is called whenever the dialog
 * closes, and the caller then unmounts it.
 */
export function ArchiveDialog({
  title,
  onConfirm,
  onClose,
}: {
  readonly title: string;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): JSX.Element | null {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { toasts } = useDoneMoves();
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
      title={title}
      actionLabel="Archive"
      actionClass="danger"
      closeLabel="Keep it"
      initialFocus="close"
      onConfirm={() => {
        onConfirm();
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
