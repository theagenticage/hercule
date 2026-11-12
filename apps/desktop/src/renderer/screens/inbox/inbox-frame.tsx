import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type ReactNode,
  type ToggleEvent,
} from "react";
import { joinClassNames } from "../../app/join-class-names";
import { isMotionReduced } from "../../app/motion/reduced";
import { IconPill, ToolButton } from "../desk/toolbar";
import { ViewPill } from "../desk/view-pill";
import type { ViewChoice } from "../view-switch";
import {
  INBOX_PANE_ID,
  INBOX_PANE_MAX_WIDTH,
  INBOX_PANE_MIN_WIDTH,
  InboxPaneFrame,
} from "./inbox-pane-frame";
import "./inbox-frame.css";

export {
  INBOX_PANE_DEFAULT_WIDTH,
  INBOX_PANE_MAX_WIDTH,
  INBOX_PANE_MIN_WIDTH,
} from "./inbox-pane-frame";

/**
 * The ids of the regions the keyboard moves between with F6, in the order it
 * visits them: the search, the rail (or the scope button that holds it, under
 * `RAIL_FOLDS_BELOW`), the list and the pane.
 */
export const INBOX_REGION_IDS = {
  search: "inbox-search",
  rail: "inbox-rail",
  scopeButton: "inbox-scope-button",
  list: "inbox-list",
  pane: INBOX_PANE_ID,
} as const;

/** The rail's width, in pixels, while it stands beside the list. */
const RAIL_WIDTH = 240;

/** The least width the list keeps, in pixels: the pane gives way before the list gets narrower. */
const LIST_MIN_WIDTH = 400;

/**
 * Widths of the frame below which the layout changes. The drawing states them
 * as window widths with the sidebar's 272px open (1330, 1032 and 900); the
 * frame is the window less the sidebar, so a collapsed sidebar or a zoomed
 * window changes the layout by the room the Inbox really has.
 *
 * - Under `RAIL_FOLDS_BELOW` the rail is a menu in the bar.
 * - Under `PANE_STACKS_BELOW` the list could not keep 400px beside the
 *   narrowest pane (400 + 360), so the pane lies over the list.
 * - Under `PILL_GIVES_WAY_BELOW` the bar makes room by dropping the pill.
 */
const RAIL_FOLDS_BELOW = 1058;
const PANE_STACKS_BELOW = 760;
const PILL_GIVES_WAY_BELOW = 628;

/** How long the pane takes to fade when nothing is current, in milliseconds. */
const PANE_FADE_MS = 140;

/** The two views of the pill: the Inbox itself and Intake, which the Inbox's pill opens. */
type InboxView = "inbox" | "intake";

const VIEW_CHOICES: ReadonlyArray<ViewChoice<InboxView>> = [
  { view: "inbox", label: "Inbox" },
  { view: "intake", label: "Intake" },
];

/**
 * Returns the widest the pane may be for a frame `frameWidth` pixels wide: at
 * most `INBOX_PANE_MAX_WIDTH`, and never so wide that the list keeps less than
 * `LIST_MIN_WIDTH` beside the rail (when the rail is not folded). It is never
 * under `INBOX_PANE_MIN_WIDTH`.
 */
function computeWidestPaneWidth(frameWidth: number, railWidth: number): number {
  return Math.max(
    INBOX_PANE_MIN_WIDTH,
    Math.min(INBOX_PANE_MAX_WIDTH, frameWidth - railWidth - LIST_MIN_WIDTH),
  );
}

