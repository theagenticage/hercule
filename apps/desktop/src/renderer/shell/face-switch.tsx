import { useRef, type JSX, type KeyboardEvent } from "react";
import { describeHerculeSegment } from "@hercule/client-core";
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
 * - The Hercule segment ends in `toDoCount`, Intake's To do count, in
 *   marigold, and its accessible name carries the count: "Hercule, 8 to do".
 *   The count is hidden at 0.
 */
export function FaceSwitch({
  face,
  onChange,
  listId,
  toDoCount,
}: {
  readonly face: SidebarFace;
  readonly onChange: (face: SidebarFace) => void;
  readonly listId: string;
  readonly toDoCount: number;
}): JSX.Element {
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
          onClick={() => onChange(segment.face)}
          aria-label={
            segment.face === "orchestration" && toDoCount > 0
              ? describeHerculeSegment(toDoCount)
              : undefined
          }
        >
          {segment.label}
          {segment.face === "orchestration" && toDoCount > 0 && (
            <b className="count count--you">{toDoCount}</b>
          )}
        </button>
      ))}
    </div>
  );
}
