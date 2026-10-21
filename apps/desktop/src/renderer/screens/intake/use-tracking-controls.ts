/**
 * What the user does with Tracking on Intake's To do view: opening and
 * closing it, selecting a row and showing its pane, taking a row off, and
 * opening the selected row's run (spec 17 §Tracking, §Keys).
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  canMarkTrackingRowDone,
  type TrackingDestination,
  type TrackingRow,
} from "@hercule/client-core";
import { pickSelectionAfterMove } from "./pick-selection-after-move";
import type { IntakeSplitState } from "./use-intake-split";
import type { HeldTrackingRowsState } from "./use-held-tracking-rows";
import type { TakeOffStatus, TakeOffTracking } from "./use-take-off-tracking";

/** What the controls act on, and where they report. */
interface TrackingControlsInput {
  /** Whether Tracking is opened over the list. */
  readonly open: boolean;
  /**
   * The selected row's Task while Tracking is opened and the row is still
   * drawn, else `null`. The address holds the selection, so it comes from the
   * route.
   */
  readonly selectedTaskId: string | null;
  /**
   * Tracking's rows as last read. Whether a row can be taken off, and where
   * its run is, are decided from them, not from `shownRows`: a row that is
   * Working now must not be ticked off, though it may still be drawn Finished
   * while changes wait.
   */
  readonly readRows: ReadonlyArray<TrackingRow>;
  /** The rows Tracking draws, which the keys walk. They lag `readRows` while changes are held. */
  readonly shownRows: ReadonlyArray<TrackingRow>;
  readonly heldTracking: HeldTrackingRowsState;
  readonly takeOff: TakeOffTracking;
  /**
   * The split of the list and the pane. Its list column takes the focus when
   * Tracking closes, and its pane follows the selected row.
   */
  readonly split: IntakeSplitState;
  /** Called as Tracking opens, so the screen can put away what the sheet covers: its checks and menus. */
  readonly onOpening: () => void;
  /**
   * Opens or closes Tracking. Opening it selects the row of `taskId`, or no
   * row when none is given. Closing it clears the selection.
   */
  readonly onOpenChange: (open: boolean, taskId?: string) => void;
  /** Selects the row of `taskId`, or no row with `null`, while Tracking is opened. */
  readonly onSelectTask: (taskId: string | null) => void;
  /** Called with where a link of the pane goes, or `O` goes to. */
  readonly onOpenDestination: (destination: TrackingDestination) => void;
}

/** The controls of Tracking, as `useTrackingControls` returns them. */
export interface TrackingControls {
  readonly openTracking: () => void;
  /**
   * Opens Tracking with the row of `taskId` selected and its pane shown, so
   * the sheet scrolls to the row and puts the focus on it. A Task with no row
   * leaves nothing selected.
   */
  readonly showTaskInTracking: (taskId: string) => void;
  readonly closeTracking: () => void;
  /**
   * Selects the row of `taskId` and shows its pane, as a click on the row
   * does. On a row of folded Tracking it opens Tracking on that row instead.
   */
  readonly selectRow: (taskId: string) => void;
  /**
   * Sets the Task `taskId` to `status`, which takes its row off Tracking,
   * unless its row can be taken off no more (see `canMarkTrackingRowDone`) or
   * is gone from the last read. When the row was the selected one, the
   * selection goes to the next row that stays.
   */
  readonly takeOffTask: (taskId: string, status: TakeOffStatus) => void;
  /**
   * The Task whose pane the focus is to go to: the user pressed `↩` on its
   * row. The pane takes the focus once it shows the row, then calls
   * `clearPaneFocus`.
   */
  readonly paneFocusTaskId: string | null;
  readonly clearPaneFocus: () => void;
  /**
   * Runs a key pressed while Tracking is opened. `key` is the key as the
   * screen read it, and `extending` is whether Shift was held.
   *
   * - `J`/`K` and the arrows walk the rows.
   * - `↩` on a row selects it, shows its pane, and moves the focus to the
   *   suggested answer. A second `↩` presses that answer.
   * - `E` takes off the row that has the focus as done, or else the selected row.
   * - `O` opens the selected row's run.
   * - Esc hides the pane, then clears the selection, then closes Tracking.
   *
   * Every other key does nothing.
   */
  readonly handleOpenedKey: (
    event: KeyboardEvent<HTMLDivElement>,
    key: string,
    extending: boolean,
  ) => void;
}

