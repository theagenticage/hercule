import { useRef, type JSX, type KeyboardEvent } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useFailedRun } from "../app/failed-run";
import { inboxCountQuery } from "../app/queries";
import type { SidebarFace } from "./sidebar-face";

/** The switch's segments, in order, with the label each one shows. */
const SEGMENTS: ReadonlyArray<{ readonly face: SidebarFace; readonly label: string }> = [
  { face: "threads", label: "Threads" },
  { face: "orchestration", label: "Hercule" },
];

/**
 * Renders the sidebar's face switch, Threads | Hercule: the book's segmented
 * control at the top of the sidebar, drawn as a tab list whose tabs control
 * the sidebar's list, the element with the id `listId`.
 *
 * - The segment of `face` is selected. Pressing a segment calls `onChange`
 *   with its face.
 * - Only the selected segment is in the tab order. ← and → select the other
 *   segment and move the focus to it, as in any segmented control.
 * - The Hercule segment ends in the Inbox's count, in the same plain grey as
 *   the Inbox's row on the Hercule face, and its accessible name carries the
 *   count: "Hercule, 8 waiting". The count is the things on the Inbox someone
 *   waits on the user for, the `waiting` of `externalEntity.countInbox`. It is
 *   hidden at 0. The shell's loader reads it and keeps it cached for the life
 *   of the window, so nothing here waits in practice.
 * - While a run is failed on a Task and the Threads face shows, a 7px marigold
 *   dot sits at the end of the Hercule segment, as a button of its own beside
 *   the tab list (it is not a tab). It is the only click here that opens Work
 *   on what failed: pressing the word still only changes the face, so nobody
 *   leaves a thread to glance at the other face. The Hercule face shows the
 *   same dot on its Overview row instead.
 */
export function FaceSwitch({
  face,
  onChange,
  listId,
}: {
  readonly face: SidebarFace;
  readonly onChange: (face: SidebarFace) => void;
  readonly listId: string;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected/_shell" }).controller;
  const { waiting } = useSuspenseQuery(inboxCountQuery(client)).data;
  const { hasFailedRun, openFailedRuns } = useFailedRun();
  // The Hercule face shows the same dot on its Overview row instead.
  const showsDot = hasFailedRun && face === "threads";
  const listRef = useRef<HTMLDivElement>(null);

  const moveSelection = (event: KeyboardEvent): void => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const index = SEGMENTS.findIndex((segment) => segment.face === face) + step;
    if (step === 0 || index < 0 || index >= SEGMENTS.length) return;
    event.preventDefault();
    onChange(SEGMENTS[index]!.face);
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
  };

  return (
    <div className="seg-side">
      <div
        ref={listRef}
        className="seg seg--side"
        role="tablist"
        aria-label="Sidebar"
        onKeyDown={moveSelection}
      >
        {SEGMENTS.map((segment) => (
          <button
            key={segment.face}
            type="button"
            role="tab"
            aria-selected={segment.face === face}
            aria-controls={listId}
            tabIndex={segment.face === face ? 0 : -1}
            data-has-dot={segment.face === "orchestration" && showsDot ? "" : undefined}
            onClick={() => onChange(segment.face)}
            aria-label={
              segment.face === "orchestration" && waiting > 0
                ? `${segment.label}, ${String(waiting)} waiting`
                : undefined
            }
          >
            {segment.label}
            {segment.face === "orchestration" && waiting > 0 && <b className="count">{waiting}</b>}
          </button>
        ))}
      </div>
      {showsDot && (
        <button
          type="button"
          className="seg-dot"
          aria-label="A run failed. Open Work filtered to Failed."
          onClick={openFailedRuns}
        />
      )}
    </div>
  );
}
