import { useEffect, type JSX } from "react";
import { buildArchivedToast, buildArchiveTitle, planArchiveAll } from "@hercule/client-core";
import { useDoneMoves } from "../app/done-moves";
import { useSessionPresentation } from "../app/session-presentation";
import { ArchiveDialog } from "../screens/archive-dialog";

/** What the sidebar asks to archive: one Done shelf row, by its group key, or every row of the shelf. */
export type ArchiveTarget =
  | { readonly kind: "row"; readonly groupKey: string }
  | { readonly kind: "all" };

/**
 * Renders the confirmation for archiving `target` from the Done shelf, and
 * archives on Archive (spec 17 §Archiving a row).
 *
 * The rows are read from the sidebar's rows when the dialog draws, so the
 * title and the Threads archived always agree with what the sidebar holds:
 * a row that changes while the dialog is open changes the dialog. "All"
 * takes the rows `planArchiveAll` plans, and the toast then says how many
 * working rows were skipped and how many did not fit in one call. When the
 * rows are gone, for instance because every one began to work, the dialog
 * closes and calls `onClose`.
 */
export function ArchiveRowsDialog({
  target,
  onClose,
}: {
  readonly target: ArchiveTarget;
  readonly onClose: () => void;
}): JSX.Element | null {
  const { groupRows } = useSessionPresentation();
  const { archive } = useDoneMoves();
  const plan =
    target.kind === "all"
      ? planArchiveAll(groupRows)
      : (() => {
          const rows = groupRows.filter((row) => row.key === target.groupKey);
          return {
            rows,
            sessionIds: rows.flatMap((row) => row.threadIds),
            skippedWorking: 0,
            leftOver: 0,
          };
        })();
  const nothingToArchive = plan.rows.length === 0;
  useEffect(() => {
    if (nothingToArchive) onClose();
  }, [nothingToArchive, onClose]);
  if (nothingToArchive) return null;
  return (
    <ArchiveDialog
      title={buildArchiveTitle(plan.rows)}
      onConfirm={() => {
        archive(plan.sessionIds, buildArchivedToast(plan.rows.length, plan));
      }}
      onClose={onClose}
    />
  );
}
