/**
 * Intake: the signals of one view in a list, and the selected one in a pane
 * beside it (spec 17 §Intake).
 */
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import { useInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Signal, SignalView } from "@hercule/contract";
import {
  countWaitingTrackingRows,
  decideSignalRowControls,
  describeBulkDoneTitle,
  groupSignalsByDay,
  groupSignalsIntoSections,
  isMoveLeavingView,
  listBulkMoves,
  moveSignalSelection,
  parsePluginId,
  planSignalMove,
  resolveDisplayTimezone,
  toggleSignalCheck,
  type IntakeSection,
  type IntakeView,
  type SignalMove,
  type SignalMovePlan,
} from "@hercule/client-core";
import {
  settingsQuery,
  signalsDoneQuery,
  signalsLaterQuery,
  signalsToDoQuery,
} from "../../app/queries";
import { useTrackingRows } from "../../app/tracking";
import { createHandoffFlights } from "./handoff-flight";
import { IntakeDock } from "./intake-dock";
import { InboxZero } from "./inbox-zero";
import { IntakeFoot } from "./intake-foot";
import { IntakeBar, IntakeSplit, IntakeViewSwitcher } from "./intake-frame";
import { IntakeList, type BulkHighlight, type SignalRowAction } from "./intake-list";
import { isTextField } from "../../app/text-field";
import { pickSelectionAfterMove } from "./pick-selection-after-move";
import { SignalPane, type SignalPaneHandle } from "./signal-pane";
import { SnoozeMenu } from "./snooze-menu";
import { TrackingTray } from "./tracking-tray";
import { canMarkTrackingStateDone } from "./tracking-states";
import { useIntakeSplit } from "./use-intake-split";
import { useHeldSignals } from "./use-held-signals";
import { useHeldTrackingRows } from "./use-held-tracking-rows";
import { useIntakeTabs } from "./use-intake-tabs";
import { useTrackingTickOff } from "./use-tracking-tick-off";
import {
  IntakeMovesContext,
  useMoveToast,
  useSignalMoveRunner,
  type IntakeMoves,
  type SnoozeMenuPlace,
} from "./use-signal-moves";

/** The snooze menu while it is open: where, for which signals, and whether `H` opened it. */
interface OpenSnoozeMenu {
  readonly place: SnoozeMenuPlace;
  readonly signals: ReadonlyArray<Signal>;
  readonly openedByKey: boolean;
}

/** The checked rows, and the view and tab they were checked in. */
interface Checks {
  /** The view and the tab, as `<view>:<plugin id or "all">`. */
  readonly scope: string;
  readonly ids: ReadonlySet<string>;
}

/** Checks whether `signal` can be checked in `view`. */
const isCheckable = (signal: Signal | undefined, view: SignalView): signal is Signal =>
  signal !== undefined && decideSignalRowControls(signal, view).checkable;

/**
 * Renders Intake: the bar with its source tabs and the pane's toggle, then
 * the split of the list and the pane. Above the list, the view switcher
 * picks To do, Later or Done; the view and the tab combine.
 *
 * `view` and `selectedId` come from the URL. `onSelect` changes the
 * selected signal, or clears it with `null`, and `onViewChange` switches
 * the view, which clears the selection and the checks. The pane shows the
 * selected signal unless the user closed it with Esc, which keeps the row
 * selected, or the split is too narrow for it.
 *
 * On To do, Tracking lies under the list, folded, or opened over the whole
 * list column (`trackingOpen`, which `onTrackingOpenChange` changes; opening
 * it clears the selected signal). The rows of Tracking that wait on the user
 * count in To do, so a list with no signal but such rows is not at inbox
 * zero. A press on a row of Tracking calls `onOpenRun` with its run's id.
 *
 * The keys of spec 17 §Keys act while the focus is in the list or the pane
 * and never in a text field:
 *
 * - `J`/`K` and `↓`/`↑` move the selection; with `⇧` they also check the
 *   row they leave and the row they land on.
 * - `X` checks or unchecks the selected row.
 * - `E` marks the checked rows done, or the selected row when none is.
 * - `H` opens the snooze menu, `U` unsnoozes on Later.
 * - `↩` on a row opens the pane on the suggested answer, `R` opens the
 *   Reply box, and `O` opens the signal on its source.
 * - Esc clears the checks, and then steps back.
 * - `T` opens and closes Tracking. While it is open, `J`/`K` and `↓`/`↑` walk
 *   only its rows, `E` marks the selected row done unless it is Working, and
 *   Esc clears the selection, then closes Tracking.
 */