/**
 * Renders the Inbox's page: a grid of the rail, the list and the pane, with
 * the bar over all three. The bar holds the `Inbox | Intake` pill over the
 * rail, the `search` over the list, and the offline pill and the keys button
 * over the pane. Every part is a slot the caller fills, and the frame
 * reads nothing.
 *
 * Slots:
 * - `rail` is drawn beside the list. Under 1058px of room it moves into a
 *   popover that the scope button of the bar opens, named `scopeName`, with
 *   the focus on the rail's entry marked `aria-current="true"` (else its tab
 *   stop). The popover closes when `scopeName` changes.
 * - `search`, `listHead` and `list` fill the bar's middle and the list column.
 *   `listHead` and `list` are children of one flex column, so the scrolling
 *   part of `list` can take `flex: 1`.
 * - `paneHead` is the line at the start of the pane's head, and `pane` is its
 *   body. The pane keeps showing what it last showed while it fades out.
 * - `offlinePill` sits before the keys button.
 *
 * The pane:
 * - `isPaneShown` says whether there is anything for it to show. When it turns
 *   false the pane fades over 140ms, then the list takes its room.
 * - `paneWidth` is the width the user asked for, kept by the caller. The frame
 *   shows the nearest width the window allows and `onPaneWidthChange` receives
 *   a width when a resize gesture or the pane's menu ends on one. Under 1032px
 *   the pane lies over the list instead: `isPaneOpen` slides it in, the list
 *   behind is inert, and Esc or the "List" button call `onClosePane`, after
 *   which the caller moves the focus back to the row.
 * - `onOpenAtSource` adds "Open at its source" to the pane's menu.
 *
 * `onOpenIntake` is called by the pill's Intake tab. `onOpenKeys` is called by
 * the keys button, whose state is `isKeysOpen`. The regions have the ids of
 * `INBOX_REGION_IDS`.
 */