/** Returns the controls of Tracking for the screen to wire to its keys, to `TrackingTray` and to the pane. */
export const useTrackingControls = ({
  open,
  selectedTaskId,
  readRows,
  shownRows,
  heldTracking,
  takeOff,
  split,
  onOpening,
  onOpenChange,
  onSelectTask,
  onOpenDestination,
}: TrackingControlsInput): TrackingControls => {
  const { listRef, setDismissed } = split;
  const [paneFocusTaskId, setPaneFocusTaskId] = useState<string | null>(null);
  const shownIds = shownRows.map((row) => row.task.taskId);
  // Read when a request ends, which can be after the selection moved on.
  const selectedTaskIdRef = useRef(selectedTaskId);
  useLayoutEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
  }, [selectedTaskId]);

  const openTracking = (): void => {
    onOpening();
    onOpenChange(true);
  };

  const showTaskInTracking = (taskId: string): void => {
    onOpening();
    setDismissed(false);
    onOpenChange(true, taskId);
  };

  const closeTracking = (): void => {
    setDismissed(false);
    onOpenChange(false);
    // The sheet holds the focus and is about to go. The list holds it until the signals are back.
    listRef.current?.focus({ preventScroll: true });
  };

  const selectRow = (taskId: string): void => {
    if (!open) {
      showTaskInTracking(taskId);
      return;
    }
    setDismissed(false);
    if (taskId !== selectedTaskIdRef.current) onSelectTask(taskId);
  };

  /** Moves the selection by `step`, and stops at the first and the last row. */
  const moveSelection = (step: 1 | -1): void => {
    if (shownIds.length === 0) return;
    const at = selectedTaskId === null ? -1 : shownIds.indexOf(selectedTaskId);
    const next = at < 0 ? (step === 1 ? 0 : shownIds.length - 1) : at + step;
    onSelectTask(shownIds[Math.min(Math.max(next, 0), shownIds.length - 1)]!);
  };

  /**
   * Moves the focus off the row of `taskId`, and off its pane, when either
   * holds it: to the sheet while Tracking is opened, else to the list. The
   * row is about to leave, and a focused element that is removed drops the
   * focus to the page's body, where none of the screen's keys, Esc included,
   * reach.
   */
  const moveFocusOffTask = (taskId: string): void => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) return;
    const inRow = focused.closest(".tr-run-item")?.getAttribute("data-item-key") === taskId;
    const inPane = focused.closest(".asks-detail") !== null;
    if (!inRow && !inPane) return;
    const holder = open
      ? listRef.current?.querySelector<HTMLElement>(".tr-tray.is-open")
      : listRef.current;
    holder?.focus({ preventScroll: true });
  };

  const takeOffTask = (taskId: string, status: TakeOffStatus): void => {
    const row = readRows.find((each) => each.task.taskId === taskId);
    if (row === undefined || !canMarkTrackingRowDone(row)) return;
    const next = pickSelectionAfterMove(shownIds, taskId, [taskId]);
    heldTracking.registerMarkedDone(taskId);
    moveFocusOffTask(taskId);
    takeOff.run(
      { taskId, title: row.task.title, status },
      () => {
        if (selectedTaskIdRef.current === taskId) onSelectTask(next);
      },
      () => {
        heldTracking.forgetMarkedDone(taskId);
      },
    );
  };

  const handleOpenedKey = (
    event: KeyboardEvent<HTMLDivElement>,
    key: string,
    extending: boolean,
  ): void => {
    const target = event.target as HTMLElement;
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
        // With the focus in a row, the row is the one taken off, its Mark done
        // control included, whatever row is selected.
        const taskId =
          target.closest<HTMLElement>(".tr-run-item")?.dataset.itemKey ?? selectedTaskId;
        if (!extending && taskId !== null) takeOffTask(taskId, "done");
        return;
      }
      case "o": {
        event.preventDefault();
        const row = readRows.find((each) => each.task.taskId === selectedTaskId);
        if (!extending && row !== undefined) onOpenDestination({ kind: "run", runId: row.run.id });
        return;
      }
      case "Enter": {
        // `↩` on a row shows its pane on the suggested answer, and never
        // answers: the second `↩` presses the focused answer, natively.
        const taskId = target.dataset.taskId;
        if (taskId === undefined) return;
        event.preventDefault();
        selectRow(taskId);
        if (split.fits) setPaneFocusTaskId(taskId);
        return;
      }
      case "Escape":
        event.preventDefault();
        if (split.paneShown) setDismissed(true);
        else if (selectedTaskId !== null) {
          setDismissed(false);
          onSelectTask(null);
        } else closeTracking();
        return;
    }
  };

  return {
    openTracking,
    showTaskInTracking,
    closeTracking,
    selectRow,
    takeOffTask,
    paneFocusTaskId,
    clearPaneFocus: () => {
      setPaneFocusTaskId(null);
    },
    handleOpenedKey,
  };
};
