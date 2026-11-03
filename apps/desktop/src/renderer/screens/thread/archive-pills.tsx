/**
 * The two header pills that archiving adds: the More menu with "Archive…",
 * and the note an archived thread shows instead of Done and More. They sit
 * apart from `thread-header.tsx` to keep that file about the tabs.
 */
import { useState, type JSX } from "react";
import {
  buildArchivedToast,
  buildArchiveTitle,
  findArchiveBlockReason,
  formatDay,
  resolveBrowserTimezone,
  type GroupRow,
} from "@hercule/client-core";
import { useDoneMoves } from "../../app/done-moves";
import { ArchiveIcon } from "../../icons/archive";
import { MoreIcon } from "../../icons/more";
import { ArchiveDialog } from "../archive-dialog";
import { usePopoverMenu } from "../use-popover-menu";
import "./menus.css";
import "./thread-header.css";

/**
 * Renders the header's More pill for the row `row` of the open thread: a
 * menu with one entry, "Archive…", which opens the confirmation. While a
 * session of the row works, the entry is disabled and its tooltip says why.
 * Confirming archives every Thread of the row and shows the shell's toast.
 */
export function ThreadMorePill({ row }: { readonly row: GroupRow }): JSX.Element {
  const { archive } = useDoneMoves();
  const { triggerProps, menuProps, buildItemProps, close } = usePopoverMenu();
  const [confirming, setConfirming] = useState(false);
  const blockReason = findArchiveBlockReason(row);
  return (
    <span className="pill">
      <button type="button" className="icon-btn" aria-label="More" title="More" {...triggerProps}>
        <MoreIcon />
      </button>
      <div
        {...menuProps}
        popover="auto"
        role="menu"
        aria-label="More"
        className="pop popover-menu more-menu"
      >
        <button
          type="button"
          {...buildItemProps("archive", { disabled: blockReason !== null })}
          title={blockReason ?? undefined}
          onClick={() => {
            if (blockReason !== null) return;
            close();
            setConfirming(true);
          }}
        >
          <ArchiveIcon size={14} />
          <span>Archive…</span>
        </button>
      </div>
      {/* Inside the pill, which takes pointer events: the header's other children do not,
          and the dialog would inherit that. */}
      {confirming && (
        <ArchiveDialog
          title={buildArchiveTitle([row])}
          onConfirm={() => {
            archive(row.threadIds, buildArchivedToast(1));
          }}
          onClose={() => {
            setConfirming(false);
          }}
        />
      )}
    </span>
  );
}

/**
 * Renders the pill an archived thread shows in place of Done and More:
 * "Archived 2 Nov", the day `archivedAt` falls on in the browser's time zone.
 */
export function ArchivedPill({ archivedAt }: { readonly archivedAt: string }): JSX.Element {
  const [timezone] = useState(resolveBrowserTimezone);
  const day = formatDay(new Date(archivedAt), timezone);
  return (
    <span className="pill">
      <span className="pill-note">
        <ArchiveIcon size={14} />
        {day === undefined ? "Archived" : `Archived ${day}`}
      </span>
    </span>
  );
}
