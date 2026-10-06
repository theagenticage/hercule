import {
  useId,
  useLayoutEffect,
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { HerculeClient } from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";
import { Popover, PopoverContent, PopoverTrigger, cn } from "@hercule/ui";
import { SubagentsSurface } from "./subagents-surface";
import {
  MIN_SIDE_PANE_WIDTH,
  SIDE_PANE_SURFACES,
  closeSurface,
  fitSidePaneWidth,
  openSurface,
  useSidePaneLayout,
  useSidePaneWidth,
  type SidePaneSurface,
} from "./use-side-pane";

/** How far one arrow key press moves the pane's edge, in pixels. */
const KEYBOARD_STEP = 16;

/** Returns the name a surface's tab shows, such as "Subagents". */
const nameSurface = (surface: SidePaneSurface): string =>
  SIDE_PANE_SURFACES.find((each) => each.kind === surface)?.name ?? surface;

/**
 * The thread's side pane, to the right of the main pane: a container of
 * surfaces shown as tabs, of which Subagents is the only one (spec 14
 * §Subagents on the thread surface). The thread's layout route puts it in
 * the shell's side-pane slot, so it stays as it was while the main pane
 * moves between the thread's page and its subagents' pages.
 *
 * Renders nothing while the pane is closed. The user resizes it by dragging
 * its left edge, or with the arrow keys once that edge has focus.
 */
export function SidePane({
  client,
  session,
  subagents,
  subagentId,
}: {
  readonly client: HerculeClient;
  readonly session: Session;
  /** Every subagent of the session, oldest first. */
  readonly subagents: readonly Subagent[];
  /** The subagent whose page is open in the main pane; undefined on the thread's own page. */
  readonly subagentId: string | undefined;
}): JSX.Element | null {
  const { layout, changeLayout } = useSidePaneLayout();
  const [storedWidth, storeWidth] = useSidePaneWidth();
  // The width while the user drags, stored only when the drag ends, so a
  // drag does not write to storage on every pointer move.
  const [dragWidth, setDragWidth] = useState<number | undefined>(undefined);
  const [pane, setPane] = useState<HTMLElement | null>(null);
  const available = useAvailableWidth(pane);
  const panelId = useId();
  if (!layout.open || layout.shown === undefined) return null;

  const width = fitSidePaneWidth(dragWidth ?? storedWidth, available);
  const widest = fitSidePaneWidth(Number.POSITIVE_INFINITY, available);
  const shown = layout.shown;

  const startDrag = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;
    const handle = event.currentTarget;
    let latest = startWidth;
    const move = (moved: globalThis.PointerEvent): void => {
      latest = fitSidePaneWidth(startWidth + startX - moved.clientX, available);
      setDragWidth(latest);
    };
    const end = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      storeWidth(latest);
      setDragWidth(undefined);
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
    storeWidth(fitSidePaneWidth(width + step, available));
  };

  return (
    <aside
      ref={setPane}
      aria-label="Side pane"
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-line-soft bg-surface"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the side pane"
        aria-valuenow={width}
        aria-valuemin={MIN_SIDE_PANE_WIDTH}
        aria-valuemax={widest}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={resizeWithKeys}
        className="absolute inset-y-0 -left-[3px] z-20 w-[6px] cursor-col-resize outline-none hover:bg-line-soft focus-visible:bg-live/40"
      />
      {/* The same insets and height as the thread's header row, so the tabs
          sit on the title's line across the split. */}
      <div className="shrink-0 px-4 pt-[22px] pb-3">
        <div className="flex h-[1lh] items-center gap-1.5 text-title">
          <div role="tablist" aria-label="Surfaces" className="flex min-w-0 items-center gap-1.5">
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
          <span className="ml-auto flex">
            <CloseButton
              label="Close the side pane"
              onClose={() => {
                changeLayout((current) => ({ ...current, open: false }));
              }}
            />
          </span>
        </div>
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-label={nameSurface(shown)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <SubagentsSurface
          client={client}
          session={session}
          subagents={subagents}
          subagentId={subagentId}
        />
      </div>
    </aside>
  );
}

/**
 * Returns the width the main pane and the side pane share, measured from the
 * shell's layout around `pane`, and measures it again whenever the window or
 * the main pane changes size. Returns undefined until `pane` is on the page
 * and laid out.
 *
 * The pane sits in the shell's side-pane slot, and the main pane is the
 * slot's previous sibling, so the shared width runs from the main pane's left
 * edge to the slot's right edge.
 */
function useAvailableWidth(pane: HTMLElement | null): number | undefined {
  const [available, setAvailable] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const slot = pane?.parentElement;
    const main = slot?.previousElementSibling;
    if (slot == null || main == null) return;
    const measure = (): void => {
      const shared = slot.getBoundingClientRect().right - main.getBoundingClientRect().left;
      // A browser that lays nothing out, such as jsdom, measures 0.
      if (shared > 0) setAvailable(shared);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    observer.observe(slot);
    return () => {
      observer.disconnect();
    };
  }, [pane]);
  return available;
}

/** Renders one surface's tab: its name, which shows the surface, and its close button. */
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
    <span
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-[8px] py-[3px] pr-1 pl-2.5 text-body tracking-normal",
        selected
          ? "border border-line bg-raised font-emph text-ink shadow-card"
          : "font-normal text-muted hover:text-ink",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls={panelId}
        onClick={onSelect}
        className="min-w-0 cursor-pointer truncate rounded-control focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
      >
        {name}
      </button>
      <CloseButton label={`Close ${name}`} onClose={onClose} />
    </span>
  );
}

/**
 * Renders the "+" button and the menu it opens, which lists the surfaces the
 * pane can show. While the menu is open, a surface's key opens it too.
 */
function SurfacePicker({
  onPick,
}: {
  readonly onPick: (surface: SidePaneSurface) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const pick = (surface: SidePaneSurface): void => {
    setOpen(false);
    onPick(surface);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Open a surface"
        title="Open a surface"
        className={cn(
          "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-control text-body hover:bg-line-soft hover:text-ink",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
          open ? "bg-line-soft text-ink" : "text-muted",
        )}
      >
        +
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-52 flex-col p-1"
        onKeyDown={(event) => {
          const chosen = SIDE_PANE_SURFACES.find((each) => each.key === event.key.toUpperCase());
          if (chosen === undefined) return;
          event.preventDefault();
          pick(chosen.kind);
        }}
      >
        <div role="menu" aria-label="Open a surface" className="flex flex-col">
          <span className="px-2 pt-1.5 pb-1 text-label font-emph tracking-[0.1em] text-faint uppercase">
            Open a surface
          </span>
          {SIDE_PANE_SURFACES.map((each) => (
            <button
              key={each.kind}
              type="button"
              role="menuitem"
              onClick={() => {
                pick(each.kind);
              }}
              className="flex cursor-pointer items-center rounded-control px-2 py-1 text-left text-ink outline-none hover:bg-line-soft focus-visible:bg-line-soft"
            >
              <span className="flex-1">{each.name}</span>
              <kbd className="font-mono text-fine text-faint">{each.key}</kbd>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Renders a small cross button, which closes a tab or the whole pane. */
function CloseButton({
  label,
  onClose,
}: {
  readonly label: string;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClose}
      className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-control text-faint hover:bg-line-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
    >
      <svg
        viewBox="0 0 12 12"
        className="size-2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M3 3l6 6M9 3l-6 6" />
      </svg>
    </button>
  );
}
