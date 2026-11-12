import { useId, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import {
  findHandOffs,
  HAND_OFF_FIND_FROM,
  listAvailableHandOffs,
  type CardOffers,
  type HandOffAsks,
} from "@hercule/client-core/inbox";
import type { ActingConnection } from "@hercule/contract";
import { buildLook, Face } from "../../faces";
import { SearchIcon } from "../../icons/search";
import { HandAccount } from "./hand-account";
import "./hand-to-menu.css";

/** The size of a workflow's face in the menu, in pixels. */
const FACE_SIZE = 28;

/** How many available workflows have a number key: 1 to 3. */
const NUMBERED_ROWS = 3;

/** The gap between the menu and the element it opens under, in pixels. */
const GAP = 6;

/** The gap the menu keeps to the window's edges, in pixels. */
const WINDOW_MARGIN = 12;

/**
 * Places the popover `menu` in the window: its right edge level with the right
 * edge of `anchor`, 6px under it, or above it when there is no room below.
 * It never leaves the window.
 */
const placeMenu = (menu: HTMLElement, anchor: HTMLElement): void => {
  const target = anchor.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const left = Math.max(
    WINDOW_MARGIN,
    Math.min(target.right - size.width, window.innerWidth - size.width - WINDOW_MARGIN),
  );
  const below = target.bottom + GAP;
  const top =
    below + size.height > window.innerHeight - WINDOW_MARGIN
      ? target.top - size.height - GAP
      : below;
  menu.style.left = `${String(left)}px`;
  menu.style.top = `${String(Math.max(WINDOW_MARGIN, top))}px`;
};

/**
 * Renders the menu of workflows a thing can be handed to, as a popover under
 * `anchor`, the element it opens from (a row of the list, or the pane's
 * button). The parent renders it only while it is open and removes it when
 * `onHand` or `onClose` is called.
 *
 * - The available workflows come first, best fit first (`rankHandOffs`), each
 *   with its face, its name, the line that names the asks a hand-off would end
 *   and the ones it leaves with the user (`describeHandOffAsks` over the
 *   thing's `asks`), and the key 1 to 3 that picks it. The ones that cannot
 *   take the thing now follow, dimmed, each saying why.
 * - From six available workflows (`HAND_OFF_FIND_FROM`) a field at the top
 *   finds a workflow by its name or by what it does, and has the focus. While
 *   nothing is typed, 1 to 3 still pick. Once something is typed the digits
 *   type, and the arrow keys and Return pick from what is found.
 * - With more than one acting account the menu names the one the hand-off
 *   acts as, "as northwind-bot", and lets the user pick another. The pick is
 *   the parent's (`chosenConnectionId`, `onChooseConnection`), who uses it
 *   when `onHand` is called. With no pick, the controller chooses the account.
 * - The open menu owns the keyboard: no key reaches the page behind it, and
 *   Esc calls `onClose`. A click outside the menu calls `onClose` too.
 *
 * It shows the first workflow as the active one and gives it the focus (the
 * field has the focus when there is one, and points at the active workflow),
 * and gives the focus back to what had it when it goes.
 */
export function HandToMenu({
  offers,
  thing,
  actingConnections,
  chosenConnectionId,
  onChooseConnection,
  onHand,
  onClose,
  anchor,
}: {
  readonly offers: CardOffers;
  /** The asks of the thing, which the lines and the ranking are read from. */
  readonly thing: HandOffAsks;
  readonly actingConnections: readonly ActingConnection[];
  /** The account the user picked, or `undefined` when they picked none. */
  readonly chosenConnectionId: string | undefined;
  readonly onChooseConnection: (connectionId: string) => void;
  readonly onHand: (workflowId: string) => void;
  readonly onClose: () => void;
  readonly anchor: HTMLElement;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const choices = listAvailableHandOffs(offers, thing);
  const hasFind = choices.length >= HAND_OFF_FIND_FROM;
  const shown = findHandOffs(choices, query);
  const shownUnavailable = findHandOffs(
    offers.unavailable.map((offer) => ({ offer, line: offer.unavailable?.message ?? "" })),
    query,
  );
  // A narrower result can leave `active` past its end until the next key.
  const activeIndex = Math.min(active, shown.length - 1);
  const typing = query.trim() !== "";
  const optionId = (index: number): string => `${ids}-${String(index)}`;

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

  // With no field, the active row has the focus, so Return and a screen reader both act on it.
  // With a field, the field keeps the focus and points at the active row.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const row = menu?.querySelector<HTMLElement>(`[data-hand-row="${String(activeIndex)}"]`);
    if (menu === null || row === null || row === undefined) return;
    if (hasFind) findRef.current?.focus({ preventScroll: true });
    else row.focus({ preventScroll: true });
    // Keeps the active row in view when the menu scrolls, as `scrollIntoView` would.
    if (row.offsetTop < menu.scrollTop) menu.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight;
    }
  }, [activeIndex, hasFind, shown.length]);

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
      const step = event.key === "ArrowDown" ? 1 : shown.length - 1;
      setActive((activeIndex + step) % Math.max(shown.length, 1));
      return;
    }
    // Digits type into the field once something is typed. Before that they pick: 1 to 3 pick
    // the first three, and the others are swallowed so a digit never lands on the page.
    if (typing && /^\d$/.test(event.key)) return;
    const picked =
      event.key === "Enter"
        ? shown[activeIndex]
        : /^[1-3]$/.test(event.key)
          ? shown[Number(event.key) - 1]
          : undefined;
    if (event.key === "Enter" || /^\d$/.test(event.key)) event.preventDefault();
    if (picked !== undefined) onHand(picked.offer.workflowId);
  };

  const itemRole = hasFind ? "option" : "menuitem";
  return (
    <div
      ref={menuRef}
      popover="auto"
      aria-labelledby={`${ids}-heading`}
      className={typing ? "hand-menu is-finding" : "hand-menu"}
      onKeyDown={handleKeyDown}
      onToggle={(event) => {
        if (event.newState === "closed") onClose();
      }}
    >
      <p className="hand-menu-heading" id={`${ids}-heading`}>
        Hand to
      </p>
      {hasFind && (
        <div className="hand-find">
          <SearchIcon size={14} />
          <input
            ref={findRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${ids}-list`}
            aria-autocomplete="list"
            aria-activedescendant={shown.length === 0 ? undefined : optionId(activeIndex)}
            aria-labelledby={`${ids}-heading`}
            placeholder="Find a workflow"
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setActive(0);
            }}
          />
        </div>
      )}
      <div
        id={`${ids}-list`}
        role={hasFind ? "listbox" : "menu"}
        aria-labelledby={`${ids}-heading`}
      >
        {shown.map(({ offer, line }, index) => (
          <button
            key={offer.workflowId}
            id={optionId(index)}
            type="button"
            role={itemRole}
            aria-selected={hasFind ? index === activeIndex : undefined}
            className={index === activeIndex ? "hand-row is-active" : "hand-row"}
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
              <small>{line}</small>
            </span>
            {index < NUMBERED_ROWS && !typing && <kbd>{index + 1}</kbd>}
          </button>
        ))}
        {hasFind && shown.length === 0 && shownUnavailable.length === 0 && (
          <p className="hand-none">No workflow by that name. Esc closes.</p>
        )}
        {shownUnavailable.length > 0 && <i className="hand-menu-line" role="separator" />}
        {shownUnavailable.map(({ offer, line }) => (
          <div key={offer.workflowId} role={itemRole} aria-disabled="true" className="hand-row">
            <Face look={buildLook(offer.workflowId)} pose="idle" size={FACE_SIZE} />
            <span className="hand-row-words">
              <b>{offer.name}</b>
              <small>{line}</small>
            </span>
          </div>
        ))}
      </div>
      <HandAccount
        actingConnections={actingConnections}
        chosenConnectionId={chosenConnectionId}
        onChoose={onChooseConnection}
      />
    </div>
  );
}
