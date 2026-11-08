import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  describeMoveRefusal,
  walkInbox,
  type InboxMove,
  type WalkedFrom,
} from "@hercule/client-core/inbox";
import type { InboxCard } from "@hercule/contract";
import { isTextField } from "../../app/text-field";
import { useFocusPageOnArrival } from "../desk";
import { OPEN_OVERLAY_SELECTOR, OVERLAY_SELECTOR } from "../desk/desk-keys";
import { CARD_SELECTOR, findCardElement, readCardElement, readInboxStops } from "./inbox-page-dom";
import { readInboxKey, type InboxKeyCommand } from "./read-inbox-key";
import type { OpenCardControls, RunAndMoveOn } from "./use-run-and-move-on";
import type { CurrentBy, CurrentCard } from "./use-current-card";
import type { HandOff } from "./use-hand-off";

/** How near, in pixels, and how soon after a dismissal, a click counts as the same click again. */
const SAME_SPOT_PX = 4;
const SAME_SPOT_MS = 1_500;

/** How soon after a Take a click on "On Work" is ignored: it is the second click of a double click on "Take it", which "On Work" replaced. */
const DOUBLE_CLICK_MS = 400;

/** What the undo line says for a key that asks a move of a place. */
const PLACE_HAS_NO_MOVES = "A place has no moves. Open one of its cards to act on it.";

/** The moves that need nothing but the card. A hand-off also needs a workflow, so it has its own path. */
type PlainMove = Exclude<InboxMove, "hand">;

