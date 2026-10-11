/**
 * The snooze menu: five choices of when a snoozed signal comes back, each
 * with its exact time (spec 17 §Snooze and Not urgent).
 */
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
} from "react";
import { buildSnoozeChoices, parsePickedSnoozeTime } from "@hercule/client-core";
import type { SnoozeMenuPlace } from "./use-signal-moves";
import "../thread/menus.css";

/** The anchor name of the control that opened the menu, which places the menu beside it. */
export const SNOOZE_ANCHOR = "--intake-snooze";

/**
 * Renders the snooze menu, open, beside the control that opened it. That
 * control carries the anchor name `SNOOZE_ANCHOR` and the attribute
 * `data-opens-snooze`, and a click on it closes the menu.
 *
 * The choices are built from `now`, the moment the menu opened, in
 * `timezone`, the user's timezone setting. `1` to `5` take a choice, the
 * arrow keys move between them, and Esc or a click outside closes the menu
 * and gives the focus back to where it was. Pick a time swaps the choices
 * for a date and time field. `onChoose` is called with the instant the
 * signals come back, after `onClose`.
 *
 * The menu is a popover, so it draws above the list and the pane, and no
 * scrolling part clips it. It handles its own keys, and stops them there,
 * so they never also move the list's selection.
 */
export function SnoozeMenu({
  place,
  now,
  timezone,
  onChoose,
  onClose,
}: {
  readonly place: SnoozeMenuPlace;
  readonly now: Date;
  readonly timezone: string;
  readonly onChoose: (until: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState("");
  const [pickFailed, setPickFailed] = useState(false);
  const choices = buildSnoozeChoices(now, timezone);

  const closeFromOutside = useEffectEvent(onClose);
  useLayoutEffect(() => {
    const menu = menuRef.current!;
    const opener = document.activeElement;
    menu.togglePopover(true);
    menu.querySelector<HTMLElement>("[role='menuitem']")?.focus({ preventScroll: true });
    const closeOnOutsidePress = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // The control that opened the menu closes it with its own click.
      if (menu.contains(target) || target.closest("[data-opens-snooze]") !== null) return;
      closeFromOutside();
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      // The menu is removed with the focus in it, which would drop the
      // focus to the page's body, outside Intake's keys.
      const focused = document.activeElement;
      const lost = focused === null || focused === document.body || menu.contains(focused);
      if (lost && opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  const pickField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (picking) pickField.current?.focus();
  }, [picking]);

  const choose = (until: string): void => {
    onClose();
    onChoose(until);
  };

  const takeChoice = (key: number): void => {
    const choice = choices.find((each) => each.key === key);
    if (choice === undefined || choice.disabled) return;
    if (choice.until === null) setPicking(true);
    else choose(choice.until);
  };

  const handleKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    // No key pressed in the menu reaches the screen's keys.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (picking || event.metaKey || event.ctrlKey || event.altKey) return;
    if (/^[1-5]$/.test(event.key)) {
      event.preventDefault();
      takeChoice(Number(event.key));
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  const submitPicked = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const until = parsePickedSnoozeTime(picked, new Date(), timezone);
    if (until === null) setPickFailed(true);
    else choose(until);
  };

  return (
    <div
      ref={menuRef}
      popover="manual"
      role="menu"
      aria-label="Snooze until"
      className="pop asks-snooze"
      data-place={place}
      onKeyDown={handleKeys}
    >
      <p className="asks-snooze-h">Snooze until</p>
      {picking ? (
        <form className="asks-snooze-pick" onSubmit={submitPicked}>
          <label className="field">
            <input
              ref={pickField}
              type="datetime-local"
              aria-label="The time it comes back"
              aria-invalid={pickFailed || undefined}
              value={picked}
              onChange={(event) => {
                setPicked(event.target.value);
                setPickFailed(false);
              }}
            />
          </label>
          {pickFailed && (
            <p className="asks-snooze-err" role="alert">
              Pick a time after now.
            </p>
          )}
          <button type="submit" className="btn btn--accent btn--sm">
            Snooze
          </button>
        </form>
      ) : (
        choices.map((choice) => (
          <button
            key={choice.key}
            type="button"
            role="menuitem"
            aria-disabled={choice.disabled || undefined}
            onClick={() => {
              takeChoice(choice.key);
            }}
          >
            <span>{choice.label}</span>
            {choice.timeLabel === null ? <span /> : <time>{choice.timeLabel}</time>}
            <kbd aria-hidden="true">{choice.key}</kbd>
          </button>
        ))
      )}
    </div>
  );
}