export function IntakeScreen({
  view,
  pluginId,
  selectedId: selectedIdParam,
  trackingOpen: trackingOpenParam,
  onSelect,
  onTrackingOpenChange,
  onOpenRun,
  onViewChange,
  onPluginChange,
}: {
  readonly view: SignalView;
  /** The pressed source tab, `null` for All. */
  readonly pluginId: string | null;
  readonly selectedId: string | null;
  /** Whether Tracking is opened over the list. It shows on To do only. */
  readonly trackingOpen: boolean;
  readonly onSelect: (signalId: string | null) => void;
  /** Opens or closes Tracking. Opening it also clears the selected signal. */
  readonly onTrackingOpenChange: (open: boolean) => void;
  /** Opens the page of a run. */
  readonly onOpenRun: (runId: string) => void;
  readonly onViewChange: (view: IntakeView) => void;
  readonly onPluginChange: (pluginId: string | null) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { tabs, plugins } = useIntakeTabs(pluginId);
  // The rows as last read give the counts, which follow each read at once.
  // The rows Tracking draws, and the keys walk, are held while the pointer is
  // on the list column (below).
  const readTrackingRows = useTrackingRows();
  const [pointerOverColumn, setPointerOverColumn] = useState(false);
  const heldTracking = useHeldTrackingRows(readTrackingRows, pointerOverColumn);
  const trackingRows = heldTracking.shown;
  // A handoff's flight carries a copy of the signal's row from the list to
  // folded Tracking, in a layer over the list column.
  const [flights] = useState(createHandoffFlights);
  // Tracking covers the list, so no signal is selected while it is open.
  const trackingOpen = view === "to-do" && trackingOpenParam;
  const selectedId = trackingOpen ? null : selectedIdParam;
  const { data: toDo } = useSuspenseQuery(signalsToDoQuery(client));
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const timezone = resolveDisplayTimezone(settings.user.timezone);
  // The view and the tab shown. Switching either clears the checks, closes
  // the snooze menu, drops the bulk bar's preview, and shows the new list
  // with no motion.
  const scope = `${view}:${pluginId ?? "all"}`;
  const [focusPaneFor, setFocusPaneFor] = useState<string | null>(null);
  const [focusSelectedRow, setFocusSelectedRow] = useState(false);
  const split = useIntakeSplit(selectedId, "data-signal-id");
  const { listRef, fits, paneShown, paneDrawn, setDismissed } = split;
  const paneRef = useRef<SignalPaneHandle>(null);
  // Read by `openSignal` when it runs, so `openSignal` keeps one identity
  // while `J` and `K` change the selection, and the list's rows, which are
  // memoized, do not draw again.
  const selectedIdRef = useRef(selectedId);
  useLayoutEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // Later and Done are read page by page, for the tab shown. On To do this
  // read is off, and its data unused.
  const paged = useInfiniteQuery({
    ...(view === "done" ? signalsDoneQuery : signalsLaterQuery)(client, pluginId ?? undefined),
    enabled: view !== "to-do",
  });
  // The signals of the view and the tab as last read, in the list's order.
  // Later and Done are read in that order already.
  const listed = useMemo(
    () =>
      view === "to-do"
        ? groupSignalsIntoSections(toDo, pluginId).flatMap((section) => section.signals)
        : (paged.data?.pages.flatMap((page) => page.items) ?? []),
    [view, toDo, pluginId, paged.data],
  );
  // What the list shows: the view, the tab, and for Later and Done the
  // pages read. A new page, or the first, is the user's own scrolling, so
  // it shows the last read at once, with no motion and nothing held.
  const listScope = view === "to-do" ? scope : `${scope}:${String(paged.data?.pages.length ?? 0)}`;
  const [pointerOverList, setPointerOverList] = useState(false);
  const [menu, setMenu] = useState<OpenSnoozeMenu | null>(null);
  // A menu opened from the list draws outside it, so the changes keep
  // waiting while the pointer is in the menu.
  const held = useHeldSignals(
    listed,
    listScope,
    pointerOverList || menu?.place === "row" || menu?.place === "bar",
  );
  const toast = useMoveToast();
  const moves = useSignalMoveRunner(client, timezone, held, toast);
  const tickOff = useTrackingTickOff(client, toast);
  const sections: ReadonlyArray<IntakeSection> =
    view === "to-do"
      ? groupSignalsIntoSections(held.shown, pluginId)
      : groupSignalsByDay(held.shown, view, new Date(), timezone);
  // The rows the list draws, in order, for the view and the tab shown.
  const listedSignals = sections.flatMap((section) => section.signals);
  const selectedSignal = listedSignals.find((signal) => signal.id === selectedId);

  const [checks, setChecks] = useState<Checks>({ scope, ids: new Set() });
  const [preview, setPreview] = useState<SignalMove | null>(null);
  if (checks.scope !== scope) {
    setChecks({ scope, ids: new Set() });
    setPreview(null);
    setMenu(null);
  }
  // Read when a move ends, which can be after the user switched the view or
  // the tab.
  const scopeRef = useRef(scope);
  useLayoutEffect(() => {
    scopeRef.current = scope;
  }, [scope]);
  const checkedSignals = listedSignals.filter((signal) => checks.ids.has(signal.id));

  /** Replaces the checked rows with `ids`. With none left, the bar's preview goes with the bar. */
  const updateChecks = (ids: ReadonlySet<string>): void => {
    setChecks({ scope, ids });
    if (ids.size === 0) setPreview(null);
  };

  // The selected row of opened Tracking. A row that left Tracking is not
  // selected any more.
  const [trackingSelection, setTrackingSelection] = useState<string | null>(null);
  const trackingIds = trackingRows.map((row) => row.task.id);
  const selectedTaskId =
    trackingOpen && trackingSelection !== null && trackingIds.includes(trackingSelection)
      ? trackingSelection
      : null;

  const openTracking = (): void => {
    updateChecks(new Set());
    setMenu(null);
    setTrackingSelection(null);
    onTrackingOpenChange(true);
  };

  const closeTracking = (): void => {
    setTrackingSelection(null);
    onTrackingOpenChange(false);
    // The sheet holds the focus and is about to go. The list holds it until the signals are back.
    listRef.current?.focus({ preventScroll: true });
  };

  /** Moves the selection of opened Tracking by `step`, and stops at the first and the last row. */
  const moveTrackingSelection = (step: 1 | -1): void => {
    if (trackingIds.length === 0) return;
    const at = selectedTaskId === null ? -1 : trackingIds.indexOf(selectedTaskId);
    const next = at < 0 ? (step === 1 ? 0 : trackingIds.length - 1) : at + step;
    setTrackingSelection(trackingIds[Math.min(Math.max(next, 0), trackingIds.length - 1)]!);
  };

  /**
   * Marks the row of `taskId` done, unless it is Working. When the row was the
   * selected one, the selection goes to the next row that stays.
   */
  const markTaskDone = (taskId: string): void => {
    const row = trackingRows.find((each) => each.task.id === taskId);
    if (row === undefined || !canMarkTrackingStateDone(row.state)) return;
    const next = pickSelectionAfterMove(trackingIds, taskId, [taskId]);
    heldTracking.registerMarkedDone(taskId);
    tickOff.run(
      { taskId, title: row.task.title },
      () => {
        setTrackingSelection((current) => (current === taskId ? next : current));
      },
      () => {
        heldTracking.forgetMarkedDone(taskId);
      },
    );
  };

  const openTrackingRow = (taskId: string): void => {
    const row = trackingRows.find((each) => each.task.id === taskId);
    if (row !== undefined) onOpenRun(row.run.id);
  };

  /** Selects `signalId` and shows the pane, as a click on its row does. */
  const openSignal = (signalId: string): void => {
    setDismissed(false);
    if (signalId !== selectedIdRef.current) onSelect(signalId);
  };

  const moveSelection = (step: 1 | -1): void => {
    const next = moveSignalSelection(sections, selectedId, step);
    if (next === null || next === selectedId) return;
    // The pane draws the new signal from scratch, which drops the focus
    // inside it, so the focus goes to the list and stays on the keys' side.
    if (!(listRef.current?.contains(document.activeElement) ?? false)) setFocusSelectedRow(true);
    onSelect(next);
  };

  /** Moves the selection by `step`, and checks the row it leaves and the row it lands on. */
  const extendChecks = (step: 1 | -1): void => {
    const next = moveSignalSelection(sections, selectedId, step);
    const landed = listedSignals.find((signal) => signal.id === next);
    const ids = new Set(checks.ids);
    for (const signal of [selectedSignal, landed]) {
      if (isCheckable(signal, view)) ids.add(signal.id);
    }
    updateChecks(ids);
    setMenu(null);
    moveSelection(step);
  };

  const stepBack = (): void => {
    if (checks.ids.size > 0) {
      updateChecks(new Set());
      return;
    }
    if (paneShown) {
      setDismissed(true);
      return;
    }
    if (selectedId !== null) {
      setDismissed(false);
      onSelect(null);
    }
  };

  /**
   * Sends `plan`, with `until` for Snooze. Once its rows have left the
   * view, they leave the checks too, and a selected row that left hands the
   * selection to the next row that stayed. A move that keeps its rows in the
   * view, such as Not urgent on To do or Snooze again on Later, changes
   * neither. Nor does a move that ends after the user switched to another
   * view or tab: the selection then belongs to the list shown now, and
   * moving it would pull the user back to the list the move started from.
   */
  const runMove = (plan: SignalMovePlan, until?: string): void => {
    setPreview(null);
    const listedIds = listedSignals.map((signal) => signal.id);
    const actedIds = plan.acted.map((signal) => signal.id);
    moves.run(plan, until, () => {
      if (!isMoveLeavingView(plan.move, view) || scopeRef.current !== scope) return;
      const moved = new Set(actedIds);
      setChecks((current) => ({
        ...current,
        ids: new Set([...current.ids].filter((id) => !moved.has(id))),
      }));
      const current = selectedIdRef.current;
      const next = pickSelectionAfterMove(listedIds, current, actedIds);
      // The moved rows, or the bulk bar, may hold the focus, and both are
      // about to go. The list holds it until the next row is drawn.
      const focused = document.activeElement;
      if (focused !== null && (listRef.current?.contains(focused) ?? false)) {
        listRef.current!.focus({ preventScroll: true });
        setFocusSelectedRow(true);
      } else if (next !== current) {
        setFocusSelectedRow(true);
      }
      if (next !== current) onSelect(next);
    });
  };

  /**
   * Opens the snooze menu for `signals` at `place`, or closes it when it is
   * open there. `openedByKey` is set when `H` opened it, which marks its
   * first choice as the one `↩` takes.
   */
  const toggleSnoozeMenu = (
    place: SnoozeMenuPlace,
    signals: ReadonlyArray<Signal>,
    openedByKey = false,
  ): void => {
    setMenu((open) =>
      open?.place === place && open.signals[0]?.id === signals[0]?.id
        ? null
        : { place, signals, openedByKey },
    );
  };

  /** Runs one of the bulk bar's moves on the checked rows. Snooze opens its menu first. */
  const runBulkMove = (move: SignalMove, openedByKey = false): void => {
    if (move === "snooze") toggleSnoozeMenu("bar", checkedSignals, openedByKey);
    else runMove(planSignalMove(checkedSignals, move));
  };

  /**
   * Runs `move` from its key: on the checked rows when there are some and
   * the bulk bar offers it, otherwise on the selected row when its row
   * offers it. Snooze opens its menu first. On Later, `H` snoozes the
   * selected row again, as the pane's Snooze again… does, but does nothing
   * to checked rows, whose bar offers Unsnooze in place of Snooze.
   */
  const runKeyMove = (move: "done" | "snooze" | "unsnooze"): void => {
    if (checkedSignals.length > 0) {
      if (listBulkMoves(checkedSignals, view).includes(move)) runBulkMove(move, true);
      return;
    }
    if (selectedSignal === undefined) return;
    if (move === "snooze") {
      if (view !== "done") toggleSnoozeMenu(paneShown ? "pane" : "row", [selectedSignal], true);
    } else if (decideSignalRowControls(selectedSignal, view).slots.includes(move)) {
      runMove(planSignalMove([selectedSignal], move));
    }
  };

  // A press on a row's checkbox or move. The list's rows are memoized, so the
  // list gets one function that keeps its identity and runs the latest one.
  const runRowActionRef = useRef<(signalId: string, action: SignalRowAction) => void>(null);
  useLayoutEffect(() => {
    runRowActionRef.current = (signalId, action) => {
      const signal = listedSignals.find((each) => each.id === signalId);
      if (signal === undefined) return;
      if (action === "check") {
        updateChecks(toggleSignalCheck(checks.ids, signalId));
        setMenu(null);
      } else if (action === "snooze") {
        toggleSnoozeMenu("row", [signal]);
      } else {
        runMove(planSignalMove([signal], action));
      }
    };
  });
  const runRowAction = useCallback((signalId: string, action: SignalRowAction): void => {
    runRowActionRef.current?.(signalId, action);
  }, []);

  const hasNextPage = paged.hasNextPage;
  const isFetchingNextPage = paged.isFetchingNextPage;
  const fetchNextPage = paged.fetchNextPage;
  const readNextPage = useCallback((): void => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  /** Runs the keys of opened Tracking, which are few: it has no pane, checks or snooze yet. */
  const handleTrackingKeys = (
    event: KeyboardEvent<HTMLDivElement>,
    key: string,
    extending: boolean,
  ): void => {
    switch (key) {
      case "j":
      case "ArrowDown":
        event.preventDefault();
        if (!extending) moveTrackingSelection(1);
        return;
      case "k":
      case "ArrowUp":
        event.preventDefault();
        if (!extending) moveTrackingSelection(-1);
        return;
      case "e":
        event.preventDefault();
        if (!extending && selectedTaskId !== null) markTaskDone(selectedTaskId);
        return;
      case "Escape":
        event.preventDefault();
        if (selectedTaskId !== null) setTrackingSelection(null);
        else closeTracking();
        return;
    }
  };

  const handleKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isTextField(event.target)) return;
    // A key pressed in a dialog or a menu the pane opened, such as the
    // Ignore dialog, belongs to it. Esc there closes it, not the pane.
    if ((event.target as Element).closest("dialog, [role='menu']") !== null) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const extending = event.shiftKey;
    if (key === "t" && view === "to-do") {
      event.preventDefault();
      if (!extending) {
        if (trackingOpen) closeTracking();
        else openTracking();
      }
      return;
    }
    if (trackingOpen) {
      handleTrackingKeys(event, key, extending);
      return;
    }
    // Shift only extends the checks with the keys that move the selection.
    if (extending && !["j", "k", "ArrowDown", "ArrowUp"].includes(key)) return;
    const target = event.target as HTMLElement;
    switch (key) {
      case "j":
      case "ArrowDown":
        event.preventDefault();
        if (extending) extendChecks(1);
        else moveSelection(1);
        return;
      case "k":
      case "ArrowUp":
        event.preventDefault();
        if (extending) extendChecks(-1);
        else moveSelection(-1);
        return;
      case "x":
        event.preventDefault();
        if (isCheckable(selectedSignal, view)) {
          updateChecks(toggleSignalCheck(checks.ids, selectedSignal.id));
          setMenu(null);
        }
        return;
      case "e": {
        event.preventDefault();
        // On a row of folded Tracking, `E` marks that row done, not the selected signal.
        const focusedTaskId = target.closest<HTMLElement>("[data-task-id]")?.dataset.taskId;
        if (focusedTaskId !== undefined) markTaskDone(focusedTaskId);
        else runKeyMove("done");
        return;
      }
      case "h":
        event.preventDefault();
        runKeyMove("snooze");
        return;
      case "u":
        event.preventDefault();
        runKeyMove("unsnooze");
        return;
      case "Enter": {
        // `↩` on a row opens the pane on the suggested answer, and never
        // answers: the second `↩` presses the focused answer, natively.
        const signalId = target.dataset.signalId;
        if (signalId === undefined) return;
        event.preventDefault();
        openSignal(signalId);
        if (fits) setFocusPaneFor(signalId);
        return;
      }
      // The closed pane stays drawn, off screen, so these keys check that it shows.
      case "r":
        event.preventDefault();
        if (paneShown) paneRef.current?.openReply();
        return;
      case "o":
        event.preventDefault();
        if (paneShown) paneRef.current?.openOnSource();
        return;
      case "Escape":
        event.preventDefault();
        stepBack();
        return;
    }
  };

  const canToggle = fits && !trackingOpen && (paneShown || listedSignals.length > 0);
  const toggleTitle = !fits
    ? "Widen the window to show the pane"
    : paneShown
      ? "Hide the signal  Esc"
      : "Show the signal";

  // While a move is sent, its rows hold their highlight; before, a bulk
  // button with hover or focus shows what it would do.
  const shownPlan =
    moves.acting ??
    (preview !== null && checkedSignals.length > 0
      ? planSignalMove(checkedSignals, preview)
      : null);
  const highlight: BulkHighlight | null =
    shownPlan === null
      ? null
      : {
          actedIds: new Set(shownPlan.acted.map((signal) => signal.id)),
          keptIds: new Set(shownPlan.keptIds),
        };
  const bulkMoves = listBulkMoves(checkedSignals, view);
  const tabName = tabs.find((tab) => tab.pluginId === pluginId && pluginId !== null)?.label;

  const intakeMoves: IntakeMoves = {
    view,
    pending: moves.acting !== null,
    run: runMove,
    toggleSnoozeMenu,
    snoozeMenuPlace: menu?.place ?? null,
    select: openSignal,
    registerOwnChanges: held.registerOwnChanges,
    forgetOwnChanges: held.forgetOwnChanges,
    registerHandoff: (signalId) => {
      flights.expect(signalId);
      heldTracking.registerHandedOff(signalId);
    },
    forgetHandoff: (signalId) => {
      flights.forget(signalId);
      heldTracking.forgetHandedOff(signalId);
    },
  };
  // Inbox zero takes the place of the empty To do list on the All tab, and
  // shows the cleared count itself, so the foot goes with the rows.
  // Rows of Tracking that wait on the user keep To do from being at zero.
  const waitingTrackingRows = countWaitingTrackingRows(readTrackingRows);
  const inboxZero =
    view === "to-do" &&
    pluginId === null &&
    listedSignals.length === 0 &&
    waitingTrackingRows === 0;

  return (
    <>
      <IntakeBar
        tabs={tabs}
        pluginId={pluginId}
        plugins={plugins}
        paneLabel="Signal pane"
        paneToggle={{
          title: toggleTitle,
          shown: paneShown,
          enabled: canToggle,
          onPress: () => {
            if (paneShown) setDismissed(true);
            else
              openSignal(
                selectedId ?? moveSignalSelection(sections, null, 1) ?? listedSignals[0]!.id,
              );
          },
        }}
        onTabChange={onPluginChange}
      />
      <IntakeMovesContext value={intakeMoves}>
        <IntakeSplit
          split={split}
          listLabel="Signals"
          onKeyDown={handleKeys}
          onListPointerEnter={() => {
            setPointerOverColumn(true);
          }}
          onListPointerLeave={() => {
            setPointerOverColumn(false);
          }}
          list={
            <>
              <div className="asks-head">
                <IntakeViewSwitcher view={view} onViewChange={onViewChange} />
              </div>
              <IntakeList
                view={view}
                scope={listScope}
                sections={sections}
                plugins={plugins}
                selectedId={selectedId}
                checkedIds={checks.ids}
                highlight={highlight}
                menuRowId={menu?.place === "row" ? (menu.signals[0]?.id ?? null) : null}
                timezone={timezone}
                focusSelectedRow={focusSelectedRow}
                empty={
                  inboxZero ? (
                    <InboxZero
                      timezone={timezone}
                      arriving={held.arriving}
                      paneShown={paneShown}
                      onShowDone={(id) => {
                        onPluginChange(id);
                        onViewChange("done");
                      }}
                    />
                  ) : (
                    <EmptyView
                      view={view}
                      tabName={tabName}
                      loading={paged.isPending}
                      trackingWaits={waitingTrackingRows > 0}
                    />
                  )
                }
                foot={
                  <>
                    {view === "to-do" && pluginId === null && !inboxZero && (
                      <IntakeFoot timezone={timezone} />
                    )}
                    <IntakeDock
                      // While opened Tracking covers the list, it shows the toast.
                      toast={trackingOpen ? null : toast.toast}
                      bulk={
                        bulkMoves.length === 0 || checkedSignals.length === 0
                          ? null
                          : {
                              checkedCount: checkedSignals.length,
                              moves: bulkMoves,
                              preview: shownPlan?.preview ?? null,
                              doneTitle: describeBulkDoneTitle(
                                planSignalMove(checkedSignals, "done"),
                              ),
                              snoozeMenuOpen: menu?.place === "bar",
                              onPreview: setPreview,
                              onMove: runBulkMove,
                              onClear: () => {
                                updateChecks(new Set());
                                setMenu(null);
                              },
                            }
                      }
                      onDismissToast={toast.dismiss}
                    />
                  </>
                }
                onSelect={openSignal}
                onRowAction={runRowAction}
                onNearEnd={readNextPage}
                onPointerEnter={() => {
                  setPointerOverList(true);
                }}
                onPointerLeave={() => {
                  setPointerOverList(false);
                }}
                onFocusedSelectedRow={() => {
                  setFocusSelectedRow(false);
                }}
                takeLeavingRow={flights.takeLeavingRow}
              />
              {view === "to-do" && (
                <TrackingTray
                  rows={trackingRows}
                  open={trackingOpen}
                  selectedTaskId={selectedTaskId}
                  signalCount={listedSignals.length}
                  signalSources={[
                    ...new Set(listedSignals.map((signal) => parsePluginId(signal.kind))),
                  ]}
                  dock={
                    <IntakeDock toast={toast.toast} bulk={null} onDismissToast={toast.dismiss} />
                  }
                  flights={flights}
                  onOpen={openTracking}
                  onClose={closeTracking}
                  onOpenRow={openTrackingRow}
                  onMarkDone={markTaskDone}
                />
              )}
            </>
          }
          pane={
            selectedId !== null &&
            paneDrawn && (
              <SignalPane
                key={selectedId}
                signalId={selectedId}
                listed={selectedSignal}
                timezone={timezone}
                shown={paneShown}
                focusSuggestedOnOpen={focusPaneFor === selectedId}
                onFocusedSuggested={() => {
                  setFocusPaneFor(null);
                }}
                ref={paneRef}
              />
            )
          }
        />
      </IntakeMovesContext>
      {menu !== null && (
        <SnoozeMenu
          place={menu.place}
          openedByKey={menu.openedByKey}
          timezone={timezone}
          onChoose={(until) => {
            runMove(planSignalMove(menu.signals, "snooze"), until);
          }}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Renders what a view shows with no rows. `tabName` names the plugin's tab
 * shown, if any. While a paged view's first page is read, it shows nothing.
 * To do with no signal points to Tracking while rows of it wait on the user.
 */
function EmptyView({
  view,
  tabName,
  loading,
  trackingWaits,
}: {
  readonly view: SignalView;
  readonly tabName: string | undefined;
  readonly loading: boolean;
  /** Whether rows of Tracking wait on the user, which To do then points to. */
  readonly trackingWaits: boolean;
}): JSX.Element | null {
  if (view === "to-do") {
    return (
      <p className="asks-empty">
        {trackingWaits ? "No signals. What waits on you is in Tracking." : "Nothing on your list."}
      </p>
    );
  }
  if (loading) return null;
  if (view === "later") {
    return (
      <p className="asks-empty">
        {tabName === undefined ? (
          <>
            Nothing snoozed. Press <kbd>H</kbd> on a signal to snooze it.
          </>
        ) : (
          `Nothing from ${tabName} is snoozed.`
        )}
      </p>
    );
  }
  return (
    <p className="asks-empty">
      {tabName === undefined ? "Nothing cleared yet." : `Nothing from ${tabName} was cleared.`}
    </p>
  );
}
