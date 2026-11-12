/**
 * The thread's side pane, to the right of the open page: a container of
 * surfaces shown as tabs, of which Subagents is the only one (spec 14
 * §Subagents on the thread surface, spec 17 §The thread). The thread's
 * layout route loads this module lazily, the first time a pane opens, so
 * its code stays out of the first screen's chunk.
 */
import { useId, useRef, type JSX } from "react";
import {
  DEFAULT_SIDE_PANE_WIDTH,
  MIN_MAIN_PANE_WIDTH,
  MIN_SIDE_PANE_WIDTH,
  SIDE_PANE_SURFACES,
  closeSidePaneSurface,
  openSidePaneSurface,
  type SidePaneSurface,
} from "@hercule/client-core";
import { CloseIcon } from "../../icons/close";
import { CrewIcon } from "../../icons/crew";
import { PlusIcon } from "../../icons/plus";
import { useResizablePane } from "../desk/use-resizable-pane";
import { SubagentsSurface } from "./subagents-surface";
import { useSidePaneLayout, useSidePaneWidth } from "./use-side-pane";
import "../thread/menus.css";
import "./side-pane.css";

declare module "react" {
  interface CSSProperties {
    /** The width the user last gave the side pane, as `<n>px`, before it is fitted to the window. */
    "--side-pane-width"?: string;
  }
}

/** The icon each surface's tab and picker line show. */
const SURFACE_ICONS: Readonly<Record<SidePaneSurface, JSX.Element>> = {
  subagents: <CrewIcon size={14} />,
};

/** Returns the name a surface's tab shows, such as "Subagents". */
const nameSurface = (surface: SidePaneSurface): string =>
  // Every surface is listed in `SIDE_PANE_SURFACES`, so the find never misses.
  SIDE_PANE_SURFACES.find((each) => each.kind === surface)!.name;

/**
 * Renders the side pane of the thread `sessionId` while its layout is open:
 * the tabs of its surfaces, a "+" that opens another, a button that closes
 * the pane, and the shown surface. `openSubagentId` is the subagent whose page
 * is open in the main pane, whose row the Subagents surface marks.
 *
 * The user resizes the pane by dragging its left edge, or with the arrow
 * keys, Home, End and a double click once that edge has focus. The pane is never narrower than
 * `MIN_SIDE_PANE_WIDTH` and never leaves the main pane narrower than
 * `MIN_MAIN_PANE_WIDTH`. CSS fits the stored width to the window each time
 * the pane is laid out, so a window made smaller never pushes the main pane
 * under its minimum.
 *
 * While the user drags, each pointer move writes the width straight into
 * the pane's style, with no React render, and only the end of the drag
 * stores it, which renders once (spec 17 §What subagents cost).
 */
