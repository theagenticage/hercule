/**
 * The Inbox's keys, as two plain functions: where a key press landed
 * (`readInboxKeyPlace`) and what it asks for there (`decideInboxKeyAction`).
 * They read nothing but the press and the element it landed on, so the
 * screen's one key listener can stay a switch over the action.
 *
 * Single keys act only while the focus is in the list, the pane or the empty
 * state's heading, or on the page itself when nothing has the focus (WCAG
 * 2.1.4: speech input and a stray key never act on a row nobody is looking
 * at). `/` and `?` reach from anywhere outside a field, the digits from the
 * rail, and Esc brings the focus back to the list.
 */
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { isTextField } from "../../app/text-field";
import { OVERLAY_SELECTOR } from "../desk/desk-keys";
import { INBOX_PANE_ID } from "./inbox-pane-frame";

/** What a key press asks the Inbox for. */
export type InboxKeyAction =
  | { readonly kind: "step"; readonly by: 1 | -1; readonly extend: boolean }
  | { readonly kind: "toggleSelect" }
  | { readonly kind: "selectAll" }
  | { readonly kind: "stepBack" }
  | { readonly kind: "dismiss" }
  | { readonly kind: "takeOn" }
  | { readonly kind: "handOff" }
  | { readonly kind: "goToTask" }
  | { readonly kind: "openAtSource" }
  | { readonly kind: "showArrivals" }
  | { readonly kind: "pickList"; readonly index: number }
  | { readonly kind: "search" }
  | { readonly kind: "narrow" }
  | { readonly kind: "toggleKeys" }
  | { readonly kind: "nextRegion"; readonly backwards: boolean }
  | { readonly kind: "openPane" }
  | { readonly kind: "focusList" };

/**
 * Where a key press landed:
 * - `list`: the list, the pane, the empty state, or the page with no focus;
 * - `rail`: the rail, or the menu that holds it under 1058px;
 * - `field`: a text field, which keeps its own keys;
 * - `overlay`: a menu, a popover or a dialog, which owns the keyboard;
 * - `bar`: the rest of the Inbox (the bar, the head of the list, the undo line);
 * - `outside`: the rest of the app, such as the sidebar.
 */
export type InboxKeyPlace = "list" | "rail" | "field" | "overlay" | "bar" | "outside";

const LIST_PLACE = `.ib-rows, #${INBOX_PANE_ID}, .ib-empty`;
const RAIL_PLACE = "#inbox-rail, #inbox-scope-menu";

/** Returns where a key press landed, from the element that had the focus. */
export const readInboxKeyPlace = (target: EventTarget | null): InboxKeyPlace => {
  if (!(target instanceof Element) || target === document.body) return "list";
  if (target === document.documentElement) return "list";
  if (isTextField(target)) return "field";
  if (target.closest(OVERLAY_SELECTOR) !== null) return "overlay";
  if (target.closest(".ib") === null) return "outside";
  if (target.closest(RAIL_PLACE) !== null) return "rail";
  return target.closest(LIST_PLACE) === null ? "bar" : "list";
};

/** The parts of a key press that decide what it asks for. */
export interface InboxKeyPress {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  /** True while the key is held down and repeating. */
  readonly repeat: boolean;
  /** True when the focus is on a button, a link or another control that answers Return and Space itself. */
  readonly isOnControl: boolean;
}

/** The moves that never repeat: a held key must not dismiss a row after row. */
const ONE_PRESS_KEYS = new Set(["e", "t", "h", "g", "o", "x"]);

/** The saved queries that have a digit: 1 to 7. The eighth place in the drawing is Triage, which is not built. */
const LIST_DIGITS = /^[1-7]$/;

/**
 * Returns what `press` asks for in `place`, or `null` when the Inbox leaves
 * the key alone (the caller then does not stop it).
 */
export const decideInboxKeyAction = (
  press: InboxKeyPress,
  place: InboxKeyPlace,
): InboxKeyAction | null => {
  const { key } = press;
  if (key === "F6" && place !== "outside") {
    return { kind: "nextRegion", backwards: press.shiftKey };
  }
  if (place === "outside" || place === "overlay" || place === "field") return null;
  if (press.altKey) return null;
  if (press.metaKey || press.ctrlKey) {
    return key.toLowerCase() === "a" && place === "list" ? { kind: "selectAll" } : null;
  }
  if (key === "/") return { kind: "search" };
  if (key === "?") return { kind: "toggleKeys" };
  if (key === "Escape") return place === "list" ? { kind: "stepBack" } : { kind: "focusList" };
  if (place === "rail") {
    return LIST_DIGITS.test(key) ? { kind: "pickList", index: Number(key) - 1 } : null;
  }
  if (place !== "list") return null;
  const lower = key.toLowerCase();
  if (press.repeat && ONE_PRESS_KEYS.has(lower)) return null;
  if ((key === "Enter" || key === " ") && press.isOnControl) return null;
  if (lower === "j" || key === "ArrowDown") return { kind: "step", by: 1, extend: press.shiftKey };
  if (lower === "k" || key === "ArrowUp") return { kind: "step", by: -1, extend: press.shiftKey };
  if (LIST_DIGITS.test(key)) return { kind: "pickList", index: Number(key) - 1 };
  switch (lower) {
    case "x":
      return { kind: "toggleSelect" };
    case "e":
      return { kind: "dismiss" };
    case "t":
      return { kind: "takeOn" };
    case "h":
      return { kind: "handOff" };
    case "g":
      return { kind: "goToTask" };
    case "o":
      return { kind: "openAtSource" };
    case "f":
      return { kind: "narrow" };
    case ".":
      return { kind: "showArrivals" };
    case "enter":
      return { kind: "openPane" };
    default:
      return null;
  }
};

/** One line of the keys sheet: the keys, as they are written, and what they do. */
export type InboxKeyRow = readonly [keys: string, words: string];

/**
 * Returns the Inbox's keys and what each does, as its sheet lists them. Undo
 * and Esc follow on every page. Select all is ⌘A on a Mac and Ctrl A elsewhere.
 */
export const buildInboxKeyRows = (platform: DesktopPlatform): readonly InboxKeyRow[] => [
  ["J K ↓ ↑", "Next and previous thing"],
  ["⇧J ⇧K", "Select a range while moving"],
  ["X", "Select, or unselect"],
  [platform === "mac" ? "⌘A" : "Ctrl A", "Select every thing that is loaded"],
  ["Return", "Open the pane, when it lies over the list"],
  ["E", "Dismiss, all of the selection at once"],
  ["T", "Take on: a Task on Work"],
  ["H", "Hand off to an agent"],
  ["G", "Go to its Task"],
  ["O", "Open at its source"],
  ["/", "Search"],
  ["F", "Narrow"],
  ["1 to 7", "The saved queries"],
  [".", "Show what is new"],
  ["F6", "The search, the rail, the list, the pane"],
];
