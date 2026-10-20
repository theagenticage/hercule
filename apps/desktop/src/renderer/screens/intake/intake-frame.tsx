/**
 * The frame every Intake view shares: the bar with its source tabs and the
 * pane's toggle, the view switcher, and the split of a list and a pane.
 */
import type { JSX, KeyboardEvent, ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  fitIntakeListWidth,
  MIN_INTAKE_LIST_WIDTH,
  MIN_INTAKE_PANE_WIDTH,
  type IntakeTab,
  type IntakeView,
  type PluginIdentity,
} from "@hercule/client-core";
import { signalsLaterQuery } from "../../app/queries";
import { useToDoCount } from "../../app/tracking";
import { SidebarIcon } from "../../icons/sidebar";
import { SourceMark } from "./source-mark";
import type { IntakeSplitState } from "./use-intake-split";
import "./intake.css";

declare module "react" {
  interface CSSProperties {
    /** The width the user last gave Intake's list, as `<n>px`, before it is fitted to the split. */
    "--intake-list-width"?: string;
    /** The list's width beside the open pane: `--intake-list-width` fitted to the split by CSS. */
    "--intake-list-fitted"?: string;
  }
}

/** The views in the order the view switcher draws them, with their labels. */
const VIEWS: ReadonlyArray<{ readonly view: IntakeView; readonly label: string }> = [
  { view: "to-do", label: "To do" },
  { view: "later", label: "Later" },
  { view: "done", label: "Done" },
  { view: "everything", label: "Everything" },
];

/**
 * Renders Intake's bar: its name, the source tabs, and the pane's toggle.
 * `pluginId` is the pressed tab, `null` for All. The toggle is one name,
 * with the pressed state telling whether the pane shows. Its tooltip, which
 * screen readers read as the description, says what a press does, or why the
 * pane cannot show.
 */
export function IntakeBar({
  tabs,
  pluginId,
  plugins,
  paneLabel,
  paneToggle,
  onTabChange,
}: {
  readonly tabs: ReadonlyArray<IntakeTab>;
  readonly pluginId: string | null;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  /** The toggle's accessible name, such as "Signal pane". */
  readonly paneLabel: string;
  readonly paneToggle: {
    readonly title: string;
    readonly shown: boolean;
    readonly enabled: boolean;
    readonly onPress: () => void;
  };
  readonly onTabChange: (pluginId: string | null) => void;
}): JSX.Element {
  return (
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
              onTabChange(tab.pluginId);
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
      <button
        type="button"
        className="icon-btn asks-pane-btn"
        aria-label={paneLabel}
        title={paneToggle.title}
        aria-pressed={paneToggle.shown}
        aria-disabled={!paneToggle.enabled || undefined}
        onClick={() => {
          if (paneToggle.enabled) paneToggle.onPress();
        }}
      >
        <SidebarIcon size={16} />
      </button>
    </header>
  );
}

/**
 * Renders the view switcher: To do, Later, Done and Everything, each an equal
 * share of the list's width. To do and Later show their counts; the others
 * show none.
 *
 * It reads its counts where it draws them. To do's is the shell's To do
 * count: the whole list, and the rows of Tracking that wait on the user.
 * Later's is the whole list of every source, which the shell holds for the
 * snooze timer; while it has more pages than the first, the count is not
 * known, and is left out.
 */
export function IntakeViewSwitcher({
  view,
  onViewChange,
}: {
  readonly view: IntakeView;
  readonly onViewChange: (view: IntakeView) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const toDoCount = useToDoCount();
  const allLater = useInfiniteQuery(signalsLaterQuery(client));
  const laterPages = allLater.data?.pages ?? [];
  const laterCount =
    laterPages.at(-1)?.nextCursor === undefined
      ? laterPages.reduce((count, page) => count + page.items.length, 0)
      : null;
  return (
    <div className="seg asks-modes" role="group" aria-label="View">
      {VIEWS.map((each) => {
        const count = each.view === "to-do" ? toDoCount : each.view === "later" ? laterCount : null;
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
  );
}

/**
 * Renders the split of the list and the pane, with the handle between them
 * while the pane shows. `split` is the state `useIntakeSplit` returned.
 * `list` fills the list's column, and `pane` is drawn after the handle: the
 * caller passes it only while `split.paneDrawn`.
 *
 * `onKeyDown` is the screen's keys, handled here where every key press in
 * the list and the pane arrives, rather than on each row and answer.
 * `onListPointerEnter` and `onListPointerLeave`, when given, are called as the
 * pointer enters and leaves the list's column whole, its view switcher and
 * the Tracking under it included. A
 * closing pane stays drawn until the list's width transition ends, so it
 * slides out as the list widens over it. The split clips it, and `inert`
 * keeps the focus and screen readers out of it.
 */
export function IntakeSplit({
  split,
  listLabel,
  list,
  pane,
  onKeyDown,
  onListPointerEnter,
  onListPointerLeave,
}: {
  readonly split: IntakeSplitState;
  /** The list's accessible name, such as "Signals". */
  readonly listLabel: string;
  readonly list: ReactNode;
  readonly pane: ReactNode;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onListPointerEnter?: () => void;
  readonly onListPointerLeave?: () => void;
}): JSX.Element {
  const { available, width, splitRef, listRef } = split;
  return (
    <div
      ref={splitRef}
      className={split.listNarrowed ? "asks has-pane" : "asks"}
      style={{
        "--intake-list-width": `${String(width)}px`,
        // The same fit as `fitIntakeListWidth`, done by CSS against the
        // split's width, which only layout knows.
        "--intake-list-fitted": `max(${String(MIN_INTAKE_LIST_WIDTH)}px, min(var(--intake-list-width), 100% - ${String(MIN_INTAKE_PANE_WIDTH)}px))`,
      }}
      onKeyDown={onKeyDown}
    >
      <section
        ref={listRef}
        className="asks-list"
        aria-label={listLabel}
        tabIndex={-1}
        onPointerEnter={onListPointerEnter}
        onPointerLeave={onListPointerLeave}
        onTransitionEnd={(event) => {
          // A row's own transitions end here too, so only the list's width counts.
          if (event.target === event.currentTarget && event.propertyName === "width") {
            split.endClosing();
          }
        }}
      >
        {list}
      </section>
      {split.paneShown && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the list"
          aria-valuenow={available === null ? width : fitIntakeListWidth(width, available)}
          aria-valuemin={MIN_INTAKE_LIST_WIDTH}
          aria-valuemax={available === null ? undefined : available - MIN_INTAKE_PANE_WIDTH}
          tabIndex={0}
          className="asks-handle"
          onPointerDown={split.startDrag}
          onKeyDown={split.resizeWithKeys}
        />
      )}
      {pane}
    </div>
  );
}
