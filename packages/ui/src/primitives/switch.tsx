import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/**
 * A switch that turns one thing on or off, and does it at once: there is no
 * form to submit after it. A checkbox is for a choice that a form sends later.
 *
 * It has no hue, because the design language keeps colour to word and dot
 * scale, and the live hue means that something runs. Off is a track outlined
 * in the faint colour with a muted knob, flat, so that the knob has a
 * contrast of at least 3:1 against the row in both themes. On is an ink track
 * with an ink knob, and a ring in the colour of the row at the edge of the
 * knob separates the knob from the track. In the dark theme the ink is light,
 * and a knob in the colour of the ground would look like a hole in the track.
 *
 * The switch is smaller than a pointer target must be, so an invisible area
 * around it takes a press that misses by a few pixels. In a row that opens a
 * page, such a press turns the switch and does not open the page.
 *
 * `aria-disabled` keeps the switch in the tab order while it ignores presses,
 * as while its write is in flight, so the keyboard focus stays on it. The
 * state is kept in `aria-checked` only, so what a screen reader reads and
 * what the switch shows cannot disagree. A switch has no visible name of its
 * own, so the caller names it with `aria-label` or a label element.
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
        // The padding box is 14 px high, so an inset of -6 px makes the area
        // 26 px high: 24 px, the size of a pointer target, and a pixel to spare
        // on each side.
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
          // Inset, so that the ring stays inside the track and never cuts its edge.
          "group-aria-checked:inset-ring-[1.5px] group-aria-checked:inset-ring-surface",
          "motion-safe:transition-transform",
        )}
      />
    </button>
  );
}
