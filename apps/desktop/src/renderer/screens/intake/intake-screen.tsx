/**
 * Intake: the signals of one view in a list, and the selected one in a pane
 * beside it (spec 17 §Intake).
 */
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Signal, SignalView } from "@hercule/contract";
import {
  buildIntakeTabs,
  decideSignalRowControls,
  fitIntakeListWidth,
  fitsIntakePane,
  groupSignalsIntoSections,
  listBulkMoves,
  MIN_INTAKE_LIST_WIDTH,
  MIN_INTAKE_PANE_WIDTH,
  moveSignalSelection,
  planBulkAction,
  resolveDisplayTimezone,
  toggleSignalCheck,
  type BulkPlan,
  type IntakeSection,
  type SignalMove,
} from "@hercule/client-core";
import {
  pluginsQuery,
  settingsQuery,
  signalsDoneQuery,
  signalsLaterQuery,
  signalsToDoQuery,
} from "../../app/queries";
import { SidebarIcon } from "../../icons/sidebar";
import { IntakeDock } from "./intake-dock";
import { IntakeFoot } from "./intake-foot";
import { IntakeList, type BulkHighlight, type SignalRowAction } from "./intake-list";
import { pickSelectionAfterMove } from "./pick-selection-after-move";
import { SignalPane, type SignalPaneHandle } from "./signal-pane";
import { SnoozeMenu } from "./snooze-menu";
import { SourceMark } from "./source-mark";
import { useIntakeListWidth } from "./use-intake-list-width";
import {
  IntakeMovesContext,
  useSignalMoves,
  type IntakeMoves,
  type SnoozeMenuPlace,
} from "./use-signal-moves";
import "./intake.css";

declare module "react" {
  interface CSSProperties {
    /** The width the user last gave Intake's list, as `<n>px`, before it is fitted to the split. */
    "--intake-list-width"?: string;
    /** The list's width beside the open pane: `--intake-list-width` fitted to the split by CSS. */
    "--intake-list-fitted"?: string;
  }
}

/** How far one arrow key press moves the split's handle, in pixels. */
const KEYBOARD_STEP = 16;

/** The views in the order the view switcher draws them, with their labels. */
const VIEWS: ReadonlyArray<{ readonly view: SignalView; readonly label: string }> = [
  { view: "to-do", label: "To do" },
  { view: "later", label: "Later" },
  { view: "done", label: "Done" },
];

/** The snooze menu while it is open: where, for which signals, and the moment it opened. */
interface OpenSnoozeMenu {
  readonly place: SnoozeMenuPlace;
  readonly signals: ReadonlyArray<Signal>;
  readonly now: Date;
}

/** The checked rows, and the view and tab they were checked in. */
interface Checks {
  /** The view and the tab, as `<view>:<plugin id or "all">`. */
  readonly scope: string;
  readonly ids: ReadonlySet<string>;
}

/** Checks whether a key press lands in a text field, where Intake's keys never act. */
const isTextField = (target: EventTarget): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);

/** Checks whether `signal` can be checked in `view`. */
const isCheckable = (signal: Signal | undefined, view: SignalView): signal is Signal =>
  signal !== undefined && decideSignalRowControls(signal, view).checkable;

/** Checks whether `move` is one of the moves of `signal`'s row in `view`. */
const hasRowMove = (signal: Signal | undefined, view: SignalView, move: SignalMove): boolean =>
  signal !== undefined && decideSignalRowControls(signal, view).moves.includes(move);

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
 */
