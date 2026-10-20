/**
 * What the user does with Tracking on Intake's To do view: opening and
 * closing it, selecting a row, ticking a row off, and opening a row's run
 * (spec 17 §Tracking, §Keys).
 */
import { useState, type KeyboardEvent, type RefObject } from "react";
import { canMarkTrackingStateDone, type TrackingRow } from "@hercule/client-core";
import { pickSelectionAfterMove } from "./pick-selection-after-move";
import type { HeldTrackingRowsState } from "./use-held-tracking-rows";
import type { TrackingTickOff } from "./use-tracking-tick-off";

/** What the controls act on, and where they report. */
interface TrackingControlsInput {
  /** Whether Tracking is opened over the list. */
  readonly open: boolean;
  /**
   * Tracking's rows as last read. Whether a row can be ticked off is decided
   * from them, not from `shownRows`: a row that is Working now must not be
   * ticked off, though it may still be drawn Finished while changes wait.
   */
  readonly readRows: ReadonlyArray<TrackingRow>;
  /** The rows Tracking draws, which the keys walk. They lag `readRows` while changes are held. */
  readonly shownRows: ReadonlyArray<TrackingRow>;
  readonly heldTracking: HeldTrackingRowsState;
  readonly tickOff: TrackingTickOff;
  /** The list column's element, which takes the focus when Tracking closes. */
  readonly listRef: RefObject<HTMLElement | null>;
  /** Called as Tracking opens, so the screen can put away what the sheet covers: its checks and menus. */
  readonly onOpening: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenRun: (runId: string) => void;
}

/** The controls of Tracking, as `useTrackingControls` returns them. */
export interface TrackingControls {
  /** The selected row's Task, while Tracking is opened and the row is still drawn, else `null`. */
  readonly selectedTaskId: string | null;
  readonly openTracking: () => void;
  readonly closeTracking: () => void;
  /**
   * Marks the Task `taskId` done, unless its row is Working in the last read
   * or is gone from it. When the row was the selected one, the selection goes
   * to the next row that stays.
   */
  readonly markTaskDone: (taskId: string) => void;
  /** Opens the page of the run of the row of `taskId`. */
  readonly openTrackingRow: (taskId: string) => void;
  /**
   * Runs a key pressed while Tracking is opened. `key` is the key as the
   * screen read it, and `extending` is whether Shift was held. `J`/`K` and the
   * arrows walk the rows, `E` ticks off the row that has the focus, or else the
   * selected row, and Esc clears the
   * selection and then closes Tracking. Every other key does nothing.
   */
  readonly handleOpenedKey: (
    event: KeyboardEvent<HTMLDivElement>,
    key: string,
    extending: boolean,
  ) => void;
}

/** Returns the controls of Tracking for the screen to wire to its keys and to `TrackingTray`. */
export const useTrackingControls = ({
  open,
  readRows,
  shownRows,
  heldTracking,
  tickOff,
  listRef,
  onOpening,
  onOpenChange,
  onOpenRun,
}: TrackingControlsInput): TrackingControls => {
  // The selected row of opened Tracking. A row that left Tracking is not
  // selected any more.
  const [selection, setSelection] = useState<string | null>(null);
  const shownIds = shownRows.map((row) => row.task.taskId);
  const selectedTaskId =
    open && selection !== null && shownIds.includes(selection) ? selection : null;

  const openTracking = (): void => {
    onOpening();
    setSelection(null);
    onOpenChange(true);
  };

  const closeTracking = (): void => {
    setSelection(null);
    onOpenChange(false);
    // The sheet holds the focus and is about to go. The list holds it until the signals are back.
    listRef.current?.focus({ preventScroll: true });
  };

  /** Moves the selection by `step`, and stops at the first and the last row. */
  const moveSelection = (step: 1 | -1): void => {
    if (shownIds.length === 0) return;
    const at = selectedTaskId === null ? -1 : shownIds.indexOf(selectedTaskId);
    const next = at < 0 ? (step === 1 ? 0 : shownIds.length - 1) : at + step;
    setSelection(shownIds[Math.min(Math.max(next, 0), shownIds.length - 1)]!);
  };

  /**
   * Moves the focus off the row of `taskId` when it holds it: to the sheet
   * while Tracking is opened, else to the list. The row is about to leave, and
   * a focused element that is removed drops the focus to the page's body,
   * where none of the screen's keys, Esc included, reach.
   */
  const moveFocusOffRow = (taskId: string): void => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) return;
    if (focused.closest(".tr-run-item")?.getAttribute("data-item-key") !== taskId) return;
    const holder = open ? focused.closest<HTMLElement>(".tr-tray") : listRef.current;
    holder?.focus({ preventScroll: true });
  };

  const markTaskDone = (taskId: string): void => {
    const row = readRows.find((each) => each.task.taskId === taskId);
    if (row === undefined || !canMarkTrackingStateDone(row.state)) return;
    const next = pickSelectionAfterMove(shownIds, taskId, [taskId]);
    heldTracking.registerMarkedDone(taskId);
    moveFocusOffRow(taskId);
    tickOff.run(
      { taskId, title: row.task.title },
      () => {
        setSelection((current) => (current === taskId ? next : current));
      },
      () => {
        heldTracking.forgetMarkedDone(taskId);
      },
    );
  };

  const openTrackingRow = (taskId: string): void => {
    const row = shownRows.find((each) => each.task.taskId === taskId);
    if (row !== undefined) onOpenRun(row.run.id);
  };

  const handleOpenedKey = (
    event: KeyboardEvent<HTMLDivElement>,
    key: string,
    extending: boolean,
  ): void => {
    switch (key) {
      case "j":
      case "ArrowDown":
        event.preventDefault();
        if (!extending) moveSelection(1);
        return;
      case "k":
      case "ArrowUp":
        event.preventDefault();
        if (!extending) moveSelection(-1);
        return;
      case "e": {
        event.preventDefault();
        // With the focus in a row, the row is the one ticked off, its Mark done
        // control included, whatever row is selected.
        const focusedTaskId = (event.target as HTMLElement).closest<HTMLElement>(".tr-run-item")
          ?.dataset.itemKey;
        const taskId = focusedTaskId ?? selectedTaskId;
        if (!extending && taskId !== null) markTaskDone(taskId);
        return;
      }
      case "Escape":
        event.preventDefault();
        if (selectedTaskId !== null) setSelection(null);
        else closeTracking();
        return;
    }
  };

  return {
    selectedTaskId,
    openTracking,
    closeTracking,
    markTaskDone,
    openTrackingRow,
    handleOpenedKey,
  };
};
