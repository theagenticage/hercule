import type { JSX, KeyboardEvent, ReactNode, RefObject } from "react";
import { joinClassNames } from "../../app/join-class-names";
import { CheckIcon } from "../../icons/check";
import { ChevronLeftIcon } from "../../icons/chevron-left";
import { MoreIcon } from "../../icons/more";
import { useResizablePane } from "../desk/use-resizable-pane";
import { MenuAction, MenuHeading, MenuLine, ToolMenu } from "../desk/tool-menu";
import { usePopoverMenu } from "../use-popover-menu";
import "./inbox-pane-frame.css";

/** The id of the pane element, so the keyboard moves focus into it. */
export const INBOX_PANE_ID = "inbox-pane";

/** The narrowest the pane may be, in pixels. */
export const INBOX_PANE_MIN_WIDTH = 360;

/** The widest the pane may be, in pixels, whatever room the window has. */
export const INBOX_PANE_MAX_WIDTH = 640;

/** The width a double click and the "Default" menu item give the pane, in pixels. */
export const INBOX_PANE_DEFAULT_WIDTH = 420;

/** How far one arrow key press moves the pane's edge, in pixels. */
const ARROW_STEP = 40;

/** The widths the ⋯ menu offers, narrowest first. */
const MENU_WIDTHS: ReadonlyArray<{ readonly name: string; readonly width: number }> = [
  { name: "Narrow", width: INBOX_PANE_MIN_WIDTH },
  { name: "Default", width: INBOX_PANE_DEFAULT_WIDTH },
  { name: "Wide", width: 560 },
];

/**
 * Renders the pane of the Inbox and its edge, as two siblings of the frame's
 * grid: the edge in the gap between the list and the pane, and the pane with
 * a head (the "List" button while the pane lies over the list, `head`, and
 * the ⋯ menu) over its `children`.
 *
 * - `width` is the width the pane has now, and `widestWidth` the widest the
 *   window lets it be. The edge resizes the pane between
 *   `INBOX_PANE_MIN_WIDTH` and `widestWidth` (see `useResizablePane`: the
 *   arrows step 40px, Home is widest, End is narrowest, a double click is
 *   `INBOX_PANE_DEFAULT_WIDTH`). `drawWidth` draws a width while the edge is
 *   dragged, and `onWidthChange` receives the width a gesture ends on or the
 *   menu picks.
 * - `isStacked` is true while the pane lies over the list. There it has no
 *   edge and no width menu, `isOpen` says whether it is slid in, and Esc or
 *   the "List" button call `onClose`.
 * - `isShown` is false while the pane steps aside: it is inert then.
 * - `onOpenAtSource`, when given, adds "Open at its source" to the menu.
 * - `paneRef` is the pane's element, which the frame fades.
 */
export function InboxPaneFrame({
  paneRef,
  width,
  widestWidth,
  isStacked,
  isOpen,
  isShown,
  head,
  children,
  drawWidth,
  onWidthChange,
  onClose,
  onOpenAtSource,
}: {
  readonly paneRef: RefObject<HTMLElement | null>;
  readonly width: number;
  readonly widestWidth: number;
  readonly isStacked: boolean;
  readonly isOpen: boolean;
  readonly isShown: boolean;
  readonly head: ReactNode;
  readonly children: ReactNode;
  readonly drawWidth: (width: number) => void;
  readonly onWidthChange: (width: number) => void;
  readonly onClose: () => void;
  readonly onOpenAtSource?: (() => void) | undefined;
}): JSX.Element {
  const separatorProps = useResizablePane({
    paneRef,
    paneSide: "right",
    width,
    defaultWidth: INBOX_PANE_DEFAULT_WIDTH,
    min: INBOX_PANE_MIN_WIDTH,
    max: widestWidth,
    measureMax: () => widestWidth,
    step: ARROW_STEP,
    draw: drawWidth,
    onCommit: onWidthChange,
  });
  const menu = usePopoverMenu();

  const closeOnEscape = (event: KeyboardEvent<HTMLElement>): void => {
    // A menu open in the pane takes Esc for itself.
    if (event.key !== "Escape" || !isStacked || !isOpen) return;
    if (event.target instanceof Element && event.target.closest("[popover]") !== null) return;
    event.preventDefault();
    onClose();
  };

  const hasMenu = onOpenAtSource !== undefined || !isStacked;
  // While the first read of the list is out, the pane holds only its still shapes and no head.
  const hasHead = head !== null || isStacked;

  return (
    <>
      {!isStacked && <div {...separatorProps} className="ib-edge" aria-label="Resize the pane" />}
      <aside
        ref={paneRef}
        id={INBOX_PANE_ID}
        className={joinClassNames("ib-pane", isStacked && "is-stacked", isOpen && "is-open")}
        aria-label="The open thing"
        inert={!isShown || (isStacked && !isOpen)}
        onKeyDown={closeOnEscape}
      >
        {hasHead && (
          <header className="ib-pane-head">
            {isStacked && (
              <button type="button" className="pill-btn ib-pane-back" onClick={onClose}>
                <ChevronLeftIcon size={12} />
                List
              </button>
            )}
            <div className="ib-pane-from">{head}</div>
            {hasMenu && (
              <>
                <button
                  {...menu.triggerProps}
                  type="button"
                  className="icon-btn ib-pane-more"
                  aria-label="More"
                  title="More"
                >
                  <MoreIcon size={16} />
                </button>
                <ToolMenu menuProps={menu.menuProps} label="The pane" edge="button-end">
                  {onOpenAtSource !== undefined && (
                    <MenuAction
                      itemProps={menu.buildItemProps("open-at-source")}
                      name="Open at its source"
                      shortcut="O"
                      onPick={() => {
                        menu.close();
                        onOpenAtSource();
                      }}
                    />
                  )}
                  {onOpenAtSource !== undefined && !isStacked && <MenuLine />}
                  {!isStacked && (
                    <>
                      <MenuHeading>Pane width</MenuHeading>
                      {MENU_WIDTHS.map((choice) => {
                        const isTooWide = choice.width > widestWidth;
                        const isChosen = choice.width === width;
                        const itemProps = menu.buildItemProps(`width-${String(choice.width)}`, {
                          disabled: isTooWide,
                          checked: isChosen,
                        });
                        return (
                          <button
                            key={choice.width}
                            {...itemProps}
                            type="button"
                            className={joinClassNames("menu-pick", itemProps.className)}
                            title={isTooWide ? "The window is too narrow for it" : undefined}
                            onClick={() => {
                              if (isTooWide) return;
                              menu.close();
                              drawWidth(choice.width);
                              onWidthChange(choice.width);
                            }}
                          >
                            <span>{choice.name}</span>
                            <small>{choice.width}px</small>
                            {isChosen && <CheckIcon size={14} />}
                          </button>
                        );
                      })}
                    </>
                  )}
                </ToolMenu>
              </>
            )}
          </header>
        )}
        <div className="ib-pane-body">{children}</div>
      </aside>
    </>
  );
}