export function IntakeScreen({
  view,
  selectedId,
  onSelect,
  onViewChange,
}: {
  readonly view: SignalView;
  readonly selectedId: string | null;
  readonly onSelect: (signalId: string | null) => void;
  readonly onViewChange: (view: SignalView) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { data: toDo } = useSuspenseQuery(signalsToDoQuery(client));
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const timezone = resolveDisplayTimezone(settings.user.timezone);
  const moves = useSignalMoves(client, timezone);
  const [pluginId, setPluginId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [focusPaneFor, setFocusPaneFor] = useState<string | null>(null);
  const [focusSelectedRow, setFocusSelectedRow] = useState(false);
  const [width, storeWidth] = useIntakeListWidth();
  const splitRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const paneRef = useRef<SignalPaneHandle>(null);
  // Read by `openSignal` when it runs, so `openSignal` keeps one identity
  // while `J` and `K` change the selection, and the list's rows, which are
  // memoized, do not draw again.
  const selectedIdRef = useRef(selectedId);
  useLayoutEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  // `null` until the split is measured, which counts as fitting, so the pane
  // never flashes closed on the first frame.
  const [available, setAvailable] = useState<number | null>(null);

  useLayoutEffect(() => {
    const split = splitRef.current!;
    const measure = (): void => {
      setAvailable(split.offsetWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(split);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Later and Done are read page by page, for the tab shown. On To do this
  // read is off, and its data unused.
  const paged = useInfiniteQuery({
    ...(view === "done" ? signalsDoneQuery : signalsLaterQuery)(client, pluginId ?? undefined),
    enabled: view !== "to-do",
  });
  // Later's count in the switcher is the whole list of every source, which
  // the shell holds for the snooze timer. While it has more pages than the
  // first, the count is not known, and is left out.
  const allLater = useInfiniteQuery(signalsLaterQuery(client));
  const laterPages = allLater.data?.pages ?? [];
  const laterCount =
    laterPages.at(-1)?.nextCursor === undefined
      ? laterPages.reduce((count, page) => count + page.items.length, 0)
      : null;

  const [seenSourceIds, setSeenSourceIds] = useState<ReadonlySet<string>>(() => new Set());
  const built = buildIntakeTabs(toDo, plugins, seenSourceIds);
  if (built.seenSourceIds !== seenSourceIds) setSeenSourceIds(built.seenSourceIds);
  const { tabs } = built;
  const pagedSignals =
    view === "to-do" ? [] : (paged.data?.pages.flatMap((page) => page.items) ?? []);
  const sections: ReadonlyArray<IntakeSection> =
    view === "to-do"
      ? groupSignalsIntoSections(toDo, pluginId)
      : pagedSignals.length === 0
        ? []
        : [{ key: "signals", label: "Signals", signals: pagedSignals }];
  const listedSignals = sections.flatMap((section) => section.signals);
  const fits = available === null || fitsIntakePane(available);
  const paneShown = selectedId !== null && !dismissed && fits;
  const listed = (view === "to-do" ? toDo : pagedSignals).find(
    (signal) => signal.id === selectedId,
  );

  // Checks belong to one view and one tab: switching either clears them, as
  // it closes the snooze menu and drops the bulk bar's preview.
  const scope = `${view}:${pluginId ?? "all"}`;
  const [checks, setChecks] = useState<Checks>({ scope, ids: new Set() });
  const [preview, setPreview] = useState<SignalMove | null>(null);
  const [menu, setMenu] = useState<OpenSnoozeMenu | null>(null);
  if (checks.scope !== scope) {
    setChecks({ scope, ids: new Set() });
    setPreview(null);
    setMenu(null);
  }
  const checkedSignals = listedSignals.filter((signal) => checks.ids.has(signal.id));
  const selectedSignal = listedSignals.find((signal) => signal.id === selectedId);

  /** Replaces the checked rows with `ids`. With none left, the bar's preview goes with the bar. */
  const updateChecks = (ids: ReadonlySet<string>): void => {
    setChecks({ scope, ids });
    if (ids.size === 0) setPreview(null);
  };

  // The signal whose pane is sliding out: the pane stays drawn until the
  // list has widened over it. Only that signal is drawn while the pane is
  // closed, so moving the selection with the pane closed reads nothing and
  // loads no image. Under Reduce motion no transition ends, so the id stays
  // until the selection moves, which draws that same signal and nothing new.
  const [closingId, setClosingId] = useState<string | null>(null);
  const [paneShownBefore, setPaneShownBefore] = useState(paneShown);
  if (paneShown !== paneShownBefore) {
    setPaneShownBefore(paneShown);
    setClosingId(paneShown ? null : selectedId);
  }
  const paneDrawn = selectedId !== null && (paneShown || closingId === selectedId);

  // Whether the list is narrowed for the pane. Changing it starts the
  // split's transition, and it follows `paneShown` one frame late: the click
  // or key is drawn in one frame, and the list starts to move in the next.
  // The click's work then never shares a frame with the motion's start:
  // - Opening renders the pane, which takes up to 12 ms.
  // - After the screen has been still, the frame that draws a click starts
  //   4 to 5 ms late, so even a small render can miss that frame's deadline
  //   and delay the transition's first frame by a whole frame.
  const [listNarrowed, setListNarrowed] = useState(paneShown);
  // Under Reduce motion nothing moves, so the split changes in this frame.
  if (listNarrowed !== paneShown && matchMedia("(prefers-reduced-motion: reduce)").matches) {
    setListNarrowed(paneShown);
  }
  useLayoutEffect(() => {
    if (listNarrowed === paneShown) return;
    // The first callback runs before the frame that draws the click, the
    // second one in the frame after it.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        setListNarrowed(paneShown);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [paneShown, listNarrowed]);

  /** Selects `signalId` and shows the pane, as a click on its row does. */
  const openSignal = (signalId: string): void => {
    setDismissed(false);
    if (signalId !== selectedIdRef.current) onSelect(signalId);
  };

  /**
   * Puts the focus on the selected row. When the list does not draw it,
   * because the signal was resolved and left the view, the focus goes to
   * the list itself, so the screen's keys keep working.
   */
  const focusSelected = (): void => {
    if (selectedId === null) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-signal-id="${CSS.escape(selectedId)}"]`,
    );
    (row ?? listRef.current)?.focus();
  };

  // When the pane closes, by Esc, by the toggle or because the window grew
  // too narrow for it, the closing pane turns inert, and the focus inside it
  // would fall to the page's body, outside the screen's keys. The focus goes
  // to the list instead. Focus outside the split, such as on the toggle that
  // closed the pane, stays where it is.
  useLayoutEffect(() => {
    if (paneShown) return;
    const focused = document.activeElement;
    const inPane =
      (splitRef.current?.contains(focused) ?? false) &&
      !(listRef.current?.contains(focused) ?? false);
    if (inPane || focused === null || focused === document.body) focusSelected();
    // Runs only when the pane closes; `focusSelected` is a new function on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneShown]);

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
   * selection to the next row that stayed. Not urgent keeps its rows on To
   * do, so it changes neither.
   */
  const runMove = (plan: BulkPlan, until?: string): void => {
    setPreview(null);
    const listedIds = listedSignals.map((signal) => signal.id);
    moves.run(plan, until, () => {
      if (plan.move === "not-urgent") return;
      const moved = new Set(plan.signalIds);
      setChecks((current) => ({
        ...current,
        ids: new Set([...current.ids].filter((id) => !moved.has(id))),
      }));
      const current = selectedIdRef.current;
      const next = pickSelectionAfterMove(listedIds, current, plan.signalIds);
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

  /** Opens the snooze menu for `signals` at `place`, or closes it when it is open there. */
  const toggleSnoozeMenu = (place: SnoozeMenuPlace, signals: ReadonlyArray<Signal>): void => {
    setMenu((open) =>
      open?.place === place && open.signals[0]?.id === signals[0]?.id
        ? null
        : { place, signals, now: new Date() },
    );
  };

  /** Runs one of the bulk bar's moves on the checked rows. Snooze opens its menu first. */
  const runBulkMove = (move: SignalMove): void => {
    if (move === "snooze") toggleSnoozeMenu("bar", checkedSignals);
    else runMove(planBulkAction(checkedSignals, move));
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
        runMove(planBulkAction([signal], action));
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

  const handleKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isTextField(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const extending = event.shiftKey;
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
      case "e":
        event.preventDefault();
        if (checkedSignals.length > 0) {
          if (listBulkMoves(checkedSignals, view).includes("done")) runBulkMove("done");
        } else if (hasRowMove(selectedSignal, view, "done")) {
          runMove(planBulkAction([selectedSignal!], "done"));
        }
        return;
      case "h":
        event.preventDefault();
        // On Later the checked rows have Unsnooze in place of Snooze, so H does nothing there.
        if (checkedSignals.length > 0) {
          if (listBulkMoves(checkedSignals, view).includes("snooze")) runBulkMove("snooze");
        } else if (selectedSignal !== undefined && view !== "done") {
          toggleSnoozeMenu(paneShown ? "pane" : "row", [selectedSignal]);
        }
        return;
      case "u":
        event.preventDefault();
        if (checkedSignals.length > 0) {
          if (listBulkMoves(checkedSignals, view).includes("unsnooze")) runBulkMove("unsnooze");
        } else if (hasRowMove(selectedSignal, view, "unsnooze")) {
          runMove(planBulkAction([selectedSignal!], "unsnooze"));
        }
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

  /** Measures the list's left edge and the split's width, once per drag or key press. */
  const measureSplit = (): {
    readonly left: number;
    readonly listWidth: number;
    readonly available: number;
  } => {
    const list = listRef.current!.getBoundingClientRect();
    return { left: list.left, listWidth: list.width, available: splitRef.current!.offsetWidth };
  };

  /**
   * Gives the list `listWidth` at once, with no React render and no
   * transition: only opening and closing the pane animate the list's width.
   * The new width is laid out before the transition is allowed again, so the
   * change never starts one.
   */
  const resizeList = (listWidth: number): void => {
    const split = splitRef.current!;
    split.dataset.resizing = "";
    split.style.setProperty("--intake-list-width", `${String(listWidth)}px`);
    void listRef.current!.offsetWidth;
    delete split.dataset.resizing;
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const split = measureSplit();
    let latest: number | undefined;
    // Each move resizes the list straight in the page; only the end of the
    // drag stores the width, which renders once.
    const move = (moved: globalThis.PointerEvent): void => {
      latest = fitIntakeListWidth(Math.round(moved.clientX - split.left), split.available);
      resizeList(latest);
      handle.setAttribute("aria-valuenow", String(latest));
    };
    const end = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      if (latest !== undefined) storeWidth(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const resizeWithKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    // The handle is the list's right edge, so the right arrow widens the list.
    const step =
      event.key === "ArrowRight" ? KEYBOARD_STEP : event.key === "ArrowLeft" ? -KEYBOARD_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    // The split's key handler must not also move the selection.
    event.stopPropagation();
    const split = measureSplit();
    const next = fitIntakeListWidth(Math.round(split.listWidth) + step, split.available);
    resizeList(next);
    storeWidth(next);
  };

  const canToggle = fits && (paneShown || listedSignals.length > 0);
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
      ? planBulkAction(checkedSignals, preview)
      : null);
  const highlight: BulkHighlight | null =
    shownPlan === null
      ? null
      : { actedIds: new Set(shownPlan.signalIds), keptIds: new Set(shownPlan.keptIds) };
  const bulkMoves = listBulkMoves(checkedSignals, view);
  const tabName = tabs.find((tab) => tab.pluginId === pluginId && pluginId !== null)?.label;

  const intakeMoves: IntakeMoves = {
    view,
    pending: moves.acting !== null,
    run: runMove,
    toggleSnoozeMenu,
    snoozeMenuPlace: menu?.place ?? null,
    select: openSignal,
  };

  return (
    <>
      <header className="bar">
        <h1 className="title">Intake</h1>
        <nav className="tabs" aria-label="Sources">
          {tabs.map((tab) => (
            <button
              key={tab.pluginId ?? "all"}
              type="button"
              className={tab.pluginId === pluginId ? "tab is-on" : "tab"}
              aria-pressed={tab.pluginId === pluginId}
              onClick={() => {
                setPluginId(tab.pluginId);
              }}
            >
              {tab.pluginId !== null && (
                <SourceMark pluginId={tab.pluginId} plugins={plugins} size={14} />
              )}
              {tab.label}
              {tab.count > 0 && <small>{tab.count}</small>}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        {/* One name, with the pressed state telling whether the pane shows.
            The tooltip, which screen readers read as the description, says
            what a press does, or why the pane cannot show. */}
        <button
          type="button"
          className="icon-btn asks-pane-btn"
          aria-label="Signal pane"
          title={toggleTitle}
          aria-pressed={paneShown}
          aria-disabled={!canToggle || undefined}
          onClick={() => {
            if (!canToggle) return;
            if (paneShown) setDismissed(true);
            else
              openSignal(
                selectedId ?? moveSignalSelection(sections, null, 1) ?? listedSignals[0]!.id,
              );
          }}
        >
          <SidebarIcon size={16} />
        </button>
      </header>
      {/* The keys are handled here, where every key press in the list and
          the pane arrives, rather than on each row and answer.

          A closing pane stays drawn until the list's width transition ends,
          so it slides out as the list widens over it. The split clips it,
          and `inert` keeps the focus and screen readers out of it. */}
      <IntakeMovesContext value={intakeMoves}>
        <div
          ref={splitRef}
          className={listNarrowed ? "asks has-pane" : "asks"}
          style={{
            "--intake-list-width": `${String(width)}px`,
            // The same fit as `fitIntakeListWidth`, done by CSS against the
            // split's width, which only layout knows.
            "--intake-list-fitted": `max(${String(MIN_INTAKE_LIST_WIDTH)}px, min(var(--intake-list-width), 100% - ${String(MIN_INTAKE_PANE_WIDTH)}px))`,
          }}
          onKeyDown={handleKeys}
        >
          <section
            ref={listRef}
            className="asks-list"
            aria-label="Signals"
            tabIndex={-1}
            onTransitionEnd={(event) => {
              // A row's own transitions end here too, so only the list's width counts.
              if (event.target === event.currentTarget && event.propertyName === "width") {
                setClosingId(null);
              }
            }}
          >
            <div className="asks-head">
              <div className="seg asks-modes" role="group" aria-label="View">
                {VIEWS.map((each) => {
                  const count =
                    each.view === "to-do" ? toDo.length : each.view === "later" ? laterCount : null;
                  return (
                    <button
                      key={each.view}
                      type="button"
                      aria-pressed={each.view === view}
                      onClick={() => {
                        if (each.view !== view) onViewChange(each.view);
                      }}
                    >
                      {each.label}
                      {count !== null && count > 0 && <small>{count}</small>}
                    </button>
                  );
                })}
              </div>
            </div>
            <IntakeList
              view={view}
              sections={sections}
              plugins={plugins}
              selectedId={selectedId}
              checkedIds={checks.ids}
              highlight={highlight}
              menuRowId={menu?.place === "row" ? (menu.signals[0]?.id ?? null) : null}
              timezone={timezone}
              focusSelectedRow={focusSelectedRow}
              empty={<EmptyView view={view} tabName={tabName} loading={paged.isPending} />}
              foot={
                <>
                  {view === "to-do" && pluginId === null && <IntakeFoot timezone={timezone} />}
                  <IntakeDock
                    toast={moves.toast}
                    bulk={
                      bulkMoves.length === 0 || checkedSignals.length === 0
                        ? null
                        : {
                            checkedCount: checkedSignals.length,
                            moves: bulkMoves,
                            preview: shownPlan?.preview ?? null,
                            snoozeMenuOpen: menu?.place === "bar",
                            onPreview: setPreview,
                            onMove: runBulkMove,
                            onClear: () => {
                              updateChecks(new Set());
                              setMenu(null);
                            },
                          }
                    }
                    onDismissToast={moves.dismissToast}
                  />
                </>
              }
              onSelect={openSignal}
              onRowAction={runRowAction}
              onNearEnd={readNextPage}
              onFocusedSelectedRow={() => {
                setFocusSelectedRow(false);
              }}
            />
          </section>
          {paneShown && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the list"
              aria-valuenow={available === null ? width : fitIntakeListWidth(width, available)}
              aria-valuemin={MIN_INTAKE_LIST_WIDTH}
              aria-valuemax={available === null ? undefined : available - MIN_INTAKE_PANE_WIDTH}
              tabIndex={0}
              className="asks-handle"
              onPointerDown={startDrag}
              onKeyDown={resizeWithKeys}
            />
          )}
          {paneDrawn && (
            <SignalPane
              key={selectedId}
              signalId={selectedId}
              listed={listed}
              timezone={timezone}
              shown={paneShown}
              focusSuggestedOnOpen={focusPaneFor === selectedId}
              onFocusedSuggested={() => {
                setFocusPaneFor(null);
              }}
              ref={paneRef}
            />
          )}
        </div>
      </IntakeMovesContext>
      {menu !== null && (
        <SnoozeMenu
          place={menu.place}
          now={menu.now}
          timezone={timezone}
          onChoose={(until) => {
            runMove(planBulkAction(menu.signals, "snooze"), until);
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
 */
function EmptyView({
  view,
  tabName,
  loading,
}: {
  readonly view: SignalView;
  readonly tabName: string | undefined;
  readonly loading: boolean;
}): JSX.Element | null {
  if (view === "to-do") return <p className="asks-empty">Nothing on your list.</p>;
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