export function InboxFrame({
  rail,
  scopeName,
  search,
  listHead,
  list,
  paneHead,
  pane,
  offlinePill,
  isPaneShown,
  isPaneOpen,
  paneWidth,
  onPaneWidthChange,
  onClosePane,
  onOpenAtSource,
  onOpenIntake,
  onOpenKeys,
  isKeysOpen,
}: {
  readonly rail: ReactNode;
  readonly scopeName: string;
  readonly search: ReactNode;
  readonly listHead: ReactNode;
  readonly list: ReactNode;
  readonly paneHead: ReactNode;
  readonly pane: ReactNode;
  readonly offlinePill: ReactNode;
  readonly isPaneShown: boolean;
  readonly isPaneOpen: boolean;
  readonly paneWidth: number;
  readonly onPaneWidthChange: (width: number) => void;
  readonly onClosePane: () => void;
  readonly onOpenAtSource?: (() => void) | undefined;
  readonly onOpenIntake: () => void;
  readonly onOpenKeys: () => void;
  readonly isKeysOpen: boolean;
}): JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const scopeMenuRef = useRef<HTMLElement>(null);
  // Unmeasured, the frame counts as wide, so the first frame of a real window never flashes the folded layout.
  const [frameWidth, setFrameWidth] = useState(Number.POSITIVE_INFINITY);
  const [isScopeMenuOpen, setIsScopeMenuOpen] = useState(false);
  const [isPaneFaded, setIsPaneFaded] = useState(false);
  const [lastPane, setLastPane] = useState<{
    readonly head: ReactNode;
    readonly body: ReactNode;
  }>({ head: paneHead, body: pane });

  // The last content of the pane, so a pane that steps aside fades with what it showed.
  if (isPaneShown && (lastPane.head !== paneHead || lastPane.body !== pane)) {
    setLastPane({ head: paneHead, body: pane });
  }

  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries.at(-1)?.contentRect.width ?? 0;
      if (width > 0) setFrameWidth(Math.round(width));
    });
    observer.observe(frame);
    return () => {
      observer.disconnect();
    };
  }, []);

  const isStacked = frameWidth < PANE_STACKS_BELOW;
  const isRailFolded = frameWidth < RAIL_FOLDS_BELOW;
  const widestPaneWidth = computeWidestPaneWidth(frameWidth, isRailFolded ? 0 : RAIL_WIDTH);
  const shownPaneWidth = Math.round(
    Math.max(INBOX_PANE_MIN_WIDTH, Math.min(widestPaneWidth, paneWidth)),
  );

  // With nothing to show the pane fades, and only then does the list take its room, so nothing in
  // the list reads through the fading pane. With reduced motion, or with the pane lying over the
  // list, there is nothing to wait for.
  const isFading = !isPaneShown && !isStacked && !isMotionReduced();
  useEffect(() => {
    const element = paneRef.current;
    if (!isFading || element === null) return;
    const fade = element.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: PANE_FADE_MS,
      easing: "ease-out",
      fill: "forwards",
    });
    fade.finished.then(
      () => {
        setIsPaneFaded(true);
      },
      () => {
        // A fade cancelled because something became current again has nothing to report.
      },
    );
    return () => {
      fade.cancel();
      setIsPaneFaded(false);
    };
  }, [isFading]);
  const isPaneless = !isPaneShown && (isPaneFaded || !isFading);

  // The scope button's menu closes when the scope changes: a pick in the rail ends it.
  useEffect(() => {
    scopeMenuRef.current?.hidePopover();
  }, [scopeName]);

  const drawPaneWidth = (width: number): void => {
    frameRef.current?.style.setProperty("--pane-w", `${String(width)}px`);
  };

  const focusCurrentRailEntry = (event: ToggleEvent<HTMLElement>): void => {
    const isOpening = event.newState === "open";
    setIsScopeMenuOpen(isOpening);
    if (!isOpening) return;
    const menu = event.currentTarget;
    const target =
      menu.querySelector<HTMLElement>('[aria-current="true"]') ??
      menu.querySelector<HTMLElement>('[tabindex="0"]') ??
      menu.querySelector<HTMLElement>("button, a[href]");
    target?.focus({ preventScroll: true });
  };

  const railLabel = "Saved queries and Browse";
  // The pane's width is the user's while it stands beside the list. Stacked, the stylesheet
  // gives it the whole list.
  const style = isStacked
    ? undefined
    : ({ "--pane-w": `${String(shownPaneWidth)}px` } as CSSProperties);

  return (
    <div
      ref={frameRef}
      className={joinClassNames(
        "ib",
        isRailFolded && "is-rail-folded",
        isStacked && "is-stacked",
        frameWidth < PILL_GIVES_WAY_BELOW && "is-pill-gone",
        isStacked && isPaneOpen && "is-pane-open",
        isPaneless && "is-paneless",
      )}
      style={style}
    >
      <div className="ib-bar">
        <h1 className="ib-title">Inbox</h1>
        <div className="ib-pill">
          <ViewPill
            label="Inbox views"
            choices={VIEW_CHOICES}
            view="inbox"
            onPick={(view) => {
              if (view === "intake") onOpenIntake();
            }}
          />
        </div>
        {isRailFolded && (
          <>
            <ToolButton
              id={INBOX_REGION_IDS.scopeButton}
              name={scopeName}
              hasMenu
              isFilled={false}
              popoverTarget="inbox-scope-menu"
              aria-expanded={isScopeMenuOpen}
            />
            <nav
              ref={scopeMenuRef}
              id="inbox-scope-menu"
              popover="auto"
              className="pop ib-scope-menu"
              aria-label={railLabel}
              onToggle={focusCurrentRailEntry}
            >
              {rail}
            </nav>
          </>
        )}
        <div id={INBOX_REGION_IDS.search} className="ib-search">
          {search}
        </div>
        <div className="ib-end">
          {offlinePill}
          <IconPill
            label="Show the keys"
            title="Keys (?)"
            aria-expanded={isKeysOpen}
            onClick={onOpenKeys}
          >
            ?
          </IconPill>
        </div>
      </div>
      {!isRailFolded && (
        <nav id={INBOX_REGION_IDS.rail} className="ib-rail" aria-label={railLabel}>
          {rail}
        </nav>
      )}
      <section
        id={INBOX_REGION_IDS.list}
        className="ib-list"
        aria-label="The list"
        inert={isStacked && isPaneOpen}
      >
        {listHead}
        {list}
      </section>
      <InboxPaneFrame
        paneRef={paneRef}
        width={shownPaneWidth}
        widestWidth={widestPaneWidth}
        isStacked={isStacked}
        isOpen={isPaneOpen}
        isShown={isPaneShown}
        head={lastPane.head}
        drawWidth={drawPaneWidth}
        onWidthChange={onPaneWidthChange}
        onClose={onClosePane}
        onOpenAtSource={onOpenAtSource}
      >
        {lastPane.body}
      </InboxPaneFrame>
    </div>
  );
}
