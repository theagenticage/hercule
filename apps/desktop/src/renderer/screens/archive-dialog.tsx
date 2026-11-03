import { useRef, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { settingsQuery } from "../app/queries";
import { ConfirmDialog } from "./confirm-dialog";

/**
 * How many days the dialog says an archived workspace is kept when the
 * controller's settings are not in the cache. It is the controller's default
 * for `workspace.archivedTtlDays`.
 */
const DEFAULT_KEPT_DAYS = 7;

/**
 * Renders the dialog that asks before rows are archived (spec 17 §Archiving a
 * row): `title` names what is archived, and the text says that archiving is
 * final, that transcripts stay readable, and how long Hercule keeps the
 * workspace afterwards. Keep it closes the dialog and has the focus, so a
 * stray Enter does not archive.
 *
 * Archive calls `onConfirm` and closes the dialog. The caller sends the
 * request and shows the controller's answer or refusal as a toast, so the
 * dialog does not wait for it. `onClose` is called whenever the dialog
 * closes, and the caller then unmounts it.
 *
 * The days are the controller's `workspace.archivedTtlDays` when the
 * settings are already in the cache. The dialog makes no read of its own, so
 * it falls back to the controller's default of 7 when they are not.
 */
export function ArchiveDialog({
  title,
  onConfirm,
  onClose,
}: {
  readonly title: string;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const settings = useQuery({ ...settingsQuery(client), enabled: false }).data;
  const days = settings?.controller["workspace.archivedTtlDays"] ?? DEFAULT_KEPT_DAYS;
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
