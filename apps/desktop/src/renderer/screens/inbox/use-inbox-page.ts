import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  decideNextWaitingCard,
  describeMoveRefusal,
  walkInbox,
  type InboxMove,
  type WalkedFrom,
} from "@hercule/client-core/inbox";
import type { InboxCard } from "@hercule/contract";
import { isTextField } from "../../app/text-field";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { CARD_SELECTOR, findCardElement, readCardElement, readInboxStops } from "./inbox-page-dom";
import { readInboxKey, type InboxKeyCommand } from "./read-inbox-key";
import type { CurrentCard } from "./use-current-card";

/**
 * What a key press can land on without being the page's: a menu or popover, a
 * dialog, and a side sheet. They keep their own keys.
 */
const OVERLAY_SELECTOR = "[popover], dialog, [role='menu'], .side-sheet";

/** Matches a popover or a dialog that is open right now, which closes itself on Esc. */
const OPEN_OVERLAY_SELECTOR = 'dialog[open], [popover="auto"]:popover-open';

/** How near, in pixels, and how soon after a dismissal, a click counts as the same click again. */
const SAME_SPOT_PX = 4;
const SAME_SPOT_MS = 1_500;

/** How soon after a Take a click on "On Work" is ignored: it is the second click of a double click on "Take it", which "On Work" replaced. */
const DOUBLE_CLICK_MS = 400;

/** The sheet that opens a card, as the page uses it. */
export interface OpenCardControls {
  /** The id of the open card, or `null` when none is open. */
  readonly openId: string | null;
  /** Opens the card `id` from the element it lies in. */
  readonly open: (id: string, origin: HTMLElement) => void;
  /** Folds the open card back. */
  readonly close: () => void;
  /** Moves the open sheet to another card, while it stays where it stands. */
  readonly walk: (id: string) => void;
}

/** What `useInboxPage` needs from the Inbox screen. */
export interface InboxPageInput {
  /** The element that scrolls the page. */
  readonly scrollRef: RefObject<HTMLElement | null>;
  /** The platform decides whether undo is ⌘Z or Ctrl Z. */
  readonly platform: DesktopPlatform;
  readonly current: CurrentCard;
  /** Returns the card `id` on the Inbox as the screen draws it. */
  readonly findCard: (id: string) => InboxCard | undefined;
  readonly open: OpenCardControls;
  readonly moves: {
    readonly take: (card: InboxCard) => void;
    readonly dismiss: (card: InboxCard) => void;
    readonly seeTask: (card: InboxCard) => void;
    readonly undoLastMove: () => void;
    /** Says `text` on the undo line, with no Undo. */
    readonly say: (text: string) => void;
  };
}

/** What `useInboxPage` returns. */
export interface InboxPage {
  readonly isKeysSheetOpen: boolean;
  /** Toggles the sheet of keys, as the `?` key does. */
  readonly toggleKeysSheet: () => void;
}

/**
 * Listens to the keys and the clicks of the Inbox page for as long as the
 * screen is mounted, and calls the screen's moves. The keys are in
 * `readInboxKey`.
 *
 * - A key is the page's only when focus is on the page itself or on something
 *   inside it, and never in a text field, a menu or a sheet. So focus in the
 *   toolbar acts on no card. Undo and Esc also work from the toolbar. A held
 *   key never repeats a move.
 * - The current card (`useCurrentCard`) is the card every key acts on. After
 *   a Take or a Dismiss the current card moves on to the next that waits,
 *   chosen by the order of the page and never by what lies under the pointer.
 * - A click on a move button runs the move. A click on a card opens it. After
 *   a dismissal by the pointer, a click at the same spot dismisses the next
 *   card, the way closing a tab brings the next under the pointer.
 * - While a card is open, the sheet holds the focus: J and K walk it through
 *   the page, T and E act on the open card and walk it on, and G closes it
 *   and goes to the Task.
 * - A roving tab stop gives the Tab key one card to land on.
 */
