import { useRef, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { connectionsQuery } from "../../app/queries";
import { GlassDialog } from "../glass-dialog";
import { NewProjectForm } from "./new-project-form";
import "./new-project.css";

/**
 * Renders the New project form in a glass dialog: the project picker's New
 * project row opens it. Once the project is added, the dialog closes and
 * `onAdded` is called with the project's id, where the caller opens a Draft
 * Thread in it.
 *
 * The dialog has no Connect GitHub button. Without a GitHub Connection, the
 * form says to connect GitHub in the web app, because the desktop app sets
 * up a Connection only in its first run.
 *
 * `onClose` is called whenever the dialog closes, the project added or not.
 * The caller then unmounts it. A project that was created when its
 * repository was not stays in the sidebar when the user closes the dialog.
 */
export function NewProjectDialog({
  onAdded,
  onClose,
}: {
  readonly onAdded: (projectId: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const dialogRef = useRef<HTMLDialogElement>(null);
  // The form reads the Connections to know whether runners can clone. The
  // shell's loader read them already, so the dialog opens with the form.
  useSuspenseQuery(connectionsQuery(controller.client));
  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="new-project-dialog"
      label="New project"
      onClose={onClose}
    >
      <div className="pop-h">
        <b>New project</b>
      </div>
      <div className="pop-sec new-project-body">
        <NewProjectForm
          client={controller.client}
          onAdded={(projectId) => {
            // The dialog closes first, because an open modal dialog keeps
            // the focus inside it, and the draft takes the focus.
            dialogRef.current?.close();
            onAdded(projectId);
          }}
        />
      </div>
    </GlassDialog>
  );
}
