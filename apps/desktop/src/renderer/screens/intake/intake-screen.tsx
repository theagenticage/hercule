/**
 * Intake: the signals on To do in a list, and the selected one in a pane
 * beside it (spec 17 §Intake).
 */
import {
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildIntakeTabs,
  fitIntakeListWidth,
  fitsIntakePane,
  groupSignalsIntoSections,
  MIN_INTAKE_LIST_WIDTH,
  MIN_INTAKE_PANE_WIDTH,
  moveSignalSelection,
  resolveBrowserTimezone,
} from "@hercule/client-core";
import { pluginsQuery, signalsToDoQuery } from "../../app/queries";
import { SidebarIcon } from "../../icons/sidebar";
import { IntakeList } from "./intake-list";
import { SignalPane, type SignalPaneHandle } from "./signal-pane";
import { SourceMark } from "./source-mark";
import { useIntakeListWidth } from "./use-intake-list-width";
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

/** Checks whether a key press lands in a text field, where Intake's keys never act. */
const isTextField = (target: EventTarget): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);

/**
 * Renders Intake: the bar with its source tabs and the pane's toggle, then
 * the split of the list and the pane.
 *
 * `selectedId` is the selected signal, from the URL, and `onSelect` changes
 * it, or clears it with `null`. The pane shows the selected signal unless
 * the user closed it with Esc, which keeps the row selected, or the split is
 * too narrow for it.
 *
 * The keys of spec 17 §Keys act while the focus is in the list or the pane
 * and never in a text field: `J`/`K` and `↓`/`↑` move the selection, `↩`
 * on a row opens the pane on the suggested answer, `R` opens the Reply box,
 * `O` opens the signal on its source, and Esc steps back.
 */
export function IntakeScreen({
  selectedId,
  onSelect,
}: {
  readonly selectedId: string | null;
  readonly onSelect: (signalId: string | null) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { data: signals } = useSuspenseQuery(signalsToDoQuery(client));
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const [timezone] = useState(() => resolveBrowserTimezone());
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

  const [seenSourceIds, setSeenSourceIds] = useState<ReadonlySet<string>>(() => new Set());
  const built = buildIntakeTabs(signals, plugins, seenSourceIds);
  if (built.seenSourceIds !== seenSourceIds) setSeenSourceIds(built.seenSourceIds);
  const { tabs } = built;
  const sections = groupSignalsIntoSections(signals, pluginId);
  const fits = available === null || fitsIntakePane(available);
  const paneShown = selectedId !== null && !dismissed && fits;
  const listed = signals.find((signal) => signal.id === selectedId);

  /** Selects `signalId` and shows the pane, as a click on its row does. */
  const openSignal = (signalId: string): void => {
    setDismissed(false);
    if (signalId !== selectedIdRef.current) onSelect(signalId);
  };

  /** Puts the focus on the selected row, when the list draws it. */
  const focusSelected = (): void => {
    if (selectedId === null) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-signal-id="${CSS.escape(selectedId)}"]`)
      ?.focus();
  };

  const moveSelection = (step: 1 | -1): void => {
    const next = moveSignalSelection(sections, selectedId, step);
    if (next === null || next === selectedId) return;
    // The pane draws the new signal from scratch, which drops the focus
    // inside it, so the focus goes to the list and stays on the keys' side.
    if (!(listRef.current?.contains(document.activeElement) ?? false)) setFocusSelectedRow(true);
    onSelect(next);
  };

  const stepBack = (): void => {
    if (paneShown) {
      const focusInPane = !(listRef.current?.contains(document.activeElement) ?? true);
      setDismissed(true);
      if (focusInPane) focusSelected();
      return;
    }
    if (selectedId !== null) {
      setDismissed(false);
      onSelect(null);
    }
  };

  const handleKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isTextField(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    switch (event.key) {
      case "j":
      case "ArrowDown":
        event.preventDefault();
        moveSelection(1);
        return;
      case "k":
      case "ArrowUp":
        event.preventDefault();
        moveSelection(-1);
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

  const canToggle = fits && (paneShown || signals.length > 0);
  const toggleTitle = !fits
    ? "Widen the window to show the pane"
    : paneShown
      ? "Hide the signal  Esc"
      : "Show the signal";

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
            else openSignal(selectedId ?? moveSignalSelection(sections, null, 1) ?? signals[0]!.id);
          }}
        >
          <SidebarIcon size={16} />
        </button>
      </header>
      {/* The keys are handled here, where every key press in the list and
          the pane arrives, rather than on each row and answer.

          While a signal is selected the pane stays drawn, even closed, so
          it slides out as the list widens over it. The split clips it, and
          `inert` keeps the focus and screen readers out of it. */}
      <div
        ref={splitRef}
        className={paneShown ? "asks has-pane" : "asks"}
        style={{
          "--intake-list-width": `${String(width)}px`,
          // The same fit as `fitIntakeListWidth`, done by CSS against the
          // split's width, which only layout knows.
          "--intake-list-fitted": `max(${String(MIN_INTAKE_LIST_WIDTH)}px, min(var(--intake-list-width), 100% - ${String(MIN_INTAKE_PANE_WIDTH)}px))`,
        }}
        onKeyDown={handleKeys}
      >
        <section ref={listRef} className="asks-list" aria-label="Signals">
          <IntakeList
            sections={sections}
            plugins={plugins}
            selectedId={selectedId}
            focusSelectedRow={focusSelectedRow}
            onSelect={openSignal}
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
        {selectedId !== null && (
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
    </>
  );
}