export const useInboxPage = (input: InboxPageInput): InboxPage => {
  const { scrollRef, current, open } = input;
  const [isKeysSheetOpen, setKeysSheetOpen] = useState(false);
  const cameFrom = useRef<WalkedFrom | undefined>(undefined);
  const lastDismissal = useRef<{ x: number; y: number; at: number } | null>(null);
  const lastTakeAt = useRef(0);
  const tabStop = useRef<HTMLElement | null>(null);

  /** Makes the card `nextId`, or no card, the current one after a move: by the keys, or handed over to the pointer. */
  const moveOn = (nextId: string | undefined, by: "keys" | "pointer"): void => {
    if (by === "keys") current.set(nextId ?? null, "keys");
    else current.handOver(nextId ?? null);
  };

  /**
   * Runs `move` on `card` unless it is refused, which is said on the undo
   * line. Take and Dismiss then hand the current card to the next that waits,
   * or walk the open sheet to it. Returns whether it ran.
   */
  const perform = (move: InboxMove, card: InboxCard, by: "keys" | "pointer"): boolean => {
    const reason = describeMoveRefusal(card, move);
    if (reason !== undefined) {
      input.moves.say(reason);
      return false;
    }
    const scroller = scrollRef.current;
    if (move === "see-task") {
      input.moves.seeTask(card);
      return true;
    }
    // The next card is chosen before the move, because a dismissal takes the card off the page.
    const next =
      scroller === null ? undefined : decideNextWaitingCard(readInboxStops(scroller), card.id);
    if (move === "take") input.moves.take(card);
    else input.moves.dismiss(card);
    if (open.openId === null) moveOn(next, by);
    else if (next === undefined) open.close();
    else {
      open.walk(next);
      current.set(next, "keys", false);
    }
    return true;
  };

  const stepBack = (event: KeyboardEvent): void => {
    if (document.querySelector(OPEN_OVERLAY_SELECTOR) !== null) return;
    if (isKeysSheetOpen) setKeysSheetOpen(false);
    else if (open.openId !== null) open.close();
    else if (current.read() !== null) current.set(null, "keys");
    else return;
    event.preventDefault();
  };

  /** Walks the open sheet to the card before or after it. */
  const walkSheet = (walk: "next" | "previous"): void => {
    const scroller = scrollRef.current;
    if (scroller === null || open.openId === null) return;
    const to = walkInbox(readInboxStops(scroller), open.openId, walk);
    if (to === undefined) return;
    open.walk(to);
    current.set(to, "keys", false);
  };

  const handleOpenCardKey = (command: InboxKeyCommand, event: KeyboardEvent): void => {
    if (command.kind === "walk") {
      if (command.walk !== "next" && command.walk !== "previous") return;
      event.preventDefault();
      walkSheet(command.walk);
      return;
    }
    // A place is open when its id is not a card's: it has no moves at all.
    const card = open.openId === null ? undefined : input.findCard(open.openId);
    if (card === undefined) return;
    if (command.kind === "take" || command.kind === "dismiss") {
      event.preventDefault();
      perform(command.kind, card, "keys");
    } else if (command.kind === "see-task") {
      event.preventDefault();
      if (perform("see-task", card, "keys")) open.close();
    }
  };

  const handleKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || isTextField(event.target)) return;
    const command = readInboxKey(event, input.platform);
    if (command === null || (event.repeat && command.kind !== "walk")) return;
    if (command.kind === "step-back") {
      stepBack(event);
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[popover], [role='menu']") != null) return;
    if (command.kind === "undo") {
      event.preventDefault();
      input.moves.undoLastMove();
      return;
    }
    if (open.openId !== null) {
      handleOpenCardKey(command, event);
      return;
    }
    if (target?.closest(OVERLAY_SELECTOR) != null) return;
    const scroller = scrollRef.current;
    const isOnPage = target === document.body || scroller?.contains(target) === true;
    if (!isOnPage || scroller === null) return;

    const here = current.read();
    switch (command.kind) {
      case "walk": {
        event.preventDefault();
        const to = walkInbox(readInboxStops(scroller), here?.id, command.walk, cameFrom.current);
        if (to === undefined) return;
        current.set(to, "keys");
        cameFrom.current =
          here === null || to === here.id ? undefined : { id: here.id, walk: command.walk };
        return;
      }
      case "open": {
        // On a button, Return and Space press that button. Only a card, or the page itself, is the page's.
        if (target !== document.body && target?.matches(CARD_SELECTOR) !== true) return;
        const element = here === null ? null : findCardElement(scroller, here.id);
        if (here === null || element === null) return;
        event.preventDefault();
        open.open(here.id, element);
        return;
      }
      case "take":
      case "dismiss":
      case "see-task": {
        const card = here === null ? undefined : input.findCard(here.id);
        if (card === undefined) return;
        event.preventDefault();
        perform(command.kind, card, "keys");
        return;
      }
      case "toggle-keys-sheet":
        setKeysSheetOpen(!isKeysSheetOpen);
        return;
    }
  };

  const handleClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    const now = performance.now();
    const before = lastDismissal.current;
    const here = current.read();
    if (
      before !== null &&
      now - before.at < SAME_SPOT_MS &&
      Math.hypot(event.clientX - before.x, event.clientY - before.y) < SAME_SPOT_PX &&
      here?.by === "pointer"
    ) {
      // The card that took the place of the one dismissed may still be on its way, so it is not hit-tested.
      const card = input.findCard(here.id);
      if (card !== undefined) {
        lastDismissal.current = { x: event.clientX, y: event.clientY, at: now };
        perform("dismiss", card, "pointer");
        return;
      }
    }
    const element = readCardElement(target);
    const cardId = element?.dataset["cardId"];
    const button = target.closest<HTMLElement>("[data-move]");
    if (button !== null && element !== null && cardId !== undefined) {
      const card = input.findCard(cardId);
      if (card === undefined) return;
      const move = button.dataset["move"];
      if (move === "take") {
        lastTakeAt.current = now;
        perform("take", card, "pointer");
      } else if (move === "dismiss") {
        lastDismissal.current = { x: event.clientX, y: event.clientY, at: now };
        perform("dismiss", card, "pointer");
      } else if (move === "see-task" && now - lastTakeAt.current >= DOUBLE_CLICK_MS) {
        perform("see-task", card, "pointer");
      }
      return;
    }
    if (element !== null && cardId !== undefined) {
      open.open(cardId, element);
      return;
    }
    // A place's head opens the place, and a pointer ("Also in ...") opens the card it points to.
    const placeHead = target.closest<HTMLElement>("[data-place-ref]");
    const placeRef = placeHead?.dataset["placeRef"];
    if (placeHead !== null && placeRef !== undefined) {
      open.open(placeRef, placeHead);
      return;
    }
    const pointer = target.closest<HTMLElement>("[data-pointer-to]");
    const pointedTo = pointer?.dataset["pointerTo"];
    if (pointer !== null && pointedTo !== undefined) open.open(pointedTo, pointer);
  };

  // A card that takes the focus by the Tab key becomes the current card.
  const handleFocusIn = (event: FocusEvent): void => {
    const element = event.target instanceof Element ? readCardElement(event.target) : null;
    const id = element?.dataset["cardId"];
    if (element === null || id === undefined || event.target !== element) return;
    if (!element.matches(":focus-visible") || current.read()?.id === id) return;
    current.set(id, "keys", false);
  };

  // The listeners are added once and call the newest handlers, which read the newest state and props.
  const handlers = useRef({ handleKey, handleClick, handleFocusIn });
  useLayoutEffect(() => {
    handlers.current = { handleKey, handleClick, handleFocusIn };
  });
  useEffect(() => {
    const scroller = scrollRef.current;
    const onKey = (event: KeyboardEvent): void => {
      handlers.current.handleKey(event);
    };
    const onClick = (event: MouseEvent): void => {
      handlers.current.handleClick(event);
    };
    const onFocusIn = (event: FocusEvent): void => {
      handlers.current.handleFocusIn(event);
    };
    window.addEventListener("keydown", onKey);
    scroller?.addEventListener("click", onClick);
    scroller?.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKey);
      scroller?.removeEventListener("click", onClick);
      scroller?.removeEventListener("focusin", onFocusIn);
    };
  }, [scrollRef]);

  // After each draw, the Tab key has one card to land on: the current card, else the first.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const here = current.read();
    const stop =
      (here === null ? null : findCardElement(scroller, here.id)) ??
      scroller.querySelector<HTMLElement>(CARD_SELECTOR);
    if (stop === tabStop.current) return;
    tabStop.current?.setAttribute("tabindex", "-1");
    stop?.setAttribute("tabindex", "0");
    tabStop.current = stop;
  });

  return { isKeysSheetOpen, toggleKeysSheet: () => setKeysSheetOpen(!isKeysSheetOpen) };
};
