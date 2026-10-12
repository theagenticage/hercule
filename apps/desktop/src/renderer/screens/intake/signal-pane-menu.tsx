import { useId, useRef, useState, type JSX, type KeyboardEvent, type ToggleEvent } from "react";
import { ExternalIcon } from "../../icons/external";
import { MoreIcon } from "../../icons/more";
import { moveMenuFocus } from "./move-menu-focus";
import "../thread/menus.css";

/** The items of the pane's menu, which tell its active item apart. */
type SignalPaneMenuItem = "open-on-source" | "ignore";

/**
 * Renders the pane's "More" button and the menu it opens (spec 17 §The
 * pane): "Open on GitHub", when the signal's address on its source is known,
 * and "Ignore signals like this…", which calls `onIgnore`. The pane draws it
 * only for a signal the user can build an Ignore Rule from.
 *
 * The menu is the browser's own popover, as the side pane's surface picker
 * is: the browser closes it on Esc and on a click outside it, and places it
 * under its button by CSS anchor positioning. Its items are drawn and
 * stepped through as the snooze menu's are:
 *
 * - the first item takes the focus when the menu opens, so the arrow keys
 *   work at once, and is drawn active when the menu was opened by a key;
 * - the arrow keys move the focus, wrapping around at either end;
 * - the item under the pointer, or the one the keys moved to, is drawn
 *   active, so two items are never highlighted at once.
 */
export function SignalPaneMenu({
  sourceName,
  sourceUrl,
  onIgnore,
}: {
  /** The name of the signal's source, such as "GitHub". */
  readonly sourceName: string;
  /** The signal's address on its source, or `null` when it is not known. */
  readonly sourceUrl: string | null;
  readonly onIgnore: () => void;
}): JSX.Element {
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const openedByKey = useRef(false);
  const [activeItem, setActiveItem] = useState<SignalPaneMenuItem | null>(null);

  const handleToggle = (event: ToggleEvent<HTMLDivElement>): void => {
    if (event.newState !== "open") {
      setActiveItem(null);
      return;
    }
    const first = event.currentTarget.querySelector<HTMLElement>("[role='menuitem']");
    first?.focus({ preventScroll: true });
    setActiveItem(
      openedByKey.current && first !== null ? (first.dataset.item as SignalPaneMenuItem) : null,
    );
  };

  const handleKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next = moveMenuFocus(event.currentTarget, event.key);
    setActiveItem(next === undefined ? null : (next.dataset.item as SignalPaneMenuItem));
  };

  /** Returns the props that draw the item `item` active under the pointer. */
  const buildItemProps = (item: SignalPaneMenuItem) => ({
    role: "menuitem",
    className: item === activeItem ? "is-active" : undefined,
    "data-item": item,
    onPointerEnter: () => {
      setActiveItem(item);
    },
    onPointerLeave: () => {
      setActiveItem(null);
    },
  });

  return (
    <>
      <button
        type="button"
        className="icon-btn icon-btn--sm ad-more"
        popoverTarget={menuId}
        aria-label="More"
        title="More"
        onClick={(event) => {
          // A click from the keyboard, Enter or Space, has no pointer press.
          openedByKey.current = event.detail === 0;
        }}
      >
        <MoreIcon size={14} />
      </button>
      <div
        ref={menuRef}
        id={menuId}
        popover="auto"
        role="menu"
        aria-label="More"
        className="pop intake-menu ad-menu"
        onToggle={handleToggle}
        onKeyDown={handleKeys}
      >
        {sourceUrl !== null && (
          <a
            {...buildItemProps("open-on-source")}
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => menuRef.current?.hidePopover()}
          >
            <span>{`Open on ${sourceName}`}</span>
            <ExternalIcon size={13} />
          </a>
        )}
        <button
          type="button"
          {...buildItemProps("ignore")}
          onClick={() => {
            menuRef.current?.hidePopover();
            onIgnore();
          }}
        >
          <span>Ignore signals like this…</span>
        </button>
      </div>
    </>
  );
}
