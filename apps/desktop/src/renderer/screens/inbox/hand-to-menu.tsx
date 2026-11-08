import { useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { describeHandOffEnds, type CardOffers } from "@hercule/client-core/inbox";
import type { ActingConnection } from "@hercule/contract";
import { buildLook, Face } from "../../faces";
import { HandAccount } from "./hand-account";
import "./hand-to-menu.css";

/** The size of a workflow's face in the menu, in pixels. */
const FACE_SIZE = 28;

/** How many available workflows have a number key: 1 to 3. */
const NUMBERED_ROWS = 3;

/** The gap between the menu and the card it opens under, in pixels. */
const GAP = 6;

/** The gap the menu keeps to the window's edges, in pixels. */
const WINDOW_MARGIN = 12;

/**
 * Places the popover `menu` in the window: left edges level with `anchor`,
 * 6px under its card, or above the card when there is no room below.
 * It never overflows the window to the right.
 */
const placeMenu = (menu: HTMLElement, anchor: HTMLElement): void => {
  const target = anchor.closest("[data-card-id]") ?? anchor;
  const card = target.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const left = Math.max(
    WINDOW_MARGIN,
    Math.min(anchor.getBoundingClientRect().left, window.innerWidth - size.width - 16),
  );
  const below = card.bottom + GAP;
  const top =
    below + size.height > window.innerHeight - WINDOW_MARGIN ? card.top - size.height - GAP : below;
  menu.style.left = `${String(left)}px`;
  menu.style.top = `${String(Math.max(WINDOW_MARGIN, top))}px`;
};

/**
 * Renders the menu of workflows a card can be handed to, as a popover under
 * the card `anchor` is in (or under `anchor` itself). The parent renders it
 * only while it is open and removes it when `onHand` or `onClose` is called.
 *
 * - The available workflows come first, each with its face, its name, the
 *   line of what a hand-off would end (`describeHandOffEnds` over
 *   `openKinds`, the kinds of the signals the card holds open), and the key
 *   1 to 3 that picks it. The ones that cannot take the card now follow,
 *   dimmed, each saying why.
 * - With more than one acting account the menu names the one the hand-off
 *   acts as, "as northwind-bot", and lets the user pick another:
 *   `chosenConnectionId` is the account in use (the first when it is not one
 *   of `actingConnections`) and `onChooseConnection` is called with the
 *   account picked.
 * - The open menu owns the keyboard: 1 to 3 and Return pick, the arrow keys move, and Esc calls `onClose`. No key reaches the page
 *   behind it. A click outside the menu calls `onClose` too.
 *
 * It shows the first available workflow as the active one and gives it the
 * focus, and gives the focus back to what had it when it goes.
 */
export function HandToMenu({
  offers,
  openKinds,
  actingConnections,
  chosenConnectionId,
  onChooseConnection,
  onHand,
  onClose,
  anchor,
}: {
  readonly offers: CardOffers;
  readonly openKinds: readonly string[];
  readonly actingConnections: readonly ActingConnection[];
  readonly chosenConnectionId: string | undefined;
  readonly onChooseConnection: (connectionId: string) => void;
  readonly onHand: (workflowId: string) => void;
  readonly onClose: () => void;
  readonly anchor: HTMLElement;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const { available, unavailable } = offers;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    const before = document.activeElement;
    menu.showPopover();
    placeMenu(menu, anchor);
    return () => {
      if (before instanceof HTMLElement && before.isConnected) {
        before.focus({ preventScroll: true });
      }
    };
  }, [anchor]);

  // The row that is active has the focus, so Return and a screen reader both act on it.
  useLayoutEffect(() => {
    menuRef.current?.querySelector<HTMLElement>(`[data-hand-row="${String(active)}"]`)?.focus({
      preventScroll: true,
    });
  }, [active]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // The menu owns the keyboard: the page behind it never sees a key.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    // The account picker keeps its own keys.
    if (event.target instanceof HTMLSelectElement) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : available.length - 1;
      setActive((active + step) % Math.max(available.length, 1));
      return;
    }
    // The number keys pick the first three, and swallow the others so a digit never lands on the page.
    const picked =
      event.key === "Enter"
        ? available[active]
        : /^[1-3]$/.test(event.key)
          ? available[Number(event.key) - 1]
          : undefined;
    if (event.key === "Enter" || /^\d$/.test(event.key)) event.preventDefault();
    if (picked !== undefined) onHand(picked.workflowId);
  };

  return (
    <div
      ref={menuRef}
      popover="auto"
      role="menu"
      aria-label="Hand to"
      className="hand-menu"
      onKeyDown={handleKeyDown}
      onToggle={(event) => {
        if (event.newState === "closed") onClose();
      }}
    >
      <p className="hand-menu-heading">Hand to</p>
      {available.map((offer, index) => (
        <button
          key={offer.workflowId}
          type="button"
          role="menuitem"
          className={index === active ? "hand-row is-active" : "hand-row"}
          data-hand-row={index}
          tabIndex={-1}
          onPointerEnter={() => {
            setActive(index);
          }}
          onClick={() => {
            onHand(offer.workflowId);
          }}
        >
          <Face look={buildLook(offer.workflowId)} pose="idle" size={FACE_SIZE} />
          <span className="hand-row-words">
            <b>{offer.name}</b>
            <small>{describeHandOffEnds(offer, openKinds)}</small>
          </span>
          {index < NUMBERED_ROWS && <kbd>{index + 1}</kbd>}
        </button>
      ))}
      <HandAccount
        actingConnections={actingConnections}
        chosenConnectionId={chosenConnectionId}
        onChoose={onChooseConnection}
      />
      {unavailable.length > 0 && <i className="hand-menu-line" />}
      {unavailable.map((offer) => (
        <div key={offer.workflowId} role="menuitem" aria-disabled="true" className="hand-row">
          <Face look={buildLook(offer.workflowId)} pose="idle" size={FACE_SIZE} />
          <span className="hand-row-words">
            <b>{offer.name}</b>
            <small>{offer.unavailable?.message}</small>
          </span>
        </div>
      ))}
    </div>
  );
}