export function SidePane({
  sessionId,
  openSubagentId,
}: {
  readonly sessionId: string;
  readonly openSubagentId: string | undefined;
}): JSX.Element {
  const { layout, changeLayout } = useSidePaneLayout(sessionId);
  const [width, storeWidth] = useSidePaneWidth();
  const paneRef = useRef<HTMLElement>(null);
  const panelId = useId();
  // The route renders the pane only while it is open, and every way of
  // opening it shows a surface.
  const shown = layout.shown ?? "subagents";

  const separator = useResizablePane({
    paneRef,
    paneSide: "right",
    width,
    defaultWidth: DEFAULT_SIDE_PANE_WIDTH,
    min: MIN_SIDE_PANE_WIDTH,
    // The widest width depends on the window, which only layout knows.
    measureMax: () =>
      paneRef.current!.parentElement!.getBoundingClientRect().width - MIN_MAIN_PANE_WIDTH,
    draw: (next) => {
      paneRef.current!.style.setProperty("--side-pane-width", `${String(next)}px`);
    },
    onCommit: storeWidth,
  });

  return (
    <aside
      ref={paneRef}
      aria-label="Side pane"
      className="side-pane"
      style={{
        "--side-pane-width": `${String(width)}px`,
        // The same fit as `fitSidePaneWidth`, done by CSS against the width
        // the two panes share, which only layout knows.
        width: `max(${String(MIN_SIDE_PANE_WIDTH)}px, min(var(--side-pane-width), 100% - ${String(MIN_MAIN_PANE_WIDTH)}px))`,
      }}
    >
      <div {...separator} aria-label="Resize the side pane" className="side-pane-handle" />
      <header className="side-pane-head">
        <div className="side-pane-tabs">
          <div role="tablist" aria-label="Surfaces" className="side-pane-tablist">
            {layout.surfaces.map((surface) => (
              <SurfaceTab
                key={surface}
                surface={surface}
                selected={surface === shown}
                panelId={panelId}
                onSelect={() => {
                  changeLayout((current) => openSidePaneSurface(current, surface));
                }}
                onClose={() => {
                  changeLayout((current) => closeSidePaneSurface(current, surface));
                }}
              />
            ))}
          </div>
          <SurfacePicker
            onPick={(surface) => {
              changeLayout((current) => openSidePaneSurface(current, surface));
            }}
          />
        </div>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Close the side pane"
          title="Close the side pane"
          onClick={() => {
            changeLayout((current) => ({ ...current, open: false }));
          }}
        >
          <CloseIcon size={14} />
        </button>
      </header>
      <div id={panelId} role="tabpanel" aria-label={nameSurface(shown)} className="side-pane-panel">
        <SubagentsSurface sessionId={sessionId} openSubagentId={openSubagentId} />
      </div>
    </aside>
  );
}

/** Renders one surface's tab: its icon and name, which show the surface, and its close button. */
function SurfaceTab({
  surface,
  selected,
  panelId,
  onSelect,
  onClose,
}: {
  readonly surface: SidePaneSurface;
  readonly selected: boolean;
  readonly panelId: string;
  readonly onSelect: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const name = nameSurface(surface);
  return (
    <span className={selected ? "side-pane-tab is-on" : "side-pane-tab"}>
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls={panelId}
        title={name}
        onClick={onSelect}
      >
        {SURFACE_ICONS[surface]}
        <span className="side-pane-tab-name">{name}</span>
      </button>
      <button
        type="button"
        className="side-pane-tab-close"
        aria-label={`Close ${name}`}
        title={`Close ${name}`}
        onClick={onClose}
      >
        <CloseIcon size={12} />
      </button>
    </span>
  );
}

/**
 * Renders the "+" button and the menu it opens, which lists the surfaces the
 * pane can show. While the menu is open, a surface's key opens it too.
 *
 * The menu is the browser's own popover, as the composer's menus are: the
 * browser closes it on Esc and on a click outside it, and places it under
 * its trigger by CSS anchor positioning.
 */
function SurfacePicker({
  onPick,
}: {
  readonly onPick: (surface: SidePaneSurface) => void;
}): JSX.Element {
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const pick = (surface: SidePaneSurface): void => {
    menuRef.current?.hidePopover();
    onPick(surface);
  };
  return (
    <span className="side-pane-picker-wrap">
      <button
        type="button"
        className="icon-btn icon-btn--sm side-pane-picker-trigger"
        popoverTarget={menuId}
        aria-label="Open a surface"
        title="Open a surface"
      >
        <PlusIcon size={14} />
      </button>
      <div
        ref={menuRef}
        id={menuId}
        popover="auto"
        role="menu"
        aria-label="Open a surface"
        className="pop side-pane-picker"
        onKeyDown={(event) => {
          const chosen = SIDE_PANE_SURFACES.find((each) => each.key === event.key.toUpperCase());
          if (chosen === undefined) return;
          event.preventDefault();
          pick(chosen.kind);
        }}
      >
        <h4>Open a surface</h4>
        {SIDE_PANE_SURFACES.map((each) => (
          <button
            key={each.kind}
            type="button"
            role="menuitem"
            onClick={() => {
              pick(each.kind);
            }}
          >
            {SURFACE_ICONS[each.kind]}
            <span>{each.name}</span>
            <kbd>{each.key}</kbd>
          </button>
        ))}
      </div>
    </span>
  );
}
