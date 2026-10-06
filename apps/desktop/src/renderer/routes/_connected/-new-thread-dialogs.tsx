import { lazy, Suspense, type Dispatch, type JSX, type SetStateAction } from "react";

// The project picker and the New project dialog are each loaded the first
// time they open, so their code is not part of the first screen's scripts
// (spec 17 §Performance).
const ProjectPicker = lazy(() =>
  import("../../screens/new-thread/project-picker").then((module) => ({
    default: module.ProjectPicker,
  })),
);
const NewProjectDialog = lazy(() =>
  import("../../screens/new-project").then((module) => ({ default: module.NewProjectDialog })),
);

/** The dialog New thread has open: the project picker, or the New project dialog its last row opens. */
export type NewThreadDialog = "picker" | "new-project";

/**
 * Renders the dialog of New thread that `dialog` names, or nothing when it is
 * `null`. `setDialog` changes which one is open. A project picked in the
 * picker, or added in the New project dialog, is passed to `onDraft`.
 */
export function NewThreadDialogs({
  dialog,
  setDialog,
  onDraft,
}: {
  readonly dialog: NewThreadDialog | null;
  readonly setDialog: Dispatch<SetStateAction<NewThreadDialog | null>>;
  readonly onDraft: (projectId: string | undefined) => void;
}): JSX.Element {
  // Without a boundary of their own, a dialog's load would suspend the shell
  // behind it.
  return (
    <Suspense fallback={null}>
      {dialog === "picker" ? (
        <ProjectPicker
          onPick={onDraft}
          onNewProject={() => {
            setDialog("new-project");
          }}
          onClose={() => {
            // The picker's close event fires after New project has already
            // asked for the next dialog, which must stay.
            setDialog((current) => (current === "picker" ? null : current));
          }}
        />
      ) : null}
      {dialog === "new-project" ? (
        <NewProjectDialog
          onAdded={onDraft}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}
    </Suspense>
  );
}
