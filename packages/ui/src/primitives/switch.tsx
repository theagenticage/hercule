import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/**
 * An on/off toggle that takes effect at once, with no form to submit. Use a
 * Checkbox for a choice that a form sends later.
 *
 * The switch uses no colour, because the design language uses colour only at
 * the size of a word or a dot, and the live colour means that something is
 * running.
 * - Off: a track with a faint outline and a muted knob. The knob has at
 *   least 3:1 contrast against the row in both themes.
 * - On: an ink track and an ink knob. A ring in the row's colour around the
 *   knob separates it from the track. The knob is not simply the row's
 *   colour, because in the dark theme ink is light, and such a knob would
 *   look like a hole in the track.
 *
 * The switch is smaller than the minimum pointer target, so an invisible
 * area around it catches clicks that miss by a few pixels. In a row that
 * links to a page, such a click toggles the switch instead of opening the
 * page.
 *
 * With `aria-disabled`, the switch ignores clicks but stays in the tab order,
 * so keyboard focus stays on it while its save is in flight. The on/off state
 * is only in `aria-checked`, so a screen reader always announces what the
 * switch shows. The switch has no visible label, so the caller must name it
 * with `aria-label` or a label element.
 */
export function Switch({
  checked,
  onCheckedChange,
  className,
  "aria-disabled": ariaDisabled,
  ...props
}: Omit<ComponentProps<"button">, "type" | "role" | "onClick" | "onChange"> & {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}): JSX.Element {
  const isInert = ariaDisabled === true || ariaDisabled === "true";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={ariaDisabled}
      onClick={() => {
        if (!isInert) onCheckedChange(!checked);
      }}
      className={cn(
        "group relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border p-px",
        "border-faint aria-checked:border-ink aria-checked:bg-ink",
        // The padding box is 14px high. A -6px inset makes the click area 26px
        // high: the 24px minimum pointer target, plus 1px to spare on each side.
        "after:absolute after:-inset-[6px] after:content-['']",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-3 rounded-full bg-muted",
          "group-aria-checked:translate-x-3 group-aria-checked:bg-ink",
          // An inset ring stays inside the knob, so it never covers the track's edge.
          "group-aria-checked:inset-ring-[1.5px] group-aria-checked:inset-ring-surface",
          "motion-safe:transition-transform",
        )}
      />
    </button>
  );
}