/** What `useInboxPage` needs from the Inbox screen. */
export interface InboxPageInput {
  /** The element that scrolls the page. */
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly current: CurrentCard;
  /** Returns the card `id` on the Inbox as the screen draws it. */
  readonly findCard: (id: string) => InboxCard | undefined;
  readonly open: OpenCardControls;
  /** Runs a move on a card and moves the page on: the current card goes to the next that waits, or the open sheet walks to it. */
  readonly runAndMoveOn: RunAndMoveOn;
  /** The Hand to gesture (`useHandOff`): the page calls it for H, the card's Hand to button, and the sheet's keys. */
  readonly handOff: Pick<HandOff, "startCardHand" | "handCard" | "pressSheetKey">;
  readonly moves: {
    readonly take: (card: InboxCard) => void;
    readonly dismiss: (card: InboxCard) => void;
    readonly seeTask: (card: InboxCard) => void;
    /** Links the two things, as `Link them` on a hint does: one move, with one Undo. */
    readonly link: (fromRef: string, toRef: string) => void;
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
 *   toolbar acts on no card. Esc also works from the toolbar. A held
 *   key never runs through the page: not a move, and not a walk.
 * - The current card (`useCurrentCard`) is the card every key acts on. After
 *   a Take or a Dismiss the current card moves on to the next that waits,
 *   chosen by the order of the page and never by what lies under the pointer.
 * - H hands the current card to its one workflow, opens the Hand to menu
 *   when several can take it, and says why when none can. The number keys
 *   belong to that menu and to the open sheet, so the page ignores them
 *   while neither is open.
 * - A click on a move button runs the move. A click on a card, or on a part
 *   that asks, opens it. A click on a quiet part, or on a line that says what a
 *   request is linked to, opens the thing it names. A click on `Link them`
 *   links the two things the hint is about. After a dismissal by the pointer, a
 *   click at the same spot dismisses the next card, the way closing a tab
 *   brings the next under the pointer; a part has no next card.
 * - While a card is open, the sheet holds the focus: J and K walk it through
 *   the page, T and E act on the card the sheet shows and walk it on, and G
 *   closes it and goes to the Task. H and the number keys 1 to 3 hand the
 *   thing the sheet shows to a workflow, as the sheet's Hand to rows do, and
 *   H says why when no workflow can take it. A sheet that shows a place has
 *   no moves, and says so.
 * - When the screen opens, the page takes the keyboard focus, so the keys
 *   act at once, even after a click on the sidebar. Focus in a text field
 *   stays there.
 * - A roving tab stop gives the Tab key one card to land on.
 */
export const useInboxPage = (input: InboxPageInput): InboxPage => {
  const { scrollRef, current, open } = input;
  const [isKeysSheetOpen, setKeysSheetOpen] = useState(false);
  const cameFrom = useRef<WalkedFrom | undefined>(undefined);
  const lastDismissal = useRef<{ x: number; y: number; at: number } | null>(null);
  const lastTakeAt = useRef(0);
  const tabStop = useRef<HTMLElement | null>(null);

  /**
   * Runs `move` on `card` unless it is refused, which is said on the undo
   * line. Take and Dismiss then hand the current card to the next that waits,
   * or walk the open sheet to it. Returns whether it ran.
   */
  const perform = (move: PlainMove, card: InboxCard, by: CurrentBy): boolean => {
    const reason = describeMoveRefusal(card, move);
    if (reason !== undefined) {
      input.moves.say(reason);
      return false;
    }
    if (move === "see-task") {
      input.moves.seeTask(card);
      return true;
    }
    input.runAndMoveOn(card.id, by, () => {
      if (move === "take") input.moves.take(card);
      else input.moves.dismiss(card);
    });
    return true;
  };

  const stepBack = (event: KeyboardEvent): void => {
    if (document.querySelector(OPEN_OVERLAY_SELECTOR) !== null) return;
    if (isKeysSheetOpen) setKeysSheetOpen(false);
    else if (open.isOpen) open.close();
    else if (current.read() !== null) current.set(null, "keys");
    else return;
    event.preventDefault();
  };

  /** Walks the open sheet to the card before or after it. */
  const walkSheet = (walk: "next" | "previous"): void => {
    const scroller = scrollRef.current;
    if (scroller === null || open.origin === null) return;
    // A sheet that opened on a place has no card to step from: the walk lands on the first card.
    const from = open.origin.kind === "card" ? open.origin.id : undefined;
    const to = walkInbox(readInboxStops(scroller), from, walk);
    if (to === undefined) return;
    open.walk(to);
    current.set(to, "keys", false);
  };

  /**
   * Handles H and the number keys 1 to 3 while a sheet is open (`useHandOff`
   * does the hand-off). A sheet that shows a place has no moves, and says so.
   */
  const handleSheetHandKey = (
    command: Extract<InboxKeyCommand, { kind: "hand" | "pick-workflow" }>,
    event: KeyboardEvent,
  ): void => {
    if (open.shown?.kind === "place") {
      if (command.kind === "hand") {
        event.preventDefault();
        input.moves.say(PLACE_HAS_NO_MOVES);
      }
      return;
    }
    const position = command.kind === "hand" ? undefined : command.position;
    if (input.handOff.pressSheetKey(position)) event.preventDefault();
  };

  const handleOpenCardKey = (command: InboxKeyCommand, event: KeyboardEvent): void => {
    if (command.kind === "walk") {
      if (command.walk !== "next" && command.walk !== "previous") return;
      event.preventDefault();
      if (!event.repeat) walkSheet(command.walk);
      return;
    }
    if (command.kind === "hand" || command.kind === "pick-workflow") {
      handleSheetHandKey(command, event);
      return;
    }
    if (command.kind !== "take" && command.kind !== "dismiss" && command.kind !== "see-task") {
      return;
    }
    // The moves act on what the sheet shows, which is not always the card it opened from.
    const { shown } = open;
    if (shown === null) return;
    event.preventDefault();
    if (shown.kind === "place") {
      input.moves.say(PLACE_HAS_NO_MOVES);
      return;
    }
    const card = input.findCard(shown.id);
    if (card === undefined) return;
    if (perform(command.kind, card, "keys") && command.kind === "see-task") open.close();
  };

  const handleKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || isTextField(event.target)) return;
    const command = readInboxKey(event);
    if (command === null || (event.repeat && command.kind !== "walk")) return;
    if (command.kind === "step-back") {
      stepBack(event);
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[popover], [role='menu']") != null) return;
    if (open.isOpen) {
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
        if (event.repeat) return;
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
        open.open({ kind: "card", id: here.id }, element);
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
      case "hand": {
        const card = here === null ? undefined : input.findCard(here.id);
        const element = here === null ? null : findCardElement(scroller, here.id);
        if (card === undefined || element === null) return;
        event.preventDefault();
        input.handOff.startCardHand(card, element, "keys");
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
      } else if (move === "hand") {
        const workflowId = button.dataset["workflowId"];
        if (workflowId !== undefined) input.handOff.handCard(card, workflowId, "pointer");
        else input.handOff.startCardHand(card, button, "pointer");
      }
      return;
    }
    if (element !== null && cardId !== undefined) {
      open.open({ kind: "card", id: cardId }, element);
      return;
    }
    // A hint is a reference found in text, and `Link them` makes it a link.
    const hint = target.closest<HTMLElement>("[data-link-from]");
    const linkFrom = hint?.dataset["linkFrom"];
    const linkTo = hint?.dataset["linkTo"];
    if (hint !== null && linkFrom !== undefined && linkTo !== undefined) {
      input.moves.link(linkFrom, linkTo);
      return;
    }
    // A quiet part, or a line that says what a request is linked to, opens the thing it names.
    const named = target.closest<HTMLElement>("[data-open-id]");
    const namedId = named?.dataset["openId"];
    if (named !== null && namedId !== undefined) {
      open.open({ kind: "card", id: namedId }, named);
      return;
    }
    // A place's head opens the place, and a pointer ("Also in ...") opens the card it points to.
    const placeHead = target.closest<HTMLElement>("[data-place-ref]");
    const placeRef = placeHead?.dataset["placeRef"];
    if (placeHead !== null && placeRef !== undefined) {
      open.open({ kind: "place", ref: placeRef }, placeHead);
      return;
    }
    const pointer = target.closest<HTMLElement>("[data-pointer-to]");
    const pointedTo = pointer?.dataset["pointerTo"];
    if (pointer !== null && pointedTo !== undefined) {
      open.open({ kind: "card", id: pointedTo }, pointer);
    }
  };

  // A card that takes the focus by the Tab key becomes the current card.
  const handleFocusIn = (event: FocusEvent): void => {
    const element = event.target instanceof Element ? readCardElement(event.target) : null;
    const id = element?.dataset["cardId"];
    if (element === null || id === undefined || event.target !== element) return;
    if (!element.matches(":focus-visible") || current.read()?.id === id) return;
    current.set(id, "keys", false);
  };

  useFocusPageOnArrival(scrollRef);

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

  return {
    isKeysSheetOpen,
    toggleKeysSheet: () => setKeysSheetOpen(!isKeysSheetOpen),
  };
};
