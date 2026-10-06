/**
 * The thread's side pane, to the right of the open page: a container of
 * surfaces shown as tabs, of which Subagents is the only one (spec 14
 * §Subagents on the thread surface, spec 17 §The thread). The thread's
 * layout route loads this module lazily, the first time a pane opens, so
 * its code stays out of the first screen's chunk.
 */
import { useId, useRef, type JSX, type KeyboardEvent, type PointerEvent } from "react";
import {
  MIN_MAIN_PANE_WIDTH,
  MIN_SIDE_PANE_WIDTH,
  SIDE_PANE_SURFACES,
  closeSurface,
  fitSidePaneWidth,
  openSurface,
  type SidePaneSurface,
} from "@hercule/client-core";
import { CloseIcon } from "../../icons/close";
import { CrewIcon } from "../../icons/crew";
import { PlusIcon } from "../../icons/plus";
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

/** How far one arrow key press moves the pane's edge, in pixels. */
const KEYBOARD_STEP = 16;

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
 * the pane, and the shown surface. `subagentId` is the subagent whose page
 * is open in the main pane, whose row the Subagents surface marks.
 *
 * The user resizes the pane by dragging its left edge, or with the arrow
 * keys once that edge has focus. The pane is never narrower than
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
  subagentId,
}: {
  readonly sessionId: string;
  readonly subagentId: string | undefined;
}): JSX.Element {
  const { layout, changeLayout } = useSidePaneLayout(sessionId);
  const [width, storeWidth] = useSidePaneWidth();
  const paneRef = useRef<HTMLElement>(null);
  const panelId = useId();
  // The route renders the pane only while it is open, and every way of
  // opening it shows a surface.
  const shown = layout.shown ?? "subagents";

  /**
   * Measures the pane and the width it shares with the main pane. Read once
   * per drag or key press, never per pointer move, because a read after a
   * style write forces a layout.
   */
  const measurePane = (): { readonly pane: DOMRect; readonly available: number } => {
    const pane = paneRef.current!;
    return {
      pane: pane.getBoundingClientRect(),
      available: pane.parentElement!.getBoundingClientRect().width,
    };
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const handle = event.currentTarget;
    const pane = paneRef.current!;
    handle.setPointerCapture(event.pointerId);
    const { pane: box, available } = measurePane();
    let latest: number | undefined;
    const move = (moved: globalThis.PointerEvent): void => {
      latest = fitSidePaneWidth(Math.round(box.right - moved.clientX), available);
      pane.style.setProperty("--side-pane-width", `${String(latest)}px`);
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
    // The handle is the pane's left edge, so the left arrow widens the pane.
    const step =
      event.key === "ArrowLeft" ? KEYBOARD_STEP : event.key === "ArrowRight" ? -KEYBOARD_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    const { pane, available } = measurePane();
    storeWidth(fitSidePaneWidth(Math.round(pane.width) + step, available));
  };

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
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the side pane"
        aria-valuenow={width}
        aria-valuemin={MIN_SIDE_PANE_WIDTH}
        tabIndex={0}
        className="side-pane-handle"
        onPointerDown={startDrag}
        onKeyDown={resizeWithKeys}
      />
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
                  changeLayout((current) => openSurface(current, surface));
                }}
                onClose={() => {
                  changeLayout((current) => closeSurface(current, surface));
                }}
              />
            ))}
          </div>
          <SurfacePicker
            onPick={(surface) => {
              changeLayout((current) => openSurface(current, surface));
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
        <SubagentsSurface sessionId={sessionId} subagentId={subagentId} />
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
