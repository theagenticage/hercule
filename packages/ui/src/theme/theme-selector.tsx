import { useId, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/popover";
import { LaneLabel } from "../patterns/patterns";
import { cn } from "../primitives/cn";

/** The three theme choices; "system" follows the operating system's appearance. */
export type ThemeChoice = "light" | "dark" | "system";

/**
 * The `localStorage` key that keeps the choice between visits. It holds `light`
 * or `dark`; no value means the system choice, so a browser that has never
 * chosen is already on the default. The pre-paint script in
 * `apps/web/public/theme-init.js` reads the same key, so keep the two in step.
 */
const KEY = "hercule:theme";

/** The option order: Light and Dark together, then System last, above its note. */
const ORDER: readonly ThemeChoice[] = ["light", "dark", "system"];

const LABELS: Record<ThemeChoice, string> = { light: "Light", dark: "Dark", system: "System" };

/**
 * Reads the current choice from the document's `data-theme` attribute, not from
 * storage. The pre-paint script has already copied any stored choice there, and
 * a browser that denies storage can still choose a theme for the current visit.
 */
const readDocumentThemeChoice = (): ThemeChoice => {
  const theme = document.documentElement.dataset.theme;
  return theme === "light" || theme === "dark" ? theme : "system";
};

/**
 * Applies the choice to the document, where the style tokens read it, and saves
 * it to `localStorage` for the next page load.
 */
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
 * The theme selector: a quiet row at the foot of the sidebar, under the Marks
 * toggle, that opens the three theme choices. The choice belongs to this
 * browser, not to the user's settings, because the people who operate one
 * machine are not one person with one screen. Nothing changes until the user
 * picks a theme.
 *
 * The options form an ARIA radio group: exactly one is checked, and the arrow
 * keys move the check. Each arrow key press applies the theme while the popover
 * stays open; a click applies the theme and closes the popover.
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
    // The arrow keys belong to the radio group, so they must not also scroll
    // the page behind the popover.
    event.preventDefault();
    const next = ORDER[(ORDER.indexOf(choice) + offset + ORDER.length) % ORDER.length]!;
    choose(next);
    // With a roving tabindex the new choice is now the tab stop, so focus it.
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
        // Focus the checked option, not the popover itself, so the arrow keys
        // work from the first key press.
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
