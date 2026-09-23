import { useId, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/popover";
import { LaneLabel } from "../patterns/patterns";
import { cn } from "../primitives/cn";

/** The three ways the app can be painted; "system" follows the machine. */
export type ThemeChoice = "light" | "dark" | "system";

/**
 * Where the choice lives between visits. The key holds `light` or `dark`, and
 * holding nothing at all is the system choice - so a browser that has never
 * chosen is already on the default, and the pre-paint script in
 * `apps/web/public/theme-init.js` reads this same key. Keep the two in step.
 */
const KEY = "hercule:theme";

/** The pinned order: Light and Dark adjacent, System last, under its fine note. */
const ORDER: readonly ThemeChoice[] = ["light", "dark", "system"];

const LABELS: Record<ThemeChoice, string> = { light: "Light", dark: "Dark", system: "System" };

/**
 * The document is what the choice is read back from, not the storage: the
 * pre-paint script has already carried a stored choice there, and a browser
 * with storage denied still gets to choose for the visit it is on.
 */
const readDocumentThemeChoice = (): ThemeChoice => {
  const theme = document.documentElement.dataset.theme;
  return theme === "light" || theme === "dark" ? theme : "system";
};

/** Applies the choice where the tokens read it, and where the next load will. */
const applyChoice = (choice: ThemeChoice): void => {
  if (choice === "light" || choice === "dark") document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage denied: the choice holds for this visit only.
  }
};

/**
 * The theme selector: a quiet row at the sidebar foot, under the Marks toggle,
 * opening the three ways the app can be painted. It is a this-browser choice
 * rather than a setting - a machine's operators are not one person with one
 * screen - and it changes nothing until it is clicked.
 *
 * The three options are a radio group in the ARIA sense as well as the visual
 * one: one is checked, the arrow keys move the check as they go, and a click
 * commits. Arrows browse with the popover open - the app repaints under them -
 * while a click is the commitment that closes it.
 */
export function ThemeSelector(): JSX.Element {
  const [choice, setChoice] = useState(readDocumentThemeChoice);
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const rows = useRef(new Map<ThemeChoice, HTMLButtonElement>());

  const choose = (next: ThemeChoice): void => {
    setChoice(next);
    applyChoice(next);
  };

  const pick = (next: ThemeChoice): void => {
    choose(next);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const offset =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (offset === 0) return;
    // The arrows are the radio group's own keys; they do not scroll the page
    // behind the popover as well.
    event.preventDefault();
    const next = ORDER[(ORDER.indexOf(choice) + offset + ORDER.length) % ORDER.length]!;
    choose(next);
    // Roving tabindex made the new choice the tab stop; focus follows it.
    rows.current.get(next)?.focus();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex w-full cursor-pointer items-center gap-2 rounded-control px-2.5 py-[5px] text-row text-muted hover:bg-line-soft hover:text-ink aria-expanded:bg-line-soft aria-expanded:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live">
        Theme <span className="ml-auto text-fine text-faint">{LABELS[choice]}</span>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="end"
        className="w-[236px]"
        aria-label="Theme"
        // Focus lands on the checked option rather than the popover's rim, so
        // the arrow keys work from the first keystroke.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          rows.current.get(choice)?.focus();
        }}
      >
        <LaneLabel className="mb-1" id={labelId}>
          Theme
        </LaneLabel>
        <div
          role="radiogroup"
          aria-labelledby={labelId}
          onKeyDown={onKeyDown}
          className="flex flex-col gap-px"
        >
          {ORDER.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={choice === value}
              tabIndex={choice === value ? 0 : -1}
              onClick={() => pick(value)}
              ref={(element) => {
                if (element === null) rows.current.delete(value);
                else rows.current.set(value, element);
              }}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2.5 rounded-control py-[2.5px] text-left text-fine",
                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
                choice === value ? "text-ink" : "text-muted hover:bg-line-soft hover:text-ink",
              )}
            >
              <span className="flex w-4 justify-start" aria-hidden="true">
                <span
                  className={cn(
                    "size-1.5 rounded-full border-[1.5px]",
                    choice === value ? "border-ink bg-ink" : "border-faint",
                  )}
                />
              </span>
              {LABELS[value]}
            </button>
          ))}
        </div>
        <p className="mt-2 border-t border-line-soft pt-2 text-fine text-faint">
          System follows this machine's appearance.
        </p>
      </PopoverContent>
    </Popover>
  );
}
