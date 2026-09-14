import { useState, type JSX } from "react";
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
const KEY = "hydra:theme";

/** The pinned order: Light and Dark adjacent, System last, under its fine note. */
const ORDER: readonly ThemeChoice[] = ["light", "dark", "system"];

const LABELS: Record<ThemeChoice, string> = { light: "Light", dark: "Dark", system: "System" };

/**
 * The document is what the choice is read back from, not the storage: the
 * pre-paint script has already carried a stored choice there, and a browser
 * with storage denied still gets to choose for the visit it is on.
 */
const choiceOfDocument = (): ThemeChoice => {
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
 */
export function ThemeSelector(): JSX.Element {
  const [choice, setChoice] = useState(choiceOfDocument);
  const [open, setOpen] = useState(false);

  const pick = (next: ThemeChoice): void => {
    setChoice(next);
    applyChoice(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex w-full cursor-pointer items-center gap-2 rounded-control px-2.5 py-[5px] text-row text-muted hover:bg-line-soft hover:text-ink aria-expanded:bg-line-soft aria-expanded:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live">
        Theme <span className="ml-auto text-fine text-faint">{LABELS[choice]}</span>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-[236px]" aria-label="Theme">
        <LaneLabel className="mb-1">Theme</LaneLabel>
        <div className="flex flex-col gap-px">
          {ORDER.map((value) => (
            <button
              key={value}
              type="button"
              aria-current={choice === value ? "true" : undefined}
              onClick={() => pick(value)}
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
